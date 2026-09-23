
export default function HeroSection() {

  return (
    <section id="home" className="hero">
      <div className="container hero__inner">
        <div className="hero__content">
          <span className="hero__eyebrow">Immersive Web Experiences</span>
          <h1 className="hero__title">Step Into a New Dimension of Learning</h1>
          <p className="hero__support">
            Explore interactive WebXR environments, engage with intelligent virtual
            characters, and experience learning beyond the traditional screen.
          </p>
          <div className="hero__compat">
            WebXR <span className="dot" /> Desktop <span className="dot" /> VR
          </div>
        </div>

        <div className="hero__visual">
          <img
            src="/assets/heroposter.png"
            alt="Immersive WebXR environment with an AI instructor"
          />
          <span className="hero__floating">Interactive WebXR</span>
        </div>
      </div>
    </section>
  )
}
