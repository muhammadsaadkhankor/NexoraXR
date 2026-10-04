import { Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './landing/pages/LandingPage';
import Scene from './classroom/Scene';
import CoursePage from './classroom/CoursePage';

export default function App() {
  return (
    <Routes>
      <Route path='/' element={<LandingPage />} />
      <Route path='/scene/:sceneName' element={<Scene />} />
      <Route path='/course/:courseId' element={<CoursePage />} />
      <Route path='*' element={<Navigate to='/' replace />} />
    </Routes>
  );
}
