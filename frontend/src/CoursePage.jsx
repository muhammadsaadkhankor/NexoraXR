import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { getLectures } from './services/lectureApi';

export default function CoursePage() {
  const { courseId } = useParams();
  const navigate = useNavigate();
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
    navigate(`/scene/${courseId}?lecture=${lecture.lecture_id}`);
  };

  return (
    <div className='min-h-screen bg-slate-950 text-slate-100'>
      <div className='container mx-auto px-4 py-8'>
        <button
          onClick={() => navigate('/')}
          className='mb-6 flex items-center gap-2 text-sm text-slate-400 hover:text-cyan-400'
        >
          <ArrowLeft size={18} /> Back
        </button>

        <div className='mb-8'>
          <h1 className='text-3xl font-bold text-cyan-400'>{course?.title || courseId}</h1>
          <p className='mt-2 text-slate-400'>Select a lecture to enter the virtual classroom.</p>
        </div>

        {loading && (
          <div className='flex flex-col items-center justify-center gap-3 py-20 text-slate-400'>
            <Loader2 className='animate-spin' size={32} />
            <p>Loading scene assets and models...</p>
            <p className='text-xs text-slate-500'>This may take a few seconds</p>
          </div>
        )}

        {error && (
          <div className='rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-red-200'>
            {error}
          </div>
        )}

        {!loading && (
          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
            {lectures.map((lecture) => {
              const number = String(Number(lecture.lecture_id.replace(/\D/g, '')) || 0).padStart(2, '0');
              return (
                <button
                  key={lecture.lecture_id}
                  onClick={() => handleSelect(lecture)}
                  className='flex flex-col items-start rounded-2xl border border-slate-800 bg-slate-900/80 p-5 text-left transition hover:border-cyan-500/50 hover:bg-slate-800'
                >
                  <span className='mb-1 text-xs font-bold text-cyan-400'>LECTURE {number}</span>
                  <h3 className='text-lg font-semibold'>{lecture.title}</h3>
                  {lecture.subtitle && <p className='mt-1 text-sm text-slate-400'>{lecture.subtitle}</p>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
