import Navbar from './components/Navbar'
import HeroSection from './components/HeroSection'
import ExperienceGallery from './components/ExperienceGallery'
import PlatformSection from './components/PlatformSection'
import CTASection from './components/CTASection'
import Footer from './components/Footer'
import AnimatedSection from './components/AnimatedSection'

function App() {
  return (
    <>
      <Navbar />
      <main>
        <HeroSection />
        <AnimatedSection>
          <ExperienceGallery />
        </AnimatedSection>
        <AnimatedSection>
          <PlatformSection />
        </AnimatedSection>
        <AnimatedSection>
          <CTASection />
        </AnimatedSection>
      </main>
      <Footer />
    </>
  )
}

export default App
