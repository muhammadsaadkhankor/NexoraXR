import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Users, Globe, Lock, ArrowRight,
  Clapperboard, ScanEye, BrainCircuit, TerminalSquare, MousePointerClick, Scale,
} from 'lucide-react'
import { API_URL, CLASSROOM_LANGUAGES } from '../../shared/config'
import { SCENE_CONFIG, PRIMARY_COURSES } from '../../classroom/sceneConfig'
import { getMe } from '../../shared/auth'
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
    tagline: 'Teach machines to see: detection, tracking, recognition.',
  },
  MachineLearning: {
    icon: BrainCircuit, accent: '#34D399',
    tagline: 'Models, gradients and data, from theory to deployment.',
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

// (No static course cards — the gallery is driven by live public rooms.)

const LANG_LABEL = Object.fromEntries(CLASSROOM_LANGUAGES.map((l) => [l.code, l.label]))

export default function ExperienceGallery({ onCourse }) {
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [liveRooms, setLiveRooms] = useState([])
  const [me, setMe] = useState(null)
  // Classroom creation is INSTRUCTOR/SUPER_ADMIN only; students and guests
  // join existing rooms.
  const canCreate = me?.role === 'INSTRUCTOR' || me?.role === 'SUPER_ADMIN'

  const [myRooms, setMyRooms] = useState([])

  useEffect(() => {
    getMe().then((r) => {
      const u = r.ok ? r.data.user : null
      setMe(u)
      // Own classrooms — hosts see theirs, SUPER_ADMIN sees everyone's.
      if (u && (u.role === 'INSTRUCTOR' || u.role === 'SUPER_ADMIN')) {
        fetch(`${API_URL}/api/rooms/mine`, { credentials: 'include' })
          .then((x) => x.json())
          // Private section: instructor sees own private rooms; SUPER_ADMIN
          // sees everyone's. Public rooms already show in the public gallery.
          .then((d) => setMyRooms((d.rooms || []).filter((r) => r.roomType === 'private')))
          .catch(() => {})
      }
    }).catch(() => {})
  }, [])

  const roomLink = (r) => {
    const base = `/scene/${encodeURIComponent(r.scene)}?room=${r.roomId}${r.lectureId ? `&lecture=${r.lectureId}` : ''}`
    return r.roomType === 'private' && r.inviteToken ? `${base}&invite=${r.inviteToken}` : base
  }

  const enterRoom = (r) => {
    const url = roomLink(r)
    if (r.roomType === 'private') {
      sessionStorage.setItem(`nexoraxr_invite_${r.roomId}`, `${window.location.origin}${url}`)
    }
    navigate(url)
  }

  // Live public classrooms are server-driven (registry); refresh periodically
  // so torn-down rooms disappear and new ones appear.
  const refreshRooms = useCallback(() => {
    fetch(`${API_URL}/api/rooms/public`)
      .then((r) => r.json())
      .then((d) => setLiveRooms(d.rooms || []))
      .catch(() => {})
  }, [])

  // Public rooms are public for everyone — including the host.
  const otherLiveRooms = liveRooms

  useEffect(() => {
    refreshRooms()
    const t = setInterval(refreshRooms, 15000)
    return () => clearInterval(t)
  }, [refreshRooms])

  const onCreated = (room) => {
    setShowCreate(false)
    // If the course build produced lectures, enter on the generated lecture
    // instead of the scene's default picker.
    const withLecture = (url) =>
      room.generatedLectureId ? `${url}&lecture=${room.generatedLectureId}` : url
    if (room.roomType === 'private') {
      // Remember that WE created it so the in-scene invite banner shows.
      sessionStorage.setItem(`nexoraxr_invite_${room.roomId}`, `${window.location.origin}${room.inviteUrl}`)
      navigate(withLecture(room.inviteUrl))
    } else {
      navigate(withLecture(room.joinUrl)) // host enters the public classroom directly
    }
  }

  // One card design for every classroom — accent color per course, a
  // public/private badge, and a join/enter action. Private rooms only ever
  // render in the authorised "mine" list below.
  // Classroom visibility flip — owner/SUPER_ADMIN only (server enforces it).
  const setVisibility = async (roomId, visibility, e) => {
    e?.stopPropagation()
    const r = await fetch(`${API_URL}/api/rooms/${roomId}/visibility`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility }),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { alert(d.error || 'Could not change visibility'); return }
    if (visibility === 'public') {
      // Leaves the private list; appears in the public gallery on refresh.
      setMyRooms((rs) => rs.filter((x) => x.roomId !== roomId))
      refreshRooms()
    } else {
      setMyRooms((rs) => rs.map((x) =>
        x.roomId === roomId ? { ...x, roomType: 'private' } : x))
    }
  }

  const RoomCard = ({ room, live }) => {
    const isPrivate = room.roomType === 'private'
    const style = COURSE_STYLE[room.courseId] || COURSE_STYLE[room.scene]
      || { icon: isPrivate ? Lock : Globe, accent: '#7C5CFC' }
    const Icon = style.icon
    const accent = style.accent
    return (
      <button
        className="roomcard"
        style={{ '--room-accent': accent }}
        onClick={() => (isPrivate ? enterRoom(room)
          : navigate(`/scene/${room.scene}?room=${room.roomId}${room.lectureId ? `&lecture=${room.lectureId}` : ''}`))}
      >
        <span className="roomcard__glow" />
        <span className="roomcard__top">
          <span className="roomcard__icon">
            <Icon size={22} strokeWidth={1.75} />
          </span>
          <span className={`roomcard__badge ${isPrivate ? 'roomcard__badge--private' : 'roomcard__badge--public'}`}>
            {isPrivate ? <Lock size={11} /> : <Globe size={11} />}
            {isPrivate ? 'Private' : 'Public'}
          </span>
        </span>
        <span className="roomcard__body">
          <span className="roomcard__course">{room.courseName || SCENE_CONFIG[room.courseId]?.title || 'Open course'}</span>
          <span className="roomcard__title">{room.className}</span>
          <span className="roomcard__meta">
            {live ? <><span className="roomcard__live-dot" /> Live now · </> : null}
            {LANG_LABEL[room.language] || room.language}
          </span>
        </span>
        <span className="roomcard__cta">
          {isPrivate ? 'Enter classroom' : 'Join class'} <ArrowRight size={16} />
        </span>
        {isPrivate && (
          <span
            role="button" tabIndex={-1}
            style={{ fontSize: 11, color: '#67e8f9', padding: '6px 0 2px', cursor: 'pointer' }}
            onClick={(e) => setVisibility(room.roomId, 'public', e)}
          >
            Make public → visible in the gallery
          </span>
        )}
      </button>
    )
  }

  const EmptyState = ({ icon: Icon, title, children, action }) => (
    <div className="rooms-empty">
      <span className="rooms-empty__icon"><Icon size={22} strokeWidth={1.5} /></span>
      <p className="rooms-empty__title">{title}</p>
      <p className="rooms-empty__desc">{children}</p>
      {action}
    </div>
  )

  return (
    <section id="explore" className="gallery">
      <div className="container">

        {/* Hero — heading, short pitch, and the create action on one line. */}
        <div className="classhero">
          <div className="classhero__glow" />
          <div className="classhero__text">
            <span className="section__eyebrow">Classrooms</span>
            <h2 className="section__title">Join a class</h2>
            <p className="section__desc">
              Jump into a live public classroom in one click, or create your
              own classroom and invite your students.
            </p>
          </div>
          {canCreate && (
            <div className="classhero__actions">
              <button className="btn btn-primary btn-lg" onClick={() => setShowCreate(true)}>
                <Plus size={18} /> Create Classroom
              </button>
            </div>
          )}
        </div>

        {/* Public classrooms — discoverable live rooms for everyone. */}
        <div className="rooms-block">
          <div className="rooms-block__head">
            <span className="rooms-block__icon rooms-block__icon--public"><Globe size={15} /></span>
            <h3>Public Classrooms</h3>
            {otherLiveRooms.length > 0 && (
              <span className="rooms-block__count">{otherLiveRooms.length} live</span>
            )}
          </div>
          {otherLiveRooms.length > 0 ? (
            <div className="rooms-block__grid">
              {otherLiveRooms.map((r) => <RoomCard key={r.roomId} room={r} live />)}
            </div>
          ) : (
            <EmptyState
              icon={Users}
              title="No public classrooms are live right now"
              action={canCreate && (
                <button className="btn btn-secondary btn-sm" onClick={() => setShowCreate(true)}>
                  <Plus size={15} /> Start the first one
                </button>
              )}
            >
              {canCreate
                ? 'Create a classroom and it appears here for anyone to join.'
                : 'New rooms appear here when a host opens one.'}
            </EmptyState>
          )}
        </div>

        {/* Private classrooms — only the caller's authorised rooms. Guests
            and students never see this section or its invite tokens. */}
        {canCreate && (
          <div className="rooms-block rooms-block--private">
            <div className="rooms-block__head">
              <span className="rooms-block__icon rooms-block__icon--private"><Lock size={15} /></span>
              <h3>Private Classrooms</h3>
              {myRooms.length > 0 && (
                <span className="rooms-block__count">{myRooms.length}</span>
              )}
            </div>
            {myRooms.length > 0 ? (
              <div className="rooms-block__grid">
                {myRooms.map((r) => <RoomCard key={r.roomId} room={r} />)}
              </div>
            ) : (
              <EmptyState
                icon={Lock}
                title="No private classrooms yet"
                action={
                  <button className="btn btn-secondary btn-sm" onClick={() => setShowCreate(true)}>
                    <Plus size={15} /> Create a private room
                  </button>
                }
              >
                Private rooms are invite-only. Create one and share the link
                with your students.
              </EmptyState>
            )}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateClassroomModal onClose={() => setShowCreate(false)} onCreated={onCreated} />
      )}
      {/* Private rooms never render here — admission is invite-link only. */}
    </section>
  )
}
