import { Box, Bot, MessageSquare, Glasses } from 'lucide-react'

const capabilities = [
  { icon: Box, label: 'Interactive 3D Environments' },
  { icon: Bot, label: 'Intelligent Virtual Characters' },
  { icon: MessageSquare, label: 'Real-Time Communication' },
  { icon: Glasses, label: 'Cross-Device WebXR Access' },
]

export default function PlatformSection() {
  return (
    <section id="about" className="platform">
      <div className="container platform__inner">
        <div className="platform__visual">
          <img
            src="/assets/heroposter.png"
            alt="WebXR platform environment"
          />
        </div>
        <div className="platform__content">
          <span className="section__eyebrow">Built for Immersion</span>
          <h2 className="section__title">More Than a Virtual World</h2>
          <p className="section__desc">
            Users can interact with environments, virtual characters, multimedia
            content, and other participants directly through the browser.
          </p>
          <ul className="platform__list">
            {capabilities.map((c, i) => (
              <li key={i} className="platform__item">
                <span className="platform__icon">
                  <c.icon size={22} />
                </span>
                <span>{c.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
