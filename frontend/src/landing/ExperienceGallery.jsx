import { ArrowUpRight } from 'lucide-react'

const experiences = [
  { title: 'ELG 5121', category: 'Engineering' },
  { title: 'CS 401', category: 'Computer Science' },
  { title: 'MED 320', category: 'Healthcare' },
  { title: 'BIO 210', category: 'Science' },
  { title: 'MTH 150', category: 'Mathematics' },
  { title: 'VR 101', category: 'Virtual Labs' },
]

export default function ExperienceGallery({ onCourse }) {
  return (
    <section id="explore" className="gallery">
      <div className="container">
        <div className="section__header">
          <h2 className="section__title">Immersive Experiences</h2>
          <p className="section__desc">
            Discover interactive environments designed for learning, exploration,
            collaboration, and intelligent virtual interaction.
          </p>
        </div>

        <div className="gallery__grid">
          {experiences.map((ex, i) => (
            <a key={i} href="#" onClick={(e) => { e.preventDefault(); onCourse(ex.title) }} className="gallery__item">
              <img src="/assets/heroposter.png" alt={ex.title} />
              <div className="gallery__overlay" />
              <div className="gallery__content">
                <span className="gallery__category">{ex.category}</span>
                <h3 className="gallery__title">{ex.title}</h3>
              </div>
              <ArrowUpRight className="gallery__arrow" size={20} />
            </a>
          ))}
        </div>
      </div>
    </section>
  )
}
