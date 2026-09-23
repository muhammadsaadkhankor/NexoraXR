import { Suspense, useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { io } from 'socket.io-client';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, User, Users } from 'lucide-react';
import { Scenario } from './components/Scenario';
import { ChatInterface } from './components/ChatInterface';
import { Joystick } from './components/Joystick';
import SettingsPanel from './components/SettingsPanel';
import ContinuousRecorder from './components/ContinuousRecorder';

import { SCENE_CONFIG } from './sceneConfig';
import { useSpeech } from './hooks/useSpeech';

const runtimeConfigModules = import.meta.glob('./scenes/configs/*.json', { eager: true });

const USER_AVATARS = [
  { path: '/assets/useravatar/avatars/UserAvatar.glb', name: 'Alex' },
  { path: '/assets/useravatar/avatars/anim_female_1.glb', name: 'Ava' },
  { path: '/assets/useravatar/avatars/anim_female_2.glb', name: 'Luna' },
  { path: '/assets/useravatar/avatars/anim_female_3.glb', name: 'Sofia' },
  { path: '/assets/useravatar/avatars/anim_female_4.glb', name: 'Mira' },
  { path: '/assets/useravatar/avatars/anim_male_1.glb', name: 'Zayn' },
  { path: '/assets/useravatar/avatars/anim_male_2.glb', name: 'Leo' },
  { path: '/assets/useravatar/avatars/anim_male_3.glb', name: 'Omar' },
  { path: '/assets/useravatar/avatars/anim_male_4.glb', name: 'Kian' },
];

function LoadingOverlay({ visible }) {
  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/95 text-white backdrop-blur-md transition-opacity duration-500 ease-out ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      <div className='h-10 w-10 animate-spin rounded-full border-4 border-slate-700 border-t-cyan-400' />
      <p className='mt-4 text-lg font-medium text-slate-300'>Preparing assets in scene...</p>
    </div>
  );
}

function AvatarPreviewModel({ path }) {
  const group = useRef();
  const { scene } = useGLTF(path);
  const model = useMemo(() => scene.clone(), [scene]);

  useLayoutEffect(() => {
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const max = Math.max(size.x, size.y, size.z);
    const s = 2.2 / max;
    model.position.set(-center.x, -1 - box.min.y * s, -center.z);
    model.scale.set(s, s, s);
  }, [model]);

  useFrame((_, delta) => {
    if (group.current) {
      group.current.rotation.y += delta * 0.8;
    }
  });

  return (
    <group ref={group} position={[0, 0, 0]}>
      <primitive object={model} />
    </group>
  );
}

function AvatarPreview({ path }) {
  return (
    <div className='h-28 w-28 overflow-hidden rounded-full bg-slate-800 shadow-inner'>
      <Canvas
        camera={{ position: [0, 0.6, 3.5], fov: 40 }}
        gl={{ antialias: false, alpha: false }}
        frameloop='always'
        className='h-full w-full'
      >
        <color attach='background' args={['#0f172a']} />
        <ambientLight intensity={0.8} />
        <directionalLight position={[2, 4, 3]} intensity={1.2} />
        <AvatarPreviewModel path={path} />
      </Canvas>
    </div>
  );
}

