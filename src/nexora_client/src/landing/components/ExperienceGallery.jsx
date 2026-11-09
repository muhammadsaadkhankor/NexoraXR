import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Globe, Lock, ArrowRight,
  Clapperboard, ScanEye, BrainCircuit, TerminalSquare, MousePointerClick, Scale,
} from 'lucide-react'
import { API_URL, CLASSROOM_LANGUAGES } from '../../shared/config'
import { classroomPath } from '../../shared/classroomUrl'
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

// Topic → icon identity for the baked Multimedia lectures. Generated-course
// lectures fall back to the course clapper icon.
const LECTURE_ICON = {
  multimedia_L1: 'media',
  multimedia_L2: 'sources',
  multimedia_L3: 'compression',
  multimedia_L4: 'interaction',
  multimedia_L5: 'metaverse',
  multimedia_L6: 'security',
  multimedia_L7: 'quality',
  multimedia_L8: 'ai',
}

const LECTURE_TOPICS = [
  [/linear regression|least squares/i, 'regression'],
  [/data sources?|sensors?|internet of things/i, 'sources'],
  [/compression|encoding|codecs?/i, 'compression'],
  [/interaction|haptics|human.computer/i, 'interaction'],
  [/metaverse|digital twins?|virtual worlds?/i, 'metaverse'],
  [/security|encryption|privacy|cryptograph/i, 'security'],
  [/quality of experience|\bqoe\b|quality of service/i, 'quality'],
  [/artificial intelligence|\bai\b|machine learning|neural/i, 'ai'],
  [/concepts|definitions|multimedia/i, 'media'],
]

