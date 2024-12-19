import { Loader } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Leva } from "leva";
import { useState, useCallback } from "react";
import { Scenario } from "./components/Scenario";
import { ChatInterface } from "./components/ChatInterface";
import AvatarFileSelector from "./components/AvatarFileSelector";

function App() {
  const [currentAvatarPath, setCurrentAvatarPath] = useState('/models/ProfAbed_VR.glb');

  const handleAvatarChange = useCallback((newPath) => {
    console.log('Setting new avatar path:', newPath);
    setCurrentAvatarPath(newPath);
  }, []);

  return (
    <>
      <Loader />
      <Leva collapsed hidden/>
      <ChatInterface />
      <AvatarFileSelector onAvatarChange={handleAvatarChange} />
      <Canvas shadows camera={{ position: [0, 0, 0], fov: 10 }}>
        <Scenario currentAvatarPath={currentAvatarPath} key={currentAvatarPath} />
      </Canvas>
    </>
  );
}

export default App;