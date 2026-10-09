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
              Learning should flow
              <span className="grad-text"> without barriers.</span>
            </h2>
            <p className="cta__desc">
              The world is in constant flux — jobs, challenges, even whole
              business models that don't exist yet. Education should move with
              it. Create a classroom, share a link, and start teaching.
            </p>
            <div className="cta__actions">
              <a href="#explore" className="btn btn-primary btn-lg">
                Browse classrooms
                <ArrowRight className="btn__arrow" size={18} />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
