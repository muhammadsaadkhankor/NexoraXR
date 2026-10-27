import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getMe, claimAdmin, listUsers, updateUser, deleteUser } from '../shared/auth';
import { getBranding, saveBranding, applyBranding } from '../shared/branding';
import { API_URL } from '../shared/config';

const fileToDataUrl = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(file);
});

const ROLES = ['STUDENT', 'INSTRUCTOR', 'SUPER_ADMIN'];
const ROLE_STYLE = {
  SUPER_ADMIN: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  INSTRUCTOR: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  STUDENT: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
};

const fmt = (d) => (d ? new Date(d).toLocaleString() : '—');

export default function AdminPage() {
  const [me, setMe] = useState(undefined);
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState(null);
  const [token, setToken] = useState('');
  const [claimErr, setClaimErr] = useState(null);
  const [query, setQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null); // user being deleted
  const [busy, setBusy] = useState(false);
  const [branding, setBranding] = useState({ appName: '', logoUrl: null, faviconUrl: null });
  const [brandName, setBrandName] = useState('');
  const [brandLogo, setBrandLogo] = useState(undefined); // dataUrl | null | undefined (unchanged)
  const [brandFav, setBrandFav] = useState(undefined);
  const [brandMsg, setBrandMsg] = useState(null);
  const [brandBusy, setBrandBusy] = useState(false);
  const [rooms, setRooms] = useState([]);
  const [courses, setCourses] = useState([]);
  const [courseLectures, setCourseLectures] = useState({});
  const [expandedCourse, setExpandedCourse] = useState(null);

  const authJson = (p, opts = {}) =>
    fetch(`${API_URL}${p}`, { credentials: 'include', ...opts }).then((r) => r.json());

  const refreshRoomsCourses = async () => {
    const [rm, cs] = await Promise.all([
      authJson('/api/rooms/mine').catch(() => ({ rooms: [] })),
      authJson('/api/courses').catch(() => ({ courses: [] })),
    ]);
    setRooms(rm.rooms || []);
    setCourses(cs.courses || []);
  };

  const deleteRoom = async (roomId) => {
    if (!window.confirm('Delete this classroom? Students will lose access.')) return;
    const r = await authJson(`/api/rooms/${roomId}`, { method: 'DELETE' });
    if (r.ok) setRooms((rs) => rs.filter((x) => x.roomId !== roomId));
    else setErr(r.error || 'Delete failed');
  };

  const toggleCourseLectures = async (cid) => {
    if (expandedCourse === cid) { setExpandedCourse(null); return; }
    setExpandedCourse(cid);
    if (!courseLectures[cid]) {
      const d = await authJson(`/api/courses/${cid}/status`).catch(() => ({}));
      setCourseLectures((m) => ({ ...m, [cid]: d.lectures || [] }));
    }
  };

  const deleteLecture = async (cid, lectureId) => {
    if (!window.confirm('Delete this lecture? Script, slides and audio are removed.')) return;
    const r = await authJson(`/api/courses/${cid}/lectures/${lectureId}`, { method: 'DELETE' });
    if (r.ok) setCourseLectures((m) => ({ ...m, [cid]: (m[cid] || []).filter((l) => l.lectureId !== lectureId) }));
    else setErr(r.error || 'Delete failed');
  };

  const deleteCourse = async (c) => {
    if (!window.confirm(`Delete the course "${c.name}"? All its lectures, documents and generated files are removed.`)) return;
    const r = await authJson(`/api/courses/${c.id}`, { method: 'DELETE' });
    if (r.ok) {
      setCourses((cs) => cs.filter((x) => x.id !== c.id));
      setCourseLectures((m) => { const { [c.id]: _gone, ...rest } = m; return rest; });
    } else setErr(r.error || 'Delete failed');
  };

  const approveLecture = async (cid, lectureId) => {
    const r = await authJson(`/api/courses/${cid}/lectures/${lectureId}/approve`, { method: 'POST' });
    if (r.ok) setCourseLectures((m) => ({ ...m, [cid]: (m[cid] || []).map((l) => l.lectureId === lectureId ? { ...l, status: 'ready' } : l) }));
    else setErr(r.error || 'Approve failed');
  };

  const refresh = async () => {
    const r = await listUsers();
    if (!r.ok) { setErr(r.data.error || 'Failed to load users'); return; }
    setUsers(r.data.users);
  };

  useEffect(() => {
    getMe().then(async (r) => {
      setMe(r.ok ? r.data.user : null);
      if (r.ok && r.data.user?.role === 'SUPER_ADMIN') {
        refresh();
        refreshRoomsCourses();
        getBranding().then((b) => { setBranding(b); setBrandName(b.appName); });
      }
    });
  }, []);

  const saveBrand = async () => {
    setBrandBusy(true); setBrandMsg(null);
    const patch = {};
    if (brandName.trim() !== branding.appName) patch.appName = brandName.trim();
    if (brandLogo !== undefined) patch.logo = brandLogo;
    if (brandFav !== undefined) patch.favicon = brandFav;
    const r = await saveBranding(patch);
    setBrandBusy(false);
    if (!r.ok) { setBrandMsg(r.data.error || 'Save failed'); return; }
    setBranding(r.data.branding);
    setBrandLogo(undefined); setBrandFav(undefined);
    applyBranding(r.data.branding); // update title + favicon live
    setBrandMsg('Branding saved.');
  };

  const submitClaim = async (e) => {
    e.preventDefault();
    setClaimErr(null);
    const r = await claimAdmin(token.trim());
    if (!r.ok) { setClaimErr(r.data.error || 'Claim failed'); return; }
    const m = await getMe();
    setMe(m.ok ? m.data.user : null);
    refresh();
    getBranding().then((b) => { setBranding(b); setBrandName(b.appName); });
  };

  const setRole = async (u, role) => {
    const r = await updateUser(u.id, { role });
    if (r.ok) refresh(); else setErr(r.data.error);
  };
  const toggleActive = async (u) => {
    const r = await updateUser(u.id, { isActive: !u.is_active });
    if (r.ok) refresh(); else setErr(r.data.error);
  };
  const doDelete = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    const r = await deleteUser(confirmDelete.id);
    setBusy(false);
    if (r.ok) { setConfirmDelete(null); refresh(); }
    else setErr(r.data.error || 'Delete failed');
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q));
  }, [users, query]);

  const stats = useMemo(() => ({
    total: users.length,
    active: users.filter((u) => u.is_active).length,
    admins: users.filter((u) => u.role === 'SUPER_ADMIN').length,
    sessions: users.reduce((n, u) => n + (u.active_sessions || 0), 0),
  }), [users]);

  const shell = (children) => (
    <div className='min-h-screen bg-slate-950 text-slate-100'>
      <div className='border-b border-slate-800 bg-slate-900/60'>
        <div className='mx-auto flex max-w-6xl items-center justify-between px-6 py-4'>
          <div>
            <h1 className='text-lg font-bold'>Administration</h1>
            <p className='text-xs text-slate-400'>User & access management</p>
          </div>
          <Link to='/' className='rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800'>
            ← Back to home
          </Link>
        </div>
      </div>
      <div className='mx-auto max-w-6xl px-6 py-6'>{children}</div>
    </div>
  );

  if (me === undefined) return shell(<p className='text-slate-400'>Loading…</p>);

  if (!me) return shell(
    <div className='mx-auto mt-16 max-w-md rounded-2xl border border-slate-700/60 bg-slate-900/60 p-8 text-center'>
      <p className='text-sm text-slate-300'>Sign in first (Sign in button on the home page), then return here.</p>
    </div>
  );

  if (me.role !== 'SUPER_ADMIN') return shell(
    <div className='mx-auto mt-16 max-w-md rounded-2xl border border-slate-700/60 bg-slate-900/60 p-8'>
      <p className='text-sm text-slate-300'>
        Signed in as <strong>{me.email}</strong> ({me.role}). This area requires SUPER_ADMIN.
      </p>
      <form onSubmit={submitClaim} className='mt-5'>
        <label className='text-xs font-medium text-slate-400'>Admin claim token</label>
        <input
          type='password' value={token} onChange={(e) => setToken(e.target.value)}
          placeholder='Provided by the server operator'
          className='mt-1.5 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2.5 text-sm outline-none focus:border-violet-500'
        />
        {claimErr && <p className='mt-2 text-xs text-rose-300'>{claimErr}</p>}
        <button className='mt-4 w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold hover:bg-violet-500'>
          Claim SUPER_ADMIN
        </button>
      </form>
    </div>
  );

  return shell(
    <>
      {/* Stats */}
      <div className='mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4'>
        {[
          ['Total users', stats.total],
          ['Active', stats.active],
          ['Super admins', stats.admins],
          ['Live sessions', stats.sessions],
        ].map(([label, v]) => (
          <div key={label} className='rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3'>
            <p className='text-2xl font-bold'>{v}</p>
            <p className='text-xs text-slate-400'>{label}</p>
          </div>
        ))}
      </div>

      {err && <p className='mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300'>{err}</p>}

      {/* Branding */}
      <div className='mb-6 rounded-2xl border border-slate-800 bg-slate-900/40 p-5'>
        <h2 className='text-sm font-bold text-slate-200'>Branding</h2>
        <p className='mb-4 text-xs text-slate-500'>App name, logo and favicon shown across NexoraXR.</p>
        <div className='grid gap-4 sm:grid-cols-3'>
          <div>
            <label className='text-xs text-slate-400'>App name</label>
            <input
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              maxLength={60}
              className='mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-violet-500'
            />
          </div>
          <div>
            <label className='text-xs text-slate-400'>Logo</label>
            <div className='mt-1 flex items-center gap-3'>
              <div className='flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-slate-700 bg-slate-800'>
                {(brandLogo !== undefined ? brandLogo : branding.logoUrl && `${API_URL}${branding.logoUrl}`)
                  ? <img src={brandLogo ?? `${API_URL}${branding.logoUrl}`} alt='logo' className='max-h-full max-w-full object-contain' />
                  : <span className='text-xs text-slate-500'>{(brandName || 'N')[0]}</span>}
              </div>
              <label className='cursor-pointer rounded-md border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800'>
                Upload
                <input type='file' accept='image/*' className='hidden'
                  onChange={async (e) => setBrandLogo(e.target.files?.[0] ? await fileToDataUrl(e.target.files[0]) : undefined)} />
              </label>
              {(branding.logoUrl || brandLogo) && (
                <button type='button' onClick={() => setBrandLogo(null)}
                  className='text-[11px] text-rose-300 hover:underline'>Remove</button>
              )}
            </div>
          </div>
          <div>
            <label className='text-xs text-slate-400'>Favicon</label>
            <div className='mt-1 flex items-center gap-3'>
              <div className='flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-slate-700 bg-slate-800'>
                {(brandFav !== undefined ? brandFav : branding.faviconUrl && `${API_URL}${branding.faviconUrl}`)
                  ? <img src={brandFav ?? `${API_URL}${branding.faviconUrl}`} alt='favicon' className='max-h-full max-w-full object-contain' />
                  : <span className='text-[9px] text-slate-500'>ico</span>}
              </div>
              <label className='cursor-pointer rounded-md border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800'>
                Upload
                <input type='file' accept='image/x-icon,image/png,image/svg+xml' className='hidden'
                  onChange={async (e) => setBrandFav(e.target.files?.[0] ? await fileToDataUrl(e.target.files[0]) : undefined)} />
              </label>
              {(branding.faviconUrl || brandFav) && (
                <button type='button' onClick={() => setBrandFav(null)}
                  className='text-[11px] text-rose-300 hover:underline'>Remove</button>
              )}
            </div>
          </div>
        </div>
        <div className='mt-4 flex items-center gap-3'>
          <button
            onClick={saveBrand}
            disabled={brandBusy}
            className='rounded-lg bg-violet-600 px-4 py-2 text-xs font-semibold hover:bg-violet-500 disabled:opacity-50'
          >
            {brandBusy ? 'Saving…' : 'Save branding'}
          </button>
          {brandMsg && <p className='text-xs text-slate-400'>{brandMsg}</p>}
        </div>
      </div>

      {/* Classrooms & lectures — SUPER_ADMIN sees every room and course */}
      <div className='mb-6 rounded-2xl border border-slate-800 bg-slate-900/40 p-5'>
        <h2 className='text-sm font-bold text-slate-200'>Classrooms</h2>
        <p className='mb-3 text-xs text-slate-500'>Every live classroom. Deleting ends it and revokes its link.</p>
        {!rooms.length && <p className='text-xs text-slate-600'>None.</p>}
        {rooms.map((r) => (
          <div key={r.roomId} className='mb-1.5 flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2.5'>
            <div className='text-sm'>
              <span className='font-medium'>{r.className}</span>
              <span className='ml-2 text-xs text-slate-500'>
                {r.courseName || '—'} · {r.roomType} · host {String(r.hostId).slice(0, 8)}
              </span>
            </div>
            <button onClick={() => deleteRoom(r.roomId)}
              className='rounded-md bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/25'>
              Delete
            </button>
          </div>
        ))}

        <h2 className='mt-6 text-sm font-bold text-slate-200'>Courses &amp; Lectures</h2>
        <p className='mb-3 text-xs text-slate-500'>Generated lectures per course. Deleting removes script, slides and audio.</p>
        {!courses.length && <p className='text-xs text-slate-600'>None.</p>}
        {courses.map((c) => (
          <div key={c.id} className='mb-1.5'>
            <div className='flex items-center gap-2'>
              <button onClick={() => toggleCourseLectures(c.id)}
                className='flex flex-1 items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2.5 text-left text-sm hover:bg-slate-800/60'>
                <span><span className='font-medium'>{c.name}</span>
                  <span className='ml-2 text-xs text-slate-500'>{c.scene}{c.owner ? ` · ${c.owner}` : ''}</span></span>
                <span className='text-xs text-slate-500'>{expandedCourse === c.id ? '▲' : '▼'}</span>
              </button>
              <button onClick={() => deleteCourse(c)}
                className='rounded-md bg-rose-500/10 px-2.5 py-2 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/25'>
                Delete course
              </button>
            </div>
            {expandedCourse === c.id && (
              <div className='ml-4 mt-1'>
                {(courseLectures[c.id] || []).length === 0 && <p className='px-2 py-1 text-xs text-slate-600'>No lectures.</p>}
                {(courseLectures[c.id] || []).map((l) => (
                  <div key={l.lectureId} className='flex items-center justify-between border-b border-slate-800/60 px-3 py-1.5 last:border-0'>
                    <span className='text-sm'>{l.title}
                      {l.status === 'draft' && <span className='ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300'>DRAFT</span>}
                    </span>
                    <span className='flex items-center gap-3'>
                      {l.status === 'draft' && (
                        <button onClick={() => approveLecture(c.id, l.lectureId)}
                          className='text-[11px] font-semibold text-emerald-300 hover:underline'>Approve</button>
                      )}
                      <button onClick={() => deleteLecture(c.id, l.lectureId)}
                        className='text-[11px] font-semibold text-rose-300 hover:underline'>
                        Delete
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className='mb-4 flex items-center gap-3'>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search by name or email…'
          className='w-72 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-cyan-500'
        />
        <button onClick={refresh} className='rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800'>
          Refresh
        </button>
      </div>

      {/* Table */}
      <div className='overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b border-slate-800 bg-slate-900/80 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500'>
              <th className='px-5 py-3.5'>User</th>
              <th className='px-5 py-3.5'>Role</th>
              <th className='px-5 py-3.5'>Status</th>
              <th className='px-5 py-3.5'>Sessions</th>
              <th className='px-5 py-3.5'>Last login</th>
              <th className='px-5 py-3.5 text-right'>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className='border-b border-slate-800/60 last:border-0 hover:bg-slate-900/70'>
                <td className='px-5 py-3.5'>
                  <div className='font-medium text-slate-100'>{u.displayName}</div>
                  <div className='text-xs text-slate-500'>{u.email}</div>
                </td>
                <td className='px-5 py-3.5'>
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${ROLE_STYLE[u.role]}`}>
                    {u.role}
                  </span>
                  {u.id !== me.id && (
                    <select
                      value={u.role}
                      onChange={(e) => setRole(u, e.target.value)}
                      className='ml-2 rounded-md border border-slate-700 bg-slate-800 px-1.5 py-1 text-[11px] text-slate-300 outline-none'
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  )}
                </td>
                <td className='px-5 py-3.5'>
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${u.is_active ? 'text-emerald-300' : 'text-slate-500'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${u.is_active ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                    {u.is_active ? 'active' : 'suspended'}
                  </span>
                </td>
                <td className='px-5 py-3.5 text-slate-400'>{u.active_sessions}</td>
                <td className='px-5 py-3.5 text-xs text-slate-400'>{fmt(u.last_login_at)}</td>
                <td className='px-5 py-3.5'>
                  {u.id !== me.id && (
                    <div className='flex justify-end gap-2'>
                      <button
                        onClick={() => toggleActive(u)}
                        className='rounded-md border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-800'
                      >
                        {u.is_active ? 'Suspend' : 'Restore'}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(u)}
                        className='rounded-md bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/25'
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className='px-5 py-10 text-center text-sm text-slate-500'>No users match “{query}”.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div
          className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm'
          onClick={() => !busy && setConfirmDelete(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className='w-[min(92vw,420px)] rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl'
          >
            <h2 className='text-base font-bold text-rose-300'>Delete user permanently</h2>
            <p className='mt-2 text-sm text-slate-300'>
              This removes <strong>{confirmDelete.displayName}</strong> ({confirmDelete.email}) and all of
              their sessions from the database. This cannot be undone.
            </p>
            <div className='mt-5 flex justify-end gap-3'>
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={busy}
                className='rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800'
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                disabled={busy}
                className='rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold hover:bg-rose-500 disabled:opacity-50'
              >
                {busy ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
