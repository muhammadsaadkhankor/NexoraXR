import { ArrowRight } from 'lucide-react'

export default function CTASection() {
  return (
    <section id="philosophy" className="cta">
      <div className="container">
        <div className="cta__inner">
          <div className="cta__flow" aria-hidden="true" />
          <span className="cta__wu" aria-hidden="true">∞</span>
          <div className="cta__content">
            <h2 className="cta__title">
              Follow your curiosity.
              <span className="grad-text"> Find your next lecture.</span>
            </h2>
            <p className="cta__desc">
              Explore the lecture collection, choose a topic, and step into
              a WuFlux classroom.
            </p>
            <div className="cta__actions">
              <a href="#explore" className="btn btn-primary btn-lg">
                Explore lectures
                <ArrowRight className="btn__arrow" size={18} aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
