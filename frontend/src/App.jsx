import { Loader } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Leva } from "leva";
import { useState, useCallback, useRef, useEffect } from "react";
import { Camera, User } from "lucide-react";
import { Scenario } from "./components/Scenario";
import { ChatInterface } from "./components/ChatInterface";
import SettingsPanel from "./components/SettingsPanel";
import ContinuousRecorder from "./components/ContinuousRecorder";

function App() {
  // State for managing the current avatar
  const [currentAvatarPath, setCurrentAvatarPath] = useState('/assets/avatar/ProfAbed_suit.glb');

  // User avatar camera mode: third-person or first-person
  const [cameraPreset, setCameraPreset] = useState('third-person');

  // Avatar picker dropdown
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);

  // Proximity chat gating
  const [inRange, setInRange] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    setChatOpen(inRange);
  }, [inRange]);

  // Reference to the canvas element for video recording
  const canvasRef = useRef(null);

  // Callback for handling avatar changes
  const handleAvatarChange = useCallback((newPath) => {
    console.log('Setting new avatar path:', newPath);
    setCurrentAvatarPath(newPath);
  }, []);

  const toggleCamera = useCallback(() => {
    setCameraPreset((prev) => (prev === 'third-person' ? 'first-person' : 'third-person'));
  }, []);

  const OUTFITS = [
    { path: '/assets/avatar/ProfAbed_suit.glb', label: 'Suit' },
    { path: '/assets/avatar/ProfAbed_arabdress.glb', label: 'Arab Dress' },
    { path: '/assets/avatar/ProfAbed_BlackTshirt.glb', label: 'Black T-Shirt' },
    { path: '/assets/avatar/ProfAbed_Soccer.glb', label: 'Soccer' },
    { path: '/assets/avatar/ProfAbed_VR.glb', label: 'VR' },
    { path: '/assets/avatar/ProfRalf.glb', label: 'Prof Ralf' },
  ];

  const onPickAvatar = useCallback((path) => {
    handleAvatarChange(path);
    setShowAvatarMenu(false);
  }, [handleAvatarChange]);

  return (
    <div className="relative w-screen h-screen">
      {/* Core UI components */}
      <Loader />
      <Leva collapsed hidden />

      {/* Chat panel - only visible when in range and opened */}
      <ChatInterface
        hidden={!chatOpen}
        onMinimize={() => setChatOpen(false)}
      />

      {/* Settings and Controls */}
      <div className="relative z-20">
        <SettingsPanel />
        <ContinuousRecorder />
      </div>

      {/* Top-right icon bar: camera + avatar */}
      <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
        <div className="relative">
          <button
            onClick={() => setShowAvatarMenu((v) => !v)}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-700 text-white shadow-lg transition hover:bg-slate-600"
            title="Change professor avatar"
          >
            <User size={18} />
          </button>

          {showAvatarMenu && (
            <div className="absolute right-0 top-12 w-48 rounded-xl bg-slate-800/95 py-2 text-sm text-white shadow-2xl ring-1 ring-slate-600/50 backdrop-blur">
              {OUTFITS.map((o) => (
                <button
                  key={o.path}
                  onClick={() => onPickAvatar(o.path)}
                  className={`w-full px-4 py-2 text-left transition hover:bg-slate-700 ${
                    o.path === currentAvatarPath ? 'text-cyan-400' : ''
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={toggleCamera}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-700 text-white shadow-lg transition hover:bg-slate-600"
          title="Toggle camera"
        >
          <Camera size={18} />
        </button>
      </div>

      {/* 3D Canvas */}
      <Canvas
        ref={canvasRef}
        shadows
        camera={{ position: [0, 0, 0], fov: 35 }}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh'
        }}
      >
        <Scenario
          currentAvatarPath={currentAvatarPath}
          key={currentAvatarPath}
          cameraPreset={cameraPreset}
          setCameraPreset={setCameraPreset}
          onInRangeChange={setInRange}
        />
      </Canvas>
    </div>
  );
}

export default App;
