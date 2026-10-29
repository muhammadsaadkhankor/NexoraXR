import { Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './landing/pages/LandingPage';
import Scene from './classroom/Scene';
import CoursePage from './classroom/CoursePage';
import AdminPage from './admin/AdminPage';
import ManagePanel from './manage/ManagePanel';
import SignInPage from './auth/SignInPage';

export default function App() {
  return (
    <Routes>
      <Route path='/' element={<LandingPage />} />
      <Route path='/classroom/:sceneName' element={<Scene />} />
      {/* Legacy: /scene/<SceneKey> still works — the canonical-slug check
          inside Scene rewrites room-bound links to /classroom/<slug>. */}
      <Route path='/scene/:sceneName' element={<Scene />} />
      <Route path='/course/:courseId' element={<CoursePage />} />
      <Route path='/admin' element={<AdminPage />} />
      <Route path='/panel' element={<ManagePanel />} />
      <Route path='/signin' element={<SignInPage />} />
      <Route path='*' element={<Navigate to='/' replace />} />
    </Routes>
  );
}
