import { useState } from 'react';
import { X } from 'lucide-react';
import { API_URL, getParticipantId, validateClassroomDraft } from '../../shared/config';
import { SCENE_CONFIG, PRIMARY_COURSES } from '../../classroom/sceneConfig';

// Unified classroom creation: one form produces either a public gallery
// classroom or a private invite-only room — same scene, same NCIP underneath.
export default function CreateClassroomModal({ onClose, onCreated }) {
  const courses = PRIMARY_COURSES.map((id) => ({ id, label: SCENE_CONFIG[id].title }));
  const [className, setClassName] = useState('');
  const [courseId, setCourseId] = useState(courses[0]?.id || 'Multimedia');
  const [isPublic, setIsPublic] = useState(false); // default: private
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const valid = validateClassroomDraft({ className });

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
          roomType: isPublic ? 'public' : 'private',
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

        <div className="ccmodal__toggle">
          <div>
            <span className="ccmodal__toggle-label">Public classroom</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isPublic}
            className={`ccmodal__switch ${isPublic ? 'ccmodal__switch--on' : ''}`}
            onClick={() => setIsPublic((v) => !v)}
          >
            <span className="ccmodal__switch-knob" />
          </button>
        </div>

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
