import { useEffect, useState } from 'react'
import { Box, Menu, X } from 'lucide-react'

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
          <Box className="navbar__logo" size={26} />
          <span>NexoraXR</span>
        </a>
        <nav className={`navbar__nav ${open ? 'navbar__nav--open' : ''}`}>
          <a href="#home" onClick={() => setOpen(false)}>Home</a>
          <a href="#explore" onClick={() => setOpen(false)}>Explore</a>
          <a href="#experiences" onClick={() => setOpen(false)}>Experiences</a>
          <a href="#about" onClick={() => setOpen(false)}>About</a>
        </nav>
        <div className="navbar__actions">
          <a href="#" className="btn btn-ghost">Sign In</a>
          {import.meta.env.DEV && (
            <a href="/editor.html?scene=ELG5121" className="btn btn-primary btn-sm navbar__cta">Scene Editor</a>
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
