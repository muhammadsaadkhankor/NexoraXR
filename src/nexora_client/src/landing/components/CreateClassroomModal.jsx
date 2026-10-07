import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { API_URL, CLASSROOM_LANGUAGES, getParticipantId, validateClassroomDraft } from '../../shared/config';
import { SCENE_CONFIG } from '../../classroom/sceneConfig';

// Unified classroom creation: one form produces either a public gallery
// classroom or a private invite-only room — same scene, same NCIP underneath.
export default function CreateClassroomModal({ onClose, onCreated }) {
  const courses = Object.entries(SCENE_CONFIG).map(([id, c]) => ({ id, label: c.title }));
  const [className, setClassName] = useState('');
  const [courseId, setCourseId] = useState(courses[0]?.id || 'Multimedia');
  const [lectures, setLectures] = useState([]);
  const [lectureId, setLectureId] = useState('');
  const [language, setLanguage] = useState('en');
  const [roomType, setRoomType] = useState('public');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/lectures`)
      .then((r) => r.json())
      .then((d) => {
        setLectures(d.lectures || []);
        setLectureId(d.lectures?.[0]?.lecture_id || '');
      })
      .catch(() => setError('Could not load lectures.'));
  }, []);

  const valid = validateClassroomDraft({ className, lectureId, language });

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          className: className.trim(),
          courseId,
          lectureId,
          language,
          roomType,
          scene: courseId,
          hostId: getParticipantId(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create classroom');
      onCreated(data);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <div className="ccmodal__backdrop" onClick={onClose}>
      <form className="ccmodal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="ccmodal__head">
          <h3>Create Classroom</h3>
          <button type="button" className="ccmodal__close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <label className="ccmodal__label">
          Class Name
          <input
            autoFocus
            maxLength={80}
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            placeholder="e.g. Computer Vision Study Room"
          />
        </label>

        <label className="ccmodal__label">
          Course
          <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>

        <label className="ccmodal__label">
          Lecture
          <select value={lectureId} onChange={(e) => setLectureId(e.target.value)}>
            {lectures.map((l) => <option key={l.lecture_id} value={l.lecture_id}>{l.title}</option>)}
          </select>
        </label>

        <label className="ccmodal__label">
          Language
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {CLASSROOM_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>

        <fieldset className="ccmodal__radios">
          <legend>Visibility</legend>
          <label>
            <input type="radio" checked={roomType === 'public'} onChange={() => setRoomType('public')} />
            Public — listed in the gallery, anyone can join
          </label>
          <label>
            <input type="radio" checked={roomType === 'private'} onChange={() => setRoomType('private')} />
            Private — invite link only, never listed
          </label>
        </fieldset>

        {error && <p className="ccmodal__error">{error}</p>}

        <div className="ccmodal__actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!valid || submitting}>
            {submitting ? 'Creating…' : 'Create Classroom'}
          </button>
        </div>
      </form>
    </div>
  );
}
