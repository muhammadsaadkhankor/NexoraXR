import { useEffect, useState } from 'react';
import { Loader2, X, ArrowRight } from 'lucide-react';
import lectureDetails from '../constants/lectureDetails';
import { API_URL } from '../config';

export default function LecturePicker({ onSelect, onCancel }) {
  const [lectures, setLectures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/api/lectures`)
      .then((r) => r.json())
      .then((data) => {
        setLectures(data.lectures);
        setSelectedId(data.lectures[0]?.lecture_id || null);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const selected = lectures.find((l) => l.lecture_id === selectedId);
  const selectedNumber = selected ? String(Number(selected.lecture_id.replace(/\D/g, '')) || 0).padStart(2, '0') : '01';
  const details = selected ? lectureDetails[selected.lecture_id] : null;

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-6 backdrop-blur-sm'>
      <div className='flex h-[90vh] w-full max-w-6xl flex-col rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-2xl'>
        {/* Header */}
        <div className='mb-6 flex items-start justify-between'>
          <div>
            <p className='mb-1 text-xs font-semibold tracking-widest text-amber-400'>
              MISSION CONTROL / {selectedNumber}
            </p>
            <h2 className='text-3xl font-bold text-slate-100'>Choose a lecture mission.</h2>
          </div>
          <button
            onClick={onCancel}
            className='flex h-10 w-10 items-center justify-center rounded-full bg-slate-900 text-slate-400 transition hover:bg-slate-800 hover:text-white'
          >
            <X size={20} />
          </button>
        </div>

        {loading && (
          <div className='flex flex-1 items-center justify-center gap-2 text-slate-400'>
            <Loader2 className='animate-spin' size={24} /> Loading missions...
          </div>
        )}

        {error && (
          <div className='flex flex-1 items-center justify-center text-red-300'>
            {error}
          </div>
        )}

        {!loading && !error && selected && (
          <div className='grid flex-1 gap-6 lg:grid-cols-[1.5fr_1fr] lg:overflow-hidden'>
            {/* Left — lecture list */}
            <div className='space-y-3 overflow-y-auto pr-2'>
              {lectures.map((lecture) => {
                const number = String(Number(lecture.lecture_id.replace(/\D/g, '')) || 0).padStart(2, '0');
                const meta = lectureDetails[lecture.lecture_id] || {};
                const isSelected = lecture.lecture_id === selectedId;
                return (
                  <button
                    key={lecture.lecture_id}
                    onClick={() => setSelectedId(lecture.lecture_id)}
                    className={`flex w-full items-center gap-4 rounded-xl border p-4 text-left transition ${
                      isSelected
                        ? 'border-amber-500/60 bg-slate-900'
                        : 'border-slate-800 bg-slate-950 hover:border-slate-600 hover:bg-slate-900'
                    }`}
                  >
                    <span className='w-8 text-sm font-bold text-amber-400'>{number}</span>
                    <div className='flex-1'>
                      <h3 className='font-semibold text-slate-100'>{lecture.title}</h3>
                      <p className='mt-1 text-sm text-slate-400'>{meta.subtitle}</p>
                    </div>
                    <ArrowRight className='text-slate-500' size={20} />
                  </button>
                );
              })}
            </div>

            {/* Right — selected mission panel */}
            <div className='flex flex-col justify-between overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-6'>
              <div>
                <p className='mb-2 text-xs font-semibold tracking-widest text-amber-400'>
                  SELECTED MISSION · LECTURE / {selectedNumber}
                </p>
                <h3 className='mb-3 text-2xl font-bold text-slate-100'>{selected.title}</h3>
                <p className='mb-6 text-sm leading-relaxed text-slate-300'>
                  {details?.subtitle}
                </p>

                <div className='mb-4 border-t border-slate-700 pt-4'>
                  <p className='mb-3 text-xs font-semibold tracking-widest text-slate-500'>
                    QUESTIONS YOU CAN EXPLORE
                  </p>
                  <ul className='space-y-3'>
                    {details?.questions?.map((q, i) => (
                      <li key={i} className='border-b border-slate-700 pb-2 text-sm text-slate-300'>
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className='mb-4 border-t border-slate-700 pt-4'>
                  <p className='mb-3 text-xs font-semibold tracking-widest text-slate-500'>
                    LECTURE PDF
                  </p>
                  <iframe
                    src={`${API_URL}/api/lecture/pdf/${selected.lecture_id}`}
                    title='Lecture PDF'
                    className='h-64 w-full rounded-lg border border-slate-700 bg-slate-950'
                  />
                </div>
              </div>

              <button
                onClick={() => onSelect(selected.lecture_id)}
                className='mt-4 flex items-center justify-between rounded-lg border border-amber-500/60 bg-amber-500/10 px-5 py-4 text-left transition hover:bg-amber-500/20'
              >
                <div>
                  <p className='text-xs font-semibold tracking-widest text-amber-400'>
                    START CLASS
                  </p>
                </div>
                <ArrowRight className='text-amber-400' size={20} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
