import { useNavigate } from 'react-router-dom';
import './landing/index.css'
import Navbar from './landing/Navbar'
import HeroSection from './landing/HeroSection'
import ExperienceGallery from './landing/ExperienceGallery'
import PlatformSection from './landing/PlatformSection'
import CTASection from './landing/CTASection'
import Footer from './landing/Footer'

export default function LandingPage() {
  const navigate = useNavigate();

  const handleEnter = (room) => {
    const code = room.replace(/\s+/g, '');
    navigate(`/scene/${code}`);
  };

  return (
    <>
      <Navbar />
      <main>
        <HeroSection />
        <ExperienceGallery onCourse={handleEnter} />
        <PlatformSection />
        <CTASection />
      </main>
      <Footer />
    </>
  )
}
