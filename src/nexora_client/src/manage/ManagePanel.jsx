import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { API_URL } from '../shared/config';
import { getMe } from '../shared/auth';

// Shared management panel — INSTRUCTOR manages their own classrooms and
// course lectures; SUPER_ADMIN manages everyone's (the API enforces it).
export default function ManagePanel() {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [courses, setCourses] = useState([]);
  const [lectures, setLectures] = useState({}); // courseId -> list
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState(null);
  const [reviewing, setReviewing] = useState(null); // {lectureId, title, text,...}
  const isAdmin = me?.role === 'SUPER_ADMIN';

  const review = async (cid, lectureId) => {
    const d = await authFetch(`/api/courses/${cid}/lectures/${lectureId}/script`);
    if (d.error) { setError(d.error); return; }
    setReviewing({ ...d, courseId: cid, lectureId });
  };

  const approve = async (cid, lectureId) => {
    const r = await authFetch(`/api/courses/${cid}/lectures/${lectureId}/approve`, { method: 'POST' });
    if (r.ok) {
      setLectures((m) => ({ ...m, [cid]: (m[cid] || []).map((l) => l.lectureId === lectureId ? { ...l, status: 'ready' } : l) }));
      setReviewing(null);
    } else setError(r.error || 'Approve failed');
  };

  const authFetch = (path, opts = {}) =>
    fetch(`${API_URL}${path}`, { credentials: 'include', ...opts }).then((r) => r.json());

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
    if (!lectures[cid]) {
      // /status is owner-scoped and includes draft lectures.
      const d = await authFetch(`/api/courses/${cid}/status`).catch(() => ({}));
      setLectures((m) => ({ ...m, [cid]: d.lectures || [] }));
    }
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
                {(lectures[c.id] || []).length === 0 && <p style={{ color: '#64748b' }}>No lectures yet.</p>}
                {(lectures[c.id] || []).map((l) => (
                  <div key={l.lectureId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                    <span style={{ fontSize: 14 }}>{l.title}
                      {' '}<span style={{ fontSize: 10, letterSpacing: '.08em', padding: '2px 7px', borderRadius: 10,
                        background: l.status === 'ready' ? 'rgba(52,211,153,.12)' : 'rgba(251,191,36,.12)',
                        color: l.status === 'ready' ? '#34d399' : '#fbbf24' }}>{l.status?.toUpperCase()}</span>
                    </span>
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <button onClick={() => review(c.id, l.lectureId)}
                        style={{ background: 'none', border: 'none', color: '#22d3ee', cursor: 'pointer', fontSize: 12 }}>
                        Review script
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

      {/* Script review modal */}
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
              {' '}· status {reviewing.status}
            </p>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.7, color: '#cbd5e1',
              borderTop: '1px solid rgba(255,255,255,.08)', marginTop: 12, paddingTop: 12 }}>
              {reviewing.text}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
