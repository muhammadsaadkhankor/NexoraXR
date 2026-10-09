const footerLinks = {
  Platform: ['Classrooms', 'Create a room', 'WebXR'],
  Learning: ['Courses', 'Catch Me Up', 'Multilingual lectures'],
  Company: ['Philosophy', 'Research', 'Contact'],
}

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__grid">
          <div className="footer__brand">
            <a href="#home" className="footer__logo">
              <span className="navbar__seal">W</span>
              WuFlux
            </a>
            <p className="footer__desc">
              Flow without barriers — a boundless classroom for every place,
              language, pace and person.
            </p>
          </div>

          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title} className="footer__col">
              <h4 className="footer__title">{title}</h4>
              <ul>
                {links.map((l) => (
                  <li key={l}>
                    <a href="#explore">{l}</a>
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
