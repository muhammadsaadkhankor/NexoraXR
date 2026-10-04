import { useNavigate } from 'react-router-dom';
import '../styles/index.css'
import Navbar from '../components/Navbar'
import HeroSection from '../components/HeroSection'
import ExperienceGallery from '../components/ExperienceGallery'
import PlatformSection from '../components/PlatformSection'
import CTASection from '../components/CTASection'
import Footer from '../components/Footer'

export default function LandingPage() {
  const navigate = useNavigate();

  const handleEnter = (room) => {
    const code = room.replace(/\s+/g, '');
    navigate(`/course/${code}`);
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
