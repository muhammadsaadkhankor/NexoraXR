import { Globe2, Languages, Rewind, Users } from 'lucide-react'

// Every "any" is really a "without" — a barrier removed. Each pillar maps
// to a shipped capability of the platform, not a slogan.
const pillars = [
  {
    icon: Globe2,
    title: 'Any place',
    desc: 'A full 3D classroom in the browser — desktop, laptop or headset. No installs, no campus.',
    tag: 'without distance',
  },
  {
    icon: Languages,
    title: 'Any language',
    desc: 'The professor lectures in English, Arabic, French, German, Spanish or Chinese — the whole room hears it natively.',
    tag: 'without translation walls',
  },
  {
    icon: Rewind,
    title: 'Any pace',
    desc: 'Join late and the professor recaps what you missed, then resumes from the exact point it paused.',
    tag: 'without falling behind',
  },
  {
    icon: Users,
    title: 'Anyone',
    desc: 'Open public classrooms for everyone, or private rooms with invite links and host approval.',
    tag: 'without gatekeepers',
  },
]

export default function PlatformSection() {
  return (
    <section id="platform" className="platform">
      <div className="container">
        <div className="section__header" style={{ textAlign: 'left', marginBottom: 56 }}>
          <span className="section__eyebrow">The platform · Education 5.0</span>
          <h2 className="section__title">
            Every barrier,
            <span className="grad-text"> removed.</span>
          </h2>
          <p className="section__desc" style={{ margin: 0 }}>
            WuFlux treats the eight "anys" of boundless learning as engineering
            requirements — each one backed by a working capability.
          </p>
        </div>

        <div className="pillars__grid">
          {pillars.map((p) => (
            <div key={p.title} className="pillar">
              <div className="pillar__head">
                <span className="pillar__icon"><p.icon size={22} /></span>
                <h3>{p.title}</h3>
              </div>
              <p>{p.desc}</p>
              <span className="pillar__tag">{p.tag}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
