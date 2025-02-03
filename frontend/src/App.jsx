import { Loader } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Leva } from "leva";
import { useState, useCallback, useRef } from "react";
import { Scenario } from "./components/Scenario";
import { ChatInterface } from "./components/ChatInterface";
import AvatarFileSelector from "./components/AvatarFileSelector";
import SettingsPanel from "./components/SettingsPanel";
import ContinuousRecorder from "./components/ContinuousRecorder";

function App() {
  // State for managing the current avatar
  const [currentAvatarPath, setCurrentAvatarPath] = useState('/models/ProfAbed_suit.glb');
  
  // Reference to the canvas element for video recording
  const canvasRef = useRef(null);

  // Callback for handling avatar changes
  const handleAvatarChange = useCallback((newPath) => {
    console.log('Setting new avatar path:', newPath);
    setCurrentAvatarPath(newPath);
  }, []);

  return (
    <div className="relative w-screen h-screen">
      {/* Core UI components */}
      <Loader />
      <Leva collapsed hidden />

      {/* Chat and Control Interface */}
      <ChatInterface />
      
      {/* Settings and Controls */}
      <div className="relative z-20">
        <AvatarFileSelector onAvatarChange={handleAvatarChange} />
        <SettingsPanel />
        <ContinuousRecorder />
      </div>

      {/* 3D Canvas */}
      <Canvas
        ref={canvasRef}
        shadows
        camera={{ position: [0, 0, 0], fov: 10 }}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'linear-gradient(19deg, #060606 0%, #ddd6f3 100%)'
        }}
      >
        <Scenario 
          currentAvatarPath={currentAvatarPath} 
          key={currentAvatarPath}
        />
      </Canvas>
    </div>
  );
}

export default App;