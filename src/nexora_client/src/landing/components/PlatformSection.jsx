import { Globe2, Languages, Rewind, Users } from 'lucide-react'

// Every "any" is really a "without" — a barrier removed. Each pillar maps
// to a shipped capability of the platform, not a slogan.
const pillars = [
  {
    icon: Globe2,
    title: 'A classroom in your browser',
    desc: 'Step into a shared 3D space from your desktop, or explore in VR with a compatible headset.',
    tag: 'Browser-based learning',
  },
  {
    icon: Languages,
    title: 'Six languages to learn in',
    desc: 'Follow AI-led lectures in English, Arabic, French, German, Spanish or Chinese.',
    tag: 'Multilingual lectures',
  },
  {
    icon: Rewind,
    title: 'Room to catch up',
    desc: 'Joining a lecture late? Get a recap of what you missed before continuing with the class.',
    tag: 'Lecture recaps',
  },
  {
    icon: Users,
    title: 'Learn with your people',
    desc: 'Join a public classroom or gather a private group with invite links and host approval.',
    tag: 'Public and private rooms',
  },
]

export default function PlatformSection() {
  return (
    <section id="platform" className="platform">
      <div className="container">
        <div className="section__header" style={{ textAlign: 'left', marginBottom: 56 }}>
          <span className="section__eyebrow">The WuFlux platform</span>
          <h2 className="section__title">
            A shared space.
            <span className="grad-text"> More ways to learn.</span>
          </h2>
          <p className="section__desc" style={{ margin: 0 }}>
            From your first lecture to your next group session, WuFlux brings
            immersive classrooms, language choice and lecture recaps together.
          </p>
        </div>

        <div className="pillars__grid">
          {pillars.map((p) => (
            <div key={p.title} className="pillar">
              <div className="pillar__head">
                <span className="pillar__icon"><p.icon size={22} aria-hidden="true" /></span>
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
