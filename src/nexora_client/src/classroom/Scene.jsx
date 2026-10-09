import { Suspense, useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { io } from 'socket.io-client';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { User, UserX, Users, Play, RotateCcw, MessageSquare, Loader2, AlertCircle, ChevronDown, Hand, Globe, X, Mic, MicOff, Languages, Lock, Copy } from 'lucide-react';
import { Scenario } from './components/Scenario';
import { ChatInterface } from './components/ChatInterface';
import { Joystick } from './components/Joystick';
import SettingsPanel from './components/SettingsPanel';
import ContinuousRecorder from './components/ContinuousRecorder';

import { SCENE_CONFIG } from './sceneConfig';
import { useSpeech } from './hooks/useSpeech';
import { useVoiceChat } from './hooks/useVoiceChat';
import { classifyEvent, snapshotIsStale, snapshotFloor, planLectureRecovery, planAnswerRecovery, planLanguageSwitch, resolveSlidePage } from './services/ncipSync';
import { API_URL, getParticipantId } from '../shared/config';

const runtimeConfigModules = import.meta.glob('./scenes/configs/*.json', { eager: true });

const USER_AVATARS = [
  // NOTE: UserAvatar.glb is excluded — it has no mouth morph targets, so it
  // can never lipsync (bind-pose mouth). All anim_* rigs carry mouthOpen.

  { path: '/assets/useravatar/avatars/anim_female_1.glb', name: 'Ava' },
  { path: '/assets/useravatar/avatars/anim_female_2.glb', name: 'Luna' },
  { path: '/assets/useravatar/avatars/anim_female_3.glb', name: 'Sofia' },
  { path: '/assets/useravatar/avatars/anim_female_4.glb', name: 'Mira' },
  { path: '/assets/useravatar/avatars/anim_male_1.glb', name: 'Zayn' },
  { path: '/assets/useravatar/avatars/anim_male_2.glb', name: 'Leo' },
  { path: '/assets/useravatar/avatars/anim_male_3.glb', name: 'Omar' },
  { path: '/assets/useravatar/avatars/anim_male_4.glb', name: 'Kian' },
];

const DISPLAY_NAME_KEY = 'nexoraxr_display_name';
const MAX_NAME_LENGTH = 30;

function NameEntryModal({ onSubmit }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);

  const submit = () => {
    const name = value.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) {
      setError('Please enter a display name.');
      return;
    }
    onSubmit(name);
  };

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 text-white backdrop-blur-sm'>
      <div className='w-full max-w-sm rounded-3xl border border-slate-700/50 bg-slate-900/70 p-6 shadow-2xl sm:p-8'>
        <h2 className='text-center text-2xl font-bold text-white'>Enter your display name</h2>
        <p className='mt-2 text-center text-sm text-slate-400'>Other participants will see this name.</p>
        <input
          autoFocus
          type='text'
          value={value}
          maxLength={MAX_NAME_LENGTH}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder='e.g. Saad'
          className='mt-6 w-full rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:border-cyan-500/60'
        />
        {error && <p className='mt-2 text-xs text-red-300'>{error}</p>}
        <button
          onClick={submit}
          className='mt-4 w-full rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400'
        >
          Join Class
        </button>
      </div>
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
      <p className='mt-4 text-lg font-medium text-slate-300'>Preparing assets in scene...</p>
    </div>
  );
}

