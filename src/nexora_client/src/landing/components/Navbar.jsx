import { useEffect, useState } from 'react'
import { Menu, X, LogOut, Settings2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getMe, logout } from '../../shared/auth'
import { DEFAULT_BRAND_MARK, getBranding } from '../../shared/branding'
import { API_URL } from '../../shared/config'

export default function Navbar() {
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const [me, setMe] = useState(null)
  const [branding, setBranding] = useState({ appName: 'WuFlux', logoUrl: null })

  useEffect(() => { getBranding().then(setBranding) }, [])

  const refreshMe = () => getMe().then((r) => setMe(r.ok ? r.data.user : null)).catch(() => setMe(null))
  useEffect(() => { refreshMe() }, [])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const doLogout = async () => { await logout().catch(() => {}); setMe(null) }

  return (
    <header className={`navbar ${scrolled ? 'navbar--scrolled' : ''}`}>
      <div className="container navbar__inner">
        <a href="#home" className="navbar__brand">
          <img src={branding.logoUrl ? `${API_URL}${branding.logoUrl}` : DEFAULT_BRAND_MARK} alt="" className="navbar__seal" width="38" height="38" />
          <span className="navbar__wordmark">{branding.appName}</span>
        </a>
        <nav className={`navbar__nav ${open ? 'navbar__nav--open' : ''}`}>
          <a href="#home" onClick={() => setOpen(false)}>Home</a>
          <a href="#explore" onClick={() => setOpen(false)}>Lectures</a>
          <a href="#platform" onClick={() => setOpen(false)}>About</a>
          <a href="#contact" onClick={() => setOpen(false)}>Contact</a>
          <div className="navbar__nav-actions">
            {me?.role === 'SUPER_ADMIN' && (
              <a href="/admin" className="btn btn-secondary btn-sm">Admin</a>
            )}
            {me?.role === 'INSTRUCTOR' && (
              <a href="/panel" className="btn btn-secondary btn-sm" title="Instructor Portal">
                <Settings2 size={14} /> Instructor Portal
              </a>
            )}
            {me ? (
              <button className="btn btn-primary btn-sm" onClick={() => { setOpen(false); doLogout() }}>
                <LogOut size={14} /> Sign out
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => { setOpen(false); navigate('/signin') }}>
                Sign in
              </button>
            )}
          </div>
        </nav>
        <div className="navbar__actions">
          {me?.role === 'SUPER_ADMIN' && (
            <a href="/admin" className="btn btn-secondary btn-sm">Admin</a>
          )}
          {me?.role === 'INSTRUCTOR' && (
            <a href="/panel" className="btn btn-secondary btn-sm" title="Instructor Portal">
              <Settings2 size={14} />
            </a>
          )}
          {me ? (
            <>
              <span className="navbar__user" title={`${me.email} (${me.role})`}>{me.displayName || me.email}</span>
              <button className="btn btn-primary btn-sm" onClick={doLogout} title="Sign out">
                <LogOut size={14} />
              </button>
            </>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/signin')}>
              Sign in
            </button>
          )}
          <button
            className="navbar__toggle"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {open ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>
    </header>
  )
}
