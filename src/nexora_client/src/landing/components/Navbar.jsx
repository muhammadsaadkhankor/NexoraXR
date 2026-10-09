import { useEffect, useState } from 'react'
import { Menu, X } from 'lucide-react'

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className={`navbar ${scrolled ? 'navbar--scrolled' : ''}`}>
      <div className="container navbar__inner">
        <a href="#home" className="navbar__brand">
          <span className="navbar__seal">W</span>
          <span className="navbar__wordmark">WuFlux</span>
        </a>
        <nav className={`navbar__nav ${open ? 'navbar__nav--open' : ''}`}>
          <a href="#explore" onClick={() => setOpen(false)}>Classrooms</a>
          <a href="#platform" onClick={() => setOpen(false)}>Platform</a>
          <a href="#philosophy" onClick={() => setOpen(false)}>Philosophy</a>
        </nav>
        <div className="navbar__actions">
          <a href="#explore" className="btn btn-secondary btn-sm">Enter a class</a>
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
