import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Users, Globe, ArrowRight,
  Clapperboard, ScanEye, BrainCircuit, TerminalSquare, MousePointerClick, Scale,
} from 'lucide-react'
import { API_URL, CLASSROOM_LANGUAGES } from '../../shared/config'
import { SCENE_CONFIG, PRIMARY_COURSES } from '../../classroom/sceneConfig'
import CreateClassroomModal from './CreateClassroomModal'

// Per-course card identity — accent color, icon and tagline give each course
// its own visual design instead of one shared photo template.
const COURSE_STYLE = {
  Multimedia: {
    icon: Clapperboard, accent: '#7C5CFC',
    tagline: 'Interactive media systems and immersive storytelling.',
  },
  ComputerVision: {
    icon: ScanEye, accent: '#38BDF8',
    tagline: 'Teach machines to see — detection, tracking, recognition.',
  },
  MachineLearning: {
    icon: BrainCircuit, accent: '#34D399',
    tagline: 'Models, gradients and data — from theory to deployment.',
  },
  ComputerScience: {
    icon: TerminalSquare, accent: '#F59E0B',
    tagline: 'Algorithms, systems and software fundamentals.',
  },
  HCI: {
    icon: MousePointerClick, accent: '#F472B6',
    tagline: 'Designing interfaces where humans and computers meet.',
  },
  Ethics: {
    icon: Scale, accent: '#2DD4BF',
    tagline: 'Technology, society and the questions that matter.',
  },
}

const courses = PRIMARY_COURSES.map((code) => ({
  code,
  title: SCENE_CONFIG[code].title,
  category: SCENE_CONFIG[code].category,
  style: COURSE_STYLE[code],
}))

const LANG_LABEL = Object.fromEntries(CLASSROOM_LANGUAGES.map((l) => [l.code, l.label]))

export default function ExperienceGallery({ onCourse }) {
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [liveRooms, setLiveRooms] = useState([])

  // Live public classrooms are server-driven (registry); refresh periodically
  // so torn-down rooms disappear and new ones appear.
  const refreshRooms = useCallback(() => {
    fetch(`${API_URL}/api/rooms/public`)
      .then((r) => r.json())
      .then((d) => setLiveRooms(d.rooms || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshRooms()
    const t = setInterval(refreshRooms, 15000)
    return () => clearInterval(t)
  }, [refreshRooms])

  const onCreated = (room) => {
    setShowCreate(false)
    if (room.roomType === 'private') {
      // Remember that WE created it so the in-scene invite banner shows.
      sessionStorage.setItem(`nexoraxr_invite_${room.roomId}`, `${window.location.origin}${room.inviteUrl}`)
      navigate(room.inviteUrl)
    } else {
      navigate(room.joinUrl) // host enters the public classroom directly
    }
  }

  return (
    <section id="explore" className="gallery">
      <div className="container">
        <div className="section__header section__header--row">
          <div>
            <span className="section__eyebrow">Learning without walls</span>
            <h2 className="section__title">Classrooms</h2>
            <p className="section__desc">
              Pick a course and step inside — or spin up your own room and
              invite your cohort. Public, private, always flowing.
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={18} /> Create Classroom
          </button>
        </div>

        {liveRooms.length > 0 && (
          <>
            <h3 className="liverooms__title">
              <Globe size={16} /> Live Classrooms
            </h3>
            <div className="liverooms__grid">
              {liveRooms.map((r) => {
                const accent = COURSE_STYLE[r.courseId]?.accent || '#7C5CFC'
                return (
                  <div key={r.roomId} className="liverooms__card" style={{ '--live-accent': accent }}>
                    <div className="liverooms__badge">
                      <span className="liverooms__dot" /> Live · Public
                    </div>
                    <h4>{r.className}</h4>
                    <p>{SCENE_CONFIG[r.courseId]?.title || r.courseId || 'General'} · {LANG_LABEL[r.language] || r.language}</p>
                    <button
                      className="liverooms__join"
                      onClick={() => navigate(`/scene/${r.scene}?room=${r.roomId}${r.lectureId ? `&lecture=${r.lectureId}` : ''}`)}
                    >
                      Join Class <ArrowRight size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          </>
        )}

        <div className="gallery__grid">
          {courses.map((c) => {
            const Icon = c.style.icon
            return (
              <button
                key={c.code}
                onClick={() => onCourse(c.code)}
                className="course-card"
                style={{ '--course-accent': c.style.accent }}
              >
                <span className="course-card__glow" />
                <span className="course-card__icon">
                  <Icon size={26} strokeWidth={1.75} />
                </span>
                <span className="course-card__body">
                  <span className="course-card__category">{c.category}</span>
                  <span className="course-card__title">{c.title}</span>
                  <span className="course-card__tagline">{c.style.tagline}</span>
                </span>
                <span className="course-card__cta">
                  Enter classroom <ArrowRight size={15} />
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {showCreate && (
        <CreateClassroomModal onClose={() => setShowCreate(false)} onCreated={onCreated} />
      )}
      {/* Private rooms never render here — admission is invite-link only. */}
    </section>
  )
}
