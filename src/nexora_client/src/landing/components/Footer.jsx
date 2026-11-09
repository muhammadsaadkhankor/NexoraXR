import { DEFAULT_BRAND_MARK } from '../../shared/branding'

const footerLinks = {
  Platform: [
    ['Classrooms', '#explore'],
    ['Create a room', '#explore'],
    ['WebXR', '#platform'],
  ],
  Learning: [
    ['Courses', '#explore'],
    ['Catch Me Up', '#platform'],
    ['Multilingual lectures', '#platform'],
  ],
  Company: [
    ['Philosophy', '#philosophy'],
    ['Research', '#platform'],
    ['Contact', '#contact'],
  ],
}

export default function Footer() {
  return (
    <footer id="contact" className="footer">
      <div className="container">
        <div className="footer__grid">
          <div className="footer__brand">
            <a href="#home" className="footer__logo">
              <img src={DEFAULT_BRAND_MARK} alt="" className="navbar__seal" width="38" height="38" />
              WuFlux
            </a>
            <p className="footer__desc">
              Flow without barriers: a boundless classroom for every place,
              language, pace and person.
            </p>
          </div>

          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title} className="footer__col">
              <h4 className="footer__title">{title}</h4>
              <ul>
                {links.map(([label, href]) => (
                  <li key={label}>
                    <a href={href}>{label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="footer__bottom">
          <span>© 2026 WuFlux. Learning without limits.</span>
          <div className="footer__legal">
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
          </div>
        </div>
      </div>
    </footer>
  )
}
