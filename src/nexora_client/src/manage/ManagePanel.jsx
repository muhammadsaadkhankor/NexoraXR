import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { API_URL, CLASSROOM_LANGUAGE_CODES } from '../shared/config';
import { getMe } from '../shared/auth';

const LANGS = CLASSROOM_LANGUAGE_CODES;
// Per-language readiness → chip styling. 'preparing' overlays whatever the
// disk state is while a translation/audio build runs.
const LANG_STYLE = {
  ready: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40',
  preparing: 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/40 animate-pulse',
  partial: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/40',
  translated: 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/40',
  missing: 'bg-slate-500/10 text-slate-400 ring-1 ring-slate-600/40',
};
const LANG_LABEL = {
  ready: 'audio ready', preparing: 'preparing', partial: 'audio incomplete',
  translated: 'text ready, audio missing', missing: 'not prepared',
};

// Shared management panel — INSTRUCTOR manages their own classrooms and
// course lectures; SUPER_ADMIN manages everyone's (the API enforces it).
export default function ManagePanel() {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [courses, setCourses] = useState([]);
  const [lectures, setLectures] = useState({});    // courseId -> list
  const [langStatus, setLangStatus] = useState({}); // courseId -> /lang-status
  const [preparing, setPreparing] = useState({});   // courseId -> true while baking
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState(null);
  const [reviewing, setReviewing] = useState(null); // {lectureId, title, text,...}
  const [draftText, setDraftText] = useState('');
  const [busy, setBusy] = useState(null);           // action label while a request runs
  const pollTimers = useRef({});
  const isAdmin = me?.role === 'SUPER_ADMIN';

  const authFetch = (path, opts = {}) =>
    fetch(`${API_URL}${path}`, { credentials: 'include', ...opts }).then((r) => r.json());

  const loadLectures = async (cid) => {
    const d = await authFetch(`/api/courses/${cid}/status`).catch(() => ({}));
    setLectures((m) => ({ ...m, [cid]: d.lectures || [] }));
  };
  const loadLangStatus = async (cid) => {
    const d = await authFetch(`/api/courses/${cid}/lang-status`).catch(() => ({}));
    setLangStatus((m) => ({ ...m, [cid]: d }));
    return d;
  };

  const review = async (cid, lectureId) => {
    const d = await authFetch(`/api/courses/${cid}/lectures/${lectureId}/script`);
    if (d.error) { setError(d.error); return; }
    setReviewing({ ...d, courseId: cid, lectureId });
    setDraftText(d.text || '');
  };

  const approve = async (cid, lectureId) => {
    const r = await authFetch(`/api/courses/${cid}/lectures/${lectureId}/approve`, { method: 'POST' });
    if (r.ok) {
      setLectures((m) => ({ ...m, [cid]: (m[cid] || []).map((l) => l.lectureId === lectureId ? { ...l, status: 'ready' } : l) }));
      setReviewing(null);
    } else setError(r.error || 'Approve failed');
  };

  // Kick off multilingual audio prep for a course, then poll lang-status
  // until the build leaves the translation/audio stages. prepare-audio is
  // resumable — already-baked segments and current translations are skipped.
  const prepareAudio = async (cid) => {
    setBusy(`prepare:${cid}`);
    setError(null);
    const r = await authFetch(`/api/courses/${cid}/prepare-audio`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ langs: LANGS }),
    });
    setBusy(null);
    if (!r.ok) { setError(r.error || 'Audio preparation failed to start'); return false; }
    setPreparing((p) => ({ ...p, [cid]: true }));
    clearTimeout(pollTimers.current[cid]);
    const tick = async () => {
      const d = await loadLangStatus(cid);
      await loadLectures(cid);
      if (d.preparing || ['translating', 'audio', 'validating'].includes(d.status)) {
        pollTimers.current[cid] = setTimeout(tick, 3000);
        return;
      }
      setPreparing((p) => ({ ...p, [cid]: false }));
      // Surface a failed bake as a visible error — artifacts are kept.
      if (d.status === 'failed') setError('Audio preparation failed — check the server log, then use "Prepare Missing Audio" to retry.');
    };
    pollTimers.current[cid] = setTimeout(tick, 3000);
    return true;
  };

  // Review modal: save the (possibly edited) canonical script, then prepare
  // all six languages. Unchanged text keeps its fingerprint — no audio is
  // invalidated; changed segments invalidate only their own wavs.
  const saveAndPrepare = async () => {
    if (!reviewing) return;
    const cid = reviewing.courseId;
    setBusy('save');
    setError(null);
    if (draftText !== reviewing.text) {
      const r = await authFetch(`/api/courses/${cid}/drafts`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lectures: [{ lectureId: reviewing.lectureId, fullText: draftText }] }),
      });
      if (!r.ok) { setBusy(null); setError(r.error || 'Failed to save script'); return; }
    }
    setBusy(null);
    setReviewing(null);
    await prepareAudio(cid);
  };

  useEffect(() => () => {
    for (const t of Object.values(pollTimers.current)) clearTimeout(t);
  }, []);

  useEffect(() => {
    getMe().then((r) => {
      const u = r.ok ? r.data.user : null;
      setMe(u);
      if (!u || (u.role !== 'INSTRUCTOR' && u.role !== 'SUPER_ADMIN')) { navigate('/'); return; }
      refresh();
    }).catch(() => navigate('/'));
  }, []);

  const refresh = async () => {
    const [r, c] = await Promise.all([
      authFetch('/api/rooms/mine').catch(() => ({ rooms: [] })),
      authFetch('/api/courses').catch(() => ({ courses: [] })),
    ]);
    setRooms(r.rooms || []);
    setCourses(c.courses || []);
  };

  const deleteRoom = async (roomId) => {
    if (!window.confirm('Delete this classroom? Students will lose access.')) return;
    const res = await authFetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
    if (res.ok !== false && res.ok) setRooms((rs) => rs.filter((x) => x.roomId !== roomId));
    else setError(res.error || 'Delete failed');
  };

  const toggleCourse = async (cid) => {
    if (expanded === cid) { setExpanded(null); return; }
    setExpanded(cid);
    if (!lectures[cid]) await loadLectures(cid);
    await loadLangStatus(cid);
  };

  const deleteCourse = async (c) => {
    if (!window.confirm(`Delete the course "${c.name}"? All its lectures, documents and generated files are removed.`)) return;
    const r = await authFetch(`/api/courses/${c.id}`, { method: 'DELETE' });
    if (r.ok) {
      setCourses((cs) => cs.filter((x) => x.id !== c.id));
      setLectures((m) => { const { [c.id]: _gone, ...rest } = m; return rest; });
    } else setError(r.error || 'Delete failed');
  };

  const deleteLecture = async (cid, lectureId) => {
    if (!window.confirm('Delete this lecture? Its script, slides and audio are removed.')) return;
    const res = await authFetch(`/api/courses/${cid}/lectures/${lectureId}`, { method: 'DELETE' });
    if (res.ok) setLectures((m) => ({ ...m, [cid]: (m[cid] || []).filter((l) => l.lecture_id !== lectureId) }));
    else setError(res.error || 'Delete failed');
  };

  const langChips = (cid, lectureId) => {
    const entry = (langStatus[cid]?.lectures || []).find((x) => x.lectureId === lectureId);
    if (!entry) return null;
    const running = langStatus[cid]?.preparing;
    return (
      <span style={{ display: 'inline-flex', gap: 4, marginLeft: 8 }}>
        {LANGS.map((l) => {
          const st = running && entry.langs[l] !== 'ready' ? 'preparing' : entry.langs[l];
          return (
            <span key={l} title={`${l.toUpperCase()}: ${LANG_LABEL[st] || st}`}
              className={LANG_STYLE[st] || LANG_STYLE.missing}
              style={{ padding: '1px 6px', borderRadius: 8, fontSize: 10, fontWeight: 700 }}>
              {l.toUpperCase()}
            </span>
          );
        })}
      </span>
    );
  };

  return (
    <div style={{ minHeight: '100vh', background: '#07050f', color: '#e5e9f0', padding: '48px 20px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <button onClick={() => navigate('/')}
          style={{ background: 'none', border: '1px solid rgba(255,255,255,.15)', borderRadius: 20,
            color: '#94a3b8', padding: '6px 14px', cursor: 'pointer', marginBottom: 28, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <ArrowLeft size={14} /> Home
        </button>
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: '0 0 6px' }}>
          {isAdmin ? 'Super Admin Panel' : 'Instructor Panel'}
        </h1>
        <p style={{ color: '#94a3b8', marginBottom: 32 }}>
          {isAdmin ? 'Manage every classroom and course lecture in the system.'
            : 'Manage your classrooms and course lectures.'}
        </p>

        {error && <div style={{ background: '#3f1d1d', border: '1px solid #7f1d1d', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>{error}</div>}

        <h2 style={{ fontSize: 13, letterSpacing: '.15em', color: '#22d3ee', marginBottom: 14 }}>CLASSROOMS</h2>
        {!rooms.length && <p style={{ color: '#64748b' }}>No classrooms.</p>}
        {rooms.map((r) => (
          <div key={r.roomId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 12,
            padding: '12px 16px', marginBottom: 8 }}>
            <div>
              <b>{r.className}</b>{' '}
              <span style={{ color: '#94a3b8', fontSize: 13 }}>
                {r.courseName || 'No course'} · {r.roomType}{isAdmin ? ` · host ${String(r.hostId).slice(0, 8)}` : ''}
              </span>
            </div>
            <button onClick={() => deleteRoom(r.roomId)}
              style={{ background: '#7f1d1d', border: 'none', color: '#fecaca', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', display: 'flex', gap: 5, alignItems: 'center' }}>
              <Trash2 size={14} /> Delete
            </button>
          </div>
        ))}

        <h2 style={{ fontSize: 13, letterSpacing: '.15em', color: '#22d3ee', margin: '32px 0 14px' }}>COURSES &amp; LECTURES</h2>
        {!courses.length && <p style={{ color: '#64748b' }}>No courses.</p>}
        {courses.map((c) => (
          <div key={c.id} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => toggleCourse(c.id)}
                style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 12,
                  padding: '12px 16px', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                <span><b>{c.name}</b> <span style={{ color: '#94a3b8', fontSize: 13 }}>{c.scene}</span></span>
                {expanded === c.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              <button onClick={() => deleteCourse(c)}
                style={{ background: '#7f1d1d', border: 'none', color: '#fecaca', borderRadius: 8,
                  padding: '8px 10px', cursor: 'pointer', fontSize: 12 }}>
                Delete
              </button>
            </div>
            {expanded === c.id && (
              <div style={{ padding: '8px 0 8px 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: '#64748b' }}>
                    {preparing[c.id] ? 'Preparing translations & audio…' : 'Language audio readiness'}
                  </span>
                  <button onClick={() => prepareAudio(c.id)} disabled={!!preparing[c.id] || busy === `prepare:${c.id}`}
                    style={{ background: '#164e63', border: 'none', color: '#a5f3fc', borderRadius: 6,
                      padding: '4px 10px', cursor: 'pointer', fontSize: 12, opacity: preparing[c.id] ? .5 : 1 }}>
                    {busy === `prepare:${c.id}` ? 'Starting…' : 'Prepare Missing Audio (all 6)'}
                  </button>
                </div>
                {(lectures[c.id] || []).length === 0 && <p style={{ color: '#64748b' }}>No lectures yet.</p>}
                {(lectures[c.id] || []).map((l) => (
                  <div key={l.lectureId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                    <span style={{ fontSize: 14 }}>{l.title}
                      {' '}<span style={{ fontSize: 10, letterSpacing: '.08em', padding: '2px 7px', borderRadius: 10,
                        background: l.status === 'ready' ? 'rgba(52,211,153,.12)' : 'rgba(251,191,36,.12)',
                        color: l.status === 'ready' ? '#34d399' : '#fbbf24' }}>{l.status?.toUpperCase()}</span>
                      {langChips(c.id, l.lectureId)}
                    </span>
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <button onClick={() => review(c.id, l.lectureId)}
                        style={{ background: 'none', border: 'none', color: '#22d3ee', cursor: 'pointer', fontSize: 12 }}>
                        Review Script &amp; Prepare Audio
                      </button>
                      {l.status === 'draft' && (
                        <button onClick={() => approve(c.id, l.lectureId)}
                          style={{ background: '#065f46', border: 'none', color: '#a7f3d0', borderRadius: 6,
                            padding: '3px 10px', cursor: 'pointer', fontSize: 12 }}>
                          Approve
                        </button>
                      )}
                      <button onClick={() => deleteLecture(c.id, l.lectureId)}
                        style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center' }}>
                        <Trash2 size={13} /> Delete
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Script review modal — full narration, editable, then prepare all
          languages. Unchanged text keeps fingerprints → nothing is re-baked. */}
      {reviewing && (
        <div onClick={() => setReviewing(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(92vw, 720px)', maxHeight: '82vh', overflow: 'auto', background: '#0b1020',
              border: '1px solid rgba(255,255,255,.12)', borderRadius: 16, padding: 24 }}>
            <h3 style={{ margin: 0 }}>{reviewing.title}</h3>
            <p style={{ color: '#94a3b8', fontSize: 12, marginTop: 4 }}>
              {reviewing.wordCount} words
              {reviewing.artifacts?.duration_s ? ` · ~${Math.round(reviewing.artifacts.duration_s / 60)} min audio` : ''}
              {' '}· status {reviewing.status} · edit then approve — unchanged text keeps its cached audio
            </p>
            <textarea value={draftText} onChange={(e) => setDraftText(e.target.value)}
              spellCheck={false}
              style={{ width: '100%', minHeight: '50vh', marginTop: 12, fontSize: 14, lineHeight: 1.7,
                color: '#cbd5e1', background: '#0f172a', border: '1px solid rgba(255,255,255,.12)',
                borderRadius: 10, padding: 12, boxSizing: 'border-box', whiteSpace: 'pre-wrap' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button onClick={() => setReviewing(null)}
                style={{ background: 'none', border: '1px solid rgba(255,255,255,.2)', borderRadius: 8,
                  color: '#cbd5e1', padding: '8px 16px', cursor: 'pointer' }}>
                Close
              </button>
              {reviewing.status === 'draft' && (
                <button onClick={() => approve(reviewing.courseId, reviewing.lectureId)}
                  style={{ background: '#065f46', border: 'none', color: '#a7f3d0', borderRadius: 8,
                    padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
                  Approve lecture
                </button>
              )}
              <button onClick={saveAndPrepare} disabled={busy === 'save'}
                style={{ background: '#164e63', border: 'none', color: '#a5f3fc', borderRadius: 8,
                  padding: '8px 16px', cursor: 'pointer', fontWeight: 600, opacity: busy === 'save' ? .5 : 1 }}>
                {busy === 'save' ? 'Saving…' : 'Approve & Prepare Audio (all 6 languages)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