function LectureArtwork({ lecture }) {
  const topic = LECTURE_TOPICS.find(([pattern]) => pattern.test(lecture.title || ''))?.[1]
    || LECTURE_ICON[lecture.lecture_id] || 'course'
  const nodes = [[94, 60], [94, 110], [94, 160], [170, 45], [170, 87], [170, 133], [170, 175], [246, 70], [246, 150]]
  return (
    <svg className="lecturecard__illustration" viewBox="0 0 340 220" fill="none" aria-hidden="true" focusable="false" data-topic={topic}>
      <g className="lecturecard__art-grid" stroke="currentColor" strokeWidth="0.7">
        {[55, 85, 115, 145, 175].map((y) => <path key={y} d={`M30 ${y}H310`} />)}
        {[50, 90, 130, 170, 210, 250, 290].map((x) => <path key={x} d={`M${x} 30V190`} />)}
      </g>
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {topic === 'media' && <>
          <rect className="lecturecard__glass" x="76" y="42" width="174" height="116" rx="12" transform="rotate(-8 163 100)" />
          <rect className="lecturecard__glass" x="91" y="61" width="174" height="116" rx="12" />
          <path d="M91 86H265" opacity=".45" />
          <circle cx="104" cy="74" r="2" /><circle cx="114" cy="74" r="2" />
          <path className="lecturecard__accent" d="M112 147L134 120L150 138L163 125L183 147Z" />
          <circle cx="170" cy="108" r="7" />
          <path d="M204 111V146M215 101V156M226 117V140M237 108V149" strokeWidth="4" />
          <path className="lecturecard__accent" d="M139 180H217M178 177V190" />
        </>}
        {topic === 'sources' && <>
          {[[83, 62], [257, 62], [73, 158], [267, 158]].map(([x, y]) => <g key={x}>
            <path d={`M${x} ${y}L170 111`} strokeDasharray="4 6" opacity=".65" />
            <rect className="lecturecard__glass" x={x - 21} y={y - 21} width="42" height="42" rx="12" />
            <circle cx={x} cy={y} r="7" /><path d={`M${x - 12} ${y - 12}Q${x} ${y - 24} ${x + 12} ${y - 12}`} />
          </g>)}
          <path className="lecturecard__glass" d="M137 91V138C137 155 203 155 203 138V91" />
          <ellipse className="lecturecard__accent" cx="170" cy="91" rx="33" ry="13" />
          <path d="M137 113C137 130 203 130 203 113" />
        </>}
        {topic === 'compression' && <>
          {[0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => <rect key={`${row}-${col}`} className="lecturecard__glass" x={45 + col * 29} y={62 + row * 32} width="20" height="23" rx="4" />))}
          <path d="M143 68L203 97M143 151L203 123" opacity=".5" />
          <path className="lecturecard__accent" d="M143 110H195M184 100L195 110L184 120" />
          <path className="lecturecard__glass" d="M218 88L248 71L278 88V132L248 150L218 132Z" />
          <path d="M218 88L248 105L278 88M248 105V150" />
          <path className="lecturecard__accent" d="M233 79L263 97V116" strokeWidth="4" />
        </>}
        {topic === 'interaction' && <>
          <rect className="lecturecard__glass" x="77" y="43" width="185" height="125" rx="14" />
          <path d="M77 145H262M145 184H195M170 168V184" opacity=".55" />
          <circle cx="162" cy="97" r="31" opacity=".25" /><circle cx="162" cy="97" r="20" opacity=".65" />
          <path className="lecturecard__accent" d="M161 95L213 122L189 131L178 155Z" strokeWidth="3" />
          <path d="M123 59L130 69M204 62L196 71M114 96H125" />
        </>}
        {topic === 'metaverse' && <>
          <ellipse cx="170" cy="167" rx="114" ry="30" opacity=".5" />
          {[[91, 91, 64], [137, 57, 110], [183, 103, 65], [226, 80, 73]].map(([x, y, height]) => <g key={x}>
            <path className="lecturecard__glass" d={`M${x} ${y}l16 -9l16 9v${height}l-16 9l-16 -9Z`} />
            <path d={`M${x} ${y}l16 9l16 -9M${x + 16} ${y + 9}v${height}`} />
            <path className="lecturecard__accent" d={`M${x + 6} ${y + 18}v${height - 28}M${x + 25} ${y + 19}v${height - 28}`} strokeDasharray="4 7" />
          </g>)}
          <path d="M62 117C38 40 276 24 286 110" strokeDasharray="3 7" opacity=".5" />
        </>}
        {topic === 'security' && <>
          <path className="lecturecard__glass" d="M170 31C145 48 119 55 102 57V112C102 151 136 177 170 192C204 177 238 151 238 112V57C213 53 190 45 170 31Z" strokeWidth="3" />
          <path d="M170 46L116 68V112C116 143 143 166 170 178C197 166 224 143 224 112V68Z" opacity=".4" />
          <rect className="lecturecard__accent" x="146" y="99" width="48" height="43" rx="9" />
          <path d="M155 99V87a15 15 0 0 1 30 0V99" strokeWidth="4" />
          <circle cx="170" cy="116" r="4" /><path d="M170 120V129" />
        </>}
        {topic === 'quality' && <>
          <circle className="lecturecard__glass" cx="170" cy="112" r="66" />
          <path d="M119 119a52 52 0 1 1 102 0" strokeWidth="6" opacity=".5" />
          <path className="lecturecard__accent" d="M170 112L203 77" strokeWidth="4" />
          <circle cx="170" cy="112" r="7" />
          <path d="M33 129H56L65 107L77 151L89 121H106M234 121H252L263 96L275 140L286 121H309" />
          <path className="lecturecard__accent" d="M151 147L163 158L188 134" strokeWidth="3" />
        </>}
        {topic === 'ai' && <>
          {nodes.slice(0, 3).flatMap(([x, y], i) => nodes.slice(3, 7).map(([tx, ty], j) => <path key={`${i}-${j}`} d={`M${x} ${y}L${tx} ${ty}`} opacity=".3" />))}
          {nodes.slice(3, 7).flatMap(([x, y], i) => nodes.slice(7).map(([tx, ty], j) => <path key={`${i}-${j}`} d={`M${x} ${y}L${tx} ${ty}`} opacity=".5" />))}
          {nodes.map(([x, y], i) => <g key={i}><circle className="lecturecard__glass" cx={x} cy={y} r="13" /><circle className="lecturecard__accent" cx={x} cy={y} r="4" /></g>)}
          <path d="M57 52V171M283 52V171" strokeDasharray="3 8" opacity=".4" />
        </>}
        {topic === 'regression' && <>
          <path d="M70 42V172H285" />
          {[75, 110, 145].map((y) => <path key={y} d={`M70 ${y}H280`} opacity=".16" />)}
          <path className="lecturecard__accent" d="M87 157L270 58" strokeWidth="3" />
          {[[97, 143], [120, 151], [143, 118], [160, 123], [185, 94], [207, 103], [230, 67], [256, 74]].map(([x, y]) => <g key={x}>
            <path d={`M${x} ${y}V${157 - (x - 87) * 99 / 183}`} strokeDasharray="2 4" opacity=".6" />
            <circle className="lecturecard__glass" cx={x} cy={y} r="6" />
          </g>)}
        </>}
        {topic === 'course' && <Clapperboard x="113" y="53" width="114" height="114" strokeWidth="1" />}
      </g>
    </svg>
  )
}

