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
            <span className="hero__wu">∞</span> Learning without limits
          </span>
          <h1 className="hero__title">
            A classroom that
            <span className="hero__title-grad"> flows with you</span>
          </h1>
          <p className="hero__support">
            WuFlux removes the walls — of place, language, pace and presence.
            Step into a shared 3D classroom, learn from an AI professor who
            speaks your language, and flow with the class instead of chasing it.
          </p>
          <div className="hero__actions">
            <a href="#explore" className="btn btn-primary btn-lg">Enter a classroom</a>
            <a href="#philosophy" className="btn btn-secondary btn-lg">Our philosophy</a>
          </div>
          <div className="hero__compat">
            WebXR <span className="dot" /> Desktop <span className="dot" /> VR
            <span className="dot" /> No installs
          </div>
        </div>
      </div>
    </section>
  )
}
