import { useEffect, useState } from 'react'
import { Menu, X } from 'lucide-react'

// Same key the classroom reads — signing in pre-fills the Enter Classroom name.
const DISPLAY_NAME_KEY = 'nexoraxr_display_name'

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const [signIn, setSignIn] = useState(false)
  const [name, setName] = useState(() => sessionStorage.getItem(DISPLAY_NAME_KEY) || '')

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const submit = (e) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    sessionStorage.setItem(DISPLAY_NAME_KEY, n)
    setSignIn(false)
  }

  return (
    <>
      <header className={`navbar ${scrolled ? 'navbar--scrolled' : ''}`}>
        <div className="container navbar__inner">
          <a href="#home" className="navbar__brand">
            <span className="navbar__seal">W</span>
            <span className="navbar__wordmark">WuFlux</span>
          </a>
          <nav className={`navbar__nav ${open ? 'navbar__nav--open' : ''}`}>
            <a href="#home" onClick={() => setOpen(false)}>Home</a>
            <a href="#philosophy" onClick={() => setOpen(false)}>About us</a>
            <a href="#contact" onClick={() => setOpen(false)}>Contact</a>
          </nav>
          <div className="navbar__actions">
            <a href="#explore" className="btn btn-secondary btn-sm">Enter a class</a>
            <button className="btn btn-primary btn-sm" onClick={() => setSignIn(true)}>
              Sign in
            </button>
            <button
              className="navbar__toggle"
              onClick={() => setOpen((v) => !v)}
              aria-label="Toggle menu"
            >
              {open ? <X size={24} /> : <Menu size={24} />}
            </button>
          </div>
        </div>
      </header>

      {signIn && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(4,6,20,.72)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setSignIn(false)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={submit}
            style={{
              width: 'min(92vw, 380px)', borderRadius: 20, padding: 28,
              background: 'rgba(13,16,32,.92)', border: '1px solid rgba(255,255,255,.1)',
              boxShadow: '0 30px 80px -20px rgba(0,0,0,.7)',
            }}
          >
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#fff' }}>Sign in</h2>
            <p style={{ margin: '8px 0 20px', fontSize: 13, color: '#94a3b8' }}>
              Your name is used as your classroom identity.
            </p>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 12, fontSize: 14,
                background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.12)',
                color: '#fff', outline: 'none', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button type="button" className="btn btn-secondary btn-sm" style={{ flex: 1 }} onClick={() => setSignIn(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary btn-sm" style={{ flex: 1 }}>
                Continue
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
