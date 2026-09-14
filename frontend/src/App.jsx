import { Suspense, useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { io } from 'socket.io-client';
import { Camera, User, Users, Play, Search, ArrowRight, Box, Globe, Star, Bot, Code, Brain, Monitor } from 'lucide-react';
import { Scenario } from './components/Scenario';
import { ChatInterface } from './components/ChatInterface';
import { Joystick } from './components/Joystick';
import SettingsPanel from './components/SettingsPanel';
import ContinuousRecorder from './components/ContinuousRecorder';

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

function LandingPage({ onEnter }) {
  const courses = [
    { id: 'ELC5121', title: 'ELC5121', name: 'Embodied Conversational AI Classroom', modules: 12, weeks: 4, tag: 'New', category: 'AI', rating: '4.8', students: '12.4k', icon: Bot, color: 'from-violet-600 to-fuchsia-700' },
    { id: 'COM 101', title: 'COM 101', name: 'Introduction to Communication', modules: 10, weeks: 3, tag: 'Popular', category: 'Comm', rating: '4.7', students: '8.9k', icon: Users, color: 'from-cyan-600 to-blue-700' },
    { id: 'CS 201', title: 'CS 201', name: 'Data Structures & Algorithms', modules: 14, weeks: 6, tag: null, category: 'CS', rating: '4.9', students: '15.2k', icon: Code, color: 'from-blue-600 to-indigo-700' },
    { id: 'AI 301', title: 'AI 301', name: 'Artificial Intelligence Fundamentals', modules: 16, weeks: 6, tag: null, category: 'AI', rating: '4.9', students: '11.7k', icon: Brain, color: 'from-cyan-600 to-teal-700' },
    { id: 'HCI 401', title: 'HCI 401', name: 'Human-Computer Interaction', modules: 12, weeks: 5, tag: null, category: 'HCI', rating: '4.6', students: '9.3k', icon: Monitor, color: 'from-rose-600 to-orange-700' },
  ];

  const page = 'mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8';

  return (
    <div className='w-full bg-[#03060d] text-slate-50'>
      <nav className='fixed top-0 left-0 right-0 z-50 h-16 border-b border-slate-800/40 bg-[#03060d]/85 backdrop-blur-md'>
        <div className={page + ' flex h-full items-center justify-between'}>
          <div className='flex items-center gap-2 text-xl font-bold tracking-tight text-white'>
            <div className='flex h-8 w-8 items-center justify-center rounded bg-gradient-to-br from-cyan-500 to-blue-600'>
              <Play size={16} className='fill-white text-white' />
            </div>
            <span>DTALK</span>
          </div>
          <div className='hidden items-center gap-8 text-sm font-medium text-slate-300 md:flex'>
            <a href='#' className='text-cyan-400'>Home</a>
            <a href='#courses' className='transition hover:text-cyan-400'>Courses</a>
            <a href='#' className='transition hover:text-cyan-400'>Features</a>
            <a href='#' className='transition hover:text-cyan-400'>About</a>
            <a href='#' className='transition hover:text-cyan-400'>Contact</a>
          </div>
          <div className='hidden items-center gap-4 md:flex'>
            <div className='relative'>
              <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400' />
              <input type='text' placeholder='Search courses...' className='h-9 w-44 rounded-full border border-slate-700 bg-slate-900/60 pl-9 pr-4 text-sm text-slate-200 placeholder-slate-500 outline-none transition focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20' />
            </div>
            <button className='rounded-full bg-cyan-500 px-5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400'>Get Started</button>
          </div>
        </div>
      </nav>

      <main className='w-full'>
        <section className='relative mt-16 flex h-auto min-h-fit items-center justify-center overflow-hidden py-20 lg:min-h-[calc(85vh-4rem)] lg:py-24'>
          <div className='pointer-events-none absolute left-1/2 top-1/2 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-500/5 blur-3xl' />

          <div className={page + ' relative z-10 flex flex-col items-center text-center'}>
            <div className='mb-5 inline-flex w-fit items-center gap-2 rounded-full border border-slate-700/60 bg-slate-900/50 px-3 py-1 text-xs font-medium text-slate-300'>
              <span className='h-1.5 w-1.5 rounded-full bg-cyan-400' />
              <span>AI-Powered</span>
              <span className='h-1 w-1 rounded-full bg-slate-500' />
              <span>Immersive</span>
              <span className='h-1 w-1 rounded-full bg-slate-500' />
              <span>Interactive</span>
            </div>

            <h1 className='max-w-4xl text-4xl font-extrabold leading-[1.05] tracking-tight text-balance text-white sm:text-5xl lg:text-6xl'>
              Learn Beyond the <span className='bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent'>Screen</span>
            </h1>

            <p className='mt-5 max-w-2xl text-lg text-slate-300'>
              Join Professor Abed in an immersive 3D world, interact with classmates, explore concepts visually, and experience education like never before.
            </p>

            <div className='mt-8 flex flex-wrap items-center justify-center gap-4'>
              <button onClick={() => onEnter('ELC5121')} className='group inline-flex h-12 items-center gap-2 rounded-full bg-cyan-500 px-6 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:bg-cyan-400 hover:shadow-cyan-400/40'>
                <Box className='h-5 w-5' />
                <span>Enter 3D Classroom</span>
                <ArrowRight className='h-4 w-4 transition group-hover:translate-x-1' />
              </button>
              <button className='inline-flex h-12 items-center gap-3 rounded-full border border-slate-700 bg-slate-900/50 px-6 text-sm font-medium text-white transition hover:border-cyan-500/50 hover:text-cyan-300'>
                <span className='flex h-9 w-9 items-center justify-center rounded-full bg-slate-800'>
                  <Play size={14} className='fill-white text-white' />
                </span>
                <span>Watch Demo</span>
              </button>
            </div>

            <div className='mt-10 flex flex-wrap items-center justify-center gap-6 md:gap-8'>
              <div className='flex items-center gap-2'>
                <Brain className='h-5 w-5 text-cyan-400' />
                <span className='text-sm text-slate-300'>Visual Learning</span>
              </div>
              <div className='flex items-center gap-2'>
                <Users className='h-5 w-5 text-cyan-400' />
                <span className='text-sm text-slate-300'>Interactive Classrooms</span>
              </div>
              <div className='flex items-center gap-2'>
                <Globe className='h-5 w-5 text-cyan-400' />
                <span className='text-sm text-slate-300'>Global Access</span>
              </div>
            </div>
          </div>
        </section>

        <section id='courses' className='py-20 lg:py-28'>
          <div className={page}>
            <div className='mb-12 flex flex-col gap-4 md:flex-row md:items-start md:justify-between'>
              <div>
                <h2 className='text-3xl font-bold text-white'>Popular Courses</h2>
                <p className='mt-2 max-w-xl text-slate-400'>Explore our immersive courses designed for the next generation of learners.</p>
              </div>
              <button className='inline-flex h-10 items-center gap-2 rounded-full border border-slate-700 px-5 text-sm font-medium text-white transition hover:border-cyan-500/50 hover:text-cyan-400'>
                View All Courses
                <ArrowRight className='h-4 w-4' />
              </button>
            </div>

            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5'>
              {courses.map((course) => (
                <div key={course.id} className='group flex h-full flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#0b101a] transition hover:-translate-y-1 hover:shadow-2xl hover:shadow-cyan-900/10'>
                  <div className={'relative h-44 w-full overflow-hidden bg-gradient-to-br ' + course.color + ' p-5'}>
                    <course.icon className='h-12 w-12 text-white/90' />
                    {course.tag && (
                      <span className={'absolute right-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ' + (course.tag === 'New' ? 'bg-cyan-400 text-slate-950' : 'bg-blue-500 text-white')}>
                        {course.tag}
                      </span>
                    )}
                    <span className='absolute left-3 top-3 rounded-full bg-slate-950/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-cyan-300'>
                      {course.category}
                    </span>
                  </div>
                  <div className='flex flex-1 flex-col p-5'>
                    <h3 className='text-lg font-bold text-white'>{course.title}</h3>
                    <p className='mt-1 line-clamp-2 text-sm text-slate-400'>{course.name}</p>
                    <div className='mt-4 flex items-center gap-2 text-xs text-slate-400'>
                      <Star className='h-3.5 w-3.5 fill-yellow-400 text-yellow-400' />
                      <span className='font-medium text-slate-300'>{course.rating}</span>
                      <span className='text-slate-500'>({course.students})</span>
                    </div>
                    <button onClick={() => onEnter(course.id)} className={'mt-auto ml-auto flex h-9 w-9 items-center justify-center rounded-full transition bg-cyan-500 text-slate-950 hover:bg-cyan-400'}>
                      <ArrowRight className='h-4 w-4' />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className='border-t border-slate-800/50 bg-[#03060d]'>
        <div className={page + ' flex flex-col items-center justify-between gap-4 py-8 md:flex-row'}>
          <div className='flex items-center gap-2 text-xl font-bold text-white'>
            <div className='flex h-8 w-8 items-center justify-center rounded bg-gradient-to-br from-cyan-500 to-blue-600'>
              <Play size={16} className='fill-white text-white' />
            </div>
            <span>DTALK</span>
          </div>
          <p className='text-sm text-slate-500'>© {new Date().getFullYear()} DTALK. All rights reserved.</p>
          <div className='flex gap-6 text-sm text-slate-400'>
            <a href='#' className='hover:text-cyan-400'>Privacy Policy</a>
            <a href='#' className='hover:text-cyan-400'>Terms of Service</a>
            <a href='#' className='hover:text-cyan-400'>Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function LoadingOverlay({ visible }) {
  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/95 text-white backdrop-blur-md transition-opacity duration-500 ease-out ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      <div className='h-10 w-10 animate-spin rounded-full border-4 border-slate-700 border-t-cyan-400' />
      <p className='mt-4 text-lg font-medium text-slate-300'>Loading scene...</p>
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

function App() {
  const [currentAvatarPath, setCurrentAvatarPath] = useState('/assets/avatar/ProfAbed_suit.glb');
  const [userAvatarPath, setUserAvatarPath] = useState(() => {
    const i = Math.floor(Math.random() * USER_AVATARS.length);
    return USER_AVATARS[i].path;
  });
  const [view, setView] = useState('landing');
  const [roomId, setRoomId] = useState('ELC5121');
  const [cameraPreset, setCameraPreset] = useState('third-person');
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [inRange, setInRange] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [showUserAvatar, setShowUserAvatar] = useState(true);
  const [myId, setMyId] = useState(null);
  const [remotePlayers, setRemotePlayers] = useState({});
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const joinedRef = useRef(false);
  const joystick = useRef({ x: 0, y: 0 });
  const [showJoystick, setShowJoystick] = useState(false);

  useEffect(() => {
    const detect = () => {
      const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
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
    if (view !== 'landing' && !socketRef.current) {
      const socket = io({ transports: ['websocket', 'polling'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        setMyId(socket.id);
        console.log('[client] socket connected, id:', socket.id);
      });

      socket.on('room-state', (players) => {
        console.log('[client] room-state received', players.length, players.map(p => p.userId));
        const map = {};
        for (const p of players) map[p.userId] = p;
        setRemotePlayers(map);
      });

      socket.on('state-update', (player) => {
        setRemotePlayers((prev) => ({ ...prev, [player.userId]: player }));
      });

      socket.on('user-joined', (player) => {
        console.log('[client] user-joined', player.userId, player.roomId || roomId);
        setRemotePlayers((prev) => ({ ...prev, [player.userId]: player }));
      });

      socket.on('user-left', ({ userId }) => {
        console.log('[client] user-left', userId);
        setRemotePlayers((prev) => {
          const next = { ...prev };
          delete next[userId];
          return next;
        });
      });

      socket.on('disconnect', () => {
        setMyId(null);
        joinedRef.current = false;
      });
    }
  }, [view, roomId]);

  useEffect(() => {
    if (view === 'scene' && myId && !joinedRef.current && socketRef.current?.connected) {
      console.log('[client] emitting join:', roomId, 'for', myId);
      joinedRef.current = true;
      socketRef.current.emit('join', { roomId, name: 'Player', avatar: userAvatarPath, position: [0, 0, 0], rotation: 0, animation: 'Idle' });
    }
  }, [view, myId, roomId, userAvatarPath]);

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, []);

  const onSceneReady = useCallback(() => {
    console.log('[client] scene ready, setting view to scene');
    setView('scene');
  }, []);

  const emitUserState = useCallback((data) => {
    socketRef.current?.emit('state-update', data);
  }, []);

  const others = useMemo(() => Object.values(remotePlayers).filter((p) => p.userId !== myId), [remotePlayers, myId]);

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
    <>
      {view === 'landing' && <LandingPage onEnter={(room) => { setRoomId(room); setView('loading'); }} />}

      {(view === 'loading' || view === 'scene') && (
        <div className='relative h-screen w-screen'>
          <LoadingOverlay visible={view === 'loading'} />

          {showAvatarPicker && (
            <AvatarPicker
              avatars={USER_AVATARS}
              onPick={(path) => { setUserAvatarPath(path); setShowAvatarPicker(false); }}
            />
          )}

          {view === 'scene' && (
            <>
              <ChatInterface
                hidden={!chatOpen}
                onMinimize={() => setChatOpen(false)}
              />

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
            shadows
            camera={{ position: [0, 0, 0], fov: 35 }}
            className={`transition-opacity duration-500 ease-out ${
              view === 'scene' ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100vw',
              height: '100vh'
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
              />
            </Suspense>
          </Canvas>
        </div>
      )}
    </>
  );
}

export default App;
