import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Loader2 } from 'lucide-react';
import { getLectures } from './services/lectureApi';

export default function CoursePage() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Room joins carry their identity through the picker — guests keep their
  // invite token so private admission still applies after lecture selection.
  const roomQuery = ['room', 'invite']
    .filter((k) => searchParams.get(k))
    .map((k) => `${k}=${encodeURIComponent(searchParams.get(k))}`)
    .join('&');
  const [lectures, setLectures] = useState([]);
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getLectures()
      .then((data) => {
        setCourse(data.course);
        setLectures(data.lectures);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const handleSelect = (lecture) => {
    navigate(`/scene/${courseId}?lecture=${lecture.lecture_id}${roomQuery ? `&${roomQuery}` : ''}`);
  };

  return (
    <div className='relative min-h-screen overflow-hidden bg-[#07050f] text-slate-100'>
      {/* WuFlux aurora backdrop — matches the landing page */}
      <div className='pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[720px] -translate-x-1/2 rounded-full bg-violet-600/20 blur-[140px]' />
      <div className='pointer-events-none absolute -left-40 top-1/3 h-[380px] w-[380px] rounded-full bg-cyan-500/15 blur-[120px]' />
      <div className='pointer-events-none absolute -right-40 bottom-0 h-[420px] w-[420px] rounded-full bg-indigo-600/15 blur-[140px]' />

      <div className='container relative mx-auto max-w-3xl px-4 py-8'>
        <button
          onClick={() => navigate('/')}
          className='mb-10 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-slate-300 backdrop-blur transition hover:border-white/25 hover:text-white'
        >
          <ArrowLeft size={15} /> Home
        </button>

        <div className='mb-10'>
          <h1 className='bg-gradient-to-r from-white via-cyan-100 to-violet-200 bg-clip-text text-4xl font-extrabold text-transparent sm:text-5xl'>
            Course: {course?.title || courseId}
          </h1>
          <p className='mt-3 max-w-lg text-slate-400'>
            Select a lecture to step into the virtual classroom.
          </p>
        </div>

        {loading && (
          <div className='flex flex-col items-center justify-center gap-3 py-20 text-slate-400'>
            <Loader2 className='animate-spin' size={32} />
            <p>Loading lectures…</p>
            <p className='text-xs text-slate-500'>This may take a few seconds</p>
          </div>
        )}

        {error && (
          <div className='rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-red-200'>
            {error}
          </div>
        )}

        {!loading && (
          <div className='flex flex-col gap-3'>
            {lectures.map((lecture, i) => {
              const number = String(Number(lecture.lecture_id.replace(/\D/g, '')) || 0).padStart(2, '0');
              return (
                <button
                  key={lecture.lecture_id}
                  onClick={() => handleSelect(lecture)}
                  className='group flex items-center gap-5 rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-5 text-left backdrop-blur transition duration-200 hover:-translate-y-0.5 hover:border-cyan-400/50 hover:bg-white/[0.07] hover:shadow-[0_12px_40px_-12px_rgba(34,211,238,0.35)]'
                >
                  <span className='flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600/40 to-cyan-500/40 text-xs font-extrabold tracking-wide text-cyan-200 ring-1 ring-white/15 transition group-hover:from-violet-600/60 group-hover:to-cyan-500/60 group-hover:text-white'>
                    {number}
                  </span>
                  <div className='min-w-0 flex-1'>
                    <p className='text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-400/80'>
                      Lecture {number}
                    </p>
                    <h3 className='mt-0.5 truncate text-base font-semibold text-white'>
                      {lecture.title}
                    </h3>
                    {lecture.subtitle && (
                      <p className='mt-0.5 truncate text-sm text-slate-400'>{lecture.subtitle}</p>
                    )}
                  </div>
                  <ChevronRight
                    size={20}
                    className='shrink-0 text-slate-500 transition group-hover:translate-x-1 group-hover:text-cyan-300'
                  />
                </button>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
}