function ClassroomPanel({
  course,
  lectureId,
  lectureTitle,
  state,
  error,
  onStart,
  onChat,
  chatOpen,
  displayName,
  floorQueue,
  activeSpeaker,
  handRaised,
  isActiveSpeaker,
  onToggleHand,
  professorStatus = 'IDLE',
  onVoice,
  voiceOn,
  language = 'en',
  onLanguage,
  canCatchUp = false,
  onCatchUp,
  isPrivateRoom = false,
  isRoomHost = false,
  roomMembers = [],
  onKick,
  pauseReason = null,
  onCopyInvite,
  inviteCopied = false,
  onHostPause,
  onHostResume,
  onHostEnd,
}) {
  const number = String(Number(String(lectureId).replace(/\D/g, '')) || 0).padStart(2, '0');
  const canStart = state === 'idle' || state === 'completed' || state === 'error';
  const [handMenuOpen, setHandMenuOpen] = useState(false);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);

  const LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'ar', label: 'العربية' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'es', label: 'Español' },
    { code: 'zh', label: '中文' },
    // 'hi' intentionally not offered — VoxCPM2 Hindi output is unverified/garbled.
  ];
  const currentLangLabel = LANGUAGES.find((l) => l.code === language)?.label || 'English';

  let buttonLabel = 'Start Class';
  let ButtonIcon = Play;
  if (state === 'loading') { buttonLabel = 'Loading Lecture...'; ButtonIcon = Loader2; }
  else if (state === 'teaching') { buttonLabel = 'Class in Progress'; ButtonIcon = Play; }
  else if (state === 'completed') { buttonLabel = 'Replay Lecture'; ButtonIcon = RotateCcw; }
  else if (state === 'error') { buttonLabel = 'Retry Class'; ButtonIcon = RotateCcw; }

  const handLabel = isActiveSpeaker ? 'Release Floor' : handRaised ? 'Lower Hand' : 'Raise Hand';

  const pillBase =
    'flex items-center gap-2.5 rounded-full px-4 py-2 text-left transition hover:bg-slate-800/80';

  return (
    <>
      {(handMenuOpen || langMenuOpen || membersOpen) && (
        <div
          className='fixed inset-0 z-40'
          onClick={() => {
            setHandMenuOpen(false);
            setLangMenuOpen(false);
            setMembersOpen(false);
          }}
        />
      )}

      <div className='fixed left-1/2 top-4 z-50 -translate-x-1/2'>
        <div className='flex items-center gap-1 rounded-full border border-slate-700/50 bg-slate-900/85 px-2 py-1.5 text-white shadow-2xl backdrop-blur'>
          <div className={`${pillBase} cursor-default`} title={lectureTitle || `Lecture ${number}`}>
            <Globe size={20} className='text-slate-300' />
            <div className='leading-tight'>
              <p className='text-xs font-semibold'>{course?.title || course?.category || 'Class'}</p>
              <p className='text-[11px] text-slate-400'>{displayName || lectureTitle || `Lecture ${number}`}</p>
            </div>
          </div>

          <div className='h-8 w-px bg-slate-700/60' />

          <div className='relative'>
            <button
              onClick={() => setHandMenuOpen((v) => !v)}
              className={`${pillBase} border ${
                handMenuOpen || handRaised || isActiveSpeaker
                  ? 'border-cyan-400/60 bg-slate-800/60'
                  : 'border-cyan-500/30'
              }`}
            >
              <Hand
                size={20}
                className={isActiveSpeaker ? 'text-emerald-300' : handRaised ? 'text-amber-300' : 'text-cyan-300'}
              />
              <div className='leading-tight'>
                <p className='text-xs font-semibold'>{handLabel}</p>
                <p className='text-[11px] text-slate-400'>
                  {isActiveSpeaker ? 'You have the floor' : handRaised ? 'Hand is raised' : 'Let the instructor know'}
                </p>
              </div>
              <ChevronDown size={14} className={`text-slate-400 transition ${handMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {handMenuOpen && (
              <div className='absolute right-0 top-full mt-2 w-72 rounded-2xl border border-slate-700/50 bg-slate-900/95 p-2 shadow-2xl backdrop-blur'>
                <button
                  onClick={() => {
                    if (!handRaised && !isActiveSpeaker) onToggleHand();
                    setHandMenuOpen(false);
                  }}
                  className='flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-800'
                >
                  <Hand size={18} className='text-cyan-300' />
                  <div className='flex-1 leading-tight'>
                    <p className='text-sm font-semibold'>Raise Hand</p>
                    <p className='text-[11px] text-slate-400'>Let the instructor know</p>
                  </div>
                  <span
                    className={`h-4 w-4 rounded-full border-2 ${
                      handRaised && !isActiveSpeaker ? 'border-cyan-400 bg-cyan-400' : 'border-slate-500'
                    }`}
                  />
                </button>

                <button
                  onClick={() => {
                    if (!handRaised && !isActiveSpeaker) onToggleHand();
                    setHandMenuOpen(false);
                  }}
                  className='flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-800'
                >
                  <MessageSquare size={18} className='text-slate-300' />
                  <div className='flex-1 leading-tight'>
                    <p className='text-sm font-semibold'>Request to Speak</p>
                    <p className='text-[11px] text-slate-400'>Add to speaking queue</p>
                  </div>
                  <span
                    className={`h-4 w-4 rounded-full border-2 ${
                      handRaised ? 'border-cyan-400 bg-cyan-400' : 'border-slate-500'
                    }`}
                  />
                </button>

                {canCatchUp && (
                  <button
                    onClick={() => {
                      onCatchUp?.();
                      setHandMenuOpen(false);
                    }}
                    className='flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-800'
                  >
                    <RotateCcw size={18} className='text-violet-300' />
                    <div className='flex-1 leading-tight'>
                      <p className='text-sm font-semibold'>Catch Me Up</p>
                      <p className='text-[11px] text-slate-400'>Recap what you missed since joining</p>
                    </div>
                  </button>
                )}

                <button
                  onClick={() => {
                    if (handRaised || isActiveSpeaker) onToggleHand();
                    setHandMenuOpen(false);
                  }}
                  className='flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-800'
                >
                  <Hand size={18} className='rotate-180 text-slate-300' />
                  <div className='flex-1 leading-tight'>
                    <p className='text-sm font-semibold'>{isActiveSpeaker ? 'Release Floor' : 'Lower Hand'}</p>
                    <p className='text-[11px] text-slate-400'>
                      {isActiveSpeaker ? 'Give up the floor' : 'Cancel your request'}
                    </p>
                  </div>
                  <span
                    className={`h-4 w-4 rounded-full border-2 ${
                      !handRaised && !isActiveSpeaker ? 'border-cyan-400 bg-cyan-400' : 'border-slate-500'
                    }`}
                  />
                </button>

                <div className='mt-1 border-t border-slate-700/50 px-3 py-2'>
                  <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500'>Active Speaker</p>
                  <p className={`mt-0.5 text-xs font-medium ${activeSpeaker ? 'text-emerald-300' : 'text-slate-500'}`}>
                    {activeSpeaker ? activeSpeaker.name : 'None'}
                  </p>
                  {floorQueue.length > 0 && (
                    <ol className='mt-1 space-y-0.5 text-xs text-slate-300'>
                      {floorQueue.map((p, i) => (
                        <li key={p.userId}>
                          {i + 1}. {p.name}
                        </li>
                      ))}
                    </ol>
                  )}
                  <p className="mt-1 text-[11px] text-slate-500">
                    Professor: <span className="font-medium text-slate-300">{professorStatus}</span>
                  </p>
                </div>
              </div>
            )}
          </div>

          <button onClick={onChat} className={`${pillBase} ${chatOpen ? 'bg-slate-800/80 ring-1 ring-cyan-400/50' : ''}`}>
            <MessageSquare size={20} className='text-slate-300' />
            <div className='leading-tight'>
              <p className='text-xs font-semibold'>Chat</p>
              <p className='text-[11px] text-slate-400'>{chatOpen ? 'Open' : 'Closed'}</p>
            </div>
          </button>

          <button
            onClick={onVoice}
            title={voiceOn ? 'Mute microphone' : 'Unmute microphone (joins voice chat)'}
            className={`${pillBase} ${voiceOn ? 'bg-slate-800/80 ring-1 ring-emerald-400/50' : ''}`}
          >
            {voiceOn
              ? <Mic size={20} className='text-emerald-300' />
              : <MicOff size={20} className='text-slate-300' />}
            <div className='leading-tight'>
              <p className='text-xs font-semibold'>Voice</p>
              <p className='text-[11px] text-slate-400'>{voiceOn ? 'On' : 'Off'}</p>
            </div>
          </button>

          {isPrivateRoom && (
            <div className='relative'>
              <button onClick={() => setMembersOpen((v) => !v)} className={pillBase}>
                <Users size={20} className='text-slate-300' />
                <div className='leading-tight'>
                  <p className='text-xs font-semibold'>Participants</p>
                  <p className='text-[11px] text-slate-400'>{roomMembers.length} in this class</p>
                </div>
                <ChevronDown size={14} className={`text-slate-500 transition ${membersOpen ? 'rotate-180' : ''}`} />
              </button>
              {membersOpen && (
                <div className='absolute right-0 top-full z-50 mt-2 w-64 rounded-2xl border border-slate-700/50 bg-slate-900/95 p-2 text-xs shadow-2xl backdrop-blur'>
                  {roomMembers.map((m) => (
                    <div key={m.userId} className='flex items-center justify-between rounded-lg px-3 py-2 hover:bg-slate-800'>
                      <span className='truncate text-slate-200'>
                        {m.name || 'User'}
                        {m.isHost && <span className='ml-2 text-[10px] font-semibold uppercase tracking-wide text-violet-300'>host</span>}
                        {m.isSelf && <span className='ml-2 text-[10px] text-slate-500'>you</span>}
                      </span>
                      {isRoomHost && !m.isSelf && !m.isHost && onKick && (
                        <button
                          onClick={() => onKick(m.userId)}
                          title={`Remove ${m.name || 'this user'} from the room`}
                          className='ml-2 rounded-md p-1 text-slate-500 transition hover:bg-rose-500/15 hover:text-rose-300'
                        >
                          <UserX size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {isPrivateRoom && onCopyInvite && (
            <button
              onClick={onCopyInvite}
              title='Generate a fresh single-use invite link'
              className={pillBase}
            >
              <Copy size={20} className={inviteCopied ? 'text-emerald-300' : 'text-violet-300'} />
              <div className='leading-tight'>
                <p className='text-xs font-semibold'>{inviteCopied ? 'Copied!' : 'New Invite'}</p>
                <p className='text-[11px] text-slate-400'>One-time link</p>
              </div>
            </button>
          )}

          <div className='relative'>
            <button
              onClick={() => setLangMenuOpen((v) => !v)}
              title='Lecture language (applies on next Start Class)'
              className={`${pillBase} ${langMenuOpen ? 'bg-slate-800/80 ring-1 ring-cyan-400/50' : ''}`}
            >
              <Languages size={20} className='text-slate-300' />
              <div className='leading-tight'>
                <p className='text-xs font-semibold'>Language</p>
                <p className='text-[11px] text-slate-400'>{currentLangLabel}</p>
              </div>
              <ChevronDown size={14} className={`text-slate-500 transition ${langMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {langMenuOpen && (
              <div className='absolute left-1/2 top-full z-50 mt-2 w-44 -translate-x-1/2 rounded-2xl border border-slate-700/50 bg-slate-900/95 p-2 text-xs shadow-2xl backdrop-blur'>
                {LANGUAGES.map((l) => (
                  <button
                    key={l.code}
                    onClick={() => {
                      onLanguage?.(l.code);
                      setLangMenuOpen(false);
                    }}
                    className='flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-800'
                  >
                    <span className='flex-1 text-sm font-semibold'>{l.label}</span>
                    <span
                      className={`h-4 w-4 rounded-full border-2 ${
                        language === l.code ? 'border-cyan-400 bg-cyan-400' : 'border-slate-500'
                      }`}
                    />
                  </button>
                ))}
                <p className='mt-1 border-t border-slate-700/50 px-3 pt-2 text-[11px] text-slate-500'>
                  Switches mid-lecture from the next segment
                </p>
              </div>
            )}
          </div>

          {(!isPrivateRoom || isRoomHost) && (
            <button
              onClick={onStart}
              disabled={!canStart}
              className={`flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition ${
                state === 'teaching' || state === 'loading'
                  ? 'cursor-not-allowed bg-slate-700 text-slate-300'
                  : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'
              }`}
            >
              <ButtonIcon size={16} className={state === 'loading' ? 'animate-spin' : ''} />
              {buttonLabel}
            </button>
          )}

          {/* Host lecture lifecycle — private rooms only (server-enforced). */}
          {isPrivateRoom && isRoomHost && professorStatus === 'LECTURING' && (
            <button
              onClick={onHostPause}
              title='Pause the lecture for discussion'
              className={`${pillBase} border border-amber-500/40`}
            >
              <Hand size={18} className='text-amber-300' />
              <div className='leading-tight'>
                <p className='text-xs font-semibold'>Pause</p>
                <p className='text-[11px] text-slate-400'>Discussion break</p>
              </div>
            </button>
          )}
          {isPrivateRoom && isRoomHost && professorStatus === 'PAUSED' && pauseReason === 'host' && (
            <button
              onClick={onHostResume}
              title='Resume the lecture from the pause point'
              className={`${pillBase} border border-emerald-500/40`}
            >
              <Play size={18} className='text-emerald-300' />
              <div className='leading-tight'>
                <p className='text-xs font-semibold'>Resume</p>
                <p className='text-[11px] text-slate-400'>Continue lecture</p>
              </div>
            </button>
          )}
          {isPrivateRoom && isRoomHost &&
            ['LECTURING', 'PAUSED', 'THINKING', 'ANSWERING', 'RESUMING'].includes(professorStatus) && (
            <button
              onClick={onHostEnd}
              title='End the lecture for everyone'
              className={`${pillBase} border border-rose-500/40`}
            >
              <X size={18} className='text-rose-300' />
              <div className='leading-tight'>
                <p className='text-xs font-semibold'>End Class</p>
                <p className='text-[11px] text-slate-400'>Stop lecture</p>
              </div>
            </button>
          )}
        </div>

        {error && (
          <div className='mt-2 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-200 backdrop-blur'>
            <AlertCircle size={14} className='mt-0.5 flex-shrink-0' />
            <span>{error}</span>
          </div>
        )}
      </div>
    </>
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
  const baseConfig = SCENE_CONFIG[sceneName];

  if (!baseConfig) {
    return <NotFound sceneName={sceneName} />;
  }

  return <SceneRoom sceneName={sceneName} baseConfig={baseConfig} />;
}

function SceneRoom({ sceneName, baseConfig }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const lectureId = searchParams.get('lecture');
  // Private-room admission params (invite links carry ?room=&invite=).
  const privateRoomId = searchParams.get('room');
  const inviteToken = searchParams.get('invite');

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

  const [currentAvatarPath] = useState('/assets/avatar/ProfAbed_suit.glb');
  const [userAvatarPath, setUserAvatarPath] = useState(() => {
    const i = Math.floor(Math.random() * USER_AVATARS.length);
    return USER_AVATARS[i].path;
  });
  const [cameraPreset, setCameraPreset] = useState('third-person');
  const [inRange, setInRange] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [lectureLang, setLectureLang] = useState('en');
  const [camHint, setCamHint] = useState(false);
  const [showUserAvatar] = useState(true);
  const [myId, setMyId] = useState(null);
  const [displayName, setDisplayName] = useState(() => {
    const stored = sessionStorage.getItem(DISPLAY_NAME_KEY);
    return stored && stored.trim() ? stored.trim() : null;
  });
  const [remotePlayers, setRemotePlayers] = useState({});
  const [floorQueue, setFloorQueue] = useState([]);
  const [activeSpeaker, setActiveSpeaker] = useState(null);
  const [professorStatus, setProfessorStatus] = useState('IDLE');
  const [floorAnswering, setFloorAnswering] = useState(false);
  const [floorError, setFloorError] = useState(null);
  // Server-authoritative: this participant joined a lecture already underway
  // and has a recap anchor — offered via the hand menu ("Catch me up").
  const [canCatchUp, setCanCatchUp] = useState(false);
  // Private-room flow: access errors replace the scene; created invite links
  // are shown to the host for sharing.
  const [accessError, setAccessError] = useState(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  // Private-room guest admission: guests wait for host approval; the host sees
  // pending requests and approves/declines each one.
  const [joinPending, setJoinPending] = useState(false);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [roomMeta, setRoomMeta] = useState(null); // {roomId, roomType, hostId} from snapshot
  const [pauseReason, setPauseReason] = useState(null); // 'host' during a host discussion pause
  const isPrivateRoom = roomMeta?.roomType === 'private';
  const isRoomHost = isPrivateRoom && roomMeta?.hostId === getParticipantId();

  // Room joins without a lecture yet go through the course picker — the
  // lecture is chosen on entry, then the room/invite params are carried back.
  useEffect(() => {
    if (privateRoomId && !lectureId) {
      const q = new URLSearchParams({ room: privateRoomId, ...(inviteToken ? { invite: inviteToken } : {}) });
      navigate(`/course/${encodeURIComponent(sceneName)}?${q}`, { replace: true });
    }
  }, [privateRoomId, lectureId, inviteToken, sceneName, navigate]);

  // Canonical scene check: a ?room= link must render the room's registered
  // scene — if the URL path drifted (stale link, fallback scene), redirect to
  // the authoritative classroom while preserving room/invite/lecture params.
  useEffect(() => {
    if (!privateRoomId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/rooms/${privateRoomId}`);
        if (!res.ok) return;
        const meta = await res.json();
        if (!cancelled && meta?.scene && meta.scene !== sceneName) {
          const q = new URLSearchParams({
            room: privateRoomId,
            ...(inviteToken ? { invite: inviteToken } : {}),
            ...(lectureId ? { lecture: lectureId } : {}),
          });
          navigate(`/scene/${encodeURIComponent(meta.scene)}?${q}`, { replace: true });
        }
      } catch (err) {
        console.warn('[room-meta]', err);
      }
    })();
    return () => { cancelled = true; };
  }, [privateRoomId, sceneName, inviteToken, lectureId, navigate]);

  // Invite links are single-use: the host mints a fresh one on each share
  // (server rotates the token). Guests never see this control.
  const copyInvite = useCallback(async () => {
    if (!privateRoomId) return;
    try {
      const res = await fetch(`${API_URL}/api/rooms/${privateRoomId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId: getParticipantId() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate invite');
      await navigator.clipboard?.writeText(`${window.location.origin}${data.inviteUrl}`);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    } catch (err) {
      console.error('[invite]', err);
      setLectureError(err.message || 'Could not generate invite link');
    }
  }, [privateRoomId]);
  const [sceneReady, setSceneReady] = useState(false);
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const joinedRef = useRef(false);
  const lastEmittedMessageIdRef = useRef(new Set());
  const joystick = useRef({ x: 0, y: 0 });
  const [showJoystick, setShowJoystick] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [lectureStatus, setLectureStatus] = useState('idle');

  const [lectureError, setLectureError] = useState(null);
  const [lectureTitle, setLectureTitle] = useState(null);


  const { message, messages, pushMessage, clearMessages, replacePending, replaceQueue, audioElementRef, stopAudio, requestMicrophoneAccess, prependMessages, pauseLectureForFloor, resumeLecture, floorPausedRef, setFloorPaused, answerEndedRef, setRecognitionLang } = useSpeech();
  const speechCtlRef = useRef({});
  speechCtlRef.current = { prependMessages, pauseLectureForFloor, resumeLecture, replaceQueue, setFloorPaused, floorPausedRef, audioElementRef, stopAudio, messages };

  // Slide follows the current lecture segment's slidePage. The head during
  // Q&A is an answer, so resolveSlidePage anchors on the first lecture
  // message in the queue; the last resolved page persists as fallback.
  const slidePageRef = useRef(1);
  const slidePage = useMemo(() => {
    const p = resolveSlidePage(messages, slidePageRef.current);
    slidePageRef.current = p;
    return p;
  }, [messages]);
  const languageChangeRef = useRef(null);
  // Refs so the once-registered socket handlers always see current values.
  const myIdRef = useRef(null);
  const lectureIdRef = useRef(lectureId);
  const lectureLangRef = useRef(lectureLang);
  myIdRef.current = myId;
  lectureIdRef.current = lectureId;
  lectureLangRef.current = lectureLang;
  // Question typed before the floor is ready — flushed once the server's
  // 'floor-ready' acknowledgement (holder checkpoint accepted) arrives.
  const pendingQuestionRef = useRef(null);
  const floorReadyRef = useRef(false);
  // NCIP Slice 2: version of the newest authoritative state this client has
  // applied. -1 = no baseline yet (fresh connect / before first snapshot).
  const lastAppliedVersionRef = useRef(-1);
  const syncPendingRef = useRef(false);

  // Peer voice chat (WebRTC mesh + positional audio on remote avatars)
  const voiceChat = useVoiceChat();
  const voiceChatRef = useRef(voiceChat);
  voiceChatRef.current = voiceChat;

  const canStartClass =
    !!lectureId && (lectureStatus === 'idle' || lectureStatus === 'completed' || lectureStatus === 'error');

  useEffect(() => {
    setLectureStatus('idle');
    setLectureError(null);
    setLectureTitle(null);
    clearMessages();
  }, [lectureId]);

  // Speech recognition follows the authoritative room language so student
  // voice questions are transcribed in the language actually spoken.
  useEffect(() => {
    setRecognitionLang(lectureLang);
  }, [lectureLang, setRecognitionLang]);

  useEffect(() => {
    return () => {
      clearMessages();
      setLectureStatus('idle');
      setLectureError(null);
    };
  }, [clearMessages]);

  const handleStartClass = async () => {
    if (!lectureId || !canStartClass) return;

    clearMessages();
    setLectureStatus('loading');
    setLectureError(null);
    // Replay of the same lectureId restarts at segment 0 — tell the server the
    // previous playthrough ended so playback position and recap anchors reset
    // (without this, the monotonic guard would reject the restart's seg 0).
    socketRef.current?.emit('lecture-ended');

    try {
      const res = await fetch(`${API_URL}/api/lecture/segments/${lectureId}?lang=${lectureLang}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lecture not available');
      if (!data.segments || data.segments.length === 0) {
        throw new Error('No segments found for this lecture');
      }

      setLectureTitle(data.title);
      data.segments.forEach((seg, i) => {
        pushMessage({
          id: `${lectureId}_seg_${seg.id}`,
          type: 'lecture',
          text: seg.text,
          audioUrl: seg.audioUrl ? `${API_URL}${seg.audioUrl}` : null,
          animation: seg.animation || 'explain',
          facialExpression: seg.facialExpression || 'smile',
          lipsync: seg.lipsync,
          slidePage: seg.slidePage ?? null,
        });
      });
      setLectureStatus('teaching');
      setChatOpen(true);
    } catch (err) {
      console.error('[handleStartClass]', err);
      setLectureStatus('error');
      setLectureError(err.message || 'Failed to load lecture');
    }
  };

  // Mid-lecture language switch — resumes at the SAME segment index:
  //  - if a lecture segment is currently playing: pause it, rebuild the queue
  //    from that segment in the new language (replays that segment in Arabic)
  //  - if a floor answer is playing while a lecture segment is paused: the
  //    answer finishes, then the interrupted segment resumes in the new
  //    language (resumeAt is dropped — timestamps don't map across languages)
  // NCIP Slice 3: language is server-authoritative — the selector only
  // requests; the room broadcasts 'language-change' and every client
  // (including the requester) applies it through applyLanguageChange.
  const requestLanguageChange = useCallback((lang) => {
    socketRef.current?.emit('language.change', { language: lang });
  }, []);

  // Applies an authoritative language change to the local lecture queue.
  // `seq` makes the last accepted switch win: a stale fetch resolving after a
  // newer change must never overwrite the queue. Position comes from the
  // live queue, falling back to the server's segmentIndex hint — never seg 0.
  const langSwitchSeqRef = useRef(0);
  const lectureStatusRef = useRef(lectureStatus);
  lectureStatusRef.current = lectureStatus;
  const handleLanguageChange = async (lang, hintSegmentIndex = null) => {
    const seq = ++langSwitchSeqRef.current;
    setLectureLang(lang);
    lectureLangRef.current = lang;
    const lid = lectureIdRef.current;
    if (lectureStatusRef.current !== 'teaching' || !lid) return;

    const plan = planLanguageSwitch(speechCtlRef.current.messages, hintSegmentIndex);
    if (!plan) return; // no known position — leave the queue untouched

    try {
      const res = await fetch(`${API_URL}/api/lecture/segments/${lid}?lang=${lang}`);
      const data = await res.json();
      if (seq !== langSwitchSeqRef.current) return; // superseded by a newer switch
      if (!res.ok || !data.segments?.length) return;

      const segs = data.segments
        .filter((seg) => seg.id >= plan.segmentIndex)
        .map((seg) => ({
          id: `${lid}_seg_${seg.id}`,
          type: 'lecture',
          text: seg.text,
          audioUrl: seg.audioUrl ? `${API_URL}${seg.audioUrl}` : null,
          animation: seg.animation || 'explain',
          facialExpression: seg.facialExpression || 'smile',
          lipsync: seg.lipsync,
          slidePage: seg.slidePage ?? null,
        }));
      if (seq !== langSwitchSeqRef.current || !segs.length) return;

      if (plan.headIsLecture) {
        // Lecture segment is playing now — invalidate it (detach handlers so
        // a late 'ended'/'error' can't pop the new head), then rebuild.
        speechCtlRef.current.stopAudio();
        speechCtlRef.current.replaceQueue(segs);
      } else {
        // An answer/non-lecture message is playing (or the queue was empty) —
        // the interrupted lecture resumes in the new language behind it.
        speechCtlRef.current.replacePending(segs);
      }
    } catch (err) {
      console.error('[lang-switch]', err);
    }
  };
  languageChangeRef.current = handleLanguageChange;

  useEffect(() => {
    if (lectureStatus === 'teaching' && messages.length === 0) {
      setLectureStatus('completed');
      // The queue drained — tell the server the live lecture is over so its
      // snapshots stop offering a stale segment to late joiners.
      socketRef.current?.emit('lecture-ended');
    }
  }, [messages, lectureStatus]);

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

  // NCIP Slice 2: the checkpoint segment is already in the local queue.
  // Trim everything before it, stamp the authoritative offset as resumeAt,
  // and keep it paused while the floor is held.
  const positionLectureAtCheckpoint = (cp, floorHeld) => {
    const msgs = speechCtlRef.current.messages || [];
    const segId = `${cp.lectureId}_seg_${cp.segmentIndex}`;
    const idx = msgs.findIndex((m) => m.type === 'lecture' && m.id === segId);
    if (idx < 0) return false;
    msgs[idx].resumeAt = cp.playbackOffsetMs / 1000;
    if (idx === 0) {
      if (floorHeld) speechCtlRef.current.audioElementRef?.current?.pause();
    } else if (msgs[0]?.type === 'lecture') {
      // Trim to the checkpoint segment only when the head is a lecture
      // message — a recovered floor answer at the head must finish first;
      // the stamped segment becomes head right after it. The old head is
      // being discarded, so detach its handlers before replacing the queue.
      speechCtlRef.current.stopAudio();
      speechCtlRef.current.replaceQueue(msgs.slice(idx));
    }
    return true;
  };

  // NCIP Slice 2 canonical lecture recovery: the checkpoint segment is NOT in
  // the local queue (late join / missed segments / different lecture) — fetch
  // the segment manifest through the existing lecture API, rebuild the queue
  // from the authoritative segmentIndex and stamp the offset. Never restarts
  // at segment 0.
  const recoverLectureFromSnapshot = async (cp, floorHeld, answerMsg = null) => {
    try {
      const lang = cp.language || lectureLangRef.current;
      const res = await fetch(`${API_URL}/api/lecture/segments/${cp.lectureId}?lang=${lang}`);
      const data = await res.json();
      if (!res.ok || !data.segments?.length) {
        console.error('[ncip] lecture recovery failed, no segments for', cp.lectureId);
        return;
      }
      const segs = data.segments
        .filter((seg) => seg.id >= cp.segmentIndex)
        .map((seg) => ({
          id: `${cp.lectureId}_seg_${seg.id}`,
          type: 'lecture',
          text: seg.text,
          audioUrl: seg.audioUrl ? `${API_URL}${seg.audioUrl}` : null,
          animation: seg.animation || 'explain',
          facialExpression: seg.facialExpression || 'smile',
          lipsync: seg.lipsync,
          slidePage: seg.slidePage ?? null,
        }));
      if (!segs.length) return;
      segs[0].resumeAt = cp.playbackOffsetMs / 1000;
      // This head resumes mid-segment at a position the server already tracks
      // — it must not be reported as a new segment start.
      segs[0].skipPlaybackReport = true;
      // The queue is being rebuilt wholesale — invalidate the old head's
      // audio handlers before replacement to avoid a stale 'ended' pop.
      speechCtlRef.current.stopAudio();
      speechCtlRef.current.replaceQueue(segs);
      setLectureStatus('teaching');
      // An in-flight floor answer recovered alongside the lecture takes the
      // queue head and plays from its elapsed offset; the stamped lecture
      // segment becomes head right after it.
      if (answerMsg) speechCtlRef.current.prependMessages([answerMsg]);
      if (floorHeld) speechCtlRef.current.audioElementRef?.current?.pause();
      console.log('[ncip] lecture recovered:', cp.lectureId, 'seg', cp.segmentIndex, '@', cp.playbackOffsetMs, 'ms, paused:', floorHeld);
    } catch (err) {
      console.error('[ncip] lecture recovery error:', err);
    }
  };

  useEffect(() => {
    if (socketRef.current) return;
    const socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      reconnection: !import.meta.env.DEV,
      reconnectionAttempts: 2,
      reconnectionDelay: 3000,
      timeout: 5000,
    });
    socketRef.current = socket;
    voiceChatRef.current.attachSocket(socket);

    socket.on('connect', () => {
      console.log('[client] socket connected, id:', socket.id);
      // Protocol identity is the stable participantId, not the socket.
      setMyId(getParticipantId());
    });

    socket.on('room-state', (players) => {
      console.log('[client] room-state received:', players.length, players.map((p) => p.userId));
      const map = {};
      for (const p of players) map[p.userId] = p;
      setRemotePlayers(map);
    });

    socket.on('state-update', (player) => {
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

    // NCIP Slice 2: gate every authoritative event through version checks.
    // 'stale' events (older than the applied version) are dropped so delayed
    // broadcasts can never roll the client backward; 'gap' versions mean we
    // missed a transition — do not apply, ask the server for a snapshot.
    const applyNcip = (data, apply) => {
      const cls = classifyEvent(lastAppliedVersionRef.current, data?.stateVersion);
      if (cls === 'stale') {
        console.log('[ncip] stale event ignored, v' + data?.stateVersion + ' <= v' + lastAppliedVersionRef.current);
        return;
      }
      if (cls === 'gap') {
        console.warn('[ncip] version gap: v' + data?.stateVersion + ' after v' + lastAppliedVersionRef.current + ' — requesting session.sync');
        if (!syncPendingRef.current) {
          syncPendingRef.current = true;
          socket.emit('session.sync');
        }
        return;
      }
      if (Number.isFinite(data?.stateVersion)) {
        lastAppliedVersionRef.current = Math.max(lastAppliedVersionRef.current, data.stateVersion);
      }
      apply();
    };

    socket.on('floor-state', (data) => applyNcip(data, () => {
      console.log('[client] floor-state received:', data);
      setFloorQueue(data?.floorQueue || []);
      setActiveSpeaker(data?.activeSpeaker || null);
      if (data?.professorStatus) setProfessorStatus(data.professorStatus);
      if (data?.activeSpeaker?.userId !== myIdRef.current) {
        floorReadyRef.current = false;
      }
    }));

    // NCIP readiness acknowledgement: the server accepted our holder
    // checkpoint, so a pending question may now enter THINKING.
    socket.on('floor-ready', (data) => applyNcip(data, () => {
      floorReadyRef.current = true;
      if (pendingQuestionRef.current) {
        const pending = pendingQuestionRef.current;
        pendingQuestionRef.current = null;
        // pending is either a plain question string or a recap request object.
        setFloorAnswering(true); // optimistic until the 'thinking' broadcast
        const payload = typeof pending === 'string' ? { question: pending } : pending;
        socket.emit('ask-floor-question', { ...payload, lectureId: lectureIdRef.current });
      }
    }));

    // Private-room admission: guest parked awaiting host approval.
    socket.on('join-pending', () => setJoinPending(true));

    // Host receives each pending guest request (private rooms only).
    socket.on('private-join-request', ({ name, socketId }) => {
      if (!socketId) return;
      setPendingRequests((l) => (l.some((r) => r.socketId === socketId) ? l : [...l, { name, socketId }]));
    });

    // Same participant opened a second tab — this socket was evicted so the
    // two can't share presence/voice/floor state.
    socket.on('session-taken-over', () => {
      speechCtlRef.current?.stopAudio?.();
      setJoinPending(false);
      setAccessError('This classroom was opened in another tab — this window was disconnected.');
    });

    socket.on('room-kicked', () => {
      // Host removed us (private room): leave the classroom UI cleanly.
      speechCtlRef.current?.stopAudio?.();
      speechCtlRef.current?.clearMessages?.();
      setJoinPending(false);
      setAccessError('The host removed you from this room.');
    });

    socket.on('join-error', (data) => {
      console.warn('[client] join rejected:', data?.error);
      joinedRef.current = false;
      if (data?.private) {
        // Private-room rejection: show the access error, don't bounce the user
        // back to the name prompt (a name can't fix a bad invite).
        setJoinPending(false);
        setAccessError(data.error || 'Invalid or expired invite link.');
        return;
      }
      sessionStorage.removeItem(DISPLAY_NAME_KEY);
      setDisplayName(null);
    });

    socket.on('disconnect', () => {
      console.log('[client] socket disconnected');
      setMyId(null);
      setRemotePlayers({});
      setFloorQueue([]);
      setActiveSpeaker(null);
      joinedRef.current = false;
      // All local NCIP state is stale now — the reconnect re-join flow brings
      // a fresh snapshot which re-establishes the baseline.
      lastAppliedVersionRef.current = -1;
      syncPendingRef.current = false;
    });

    socket.on('professor-speak', (data) => applyNcip(data, () => {
      console.log('[client] professor-speak received:', data?.text);
      // Resolve host-relative audio URLs against the backend origin.
      const audioUrl = data?.audioUrl?.startsWith('/') ? `${API_URL}${data.audioUrl}` : data?.audioUrl;
      if (data?.floorAnswer) {
        setFloorAnswering(false);
        speechCtlRef.current.prependMessages([{ ...data, audioUrl, fromRemote: true }]);
      } else {
        pushMessage({ ...data, audioUrl }, true);
      }
    }));

    socket.on('lecture-control', (data) => applyNcip(data, () => {
      console.log('[client] lecture-control received:', data?.action);
      if (data?.action === 'pause-for-host') {
        // Host discussion pause (private rooms): same local pause as a floor
        // pause, but no checkpoint report — the server already projected the
        // canonical position.
        speechCtlRef.current.pauseLectureForFloor();
      } else if (data?.action === 'control-error') {
        setFloorError(data?.error || 'Lecture control rejected.');
      } else if (data?.action === 'end') {
        // Host ended the class (private room): stop and clear local playback.
        speechCtlRef.current.floorPausedRef.current = false;
        speechCtlRef.current.setFloorPaused(false);
        speechCtlRef.current.clearMessages();
        setLectureStatus('idle');
        setFloorAnswering(false);
      } else if (data?.action === 'pause-for-floor') {
        const cp = speechCtlRef.current.pauseLectureForFloor();
        // Only the holder reports the canonical checkpoint; a null
        // segmentIndex means "no lecture playing locally" but still counts
        // as a report so the floor can proceed.
        if (data?.activeSpeaker?.userId === myIdRef.current) {
          floorReadyRef.current = false;
          socket.emit('lecture-checkpoint', {
            lectureId: lectureIdRef.current,
            language: lectureLangRef.current,
            segmentIndex: cp?.segmentIndex ?? null,
            playbackOffsetMs: cp?.playbackOffsetMs ?? 0,
          });
        }
      } else if (data?.action === 'resume') {
        setFloorAnswering(false);
        // Server-authoritative checkpoint: every client resumes from the same
        // {lectureId, segmentIndex, playbackOffsetMs}.
        const cp = data?.checkpoint;
        if (cp?.language && cp.language !== lectureLangRef.current) {
          console.warn('[client] resume checkpoint language differs from local lecture language:', cp.language, 'vs', lectureLangRef.current);
        }
        speechCtlRef.current.resumeLecture(cp);
      } else if (data?.action === 'thinking' || data?.action === 'answering') {
        setFloorAnswering(true);
        setFloorError(null);
      } else if (data?.action === 'answer-error') {
        setFloorAnswering(false);
      } else if (data?.action === 'language-change') {
        // NCIP Slice 3: the server accepted a language.change — every client
        // applies it identically. Floor-held states only retarget the
        // checkpoint language locally (already done server-side); an active
        // lecture rebuilds from its current segment in the new language.
        console.log('[client] language-change received:', data.language);
        languageChangeRef.current?.(data.language, data.segmentIndex);
      } else if (data?.action === 'language-error') {
        console.warn('[client] language change rejected:', data?.error);
      }
    }));

    socket.on('floor-question-error', (data) => applyNcip(data, () => {
      console.warn('[client] floor-question-error:', data?.error);
      setFloorAnswering(false);
      setFloorError(data?.error || 'Question failed.');
    }));

    // NCIP Slice 2: authoritative snapshot — sent on join and on session.sync.
    // Replaces local NCIP state wholesale; stale snapshots are dropped.
    socket.on('session.snapshot', (snap) => {
      if (snapshotIsStale(lastAppliedVersionRef.current, snap)) {
        console.log('[ncip] stale snapshot ignored, v' + snap?.stateVersion + ' < v' + lastAppliedVersionRef.current);
        return;
      }
      console.log('[ncip] applying session.snapshot v' + snap?.stateVersion + ':', snap?.professor?.status);
      lastAppliedVersionRef.current = snap?.stateVersion ?? lastAppliedVersionRef.current;
      syncPendingRef.current = false;

      // Floor + professor UI state.
      const { floorQueue, activeSpeaker } = snapshotFloor(snap);
      setFloorQueue(floorQueue);
      setActiveSpeaker(activeSpeaker);
      const status = snap?.professor?.status || 'IDLE';
      setProfessorStatus(status);
      setCanCatchUp(snap?.canCatchUp === true);
      setRoomMeta(snap?.room || null); // roomType/hostId for private-room UI
      setPauseReason(snap?.interruption?.pauseReason || null);
      setJoinPending(false); // snapshot = admitted
      setFloorAnswering(status === 'THINKING' || status === 'ANSWERING');
      if (activeSpeaker?.userId !== myIdRef.current) floorReadyRef.current = false;

      // NCIP Slice 3: adopt the authoritative room language immediately —
      // lecture recovery below and future checkpoint reports use it.
      if (snap?.language?.roomLanguage) {
        lectureLangRef.current = snap.language.roomLanguage;
        setLectureLang(snap.language.roomLanguage);
      }

      // Floor held => a recovered lecture head must stay paused (Avatar
      // consults floorPausedRef before playing the head message).
      const floorHeld = status === 'PAUSED' || status === 'THINKING' || status === 'ANSWERING';
      speechCtlRef.current.floorPausedRef.current = floorHeld;
      speechCtlRef.current.setFloorPaused(floorHeld);

      // In-flight floor answer: join partway through instead of missing it.
      const answerPlan = planAnswerRecovery(snap);
      const answerMsg = answerPlan.action === 'play' ? answerPlan.message : null;
      if (answerMsg) {
        console.log('[ncip] recovering in-flight answer at +' + answerPlan.elapsedMs + 'ms (seek ' + answerPlan.seekSec.toFixed(2) + 's)');
      }

      // Lecture recovery at the canonical server position — never seg 0.
      const plan = planLectureRecovery(snap, speechCtlRef.current.messages);
      if (plan.action === 'resume' || plan.action === 'reload') {
        // The room is actively lecturing — reflect that in the panel so a
        // late joiner sees "Class in Progress", not "Start Class", and so a
        // room-wide language change applies to this client too.
        setLectureStatus('teaching');
      }
      if (plan.action === 'resume') {
        if (floorHeld) {
          positionLectureAtCheckpoint(plan.checkpoint, true);
          if (answerMsg) speechCtlRef.current.prependMessages([answerMsg]);
        } else {
          speechCtlRef.current.resumeLecture(plan.checkpoint);
        }
      } else if (plan.action === 'reload') {
        recoverLectureFromSnapshot(plan.checkpoint, floorHeld, answerMsg);
      } else if (answerMsg) {
        speechCtlRef.current.prependMessages([answerMsg]);
      }
    });

    // NCIP answer.end: report when this client finishes playing a floor
    // answer; the server advances the protocol on the first report.
    answerEndedRef.current = (msg) => {
      socket.emit('answer-ended', { id: msg.id });
    };

    return () => {
      answerEndedRef.current = null;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [pushMessage]);

  useEffect(() => {
    if (!message || message.fromRemote) return;
    // skipPlaybackReport: recovered snapshot heads re-enter the queue at a
    // position the server already knows — re-emitting them as a segment-start
    // report would corrupt the room's authoritative playback position.
    if (message.skipPlaybackReport) return;
    if (!message.id) return;
    if (lastEmittedMessageIdRef.current.has(message.id)) return;
    lastEmittedMessageIdRef.current.add(message.id);
    socketRef.current?.emit('professor-speak', message);
  }, [message]);

  useEffect(() => {
    if (myId && displayName && !joinedRef.current && socketRef.current?.connected) {
      joinedRef.current = true;
      socketRef.current.emit('join', {
        roomId: privateRoomId || sceneName,
        room: privateRoomId || undefined,
        invite: inviteToken || undefined,
        participantId: getParticipantId(),
        name: displayName,
        avatar: userAvatarPath,
        position: config.userStart.position,
        rotation: config.userStart.rotation[1] ?? Math.PI,
        animation: config.userStart.animation,
      });
    }
  }, [myId, displayName, sceneName, privateRoomId, inviteToken, userAvatarPath, config]);

  const onSceneReady = useCallback(() => {
    setSceneReady(true);
  }, []);

  // One-time centered hint on scene entry; auto-dismisses and hides on F5.
  useEffect(() => {
    if (!sceneReady) return;
    setCamHint(true);
    const t = setTimeout(() => setCamHint(false), 8000);
    const onKey = (e) => { if (e.key === 'F5') setCamHint(false); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [sceneReady]);

  // Ask for the mic once the user is fully inside the classroom: name
  // submitted and the 3D scene finished loading. One-time request; the
  // toolbar voice toggle still turns voice chat on/off independently.
  useEffect(() => {
    if (sceneReady && displayName) {
      requestMicrophoneAccess().catch(() => {});
    }
  }, [sceneReady, displayName, requestMicrophoneAccess]);

  const emitUserState = useCallback((data) => {
    socketRef.current?.emit('state-update', data);
  }, []);

  const others = useMemo(() => Object.values(remotePlayers).filter((p) => p.userId !== myId), [remotePlayers, myId]);
  // Private-room member list for the participants pill — self first.
  const roomMembers = useMemo(() => [
    { userId: myId, name: displayName || 'You', isSelf: true, isHost: roomMeta?.hostId === myId },
    ...others.map((p) => ({ userId: p.userId, name: p.name, isHost: roomMeta?.hostId === p.userId })),
  ], [myId, displayName, others, roomMeta]);

  // Keep the voice hook aware of who's in the room so voice can be enabled
  // after joining and still connect to existing members.
  useEffect(() => {
    voiceChat.setRemotePlayers(others);
  }, [others, voiceChat.setRemotePlayers]);

  const handRaised = useMemo(() => !!myId && floorQueue.some((p) => p.userId === myId), [floorQueue, myId]);

  const isActiveSpeaker = !!myId && activeSpeaker?.userId === myId;

  const toggleHand = useCallback(() => {
    pendingQuestionRef.current = null;
    if (isActiveSpeaker) {
      socketRef.current?.emit('release-floor');
    } else {
      socketRef.current?.emit(handRaised ? 'cancel-floor-request' : 'request-floor');
    }
  }, [handRaised, isActiveSpeaker]);

  // "Catch me up": a late joiner takes the floor and asks the professor to
  // recap what they missed. Reuses the normal floor pipeline — the request is
  // held in pendingQuestionRef and submitted when 'floor-ready' arrives, or
  // immediately if this client already holds a ready floor.
  const requestCatchUp = useCallback(() => {
    if (!canCatchUp) return;
    setFloorError(null);
    const recap = { kind: 'recap', question: 'Summarize what I missed.' };
    if (isActiveSpeaker && floorReadyRef.current) {
      setFloorAnswering(true); // optimistic until the 'thinking' broadcast
      socketRef.current?.emit('ask-floor-question', { ...recap, lectureId: lectureIdRef.current });
    } else {
      pendingQuestionRef.current = recap;
      if (!isActiveSpeaker) socketRef.current?.emit('request-floor');
    }
  }, [canCatchUp, isActiveSpeaker]);

  // Create a private room bound to the currently selected lecture/language —


  const raisedHands = useMemo(() => new Set(floorQueue.map((p) => p.userId)), [floorQueue]);


  if (accessError) {
    return (
      <div className='flex h-screen w-screen flex-col items-center justify-center bg-slate-950 text-slate-100'>
        <Lock size={40} className='mb-4 text-violet-400' />
        <h2 className='text-xl font-bold'>Private room</h2>
        <p className='mt-2 max-w-sm text-center text-sm text-slate-400'>{accessError}</p>
        <a href='/' className='mt-6 rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800'>
          Back to courses
        </a>
      </div>
    );
  }

  return (
    <div className='relative h-screen w-screen bg-slate-950'>
      <LoadingOverlay visible={!sceneReady} />

      {/* Guest waiting on host approval (private rooms) */}
      {joinPending && (
        <div className='fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/90 text-slate-100 backdrop-blur'>
          <Loader2 size={36} className='mb-4 animate-spin text-violet-400' />
          <h2 className='text-lg font-bold'>Waiting for the host…</h2>
          <p className='mt-1 text-sm text-slate-400'>The host must approve your request to join this private room.</p>
        </div>
      )}

      {/* Host: pending guest approval requests (private rooms) */}
      {pendingRequests.length > 0 && (
        <div className='fixed bottom-24 right-4 z-50 flex w-80 flex-col gap-2'>
          {pendingRequests.map((r) => (
            <div key={r.socketId} className='flex items-center gap-3 rounded-xl border border-violet-500/40 bg-slate-900/95 px-4 py-3 shadow-2xl'>
              <User size={18} className='shrink-0 text-violet-300' />
              <div className='min-w-0 flex-1'>
                <p className='truncate text-sm font-semibold text-white'>{r.name || 'Guest'}</p>
                <p className='text-[11px] text-slate-400'>wants to join this private room</p>
              </div>
              <button
                className='rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500'
                onClick={() => {
                  socketRef.current?.emit('private-join-decision', { socketId: r.socketId, accept: true });
                  setPendingRequests((l) => l.filter((x) => x.socketId !== r.socketId));
                }}
              >
                Accept
              </button>
              <button
                className='rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-600'
                onClick={() => {
                  socketRef.current?.emit('private-join-decision', { socketId: r.socketId, accept: false });
                  setPendingRequests((l) => l.filter((x) => x.socketId !== r.socketId));
                }}
              >
                Decline
              </button>
            </div>
          ))}
        </div>
      )}

      {!displayName && (
        <NameEntryModal
          onSubmit={(name) => {
            sessionStorage.setItem(DISPLAY_NAME_KEY, name);
            setDisplayName(name);
          }}
        />
      )}

      {sceneReady && camHint && (
        <div className='pointer-events-none fixed inset-0 z-40 flex items-center justify-center'>
          <div className='rounded-2xl border border-slate-700/60 bg-slate-900/85 px-8 py-5 text-center shadow-2xl backdrop-blur'>
            <p className='text-sm font-semibold text-white'>
              Press <span className='rounded-md bg-slate-700 px-2 py-0.5 font-mono text-cyan-300'>F5</span> to toggle camera
            </p>
            <p className='mt-1.5 text-xs text-slate-400'>Switch between first-person and third-person view</p>
          </div>
        </div>
      )}

      {sceneReady && (
        <>
          <ClassroomPanel
            course={config}
            lectureId={lectureId}
            lectureTitle={lectureTitle}
            state={lectureStatus}
            error={lectureError}
            onStart={handleStartClass}
            onChat={() => setChatOpen((v) => !v)}
            chatOpen={chatOpen}
            displayName={displayName}
            floorQueue={floorQueue}
            activeSpeaker={activeSpeaker}
            handRaised={handRaised}
            isActiveSpeaker={isActiveSpeaker}
            onToggleHand={toggleHand}
            professorStatus={professorStatus}
            onVoice={voiceChat.toggleVoice}
            voiceOn={voiceChat.voiceOn}
            language={lectureLang}
            onLanguage={requestLanguageChange}
            canCatchUp={canCatchUp}
            onCatchUp={requestCatchUp}
            isPrivateRoom={isPrivateRoom}
            isRoomHost={isRoomHost}
            roomMembers={roomMembers}
            onKick={(userId) => socketRef.current?.emit('room.kick', { userId })}
            pauseReason={pauseReason}
            onCopyInvite={isRoomHost ? copyInvite : null}
            inviteCopied={inviteCopied}
            onHostPause={() => socketRef.current?.emit('lecture-control', { action: 'pause' })}
            onHostResume={() => socketRef.current?.emit('lecture-control', { action: 'resume' })}
            onHostEnd={() => socketRef.current?.emit('lecture-control', { action: 'end' })}
          />

          <ChatInterface
            hidden={!chatOpen}
            onMinimize={() => setChatOpen(false)}
            lectureId={lectureId}
            floorHolder={activeSpeaker}
            isFloorHolder={isActiveSpeaker}
            floorAnswering={floorAnswering}
            floorError={floorError}
            onFloorQuestion={(text) => {
              setFloorError(null);
              if (isActiveSpeaker && floorReadyRef.current) {
                setFloorAnswering(true); // optimistic: blocks duplicate sends before the 'thinking' broadcast arrives
                socketRef.current?.emit('ask-floor-question', { question: text, lectureId });
              } else {
                // Single protocol path: hold the question until the server
                // acknowledges the floor is ready ('floor-ready'), which is
                // emitted only after the holder's checkpoint is stored.
                pendingQuestionRef.current = text;
                if (!isActiveSpeaker) socketRef.current?.emit('request-floor');
              }
            }}
          />

          <Joystick joystick={joystick} hidden={!showJoystick} />

          <div className='relative z-20'>
            <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />
            <ContinuousRecorder />
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
            raisedHands={raisedHands}
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
            slidePage={slidePage}
            remoteStreams={voiceChat.remoteStreams}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}
