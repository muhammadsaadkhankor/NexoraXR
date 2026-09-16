import { ArrowRight } from 'lucide-react'

export default function CTASection() {
  return (
    <section id="experiences" className="cta">
      <div className="container">
        <div className="cta__inner">
          <img
            className="cta__bg"
            src="/assets/heroposter.png"
            alt=""
          />
          <div className="cta__overlay" />
          <div className="cta__content">
            <h2 className="cta__title">Ready to Enter the Experience?</h2>
            <p className="cta__desc">
              Launch directly from your browser and explore an immersive
              environment built for interaction, learning, and discovery.
            </p>
            <div className="cta__actions">
              <a href="#explore" className="btn btn-secondary btn-lg">
                Explore Experiences
                <ArrowRight className="btn__arrow" size={18} />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
