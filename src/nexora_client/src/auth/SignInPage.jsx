import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login, requestLink } from '../shared/auth';

// Sign-in page: returning users log in with email+password; first-time users
// register (name + email + password) and confirm via the one-time link.
// Guests can always go back — no forced registration.
export default function SignInPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'sent'
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const input = {
    width: '100%', padding: '12px 14px', borderRadius: 10, fontSize: 14,
    background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.12)',
    color: '#fff', outline: 'none', boxSizing: 'border-box',
  };
  const label = { display: 'block', fontSize: 12, color: '#94a3b8', margin: '14px 0 6px' };

  const doLogin = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const r = await login(email.trim(), password);
    setBusy(false);
    if (!r.ok) { setError(r.data.error || 'Sign-in failed'); return; }
    navigate('/', { replace: true });
  };

  const doRegister = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (password !== confirm) { setError('Passwords do not match'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setBusy(true); setError(null);
    const r = await requestLink(email.trim(), firstName.trim(), lastName.trim(), password);
    setBusy(false);
    if (!r.ok) { setError(r.data.error || 'Could not create the account'); return; }
    setMode('sent');
  };

  return (
    <div className='min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6'>
      <div className='relative w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/70 p-8 shadow-2xl'>
        <button
          onClick={() => navigate('/')}
          aria-label='Close'
          className='absolute right-4 top-4 rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200'
        >
          ✕
        </button>
        <h1 className='text-xl font-bold'>
          {mode === 'register' ? 'Create your account' : mode === 'sent' ? 'Check your link' : 'Sign in'}
        </h1>

        {mode === 'login' && (
          <form onSubmit={doLogin}>
            <label style={label}>Email</label>
            <input style={input} type='email' required autoFocus value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder='you@example.com' />
            <label style={label}>Password</label>
            <input style={input} type='password' required value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder='Your password' />
            {error && <p className='mt-3 text-xs text-rose-300'>{error}</p>}
            <button disabled={busy}
              className='mt-6 w-full rounded-lg bg-violet-600 py-2.5 text-sm font-semibold hover:bg-violet-500 disabled:opacity-50'>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className='mt-4 text-center text-xs text-slate-400'>
              New here?{' '}
              <button type='button' className='text-cyan-300 hover:underline'
                onClick={() => { setMode('register'); setError(null); }}>
                Create an account
              </button>
            </p>
          </form>
        )}

        {mode === 'register' && (
          <form onSubmit={doRegister}>
            <div className='flex gap-3'>
              <div className='flex-1'>
                <label style={label}>First name</label>
                <input style={input} required autoFocus value={firstName}
                  onChange={(e) => setFirstName(e.target.value)} placeholder='First name' />
              </div>
              <div className='flex-1'>
                <label style={label}>Last name</label>
                <input style={input} required value={lastName}
                  onChange={(e) => setLastName(e.target.value)} placeholder='Last name' />
              </div>
            </div>
            <label style={label}>Email</label>
            <input style={input} type='email' required value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder='you@example.com' />
            <label style={label}>Password</label>
            <input style={input} type='password' required minLength={8} value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder='At least 8 characters' />
            <label style={label}>Confirm password</label>
            <input style={input} type='password' required value={confirm}
              onChange={(e) => setConfirm(e.target.value)} placeholder='Repeat your password' />
            {error && <p className='mt-3 text-xs text-rose-300'>{error}</p>}
            <button disabled={busy}
              className='mt-6 w-full rounded-lg bg-violet-600 py-2.5 text-sm font-semibold hover:bg-violet-500 disabled:opacity-50'>
              {busy ? 'Sending link…' : 'Create account'}
            </button>
            <p className='mt-3 text-center text-[11px] text-slate-500'>
              You'll receive a one-time confirmation link (printed to the backend terminal in dev).
            </p>
            <p className='mt-3 text-center text-xs text-slate-400'>
              Already registered?{' '}
              <button type='button' className='text-cyan-300 hover:underline'
                onClick={() => { setMode('login'); setError(null); }}>
                Sign in
              </button>
            </p>
          </form>
        )}

        {mode === 'sent' && (
          <div className='mt-2'>
            <p className='text-sm leading-relaxed text-emerald-300'>
              A confirmation link was generated for <strong>{email}</strong>.
              In development it's printed to the backend terminal — open it to
              finish creating your account.
            </p>
            <button onClick={() => setMode('register')}
              className='mt-6 w-full rounded-lg border border-slate-600 py-2.5 text-sm hover:bg-slate-800'>
              ← Back — change my details
            </button>
          </div>
        )}

        <div className='mt-6 border-t border-slate-800 pt-4 text-center'>
          <Link to='/' className='text-xs text-slate-400 hover:text-slate-200'>
            ← Continue as guest — no account needed
          </Link>
        </div>
      </div>
    </div>
  );
}
