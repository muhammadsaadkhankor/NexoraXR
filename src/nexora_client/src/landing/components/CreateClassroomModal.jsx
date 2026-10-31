import { useEffect, useRef, useState } from 'react';
import { X, FileText, Upload, Plus } from 'lucide-react';
import { API_URL } from '../../shared/config';

const MAX_PDFS = 8;
const MAX_PDF_MB = 25;
const BUILD_MSGS = [
  'Analyzing your documents…',
  'Mapping the course material…',
  'Designing the lecture outline…',
  'Writing the course script…',
  'Almost there, polishing the lectures…',
];

// Classroom creation = pick an existing course, or create a new one inline.
// The classroom takes the course's name; PDFs dropped here become the course
// materials (ingested later for the 8-lecture build).
export default function CreateClassroomModal({ onClose, onCreated }) {
  const [courses, setCourses] = useState([]);
  const [courseId, setCourseId] = useState(''); // '' | 'new' | <uuid>
  const [newCourseName, setNewCourseName] = useState('');
  const [isPublic, setIsPublic] = useState(false); // default: private
  const [lectureCount, setLectureCount] = useState(8);
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // Stages: 'form' → 'plan' (confirm lecture order/titles, one PDF each)
  // → 'review' (edit canonical script) → one click bakes audio for ALL
  // languages → ready. reviewRef carries course/room through the stages.
  const [stage, setStage] = useState('form');
  const [plan, setPlan] = useState(null);           // [{idx,title,titleGuessed,sources}]
  const [lectureMinutes, setLectureMinutes] = useState(10); // narration duration target
  const [planAmbiguous, setPlanAmbiguous] = useState(false);
  const [drafts, setDrafts] = useState(null);
  const [audioLangs] = useState(['en', 'ar', 'fr', 'de', 'es', 'zh']);
  const [approveBlocked, setApproveBlocked] = useState(null);
  const [approving, setApproving] = useState(false);
  const [canRetryIngest, setCanRetryIngest] = useState(false);
  // Live backend build state — the Approve button's disabled/label logic
  // reads THIS (not local flags), so reopening the modal or refreshing the
  // page mid-build can never enable a duplicate submission.
  const [buildState, setBuildState] = useState(null); // {status, progress}
  const reviewRef = useRef(null);

  const BUILDING = ['translating', 'audio', 'validating'];
  const processing = BUILDING.includes(buildState?.status);

  useEffect(() => {
    fetch(`${API_URL}/api/courses`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setCourses(d.courses || []))
      .catch(() => {});
  }, []);

  const creatingNew = courseId === 'new' || (!courseId && courses.length === 0);
  const valid = creatingNew ? newCourseName.trim().length > 0 : !!courseId;

  const addFiles = (list) => {
    const all = [...list];
    const pdfs = all.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    setError(null);
    if (pdfs.length !== all.length) setError('Only PDF files are supported.');
    const over = pdfs.find((f) => f.size > MAX_PDF_MB * 1024 * 1024);
    if (over) setError(`"${over.name}" exceeds ${MAX_PDF_MB} MB.`);
    setFiles((prev) => [...prev, ...pdfs.filter((f) => f.size <= MAX_PDF_MB * 1024 * 1024)].slice(0, MAX_PDFS));
  };

  // Shared status poller — resolves 'awaiting_review' | 'ready' | 'failed'.
  // Records the first ready lecture id for classroom entry. No deadline:
  // a mid-flight build is never reported as an error just for being slow.
  const pollUntilGate = async (courseId) => {
    // No hard deadline: a real bake (translate ×5 + TTS ×6) regularly exceeds
    // 20 min. Timing out used to print "did not complete" while the backend
    // was still working — now we keep watching until a terminal state.
    const started = Date.now();
    const STEP_LABEL = {
      ingesting: 'Generating scripts · reading your documents…',
      planning: 'Generating scripts · designing the curriculum…',
      scripts: 'Generating scripts · writing lecture scripts…',
      translating: 'Preparing translations · all supported languages…',
      audio: 'Generating audio · recording professor narration…',
      validating: 'Generating audio · verifying course artifacts…',
    };
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await fetch(`${API_URL}/api/courses/${courseId}/status`, { credentials: 'include' })
        .then((r) => r.json()).catch(() => null);
      if (!st) continue;
      const step = st.build?.status;
      const progress = st.build?.stats?.progress;
      setBuildState({ status: step, progress, stage: st.build?.stats?.stage });
      const long = Date.now() - started > 20 * 60 * 1000;
      setStatus((STEP_LABEL[step]
        ? `${STEP_LABEL[step]}${progress ? ` (${progress})` : ''}`
        : BUILD_MSGS[(Math.random() * BUILD_MSGS.length) | 0])
        + (long ? ' — still working, progress is preserved even if you close this window' : ''));
      if (step === 'awaiting_review') return st.build?.stats?.stage || 'scripts';
      if (step === 'ready') {
        if (reviewRef.current) reviewRef.current.firstLecture = st.lectures?.[0]?.lectureId || null;
        return 'ready';
      }
      if (step === 'failed') {
        // Failure AFTER scripts were written (translation/audio/validating)
        // is retryable — scripts persist; the build can be resumed by
        // approving again. Pre-script failures still need a rebuild.
        const retryable = ['translations', 'audio', 'validating'].includes(st.build?.stats?.stage);
        setError(retryable
          ? `Audio generation failed: ${st.build.error || 'server error'}. Your scripts are saved — fix the issue and press "Retry Missing Audio" to continue (already-baked segments are reused).`
          : `Course build failed: ${st.build.error || 'server error'}. The classroom is created; you can rebuild later.`);
        return 'failed';
      }
    }
  };

  // Load the canonical drafts for the review screen (single shape used by
  // every entry point — origText lets approval skip unchanged scripts).
  const loadReviewDrafts = async (cid) => {
    const dr = await fetch(`${API_URL}/api/courses/${cid}/drafts`, { credentials: 'include' })
      .then((r) => r.json()).catch(() => null);
    setDrafts((dr?.drafts || []).map((d) => {
      const text = d.segments.map((s) => s.text).join('\n\n');
      return { ...d, fullText: text, origText: text };
    }));
  };

  // Reopen/refresh recovery: picking a course whose build is mid-flight
  // jumps straight to a watch-only review — approval stays disabled while
  // the backend reports translating/audio/validating.
  const resumeInFlight = async (cid) => {
    const st = await fetch(`${API_URL}/api/courses/${cid}/status`, { credentials: 'include' })
      .then((r) => r.json()).catch(() => null);
    const step = st?.build?.status;
    if (!BUILDING.includes(step)) return false;
    reviewRef.current = { courseId: cid, room: null, firstLecture: null,
      count: st.build.lecture_count || 1 };
    setBuildState({ status: step, progress: st.build?.stats?.progress });
    setStatus('Preparing multilingual audio…');
    await loadReviewDrafts(cid);
    setStage('review');
    const outcome = await pollUntilGate(cid);
    if (outcome === 'ready') {
      // Find the classroom this course belongs to (room wasn't in memory
      // after a refresh) and go straight in.
      const rooms = await fetch(`${API_URL}/api/rooms/mine`, { credentials: 'include' })
        .then((r) => r.json()).catch(() => ({}));
      const room = (rooms.rooms || []).find((r) => r.courseId === cid);
      if (room) { onCreated({ ...room, generatedLectureId: reviewRef.current?.firstLecture }); return true; }
      setStatus('All languages ready — open the classroom from your list.');
    }
    return true; // handled (either still processing-failed or ready)
  };

  useEffect(() => {
    // Only while picking an existing course on the form — never fires for
    // 'new' or inside the build/review stages (ctx already set there).
    if (stage !== 'form' || !courseId || courseId === 'new') return;
    resumeInFlight(courseId).catch(() => {});
  }, [courseId, stage]);

  // Wait for async ingestion to finish (documents 'ready'), then fetch the
  // proposed per-document lecture plan. Failed docs abort immediately with
  // their real error — no 4-minute wait for a dead document.
  const pollPlanPreview = async (courseId, expectedDocs) => {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = await fetch(`${API_URL}/api/courses/${courseId}/plan-preview`, { credentials: 'include' })
        .then((r) => r.json()).catch(() => null);
      if (p?.failed?.length) {
        const names = p.failed.map((f) => `${f.filename}: ${f.error}`).join('; ');
        throw new Error(`Document extraction failed — ${names}`);
      }
      if (p?.lectures?.length >= expectedDocs) return p;
      if (p?.ready != null && p.ready < expectedDocs && i % 5 === 0) {
        setStatus(`Reading your documents · ${p.ready}/${expectedDocs} ready…`);
      }
    }
    return null;
  };

  const fileToDataUrl = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });

  // Approve Scripts and Generate Audio — saves the reviewed English text,
  // then atomically starts the audio stage: the server translates the
  // approved scripts into every supported language and bakes TTS for all
  // lectures. A second click while running is rejected; a failure keeps
  // scripts + baked audio and retries only the missing work.
  const approveAudio = async () => {
    const ctx = reviewRef.current;
    if (!ctx || approving) return;
    setApproving(true);
    setError(null);
    try {
      // Only persist scripts the instructor actually edited — an unchanged
      // approval must not rewrite drafts (or invalidate audio fingerprints).
      const edited = (drafts || []).filter((d) => d.fullText !== d.origText);
      if (edited.length) {
        const pr = await fetch(`${API_URL}/api/courses/${ctx.courseId}/drafts`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lectures: edited.map((d) => ({
              lectureId: d.lectureId, fullText: d.fullText,
            })),
          }),
        });
        const pd = await pr.json().catch(() => ({}));
        if (!pr.ok) throw new Error(pd.error || 'Failed to save reviewed scripts');
      }
      const ar = await fetch(`${API_URL}/api/courses/${ctx.courseId}/approve-audio`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioLangs,
          confirmUncertain: approveBlocked?.uncertain === true,
        }),
      });
      const ad = await ar.json().catch(() => ({}));
      if (!ar.ok) {
        if (ar.status === 409 && ad.blocked?.length) {
          setApproveBlocked({
            list: ad.blocked,
            uncertain: ad.blocked.some((b) => /uncertain/i.test(b)),
          });
          throw new Error('Approval blocked — see the list below.');
        }
        throw new Error(ad.error || 'Failed to start audio generation');
      }
      setApproveBlocked(null);
      setStatus('Generating audio · translating scripts, then recording narration (all 6 languages)…');
      const outcome = await pollUntilGate(ctx.courseId);
      if (outcome === 'ready') {
        ctx.room.generatedLectureId = ctx.firstLecture || null;
        onCreated(ctx.room);
        return;
      }
      // 'failed' already set a retryable error in the poller; any other
      // gate (stale fingerprints, timeout) bounces back to script review.
      if (outcome !== 'failed') {
        await loadReviewDrafts(ctx.courseId);
        setError((prev) => prev || 'Audio generation did not complete — review the scripts and press "Approve & Generate Audio" again.');
        setStatus(null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setApproving(false);
    }
  };


  const updateDraftText = (li, text) => {
    setDrafts((ds) => ds.map((d, i) => i !== li ? d : { ...d, fullText: text }));
  };

  // POST build → scripts → review. `plan` may be null → server derives the
  // outline deterministically (1-PDF-per-lecture or fullCoverage).
  const startBuildAndReview = async (planToSend, count, { internal = false } = {}) => {
    const ctx = reviewRef.current;
    if (!ctx || (submitting && !internal)) return;
    setSubmitting(true);
    setError(null);
    try {
      const br = await fetch(`${API_URL}/api/courses/${ctx.courseId}/build`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(planToSend?.length
          ? { lectureCount: planToSend.length, lecturePlan: planToSend, minutes: lectureMinutes }
          : { lectureCount: count, minutes: lectureMinutes }),
      }).catch(() => null);
      if (!br) {
        throw new Error('Could not reach the server — it may be restarting. Try again in a few seconds.');
      }
      if (!br.ok) {
        const bd = await br.json().catch(() => ({}));
        throw new Error(bd.error || `Course build could not be started (HTTP ${br.status}).`);
      }
      const outcome = await pollUntilGate(ctx.courseId);
      if (outcome === 'scripts' || outcome === 'awaiting_review') {
        await loadReviewDrafts(ctx.courseId);
        setStage('review');
        setStatus(null);
        return;
      }
      if (outcome === 'ready') {
        ctx.room.generatedLectureId = ctx.firstLecture || null;
        onCreated(ctx.room);
        return;
      }
    } catch (err) {
      setError(err.message);
      setStatus(null);
    } finally {
      setSubmitting(false);
    }
  };

  // Confirm the (edited) lecture list from the plan screen.
  const confirmPlan = () => startBuildAndReview(plan, plan.length);

  const movePlan = (i, dir) => {
    setPlan((ps) => {
      const a = [...ps];
      const j = i + dir;
      if (j < 0 || j >= a.length) return a;
      [a[i], a[j]] = [a[j], a[i]];
      return a.map((p, k) => ({ ...p, idx: k + 1 }));
    });
  };

  const setPlanTitle = (i, title) => {
    setPlan((ps) => ps.map((p, k) => k === i ? { ...p, title } : p));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // Any number of source PDFs — the planner allocates their content
      // across the requested lectures.
      if (creatingNew && !files.length) {
        throw new Error('Upload at least one source PDF.');
      }
      // Free-typed field — normalize before it goes to the API.
      const count = Math.min(Math.max(Number.parseInt(lectureCount, 10) || 1, 1), 50);
      setLectureCount(count);
      // 1) resolve the course (create inline when needed)
      setStatus('Resolving course…');
      let course = courses.find((c) => c.id === courseId);
      if (!course) {
        const cr = await fetch(`${API_URL}/api/courses`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newCourseName.trim() }),
        });
        const cd = await cr.json();
        if (!cr.ok) throw new Error(cd.error || 'Failed to create course');
        course = cd.course;
      }

      // 2) create the classroom bound to that course
      setStatus('Creating classroom…');
      const res = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          className: course.name,      // classroom name = course name
          courseName: course.name,
          courseId: course.id,
          roomType: isPublic ? 'public' : 'private',
          scene: course.scene || 'Multimedia',
          lectureCount: count,
        }),
      });
      const data = await res.json();
      if (res.status === 401) throw new Error('Sign in with an instructor account to create classrooms');
      if (res.status === 403) throw new Error('Only instructors can create classrooms');
      if (!res.ok) throw new Error(data.error || 'Failed to create classroom');

      // 3) attach PDF materials
      if (files.length) {
        setStatus(`Uploading ${files.length} PDF${files.length > 1 ? 's' : ''}…`);
        const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, dataUrl: await fileToDataUrl(f) })));
        const up = await fetch(`${API_URL}/api/rooms/${data.roomId}/materials`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: uploads }),
        });
        const ud = await up.json().catch(() => ({}));
        if (!up.ok) throw new Error(ud.error || 'Classroom created but material upload failed');

        // One PDF = one lecture. Poll plan-preview until ingestion finishes
        // (docs 'ready'), then show the ordered lecture list for review.
        reviewRef.current = { courseId: course.id, room: data, firstLecture: null, count };
        setStatus('Reading your documents…');
        const preview = await pollPlanPreview(course.id, files.length);
        if (!preview?.lectures?.length) {
          // Stay in the modal — navigating now would land on an empty course.
          setError('Documents were uploaded but none produced usable text (image-only or corrupt PDF). Retry extraction or replace the file.');
          setStatus(null);
          setSubmitting(false);
          setCanRetryIngest(true);
          return;
        }
        setPlan(preview.lectures);
        setPlanAmbiguous(preview.ambiguousOrder);
        // Auto path — no manual plan confirmation. PDFs == requested lectures
        // → send the derived plan (one PDF per lecture). Otherwise let the
        // server allocate across all documents (fullCoverage).
        const autoPlan = preview.lectures.length === count ? preview.lectures : null;
        if (preview.ambiguousOrder && autoPlan) {
          console.warn('[create] lecture order inferred from upload order');
        }
        setStatus('Generating scripts · writing lecture scripts…');
        await startBuildAndReview(autoPlan, count, { internal: true });
        return;
      }
      onCreated(data);
    } catch (err) {
      setError(err.message);
      setStatus(null);
      setSubmitting(false);
      if (/extraction failed|usable text/i.test(err.message || '')) setCanRetryIngest(true);
    }
  };

  // Retry ingestion for failed documents (e.g. image-only PDF before OCR was
  // available) — reuses registered docs, re-polls preview, auto-resumes build.
  const retryIngest = async () => {
    const ctx = reviewRef.current;
    if (!ctx || submitting) return;
    setSubmitting(true);
    setError(null);
    setCanRetryIngest(false);
    try {
      const rr = await fetch(`${API_URL}/api/courses/${ctx.courseId}/reingest`, {
        method: 'POST', credentials: 'include' });
      const rd = await rr.json().catch(() => ({}));
      if (!rr.ok) throw new Error(rd.error || 'Retry failed');
      setStatus('Retrying document extraction…');
      const preview = await pollPlanPreview(ctx.courseId, files.length || ctx.count);
      if (!preview?.lectures?.length) {
        setError('Extraction produced no usable text — try a PDF with a text layer or clearer scans.');
        setCanRetryIngest(true);
        setStatus(null);
        return;
      }
      setPlan(preview.lectures);
      setPlanAmbiguous(preview.ambiguousOrder);
      const autoPlan = preview.lectures.length === ctx.count ? preview.lectures : null;
      setStatus('Generating scripts · writing lecture scripts…');
      await startBuildAndReview(autoPlan, ctx.count, { internal: true });
    } catch (err) {
      setError(err.message);
      setStatus(null);
      if (/extraction failed|usable text/i.test(err.message || '')) setCanRetryIngest(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ccmodal__backdrop" onClick={onClose}>
      <form className={`ccmodal${stage === 'review' ? ' ccmodal--wide' : ''}`} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="ccmodal__head">
          <h3>Create Classroom</h3>
          <button type="button" className="ccmodal__close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {stage === 'plan' ? (
          /* ---- Lecture plan: confirm order/titles before generation ---- */
          <div className="ccmodal__review">
            <p className="ccmodal__review-hint">
              Each uploaded PDF becomes one lecture. Confirm the order and
              titles below — generation uses exactly this list.
            </p>
            {planAmbiguous && (
              <p className="ccmodal__error" style={{ textAlign: 'left' }}>
                Could not determine lecture order from the filenames — the
                list below follows upload order. Reorder it if needed.
              </p>
            )}
            <div className="ccmodal__review-list">
              {(plan || []).map((p, i) => (
                <div key={p.idx} className="ccmodal__review-lec">
                  <div className="ccmodal__review-lechead">
                    <strong>Lecture {i + 1}</strong>
                    <span className="ccmodal__review-count">
                      {p.sources?.[0]?.filename}{p.titleGuessed ? ' · title guessed' : ''}
                    </span>
                    <span>
                      <button type="button" className="ccmodal__updown" onClick={() => movePlan(i, -1)} disabled={i === 0}>↑</button>
                      <button type="button" className="ccmodal__updown" onClick={() => movePlan(i, 1)} disabled={i === plan.length - 1}>↓</button>
                    </span>
                  </div>
                  <input
                    className="ccmodal__plan-title"
                    value={p.title}
                    onChange={(e) => setPlanTitle(i, e.target.value)}
                    maxLength={190}
                  />
                </div>
              ))}
            </div>
            {error && <p className="ccmodal__error">{error}</p>}
            <div className="ccmodal__actions" style={{ alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
                Minutes per lecture
                <input
                  type="number" min={5} max={15} value={lectureMinutes}
                  onChange={(e) => setLectureMinutes(Math.min(15, Math.max(5, +e.target.value || 10)))}
                  style={{ width: 52, background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
                    color: '#e2e8f0', padding: '3px 6px', fontSize: 12 }}
                />
              </label>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={submitting}
                onClick={confirmPlan}>
                {submitting ? (status || 'Generating scripts…') : `Generate ${plan.length} Lecture Script${plan.length > 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        ) : stage === 'review' ? (
          /* ---- Canonical script review (English) → one-click approve+bake ---- */
          <div className="ccmodal__review">
            <p className="ccmodal__review-hint">
              Review each lecture's script — edit freely, or paste an improved
              version (e.g. from ChatGPT). One click approves the scripts,
              translates them into AR · FR · DE · ES · ZH, and generates
              narrated audio in all six languages for every lecture.
            </p>
            <div className="ccmodal__review-list">
              {(drafts || []).map((d, li) => (
                <div key={d.lectureId} className="ccmodal__review-lec">
                  <div className="ccmodal__review-lechead">
                    <strong>{d.title || `Lecture ${li + 1}`}</strong>
                    <span className="ccmodal__review-count">
                      ~{d.segments.length} segments{d.audioOutdated ? ' · audio outdated' : ''}
                    </span>
                  </div>
                  {d.coverage?.recommendedMinutes ? (
                    <p className="ccmodal__error" style={{ textAlign: 'left', margin: '0 0 6px' }}>
                      Full topic coverage needs ~{d.coverage.recommendedMinutes} min of narration —
                      increase the lecture minutes or accept the omissions below.
                    </p>
                  ) : null}
                  {d.coverage?.missing?.length ? (
                    <p className="ccmodal__error" style={{ textAlign: 'left', margin: '0 0 6px' }}>
                      Possible missing topics: {d.coverage.missing.join('; ')} — expand the script or confirm the source lacks them.
                    </p>
                  ) : null}
                  <textarea
                    className="ccmodal__review-full"
                    rows={14}
                    value={d.fullText}
                    onChange={(e) => updateDraftText(li, e.target.value)}
                    spellCheck={false}
                  />
                </div>
              ))}
            </div>
            {approveBlocked?.list?.length ? (
              <div className="ccmodal__error" style={{ textAlign: 'left' }}>
                <p style={{ margin: '0 0 4px' }}>Approval blocked:</p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {approveBlocked.list.slice(0, 6).map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>
            ) : null}
            {error && <p className="ccmodal__error">{error}</p>}
            <div className="ccmodal__actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              {/* Disabled by BACKEND build state (not just local flags) —
                  mid-flight builds can never receive a second submission,
                  even after reopen/refresh. A post-failure retry reuses
                  cached audio. */}
              <button
                type="button"
                className="btn btn-primary"
                disabled={approving || processing}
                onClick={approveAudio}
              >
                {processing
                  ? `Preparing Multilingual Audio…${buildState?.progress ? ` (${buildState.progress})` : ''}`
                  : approving
                    ? (status || 'Generating audio…')
                    : buildState?.status === 'failed' && approveBlocked === null
                      ? 'Retry Missing Audio'
                      : approveBlocked?.uncertain
                        ? 'Confirm flagged alignments and Generate Audio'
                        : `Approve Scripts and Generate Audio (${audioLangs.join(', ').toUpperCase()})`}
              </button>
            </div>
          </div>
        ) : (<>
        {/* Course: pick existing or create new */}
        <div className="ccmodal__label">
          Course
          {courses.length > 0 ? (
            <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              <option value='' disabled>Select a course…</option>
              {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value='new'>＋ Create new course…</option>
            </select>
          ) : null}
          {creatingNew && (
            <input
              style={{ marginTop: courses.length ? 8 : 0 }}
              autoFocus
              maxLength={80}
              value={newCourseName}
              onChange={(e) => setNewCourseName(e.target.value)}
              placeholder='Course name'
            />
          )}
          {courseId === 'new' && (
            <button type='button' onClick={() => { setCourseId(''); setNewCourseName(''); }}
              style={{ marginTop: 6, background: 'none', border: 'none', color: '#67e8f9', fontSize: 12, cursor: 'pointer', padding: 0 }}>
              ← pick an existing course instead
            </button>
          )}
        </div>

        {/* Lecture plan — free number entry; clamped on blur/submit so the
            field can be cleared and retyped without jumping. */}
        <div className="ccmodal__label">
          Number of lectures
          <input
            type='number' min={1} max={50} step={1}
            value={lectureCount}
            onChange={(e) => setLectureCount(e.target.value)}
            onBlur={() => {
              const n = Number.parseInt(lectureCount, 10);
              setLectureCount(Number.isInteger(n) && n >= 1 ? Math.min(n, 50) : 1);
            }}
          />
          <p style={{ margin: '4px 0 0', fontSize: 11, color: '#64748b' }}>
            Type any number. The course material is organised into that many lectures.
          </p>
        </div>

        {/* Drag & drop PDF materials */}
        <div className="ccmodal__label" style={{ marginBottom: 0 }}>
          {creatingNew ? 'Upload source PDFs' : 'Course materials'}
          {' '}
          <span style={{ color: '#94a3b8', fontWeight: 400 }}>
            (each PDF becomes one lecture)
          </span>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
            onClick={() => document.getElementById('ccmodal-files')?.click()}
            style={{
              marginTop: 8, border: `2px dashed ${dragging ? '#22d3ee' : '#334155'}`,
              borderRadius: 12, padding: '22px 14px', textAlign: 'center', cursor: 'pointer',
              background: dragging ? 'rgba(34,211,238,.06)' : 'rgba(255,255,255,.02)',
              transition: 'all .15s',
            }}
          >
            <Upload size={20} style={{ color: dragging ? '#22d3ee' : '#64748b', marginBottom: 6 }} />
            <p style={{ margin: 0, fontSize: 13, color: '#cbd5e1' }}>
              Drag &amp; drop PDFs here, or <span style={{ color: '#67e8f9' }}>browse</span>
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#64748b' }}>
              {creatingNew
                ? `Each PDF becomes one lecture — you'll confirm the order next.`
                : `Materials for this course's lectures.`}
            </p>
            <input id='ccmodal-files' type='file' accept='application/pdf,.pdf' multiple hidden
              onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </div>
          {files.length > 0 && (
            <ul style={{ marginTop: 8, padding: 0, listStyle: 'none' }}>
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} style={{
                  display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
                  color: '#cbd5e1', padding: '4px 0',
                }}>
                  <FileText size={13} style={{ flexShrink: 0, color: '#f87171' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ccmodal__toggle">
          <div>
            <span className="ccmodal__toggle-label">Public classroom</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isPublic}
            className={`ccmodal__switch ${isPublic ? 'ccmodal__switch--on' : ''}`}
            onClick={() => setIsPublic((v) => !v)}
          >
            <span className="ccmodal__switch-knob" />
          </button>
        </div>

        {error && <p className="ccmodal__error">{error}</p>}

        <div className="ccmodal__actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {canRetryIngest && (
            <button type="button" className="btn btn-ghost" onClick={retryIngest} disabled={submitting}>
              Retry document extraction
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={!valid || submitting}>
            {submitting ? (status || 'Creating…') : 'Create Classroom'}
          </button>
        </div>
        </>)}
      </form>
    </div>
  );
}
