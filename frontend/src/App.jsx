import { Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './LandingPage';
import Scene from './Scene';

export default function App() {
  return (
    <Routes>
      <Route path='/' element={<LandingPage />} />
      <Route path='/scene/:sceneName' element={<Scene />} />
      <Route path='*' element={<Navigate to='/' replace />} />
    </Routes>
  );
}
