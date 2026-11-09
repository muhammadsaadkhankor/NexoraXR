import { Box, ChevronDown, Languages, MessageCircle } from 'lucide-react'
import { DEFAULT_BRAND_MARK } from '../../shared/branding'

// WuFlux — "without" barriers, everything flows: the classroom adapts, the
// lecture adapts, you adapt.
export default function HeroSection() {
  return (
    <section id="home" className="hero">
      <div className="hero__bg" aria-hidden="true">
        <img src="/assets/heroposter.png" alt="" />
        <div className="hero__bg-overlay" />
        <div className="hero__bg-aurora" />
      </div>

      <div className="container hero__inner">
        <div className="hero__content">
          <span className="hero__eyebrow">
            <img className="hero__wu" src={DEFAULT_BRAND_MARK} alt="" width="24" height="24" /> A new space to learn
          </span>
          <h1 className="hero__title">
            Step into your
            <span className="hero__title-grad"> next classroom.</span>
          </h1>
          <p className="hero__support">
            Learn together in WuFlux. Explore AI-led lectures in a shared 3D
            classroom, choose your language, and ask questions as you go.
          </p>
          <ul className="hero__capabilities" aria-label="Classroom capabilities">
            <li><Box size={16} aria-hidden="true" /><span>Shared 3D classrooms</span></li>
            <li><Languages size={16} aria-hidden="true" /><span>Six languages</span></li>
            <li><MessageCircle size={16} aria-hidden="true" /><span>Interactive Q&amp;A</span></li>
          </ul>
          <div className="hero__compat">
            WebXR <span className="dot" /> Desktop <span className="dot" /> VR
            <span className="dot" /> No installs
          </div>
        </div>
        <div className="hero__visual-label">
          <span className="hero__visual-dot" aria-hidden="true" />
          Inside your next classroom
        </div>
      </div>
      <a href="#explore" className="hero__scroll">
        <span>Browse lectures</span>
        <ChevronDown size={16} aria-hidden="true" />
      </a>
    </section>
  )
}