function AvatarPicker({ avatars, onPick }) {
  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 text-white backdrop-blur-sm'>
      <div className='w-full max-w-2xl rounded-3xl border border-slate-700/50 bg-slate-900/70 p-6 shadow-2xl sm:p-8'>
        <h2 className='text-center text-3xl font-bold text-white'>Change Your Avatar</h2>
        <p className='mt-2 text-center text-slate-400'>Pick a different avatar.</p>
        <div className='mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4'>
          {avatars.map((a) => (
            <button
              key={a.path}
              onClick={() => onPick(a.path)}
              className='group flex flex-col items-center gap-3 rounded-2xl border border-slate-700 bg-slate-800/50 p-4 transition hover:border-cyan-500/50 hover:bg-slate-800'
            >
              <div className='flex h-28 w-28 items-center justify-center rounded-full ring-2 ring-slate-700/50'>
                <AvatarPreview path={a.path} />
              </div>
              <span className='text-base font-semibold text-slate-100'>{a.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function CourseInfo({ config, onStartClass, showStart }) {
  if (!config) return null;
  return (
    <div className='fixed left-4 top-4 z-40 max-w-xs rounded-xl border border-slate-700/50 bg-slate-900/80 p-4 text-white shadow-2xl backdrop-blur'>
      <h2 className='text-lg font-bold text-cyan-400'>{config.title}</h2>
      <p className='text-sm text-slate-300'>{config.category}</p>
      <p className='mt-2 text-sm leading-relaxed text-slate-200'>{config.courseContent}</p>
      {showStart && (
        <button
          onClick={onStartClass}
          className='mt-4 w-full rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400'
        >
          Start Class
        </button>
      )}
    </div>
  );
}

function NotFound({ sceneName }) {
  const navigate = useNavigate();
  return (
    <div className='flex h-screen w-screen flex-col items-center justify-center bg-slate-950 text-white'>
      <h1 className='text-3xl font-bold'>Scene not found</h1>
      <p className='mt-2 text-slate-400'>
        No classroom is configured for <code className='rounded bg-slate-800 px-1'>{sceneName}</code>.
      </p>
      <button
        onClick={() => navigate('/')}
        className='mt-6 rounded-full bg-cyan-500 px-6 py-2 font-semibold text-slate-950 transition hover:bg-cyan-400'
      >
        Back to landing
      </button>
    </div>
  );
}

export default function Scene() {
  const { sceneName } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const lectureId = searchParams.get('lecture');
  const baseConfig = SCENE_CONFIG[sceneName];

  if (!baseConfig) {
    return <NotFound sceneName={sceneName} />;
  }

  const runtimeConfig = useMemo(() => {
    const m = runtimeConfigModules[`./scenes/configs/${sceneName}.json`];
    if (!m) {
      console.warn(`[Scene] No runtime config found for ${sceneName}; using defaults.`);
      return null;
    }
    return m.default;
  }, [sceneName]);

  const config = useMemo(() => {
    const defaults = {
      defaultLookAt: baseConfig.assistant?.position ? [...baseConfig.assistant.position] : [0, 1.0, -6],
      modelUrl: baseConfig.modelUrl,
      environmentPreset: baseConfig.environmentPreset,
      title: baseConfig.title,
      category: baseConfig.category,
      courseContent: baseConfig.courseContent,
      userStart: baseConfig.userStart,
      assistant: {
        ...baseConfig.assistant,
        rotation: [0, 0, 0],
      },
      cameraBounds: { min: [-20, 0, -20], max: [20, 10, 20] },
    };
    if (!runtimeConfig) return { ...baseConfig, ...defaults };

    const toRot = (r, fallback) => {
      if (Array.isArray(r)) return [...r];
      if (typeof r === 'number') return [0, r, 0];
      return fallback;
    };

    const modelUrl = runtimeConfig.sceneModel?.url ?? baseConfig.modelUrl;
    const modelPosition = runtimeConfig.sceneModel?.position ?? [0, 0, 0];
    const modelRotation = toRot(runtimeConfig.sceneModel?.rotation, [0, 0, 0]);
    const modelScale = runtimeConfig.sceneModel?.scale ?? [1, 1, 1];
    const cameraBounds = runtimeConfig.sceneCamera?.bounds ?? defaults.cameraBounds;
    const defaultLookAt = runtimeConfig.sceneCamera?.defaultLookAt ?? defaults.defaultLookAt;

    const userPosition = runtimeConfig.userSpawn?.position ?? baseConfig.userStart.position;
    const userRotation = toRot(runtimeConfig.userSpawn?.rotation, baseConfig.userStart.rotation);
    const userScale = runtimeConfig.userSpawn?.scale ?? [1, 1, 1];
    const professorPosition = runtimeConfig.professorSpawn?.position ?? baseConfig.assistant.position;
    const professorRotation = toRot(runtimeConfig.professorSpawn?.rotation, [0, 0, 0]);
    const professorScale = runtimeConfig.professorSpawn?.scale ?? [1.2, 1.2, 1.2];

    return {
      ...baseConfig,
      modelUrl,
      modelTransform: { position: modelPosition, rotation: modelRotation, scale: modelScale },
      environmentPreset: baseConfig.environmentPreset,
      userStart: {
        position: userPosition,
        rotation: userRotation,
        scale: userScale,
        animation: baseConfig.userStart.animation ?? 'Idle',
      },
      assistant: {
        position: professorPosition,
        rotation: professorRotation,
        scale: professorScale,
        animation: baseConfig.assistant.animation ?? 'Idle',
      },
      cameraBounds,
      defaultLookAt,
    };
  }, [baseConfig, runtimeConfig]);

  const [currentAvatarPath, setCurrentAvatarPath] = useState('/assets/avatar/ProfAbed_suit.glb');
  const [userAvatarPath, setUserAvatarPath] = useState(() => {
    const i = Math.floor(Math.random() * USER_AVATARS.length);
    return USER_AVATARS[i].path;
  });
  const [cameraPreset, setCameraPreset] = useState('third-person');
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [inRange, setInRange] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [showUserAvatar] = useState(true);
  const [myId, setMyId] = useState(null);
  const [remotePlayers, setRemotePlayers] = useState({});
  const [sceneReady, setSceneReady] = useState(false);
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const joinedRef = useRef(false);
  const { message, pushMessage, requestMicrophoneAccess } = useSpeech();
  const lastEmittedMessageIdRef = useRef(new Set());
  const joystick = useRef({ x: 0, y: 0 });
  const [showJoystick, setShowJoystick] = useState(false);
  const isMultimedia = sceneName === 'Multimedia';

  const handleLectureSelect = async (lectureId) => {
    try {
      const res = await fetch(`http://localhost:3000/api/lecture/summary/${lectureId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Summary not ready');
      const audioUrl = data.audioUrl ? `http://localhost:3000${data.audioUrl}` : null;
      if (!audioUrl) throw new Error('Audio not ready yet. Run prep_tts.py first.');
      pushMessage({
        text: data.text,
        audioUrl,
        animation: data.animation || 'explain',
        facialExpression: data.facialExpression || 'smile',
        lipsync: data.lipsync,
      });
    } catch (err) {
      alert(err.message);
    }
  };

  useEffect(() => {
    const detect = () => {
      const isTouch =
        window.matchMedia('(pointer: coarse)').matches ||
        'ontouchstart' in window ||
        navigator.maxTouchPoints > 0;
      const isMobileViewport = window.innerWidth < 1024;
      setShowJoystick(isTouch && isMobileViewport);
    };
    detect();
    window.addEventListener('resize', detect);
    return () => window.removeEventListener('resize', detect);
  }, []);

  useEffect(() => {
    setChatOpen(inRange);
  }, [inRange]);

  useEffect(() => {
    if (socketRef.current) return;
    const socket = io('http://localhost:3000', {
      transports: ['websocket', 'polling'],
      reconnection: !import.meta.env.DEV,
      reconnectionAttempts: 2,
      reconnectionDelay: 3000,
      timeout: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[client] socket connected, id:', socket.id);
      setMyId(socket.id);
    });

    socket.on('room-state', (players) => {
      console.log('[client] room-state received:', players.length, players.map((p) => p.userId));
      const map = {};
      for (const p of players) map[p.userId] = p;
      setRemotePlayers(map);
    });

    socket.on('state-update', (player) => {
      console.log('[client] state-update received:', player.userId, player.position, player.animation);
      setRemotePlayers((prev) => ({ ...prev, [player.userId]: player }));
    });

    socket.on('user-joined', (player) => {
      console.log('[client] user-joined received:', player.userId, player);
      setRemotePlayers((prev) => ({ ...prev, [player.userId]: player }));
    });

    socket.on('user-left', ({ userId }) => {
      console.log('[client] user-left received:', userId);
      setRemotePlayers((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    });

    socket.on('disconnect', () => {
      console.log('[client] socket disconnected');
      setMyId(null);
      joinedRef.current = false;
    });

    socket.on('professor-speak', (data) => {
      console.log('[client] professor-speak received:', data?.text);
      pushMessage(data, true);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [pushMessage]);

  useEffect(() => {
    if (!message || message.fromRemote) return;
    if (!message.id) return;
    if (lastEmittedMessageIdRef.current.has(message.id)) return;
    lastEmittedMessageIdRef.current.add(message.id);
    socketRef.current?.emit('professor-speak', message);
  }, [message]);

  useEffect(() => {
    if (myId && !joinedRef.current && socketRef.current?.connected) {
      joinedRef.current = true;
      socketRef.current.emit('join', {
        roomId: sceneName,
        name: 'Player',
        avatar: userAvatarPath,
        position: config.userStart.position,
        rotation: config.userStart.rotation[1] ?? Math.PI,
        animation: config.userStart.animation,
      });
    }
  }, [myId, sceneName, userAvatarPath, config]);

  const onSceneReady = useCallback(() => {
    setSceneReady(true);
  }, []);

  useEffect(() => {
    if (sceneReady) {
      requestMicrophoneAccess().catch(() => {});
    }
  }, [sceneReady, requestMicrophoneAccess]);

  const emitUserState = useCallback((data) => {
    socketRef.current?.emit('state-update', data);
  }, []);

  const others = useMemo(() => Object.values(remotePlayers).filter((p) => p.userId !== myId), [remotePlayers, myId]);

  const handleAvatarChange = useCallback((newPath) => {
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
    <div className='relative h-screen w-screen bg-slate-950'>
      <LoadingOverlay visible={!sceneReady} />

      {showAvatarPicker && (
        <AvatarPicker
          avatars={USER_AVATARS}
          onPick={(path) => {
            setUserAvatarPath(path);
            setShowAvatarPicker(false);
          }}
        />
      )}

      {sceneReady && (
        <>
          <CourseInfo
            config={config}
            showStart={isMultimedia && !!lectureId}
            onStartClass={() => lectureId && handleLectureSelect(lectureId)}
          />

          <ChatInterface hidden={!chatOpen} onMinimize={() => setChatOpen(false)} />

          <Joystick joystick={joystick} hidden={!showJoystick} />

          <div className='relative z-20'>
            <SettingsPanel />
            <ContinuousRecorder />
          </div>

          <div className='fixed right-4 top-4 z-50 flex items-center gap-2'>
            <button
              onClick={() => setShowAvatarPicker(true)}
              className='flex h-10 w-10 items-center justify-center rounded-full bg-slate-700 text-white shadow-lg transition hover:bg-slate-600'
              title='Change user avatar'
            >
              <Users size={18} />
            </button>

            <div className='relative'>
              <button
                onClick={() => setShowAvatarMenu((v) => !v)}
                className='flex h-10 w-10 items-center justify-center rounded-full bg-slate-700 text-white shadow-lg transition hover:bg-slate-600'
                title='Change professor avatar'
              >
                <User size={18} />
              </button>

              {showAvatarMenu && (
                <div className='absolute right-0 top-12 w-48 rounded-xl bg-slate-800/95 py-2 text-sm text-white shadow-2xl ring-1 ring-slate-600/50 backdrop-blur'>
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
              className='flex h-10 w-10 items-center justify-center rounded-full bg-slate-700 text-white shadow-lg transition hover:bg-slate-600'
              title='Toggle camera'
            >
              <Camera size={18} />
            </button>
          </div>
        </>
      )}

      <Canvas
        ref={canvasRef}
        dpr={[1, 1]}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{ position: [0, 0, 0], fov: 35 }}
        className='fixed left-0 top-0 transition-opacity duration-500 ease-out'
        style={{
          width: '100vw',
          height: '100vh',
          opacity: sceneReady ? 1 : 0,
          pointerEvents: sceneReady ? 'auto' : 'none',
        }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            console.error('[Canvas] WebGL context lost', e);
          });
          gl.domElement.addEventListener('webglcontextrestored', () => {
            console.log('[Canvas] WebGL context restored');
          });
        }}
      >
        <Suspense fallback={null}>
          <Scenario
            currentAvatarPath={currentAvatarPath}
            userAvatarPath={userAvatarPath}
            showUserAvatar={showUserAvatar}
            remotePlayers={others}
            onUserState={emitUserState}
            joystick={joystick}
            cameraPreset={cameraPreset}
            setCameraPreset={setCameraPreset}
            onInRangeChange={setInRange}
            onReady={onSceneReady}
            modelUrl={config.modelUrl}
            environmentPreset={config.environmentPreset}
            userStart={config.userStart}
            professorStart={config.assistant}
            cameraBounds={config.cameraBounds}
            defaultLookAt={config.defaultLookAt}
            modelTransform={config.modelTransform}
            lectureId={lectureId}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}
