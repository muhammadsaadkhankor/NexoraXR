import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUpRight, Plus, Users, Globe } from 'lucide-react'
import { API_URL, CLASSROOM_LANGUAGES } from '../../shared/config'
import CreateClassroomModal from './CreateClassroomModal'

// Static course/experience cards — unchanged; they navigate into course pages.
const experiences = [
  { title: 'Multimedia', category: 'Multimedia Computing' },
  { title: 'ELG 5121', category: 'Engineering' },
  { title: 'CS 401', category: 'Computer Science' },
  { title: 'MED 320', category: 'Healthcare' },
  { title: 'BIO 210', category: 'Science' },
  { title: 'MTH 150', category: 'Mathematics' },
  { title: 'VR 101', category: 'Virtual Labs' },
]

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
            <h2 className="section__title">Immersive Experiences</h2>
            <p className="section__desc">
              Discover interactive environments designed for learning, exploration,
              collaboration, and intelligent virtual interaction.
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
              {liveRooms.map((r) => (
                <div key={r.roomId} className="liverooms__card">
                  <div className="liverooms__badge">
                    <Globe size={12} /> Public
                  </div>
                  <h4>{r.className}</h4>
                  <p>{r.courseId || 'General'} · {LANG_LABEL[r.language] || r.language}</p>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => navigate(`/scene/${r.scene}?room=${r.roomId}&lecture=${r.lectureId}`)}
                  >
                    <Users size={14} /> Join Class
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

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

      {showCreate && (
        <CreateClassroomModal onClose={() => setShowCreate(false)} onCreated={onCreated} />
      )}
      {/* Private rooms never render here — admission is invite-link only. */}
    </section>
  )
}
