import { Box } from 'lucide-react'

const footerLinks = {
  Platform: ['Explore', 'Experiences', 'WebXR'],
  Resources: ['Documentation', 'Research', 'Support'],
  Company: ['About', 'Contact'],
}

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__grid">
          <div className="footer__brand">
            <a href="#home" className="footer__logo">
              <Box size={24} />
              NexoraXR
            </a>
            <p className="footer__desc">
              Immersive WebXR platform for intelligent virtual experiences,
              education, training, and collaboration.
            </p>
          </div>

          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title} className="footer__col">
              <h4 className="footer__title">{title}</h4>
              <ul>
                {links.map((l) => (
                  <li key={l}>
                    <a href="#">{l}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="footer__bottom">
          <span>© 2026 NexoraXR. All rights reserved.</span>
          <div className="footer__legal">
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
          </div>
        </div>
      </div>
    </footer>
  )
}