function CourseHeading({ title, count, multimedia = false }) {
  const Icon = multimedia ? Clapperboard : BrainCircuit
  return (
    <div className="course-heading">
      <div className="course-heading__identity">
        <span className="course-heading__icon"><Icon size={24} strokeWidth={1.6} /></span>
        <div>
          <span className="course-heading__eyebrow">Explore the course</span>
          <h3>{title}</h3>
        </div>
      </div>
      <span className="course-heading__count">{String(count).padStart(2, '0')} <span>{count === 1 ? 'lecture' : 'lectures'}</span></span>
    </div>
  )
}

export default function ExperienceGallery({ onCourse }) {
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [liveRooms, setLiveRooms] = useState([])
  const [me, setMe] = useState(null)
  // Classroom creation is INSTRUCTOR/SUPER_ADMIN only; students and guests
  // join existing rooms.
  const canCreate = me?.role === 'INSTRUCTOR' || me?.role === 'SUPER_ADMIN'

  const [myRooms, setMyRooms] = useState([])
  // Lecture gallery — each lecture is its own classroom (one public room
  // per lecture, resolved server-side on join).
  const [courseInfo, setCourseInfo] = useState(null)
  const [lectures, setLectures] = useState([])
  // Built courses — each approved course renders as its own lecture
  // section under its course name (same card design as Multimedia).
  const [courseSections, setCourseSections] = useState([])

  useEffect(() => {
    fetch(`${API_URL}/api/courses/public`)
      .then((r) => r.json())
      .then((d) => setCourseSections(d.courses || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch(`${API_URL}/api/lectures`)
      .then((r) => r.json())
      .then(async (d) => {
        setCourseInfo(d.course || null)
        const all = d.lectures || []
        // Only fully-prepared lectures are offered — the catalogue also
        // lists legacy Lecture_* entries whose audio/translations were
        // never baked; they'd die at the start gate anyway.
        const ready = await Promise.all(all.map(async (l) => {
          try {
            const rd = await fetch(`${API_URL}/api/lecture/${l.lecture_id}/readiness`)
              .then((r) => r.json())
            return rd?.allReady ? l : null
          } catch { return l } // transient check failure — keep it visible
        }))
        setLectures(ready.filter(Boolean))
      })
      .catch(() => {})
  }, [])

  // Click a lecture card → resolve (or create) its dedicated public room
  // and join it. Everyone who picks this lecture shares that room; other
  // lectures are other rooms entirely.
  const joinLecture = async (lecture) => {
    try {
      const res = await fetch(`${API_URL}/api/rooms/for-lecture`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lectureId: lecture.lecture_id }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.joinUrl) { navigate(d.joinUrl); return }
      alert(d.error || 'Could not join that lecture — is the backend running?')
    } catch {
      alert('Could not reach the server — is the backend running?')
    }
    // No bare-classroom fallback: a classroom URL without ?room= has no
    // room to join and would land on a dead "Loading Lecture" screen.
  }

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
    const base = classroomPath(r)
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

  // Public rooms no longer render as room cards — lectures are the join
  // surface now. liveRooms is still fetched for each lecture's 'Live now'
  // badge.

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

  const LectureCard = ({ lecture, index, total }) => {
    const num = String(index + 1).padStart(2, '0')
    const tot = String(total).padStart(2, '0')
    const live = liveRooms.some((r) => r.roomId === `pub_lecture__${lecture.lecture_id}`)
    const desc = (lecture.learning_objectives || []).slice(0, 3).join(' · ') || lecture.subtitle || 'Explore the topic in a shared classroom with an AI professor.'
    // Brand-family hue per lecture — deterministic by position so cards
    // keep their identity between renders.
    const hue = 195 + (index % 4) * 22
    return (
      <button className="lecturecard" onClick={() => joinLecture(lecture)}>
        <span className="lecturecard__art" style={{ '--art-hue': hue }}>
          <LectureArtwork lecture={lecture} />
          <span className="lecturecard__num">MODULE {num} <span>/ {tot}</span></span>
        </span>
        <span className="lecturecard__body">
          <span className={`lecturecard__status ${live ? 'lecturecard__status--live' : ''}`}>
            <span className="lecturecard__status-dot" />
            {live ? 'Classroom open' : 'Ready to explore'}
          </span>
          <span className="lecturecard__title">{lecture.title}</span>
          {desc && <span className="lecturecard__desc">{desc}</span>}
          <span className="lecturecard__cta">Enter lecture <span className="lecturecard__arrow"><ArrowRight size={18} /></span></span>
        </span>
      </button>
    )
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
          : navigate(classroomPath(room)))}
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

  return (
    <section id="explore" className="gallery">
      <div className="container">

        {/* Hero — heading, short pitch, and the create action on one line. */}
        <div className="classhero">
          <div className="classhero__glow" />
          <div className="classhero__text">
            <span className="section__eyebrow">The learning collection</span>
            <h2 className="section__title">Find your next <span className="grad-text">discovery.</span></h2>
            <p className="section__desc">
              Choose a topic. Step into the classroom. Make room for a new perspective.
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

        {/* Lecture gallery — one classroom per lecture under the course
            heading. Each card resolves to the lecture's own public room. */}
        {lectures.length > 0 && (
          <div className="rooms-block">
            <CourseHeading title={courseInfo?.title || 'Multimedia'} count={lectures.length} multimedia />
            <div className="rooms-block__grid rooms-block__grid--lectures">
              {lectures.map((l, i) => (
                <LectureCard key={l.lecture_id} lecture={l} index={i} total={lectures.length} />
              ))}
            </div>
          </div>
        )}

        {/* Built-course sections — one block per approved course, same
            lecture-card design as the Multimedia section. Lectures already
            shown above (shared ids) are deduplicated. */}
        {courseSections.map((c) => {
          const seen = new Set(lectures.map((l) => l.lecture_id))
          const list = (c.lectures || []).filter((l) => !seen.has(l.lecture_id))
          if (!list.length) return null
          return (
            <div className="rooms-block" key={c.id}>
              <CourseHeading title={c.name} count={list.length} />
              <div className="rooms-block__grid rooms-block__grid--lectures">
                {list.map((l, i) => (
                  <LectureCard key={l.lecture_id} lecture={l} index={i} total={list.length} />
                ))}
              </div>
            </div>
          )
        })}

        {/* Private classrooms — only the caller's authorised rooms. Hidden
            entirely when the user has none (section appears on creation). */}
        {canCreate && myRooms.length > 0 && (
          <div className="rooms-block rooms-block--private">
            <div className="rooms-block__head">
              <span className="rooms-block__icon rooms-block__icon--private"><Lock size={15} /></span>
              <h3>Private Classrooms</h3>
              {myRooms.length > 0 && (
                <span className="rooms-block__count">{myRooms.length}</span>
              )}
            </div>
            <div className="rooms-block__grid">
              {myRooms.map((r) => <RoomCard key={r.roomId} room={r} />)}
            </div>
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
