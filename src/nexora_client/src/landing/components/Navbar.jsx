import { useEffect, useState } from 'react'
import { Menu, X, LogOut, Settings2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getMe, logout } from '../../shared/auth'
import { getBranding } from '../../shared/branding'
import { API_URL } from '../../shared/config'

export default function Navbar() {
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const [me, setMe] = useState(null)
  const [branding, setBranding] = useState({ appName: 'NexoraXR', logoUrl: null })

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
          {branding.logoUrl
            ? <img src={`${API_URL}${branding.logoUrl}`} alt={branding.appName} className="navbar__seal" style={{ objectFit: 'contain' }} />
            : <span className="navbar__seal">{(branding.appName || 'N')[0]}</span>}
          <span className="navbar__wordmark">{branding.appName}</span>
        </a>
        <nav className={`navbar__nav ${open ? 'navbar__nav--open' : ''}`}>
          <a href="#home" onClick={() => setOpen(false)}>Home</a>
          <a href="#philosophy" onClick={() => setOpen(false)}>About us</a>
          <a href="#contact" onClick={() => setOpen(false)}>Contact</a>
        </nav>
        <div className="navbar__actions">
          {me?.role === 'SUPER_ADMIN' && (
            <a href="/admin" className="btn btn-secondary btn-sm">Admin</a>
          )}
          {me?.role === 'INSTRUCTOR' && (
            <a href="/panel" className="btn btn-secondary btn-sm" title="Instructor panel">
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
          >
            {open ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>
    </header>
  )
}
