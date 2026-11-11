import { Suspense, useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { io } from 'socket.io-client';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { User, UserX, Users, Play, RotateCcw, MessageSquare, Loader2, AlertCircle, ChevronDown, Hand, Globe, X, Mic, MicOff, Languages, Lock, Copy, Pause } from 'lucide-react';
import { Scenario } from './components/Scenario';
import { ChatInterface } from './components/ChatInterface';
import { Joystick } from './components/Joystick';
import SettingsPanel from './components/SettingsPanel';
// ContinuousRecorder removed — no recording/download-video feature.

import { SCENE_CONFIG } from './sceneConfig';
import { useSpeech } from './hooks/useSpeech';
import { useVoiceChat } from './hooks/useVoiceChat';
import { classifyEvent, snapshotIsStale, snapshotFloor, planLectureRecovery, planAnswerRecovery, planLanguageSwitch, resolveSlidePage, resolveSlideDoc, shouldAcceptLectureUnit } from './services/ncipSync';
import { syncLectureClock } from './lectureClock';
import { API_URL, getParticipantId, CLASSROOM_LANGUAGES } from '../shared/config';
import { classroomSlug } from '../shared/classroomUrl';
import { getGuestToken, setGuestToken, getMe } from '../shared/auth';
import { getBranding } from '../shared/branding';

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

// Guests get a random friendly identity for the session — no prompt.
const GUEST_ADJ = ['Curious', 'Bright', 'Swift', 'Calm', 'Bold', 'Kind', 'Witty', 'Keen'];
const GUEST_NOUN = ['Otter', 'Fox', 'Falcon', 'Koala', 'Lynx', 'Panda', 'Raven', 'Wolf'];
const randomGuestName = () =>
  `${GUEST_ADJ[(Math.random() * GUEST_ADJ.length) | 0]} ${GUEST_NOUN[(Math.random() * GUEST_NOUN.length) | 0]}-${(Math.random() * 900 + 100) | 0}`;

// Friendly staged messages while the 3D classroom + assets load.
const LOAD_TIPS = [
  'Preparing the classroom…',
  'Arranging desks and holograms…',
  'Waking up the professor…',
  'Loading lecture materials…',
  'Dimming the lights…',
];

function LoadingOverlay({ visible }) {
  const [tip, setTip] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setTip((i) => (i + 1) % LOAD_TIPS.length), 2200);
    return () => clearInterval(t);
  }, [visible]);
  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#07050f]/95 text-white backdrop-blur-xl transition-opacity duration-500 ease-out ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      {/* Pulsing core inside two counter-rotating orbit rings */}
      <div className='loadorb'>
        <div className='loadorb__core' />
        <div className='loadorb__ring loadorb__ring--a' />
        <div className='loadorb__ring loadorb__ring--b' />
      </div>
      <div className='mt-8 flex items-baseline gap-2'>
        <span className='text-2xl font-bold tracking-wide text-white'>
          Wu<span className='text-violet-400'>Flux</span>
        </span>
      </div>
      <p className='mt-1 text-[10px] font-semibold uppercase tracking-[0.4em] text-slate-500'>
        Bionic Classroom
      </p>
      <div className='mt-9 h-[3px] w-56 overflow-hidden rounded-full bg-white/10'>
        <div className='loadbar' />
      </div>
      <p key={tip} className='loadtip mt-5 text-sm font-medium text-slate-400'>{LOAD_TIPS[tip]}</p>
    </div>
  );
}

function ClassroomPanel({
  course,
  lectureId,
  lectureTitle,
  classTitle = '',
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
  micState = null,
  isGuest = false,
  canModerate = false,
  micPerms = {},
  onMicDecision,
  onMicRevoke,
  language = 'en',
  onLanguage,
  canChangeLanguage = false,
  canCatchUp = false,
  onCatchUp,
  isPrivateRoom = false,
  isRoomHost = false,
  roomMembers = [],
  avatars = [],
  currentAvatar = '',
  onSelectAvatar,
  onRename,
  onKick,
  pauseReason = null,
  onCopyInvite,
  inviteCopied = false,
  onHostPause,
  onHostResume,
  onHostEnd,
  canEndLecture = false,
  langReadiness = null,
  onRepair = null,
}) {
  const number = String(Number(String(lectureId).replace(/\D/g, '')) || 0).padStart(2, '0');
  // Class may only start when every supported language is fully baked —
  // the server enforces the same rule on lecture.start.
  const langReadyMap = langReadiness?.langs || null;
  const allLangsReady = !langReadyMap || Object.values(langReadyMap).every((r) => r?.ready);
  const canStart = (state === 'idle' || state === 'completed' || state === 'error') && allLangsReady;
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);

  const LANGUAGES = CLASSROOM_LANGUAGES;
  const currentLangLabel = LANGUAGES.find((l) => l.code === language)?.label || 'English';

  // For owners/instructors/admins the class button toggles pause/resume:
  // LECTURING -> 'Pause Class', host-PAUSED -> 'Continue Class' (resumes
  // from the canonical checkpoint). Everyone else sees a passive label.
  const isHostPaused = state === 'teaching' && professorStatus === 'PAUSED' && pauseReason === 'host';
  const canPauseResume = canEndLecture && (professorStatus === 'LECTURING' || isHostPaused);
  let buttonLabel = 'Start Class';
  let ButtonIcon = Play;
  if (state === 'loading') { buttonLabel = 'Loading Lecture...'; ButtonIcon = Loader2; }
  else if (state === 'teaching') {
    if (isHostPaused && canEndLecture) { buttonLabel = 'Continue Class'; ButtonIcon = Play; }
    else if (canEndLecture && professorStatus === 'LECTURING') { buttonLabel = 'Pause Class'; ButtonIcon = Pause; }
    else { buttonLabel = 'Class in Progress'; ButtonIcon = Play; }
  }
  else if (state === 'completed') { buttonLabel = 'Replay Lecture'; ButtonIcon = RotateCcw; }
  else if (state === 'error') { buttonLabel = 'Retry Class'; ButtonIcon = RotateCcw; }
  if (!allLangsReady && state !== 'teaching') {
    buttonLabel = 'Preparing…';
    ButtonIcon = Loader2;
  }

  const handLabel = isActiveSpeaker ? 'Release Floor' : handRaised ? 'Lower Hand' : 'Raise Hand';

  const pillBase =
    'flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-1 text-left transition hover:bg-slate-800/80 sm:px-2';

  return (
    <>
      {(langMenuOpen || membersOpen || avatarMenuOpen) && (
        <div
          className='fixed inset-0 z-40'
          onClick={() => {
            setLangMenuOpen(false);
            setMembersOpen(false);
            setAvatarMenuOpen(false);
          }}
        />
      )}

      <div className='fixed inset-x-0 top-0 z-50'>
        <div className='flex w-full items-center gap-1 border-b border-slate-700/50 bg-slate-900/85 px-1.5 py-1 text-white shadow-2xl backdrop-blur sm:px-3'>

          {/* Brand + current class — navbar left side. */}
          <div className='mr-auto flex items-center gap-2 pr-3'>
            <span className='text-sm font-bold tracking-tight text-cyan-400'>WuFlux</span>
            {(classTitle || lectureTitle) && (
              <span className='hidden max-w-[40vw] truncate text-[10px] text-slate-400 sm:block'>
                {classTitle || lectureTitle}
              </span>
            )}
          </div>

          <div className='relative'>
            <button
              onClick={() => { if (!isGuest) onToggleHand(); }}
              disabled={isGuest}
              title={isGuest ? 'Sign in to raise your hand' : undefined}
              className={`${pillBase} border ${
                handRaised || isActiveSpeaker
                  ? 'border-cyan-400/60 bg-slate-800/60'
                  : 'border-cyan-500/30'
              } ${isGuest ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <Hand
                size={16}
                className={isActiveSpeaker ? 'text-emerald-300' : handRaised ? 'text-amber-300' : 'text-cyan-300'}
              />
              <div className='leading-tight'>
                <p className='text-[11px] font-semibold'>{handLabel}</p>
                <p className='hidden text-[10px] text-slate-400 sm:block'>
                  {isActiveSpeaker ? 'You have the floor' : handRaised ? 'Hand is raised' : 'Let the instructor know'}
                </p>
              </div>
            </button>

            {/* Recap shortcut — only appears for late joiners with a valid
                recap anchor (server-authoritative via canCatchUp). */}
            {canCatchUp && (
              <button
                onClick={() => onCatchUp?.()}
                title='Recap what you missed since joining'
                className={`${pillBase} mt-1 w-full border border-violet-500/40`}
              >
                <RotateCcw size={16} className='text-violet-300' />
                <div className='leading-tight'>
                  <p className='text-[11px] font-semibold'>Catch Me Up</p>
                  <p className='hidden text-[10px] text-slate-400 sm:block'>Recap what you missed</p>
                </div>
              </button>
            )}
          </div>

          <button
            onClick={onVoice}
            title={voiceOn ? 'Mute microphone' : micState === 'pending' ? 'Microphone request pending approval' : 'Unmute microphone (requests permission first)'}
            className={`${pillBase} ${voiceOn ? 'bg-slate-800/80 ring-1 ring-emerald-400/50' : ''}`}
          >
            {voiceOn
              ? <Mic size={16} className='text-emerald-300' />
              : micState === 'pending'
                ? <Mic size={16} className='text-amber-300' />
                : <MicOff size={16} className='text-slate-300' />}
            <div className='leading-tight'>
              <p className='text-[11px] font-semibold'>Voice</p>
              <p className='hidden text-[10px] text-slate-400 sm:block'>{voiceOn ? 'On' : micState === 'pending' ? 'Requested…' : 'Off'}</p>
            </div>
          </button>

          {/* Avatar picker — swaps the local GLB and broadcasts the new path
              to the room so remote views update live. */}
          {avatars.length > 0 && (
            <div className='relative'>
              <button
                onClick={() => setAvatarMenuOpen((v) => !v)}
                title='Change your avatar'
                className={`${pillBase} ${avatarMenuOpen ? 'bg-slate-800/80 ring-1 ring-cyan-400/50' : ''}`}
              >
                <User size={16} className='text-slate-300' />
                <div className='leading-tight'>
                  <p className='text-[11px] font-semibold'>Avatar</p>
                  <p className='hidden text-[10px] text-slate-400 sm:block'>Change look</p>
                </div>
                <ChevronDown size={14} className={`text-slate-500 transition ${avatarMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {avatarMenuOpen && (
                <div className='absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-slate-700/50 bg-slate-900/95 p-1.5 text-xs shadow-2xl backdrop-blur'>
                  {/* Live rename — broadcasts the new name to the room. */}
                  <form
                    className='mb-1 border-b border-slate-700/50 pb-1.5'
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = e.currentTarget.elements.rename.value.trim();
                      if (v && v !== displayName) onRename?.(v);
                      setAvatarMenuOpen(false);
                    }}
                  >
                    <label className='px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500'>
                      Your name
                    </label>
                    <div className='mt-1 flex gap-1 px-1'>
                      <input
                        name='rename'
                        defaultValue={displayName}
                        maxLength={32}
                        className='min-w-0 flex-1 rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500'
                      />
                      <button type='submit' className='rounded-md bg-cyan-500 px-2 text-[10px] font-semibold text-slate-950 hover:bg-cyan-400'>
                        Save
                      </button>
                    </div>
                  </form>
                  {avatars.map((a) => (
                    <button
                      key={a.path}
                      onClick={() => { onSelectAvatar?.(a.path); setAvatarMenuOpen(false); }}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition hover:bg-slate-800 ${
                        a.path === currentAvatar ? 'text-cyan-300' : 'text-slate-200'
                      }`}
                    >
                      <span>{a.name}</span>
                      {a.path === currentAvatar && <span className='text-[10px]'>●</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {isPrivateRoom && (
            <div className='relative'>
              <button onClick={() => setMembersOpen((v) => !v)} className={pillBase}>
                <Users size={16} className='text-slate-300' />
                <div className='leading-tight'>
                  <p className='text-[11px] font-semibold'>Participants</p>
                  <p className='hidden text-[10px] text-slate-400 sm:block'>{roomMembers.length} in this class</p>
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
                      <span className='ml-2 flex items-center gap-1'>
                        {canModerate && !m.isSelf && micPerms[m.userId] === 'pending' && (
                          <>
                            <button onClick={() => onMicDecision?.(m.userId, true)}
                              className='rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-500/15'>
                              Allow mic
                            </button>
                            <button onClick={() => onMicDecision?.(m.userId, false)}
                              className='rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-rose-300 hover:bg-rose-500/15'>
                              Deny
                            </button>
                          </>
                        )}
                        {canModerate && !m.isSelf && micPerms[m.userId] === 'granted' && (
                          <button onClick={() => onMicRevoke?.(m.userId)}
                            className='rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 hover:bg-rose-500/15 hover:text-rose-300'
                            title='Microphone granted — click to revoke'>
                            mic on
                          </button>
                        )}
                        {isRoomHost && !m.isSelf && !m.isHost && onKick && (
                          <button
                            onClick={() => onKick(m.userId)}
                            title={`Remove ${m.name || 'this user'} from the room`}
                            className='rounded-md p-1 text-slate-500 transition hover:bg-rose-500/15 hover:text-rose-300'
                          >
                            <UserX size={14} />
                          </button>
                        )}
                      </span>
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
              <Copy size={16} className={inviteCopied ? 'text-emerald-300' : 'text-violet-300'} />
              <div className='leading-tight'>
                <p className='text-[11px] font-semibold'>{inviteCopied ? 'Copied!' : 'New Invite'}</p>
                <p className='hidden text-[10px] text-slate-400 sm:block'>One-time link</p>
              </div>
            </button>
          )}

          <div className='relative'>
            <button
              onClick={() => setLangMenuOpen((v) => !v)}
              title={`Your lecture language — applies only to you (${currentLangLabel})`}
              className={`${pillBase} ${langMenuOpen ? 'bg-slate-800/80 ring-1 ring-cyan-400/50' : ''}`}
            >
              <Languages size={16} className='text-slate-300' />
              <div className='leading-tight'>
                <p className='text-[11px] font-semibold'>Language</p>
                <p className='hidden text-[10px] text-slate-400 sm:block'>{currentLangLabel}</p>
              </div>
              <ChevronDown size={14} className={`text-slate-500 transition ${langMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {langMenuOpen && (
              <div className='absolute left-1/2 top-full z-50 mt-2 w-44 -translate-x-1/2 rounded-2xl border border-slate-700/50 bg-slate-900/95 p-2 text-xs shadow-2xl backdrop-blur'>
                {LANGUAGES.filter((l) => !langReadyMap || langReadyMap[l.code]?.ready).map((l) => (
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
                  Your language only — others keep theirs. Applies from the next segment.
                </p>
              </div>
            )}
          </div>

          {(!isPrivateRoom || isRoomHost || canEndLecture) && (
            <button
              onClick={canPauseResume ? (isHostPaused ? onHostResume : onHostPause) : onStart}
              disabled={!canStart && !canPauseResume}
              title={!allLangsReady && langReadiness?.missing?.length
                ? `Still preparing: ${langReadiness.missing.join('; ')}`
                : undefined}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                canPauseResume
                  ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                  : state === 'teaching' || state === 'loading'
                    ? 'cursor-not-allowed bg-slate-700 text-slate-300'
                    : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'
              }`}
            >
              <ButtonIcon size={16} className={state === 'loading' || !allLangsReady ? 'animate-spin' : ''} />
              {buttonLabel}
            </button>
          )}

          {!allLangsReady && state !== 'teaching' && (
            <div className='absolute left-1/2 top-full z-40 mt-2 w-80 -translate-x-1/2 rounded-2xl border border-slate-700/50 bg-slate-900/95 p-3 shadow-2xl backdrop-blur'>
              <div className='mb-2 flex items-center justify-between'>
                <p className='text-xs font-semibold text-slate-200'>
                  {langReadiness?.running ? 'Preparing…' : 'Incomplete'}
                </p>
                {!langReadiness?.running && onRepair && (
                  <button
                    onClick={onRepair}
                    className='rounded-full bg-cyan-500/90 px-3 py-1 text-[11px] font-semibold text-slate-950 hover:bg-cyan-400'
                  >
                    Retry
                  </button>
                )}
              </div>
              {(langReadyMap ? Object.entries(langReadyMap) : []).map(([code, r]) => {
                const done = (r?.readyCount ?? 0) + (r?.utterances?.have ?? 0);
                const total = (r?.total ?? 0) + (r?.utterances?.expected ?? 0);
                const pct = total ? Math.round((done / total) * 100) : 0;
                return (
                  <div key={code} className='mb-1.5 last:mb-0'>
                    <div className='flex items-baseline justify-between text-[11px]'>
                      <span className='font-semibold uppercase text-slate-300'>{code}</span>
                      <span className='text-slate-400'>
                        segments {r?.readyCount ?? 0}/{r?.total ?? 0} · utterances {r?.utterances?.have ?? 0}/{r?.utterances?.expected ?? 0}
                      </span>
                    </div>
                    <div className='mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-700/60'>
                      <div
                        className={`h-full rounded-full ${r?.ready ? 'bg-emerald-400' : langReadiness?.running ? 'bg-cyan-400' : 'bg-amber-400'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {!r?.ready && !langReadiness?.running && r?.missingSegments?.length > 0 && (
                      <p className='mt-0.5 text-[10px] text-amber-300/80'>
                        failed: segments {r.missingSegments.join(', ')}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {canEndLecture &&
            ['LECTURING', 'PAUSED', 'THINKING', 'ANSWERING', 'RESUMING'].includes(professorStatus) && (
            <button
              onClick={onHostEnd}
              title='Stop the lecture and reset to the beginning'
              className='flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-500'
            >
              <X size={16} /> Stop Lecture
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
  const [searchParams] = useSearchParams();
  const roomId = searchParams.get('room');
  const direct = SCENE_CONFIG[sceneName];
  // Classroom slugs (e.g. /classroom/haptics) are not scene keys — resolve the
  // authoritative scene from the room registry. undefined = still loading.
  const [meta, setMeta] = useState(undefined);

  useEffect(() => {
    if (direct || !roomId) return;
    let cancelled = false;
    fetch(`${API_URL}/api/rooms/${roomId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (!cancelled) setMeta(m); })
      .catch(() => { if (!cancelled) setMeta(null); });
    return () => { cancelled = true; };
  }, [direct, roomId]);

  // Tab title: "WuFlux | <classroom name>" inside a classroom; restored on exit.
  const classTitle = meta?.className || meta?.courseName
    || (direct ? (SCENE_CONFIG[sceneName]?.title || sceneName) : null);
  useEffect(() => {
    if (!classTitle) return;
    let cancelled = false;
    getBranding().then((b) => {
      if (!cancelled) document.title = `${b?.appName || 'WuFlux'} | ${classTitle}`;
    });
    return () => {
      cancelled = true;
      getBranding().then((b) => { if (b?.appName) document.title = b.appName; });
    };
  }, [classTitle]);

  const sceneKey = direct ? sceneName : meta?.scene;
  if (!sceneKey) {
    return meta === null
      ? <NotFound sceneName={sceneName} />
      : <LoadingOverlay visible />;
  }

  return <SceneRoom sceneName={sceneKey} baseConfig={SCENE_CONFIG[sceneKey]} classTitle={classTitle} />;
}

function SceneRoom({ sceneName, baseConfig, classTitle }) {
  const navigate = useNavigate();
  // URL path segment (a cosmetic classroom slug or a bare scene key) — the
  // resolved sceneName prop is the authoritative scene config key.
  const { sceneName: urlSlug } = useParams();
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
    const stored = sessionStorage.getItem('nxr_avatar');
    if (stored && USER_AVATARS.some((a) => a.path === stored)) return stored;
    const i = Math.floor(Math.random() * USER_AVATARS.length);
    return USER_AVATARS[i].path;
  });
  const selectAvatar = useCallback((path) => {
    if (!USER_AVATARS.some((a) => a.path === path)) return;
    sessionStorage.setItem('nxr_avatar', path);
    setUserAvatarPath(path);
    socketRef.current?.emit('state-update', { avatar: path });
  }, []);
  const [cameraPreset, setCameraPreset] = useState('third-person');
  const [inRange, setInRange] = useState(false);
  // Chat/transcript panel follows the class lifecycle — open while a class
  // is live, closed before start and after end. A late joiner lands on
  // 'teaching' via the snapshot and the panel opens for them too.
  const [chatOpen, setChatOpen] = useState(false);
  const [lectureLang, setLectureLang] = useState('en');
  const [camHint, setCamHint] = useState(false);
  const [showUserAvatar] = useState(true);
  const [myId, setMyId] = useState(null);
  // Stage 2: server-resolved identity ('self-info') and mic grant map.
  const [selfInfo, setSelfInfo] = useState(null);
  const [micPerms, setMicPerms] = useState({});
  const [displayName, setDisplayName] = useState(() => {
    const stored = sessionStorage.getItem(DISPLAY_NAME_KEY);
    return stored && stored.trim() ? stored.trim() : null;
  });

  // Name resolution: signed-in users join under their account name (first +
  // last, set at registration). Guests are PROMPTED for a name before joining
  // — the suggestion is a friendly random one they can keep or replace.
  const [guestNameNeeded, setGuestNameNeeded] = useState(false);
  useEffect(() => {
    if (displayName) return;
    getMe().then((r) => {
      const name = r.ok && r.data.user?.displayName;
      if (name) {
        sessionStorage.setItem(DISPLAY_NAME_KEY, name);
        setDisplayName(name);
      } else {
        setGuestNameNeeded(true);
      }
    }).catch(() => setGuestNameNeeded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitGuestName = useCallback((name) => {
    const n = String(name || '').trim().slice(0, 32);
    if (!n) return;
    sessionStorage.setItem(DISPLAY_NAME_KEY, n);
    setDisplayName(n);
    setGuestNameNeeded(false);
  }, []);

  // Live rename (avatar menu): updates the nameplate + broadcasts the new
  // name so remote nameplates and the floor queue follow immediately.
  const renameTo = useCallback((name) => {
    const n = String(name || '').trim().slice(0, 32);
    if (!n) return;
    sessionStorage.setItem(DISPLAY_NAME_KEY, n);
    setDisplayName(n);
    socketRef.current?.emit('state-update', { name: n });
  }, []);
  const [remotePlayers, setRemotePlayers] = useState({});
  const [floorQueue, setFloorQueue] = useState([]);
  const [activeSpeaker, setActiveSpeaker] = useState(null);
  // Previous floor holder — lets the toast fire only on HOLDER CHANGES, not
  // every floor-state broadcast (queue joins, professor flips, etc).
  const floorHolderRef = useRef(null);
  const [floorNotice, setFloorNotice] = useState(null); // "<name> is asking" toast
  const floorNoticeTimer = useRef(null);
  const [professorStatus, setProfessorStatus] = useState('IDLE');
  const professorStatusRef = useRef('IDLE');
  professorStatusRef.current = professorStatus;
  const [floorAnswering, setFloorAnswering] = useState(false);
  const [floorError, setFloorError] = useState(null);
  // Transient notice for rejected language changes (unprepared language).
  const [langNotice, setLangNotice] = useState(null);
  const langNoticeTimer = useRef(null);
  const flashLangNotice = (msg) => {
    setLangNotice(msg);
    clearTimeout(langNoticeTimer.current);
    langNoticeTimer.current = setTimeout(() => setLangNotice(null), 8000);
  };
  // Server-authoritative: this participant joined a lecture already underway
  // and has a recap anchor — offered via the hand menu ("Catch me up").
  const [canCatchUp, setCanCatchUp] = useState(false);
  // Private-room flow: access errors replace the scene; created invite links
  // are shown to the host for sharing.
  const [accessError, setAccessError] = useState(null);
  const [accessErrorTitle, setAccessErrorTitle] = useState('Private room');
  const [inviteCopied, setInviteCopied] = useState(false);
  const lectureManifestRef = useRef([]); // last fetched segments (any lang)
  const maxSegRef = useRef(0);           // highest segment index reached
  const [spawnPos, setSpawnPos] = useState(null); // server-assigned spawn slot
  // Private-room guest admission: guests wait for host approval; the host sees
  // pending requests and approves/declines each one.
  const [joinPending, setJoinPending] = useState(false);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [roomMeta, setRoomMeta] = useState(null); // {roomId, roomType, hostId} from snapshot
  const [pauseReason, setPauseReason] = useState(null); // 'host' during a host discussion pause
  const isPrivateRoom = roomMeta?.roomType === 'private';
  // Host identity must use the SERVER-resolved participant id (self-info),
  // never the locally generated one — a client can't mint host authority.
  const isRoomHost = isPrivateRoom && roomMeta?.hostId === myId;
  // Lecture End works in both room types: owner, INSTRUCTOR, or SUPER_ADMIN.
  const isRoomOwner = roomMeta?.hostId === myId;
  const canEndLecture = isRoomOwner
    || selfInfo?.user?.role === 'INSTRUCTOR' || selfInfo?.user?.role === 'SUPER_ADMIN';
  // Room language is host/instructor-only — mirrors the server check in the
  // language.change handler (students/guests see a read-only pill).
  const canChangeLanguage = isRoomOwner
    || selfInfo?.user?.role === 'INSTRUCTOR' || selfInfo?.user?.role === 'SUPER_ADMIN';

  // Room joins without a lecture yet go through the course picker — the
  // lecture is chosen on entry, then the room/invite params are carried back.
  // Uses the URL slug (the class name, e.g. "machine-learning") — the
  // by-name endpoint normalizes separators, so it still resolves the course.
  useEffect(() => {
    if (privateRoomId && !lectureId) {
      const q = new URLSearchParams({ room: privateRoomId, ...(inviteToken ? { invite: inviteToken } : {}) });
      navigate(`/course/${encodeURIComponent(urlSlug)}?${q}`, { replace: true });
    }
  }, [privateRoomId, lectureId, inviteToken, urlSlug, navigate]);

  // Canonical slug check: a ?room= link's path segment must be the room's
  // classroom-name slug (e.g. /classroom/haptics) — stale links, legacy
  // /scene/<key> URLs, and drifted slugs are rewritten while preserving
  // room/invite/lecture params. The registry stays authoritative for the
  // scene itself. No-lecture joins defer to the course picker instead —
  // rewriting here would race the picker redirect and abandon it.
  useEffect(() => {
    if (!privateRoomId || !lectureId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/rooms/${privateRoomId}`);
        if (!res.ok) return;
        const meta = await res.json();
        const inviteQs = inviteToken ? `&invite=${inviteToken}` : '';
        if (meta?.lectureId && meta.lectureId !== lectureId) {
          // Bound room: it teaches its own lecture — a stale/mismatched
          // ?lecture= is corrected to the room's binding, never honored.
          if (!cancelled) {
            navigate(`${classroomPath(meta)}${inviteQs}`, { replace: true });
          }
          return;
        }
        if (meta && !meta.lectureId) {
          // Unbound course room: the chosen lecture lives in its own
          // dedicated room — reroute so different lectures never share
          // the same classroom.
          const jr = await fetch(`${API_URL}/api/rooms/${privateRoomId}/join-lecture`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lectureId, invite: inviteToken || null }),
          });
          const jd = await jr.json().catch(() => ({}));
          if (!cancelled && jr.ok && jd.joinUrl) {
            navigate(`${jd.joinUrl}${inviteQs}`, { replace: true });
          }
          return;
        }
        const canonical = meta ? classroomSlug(meta) : null;
        if (!cancelled && canonical && canonical !== urlSlug) {
          const q = new URLSearchParams({
            room: privateRoomId,
            ...(inviteToken ? { invite: inviteToken } : {}),
            ...(lectureId ? { lecture: lectureId } : {}),
          });
          navigate(`/classroom/${encodeURIComponent(canonical)}?${q}`, { replace: true });
        }
      } catch (err) {
        console.warn('[room-meta]', err);
      }
    })();
    return () => { cancelled = true; };
  }, [privateRoomId, urlSlug, inviteToken, lectureId, navigate]);

  // Invite links are single-use: the host mints a fresh one on each share
  // (server rotates the token). Guests never see this control.
  const copyInvite = useCallback(async () => {
    if (!privateRoomId) return;
    try {
      const res = await fetch(`${API_URL}/api/rooms/${privateRoomId}/invite`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId: myId }), // ignored server-side unless dev-compat
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
  // Authoritative open/close: 'teaching' keeps the transcript visible; any
  // other status (idle/loading/completed/error) closes it. Manual minimize
  // still works — the effect only fires on status CHANGE, not every render.
  useEffect(() => {
    setChatOpen(lectureStatus === 'teaching');
  }, [lectureStatus]);

  const [lectureError, setLectureError] = useState(null);
  const [lectureTitle, setLectureTitle] = useState(null);


  const { message, messages, pushMessage, clearMessages, replacePending, replaceQueue, audioElementRef, stopAudio, requestMicrophoneAccess, prependMessages, pauseLectureForFloor, resumeLecture, floorPausedRef, setFloorPaused, answerEndedRef, lectureSegmentEndedRef, audioErrorRef, setRecognitionLang, getLecturePosition } = useSpeech();
  const speechCtlRef = useRef({});
  speechCtlRef.current = { prependMessages, pauseLectureForFloor, resumeLecture, replaceQueue, clearMessages, setFloorPaused, floorPausedRef, audioElementRef, stopAudio, messages, audioErrorRef, getLecturePosition };

  // Slide follows the current lecture segment's slidePage. The head during
  // Q&A is an answer, so resolveSlidePage anchors on the first lecture
  // message in the queue; the last resolved page persists as fallback.
  const slidePageRef = useRef(1);
  const slidePage = useMemo(() => {
    const p = resolveSlidePage(messages, slidePageRef.current);
    slidePageRef.current = p;
    return p;
  }, [messages]);

  // Eval instrumentation (read-only, gated on ?nxrdbg): per-client segment
  // head transitions — 'to' = new segment start, 'from' = segment just
  // ended (null = queue empty / waiting at a barrier boundary).
  const nxrdbg = useMemo(
    () => new URLSearchParams(window.location.search).has('nxrdbg'), []);
  const prevHeadRef = useRef(null);
  useEffect(() => {
    if (!nxrdbg) return;
    const head = messages?.[0];
    const id = head?.type === 'lecture' ? head.id : null;
    if (id === prevHeadRef.current) return;
    const prev = prevHeadRef.current;
    prevHeadRef.current = id;
    (window.__nxrSegEvents ??= []).push({ ev: 'head-change', from: prev, to: id, t: Date.now() });
  }, [messages, nxrdbg]);
  // The document the current slide belongs to — multi-PDF lectures switch
  // the board between source files as segments change.
  const slideDocRef = useRef(null);
  const slideDoc = useMemo(() => {
    const d = resolveSlideDoc(messages, slideDocRef.current);
    slideDocRef.current = d;
    return d;
  }, [messages]);
  // Prefetch the NEXT segment's audio + slide while the current one plays.
  // The manifest is already held for transcript/lang-switch; warming the
  // browser caches hides segment-boundary fetch latency.
  useEffect(() => {
    // No prefetch while the floor is held — warming audio mid-Q&A can race
    // the resume and any segment the agent hasn't emitted yet is speculative.
    if (speechCtlRef.current.floorPausedRef?.current) return;
    const head = messages[0];
    const segIdx = head?.id && /_seg_(\d+)$/.exec(head.id)?.[1];
    if (segIdx == null) return;
    const segs = lectureManifestRef.current;
    const next = segs[segs.findIndex((s) => String(s.id) === String(segIdx)) + 1];
    if (!next) return;
    if (next.audioUrl) fetch(`${API_URL}${next.audioUrl}`).catch(() => {});
    if (next.slidePage) {
      const doc = next.slideDoc ? `&doc=${encodeURIComponent(next.slideDoc)}` : '';
      fetch(`${API_URL}/api/lecture/pdf_image/${lectureId}?page=${next.slidePage}${doc}`).catch(() => {});
    }
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
  // Locally-recorded pause checkpoint — this client's own paused position,
  // used FIRST on resume (exact same-language offset; sentence+fraction
  // re-grounded through the current language after a mid-pause switch).
  // The server's per-pid checkpoint is the fallback for reconnects.
  const localResumeCpRef = useRef(null);
  // Start-class watchdog — resolved on 'lecture-started'/'control-error',
  // fires an error if the server never answers (see handleStartClass).
  const startWatchdogRef = useRef(null);
  // Unit ids already delivered to the queue for the CURRENT run — a
  // duplicate professor-speak for an id that's played/queued must not
  // re-enter playback. Cleared on 'lecture-started' (explicit Replay is a
  // fresh run and legitimately reuses ids).
  const deliveredUnitsRef = useRef(new Set());
  // Host End / lecture-complete: status resets to 'idle' (which still accepts
  // units pre-start) — this latch drops any professor-speak that arrives
  // AFTER the end broadcast until the next 'lecture-started' clears it.
  const lectureEndedRef = useRef(false);
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

  // Lecture switch inside the same mounted scene (Lecture_1 -> Lecture_2
  // without leaving the room): every lecture-scoped piece of state resets —
  // manifest, transcript seed, max-seg watermark, slide anchors — so nothing
  // from the previous lecture bleeds into the new one.
  useEffect(() => {
    setLectureStatus('idle');
    setLectureError(null);
    setLectureTitle(null);
    clearMessages();
    lectureManifestRef.current = [];
    maxSegRef.current = -1;
    setScriptSeed([]);
    slidePageRef.current = 1;
    slideDocRef.current = null;
    floorReadyRef.current = false;
    pendingQuestionRef.current = null;
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

  // Full prepared narration for the Script view — fetched eagerly when a
  // lecture is selected so the whole script is readable before Start Class.
  // Same manifest endpoint the server plays from; no extra generation.
  const [lectureScript, setLectureScript] = useState([]);
  useEffect(() => {
    setLectureScript([]);
    if (!lectureId) return;
    let cancelled = false;
    fetch(`${API_URL}/api/lecture/segments/${lectureId}?lang=${lectureLang}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.segments?.length) {
          setLectureScript(d.segments);
          if (!lectureManifestRef.current.length) lectureManifestRef.current = d.segments;
          setLectureTitle((t) => t || d.title);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [lectureId, lectureLang]);

  // Per-language readiness — the Start button and the language menu are
  // gated on this so a partially-baked language is never offered. Polls
  // while the lecture is selected so a finishing bake flips it live.
  const [langReadiness, setLangReadiness] = useState(null);
  useEffect(() => {
    setLangReadiness(null);
    if (!lectureId) return;
    let cancelled = false;
    const poll = () => fetch(`${API_URL}/api/lecture/${lectureId}/readiness`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.langs) setLangReadiness(d); })
      .catch(() => {});
    poll();
    const t = setInterval(poll, 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, [lectureId]);

  // Host "Retry" on an incomplete lecture — the repair job only redoes the
  // missing segments/utterances; readiness re-polls pick up the progress.
  const repairLectureAssets = useCallback(async () => {
    if (!lectureId) return;
    try {
      await fetch(`${API_URL}/api/lecture/${lectureId}/repair`, {
        method: 'POST', credentials: 'include' });
    } catch { /* the next poll reflects state either way */ }
  }, [lectureId]);

  // Lazily fetch the segment manifest for transcript-seeding and language-
  // switch rebuilds — metadata only, NEVER pushed to the playback queue
  // (V2: the server emits each segment itself via professor-speak).
  const ensureLectureManifest = useCallback(async (lid, lang) => {
    if (!lid || lectureManifestRef.current.length > 0) return;
    // A stale emit can name a different lecture than this session — never
    // cache another lecture's manifest as ours.
    if (lectureIdRef.current && lid !== lectureIdRef.current) return;
    try {
      const res = await fetch(`${API_URL}/api/lecture/segments/${lid}?lang=${lang || 'en'}`);
      const data = await res.json();
      if (res.ok && data.segments?.length) {
        lectureManifestRef.current = data.segments;
        setLectureTitle((t) => t || data.title);
      }
    } catch (err) {
      console.error('[manifest] fetch failed:', err);
    }
  }, []);

  const handleStartClass = () => {
    // Server re-checks this anyway — the client check only avoids the emit.
    if (!lectureId || !canStartClass || langReadiness?.allReady === false) return;
    clearMessages();
    setLectureStatus('loading');
    setLectureError(null);
    maxSegRef.current = 0;
    // V2: the server owns lecture progression — ask it to start the session;
    // it emits one professor-speak message per segment to the whole room.
    socketRef.current?.emit('lecture.start', { lectureId });
    setChatOpen(true);
    // Watchdog: if the server never confirms the start (auth rejection,
    // handler crash, dead socket), surface a real error instead of spinning
    // on "Loading Lecture…" forever.
    clearTimeout(startWatchdogRef.current);
    startWatchdogRef.current = setTimeout(() => {
      if (lectureStatusRef.current === 'loading') {
        setLectureStatus('error');
        setLectureError('The classroom did not respond — check your connection and try again.');
      }
    }, 30_000);
  };

  // Mid-lecture language switch — resumes at the SAME segment index:
  //  - if a lecture segment is currently playing: pause it, rebuild the queue
  //    from that segment in the new language (replays that segment in Arabic)
  //  - if a floor answer is playing while a lecture segment is paused: the
  //    answer finishes, then the interrupted segment resumes in the new
  //    language (resumeAt is dropped — timestamps don't map across languages)
  // Per-user language: the selector sets THIS participant's language only
  // (same segment index + slide for everyone; other members keep theirs).
  // The server acks with 'language-mine' and this client applies it through
  // applyLanguageChange — identical mechanics to a room-wide switch.
  const myLangOverrideRef = useRef(null); // personal override — room 'language-change' no longer applies to me
  const roomLangRef = useRef('en');
  // A personal language switch that hasn't finished rebuilding the queue.
  // While set, an incoming floor 'resume' is deferred (re-applied after the
  // switch) instead of resuming mid-flight in the old language.
  const langSwitchInFlightRef = useRef(null);   // target lang, or null
  const pendingResumeRef = useRef(null);        // {pauseSeq, localCp, mine, roomCp}
  const pauseSeqRef = useRef(0);                // bumped per pause-for-floor
  const resolveResumeCpRef = useRef(null);      // set inside socket effect
  const applyDeferredResumeRef = useRef(null);  // set inside socket effect
  const requestLanguageChange = useCallback((lang) => {
    langSwitchInFlightRef.current = lang;
    socketRef.current?.emit('language.mine', { language: lang });
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
    if (lectureStatusRef.current !== 'teaching' || !lid) {
      if (langSwitchInFlightRef.current === lang) {
        langSwitchInFlightRef.current = null;
        applyDeferredResumeRef.current?.();
      }
      return;
    }

    const plan = planLanguageSwitch(speechCtlRef.current.messages, hintSegmentIndex);
    if (!plan) {
      if (langSwitchInFlightRef.current === lang) {
        langSwitchInFlightRef.current = null;
        applyDeferredResumeRef.current?.();
      }
      return;
    } // no known position — leave the queue untouched

    // Mid-segment resume inputs, captured BEFORE the rebuild: the live
    // playback offset inside the current segment, and the OLD language's
    // sentence alignment for that segment (from the current manifest).
    const livePos = plan.headIsLecture
      ? speechCtlRef.current.getLecturePosition?.()
      : null;
    const oldSeg = plan.headIsLecture
      ? (lectureManifestRef.current || []).find((s) => s.id === plan.segmentIndex)
      : null;

    try {
      const res = await fetch(`${API_URL}/api/lecture/segments/${lid}?lang=${lang}`);
      const data = await res.json();
      if (seq !== langSwitchSeqRef.current) return; // superseded by a newer switch
      if (!res.ok || !data.segments?.length) return;

      lectureManifestRef.current = data.segments;
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
          slideDoc: seg.slideDoc ?? null,
        }));
      if (seq !== langSwitchSeqRef.current || !segs.length) return;

      // Same-sentence resume: the index of the sentence playing at the live
      // offset in the OLD language maps to that sentence's start time in the
      // NEW language (baked alignment on both sides). Without alignment the
      // interrupted segment restarts from its beginning — the old behavior.
      if (livePos?.offsetSec > 0 && oldSeg?.sentences?.length
          && segs[0].id === `${lid}_seg_${plan.segmentIndex}`) {
        const newSents = data.segments.find(
          (s) => s.id === plan.segmentIndex)?.sentences;
        if (newSents?.length) {
          let si = 0;
          for (let k = 0; k < oldSeg.sentences.length; k++) {
            if ((oldSeg.sentences[k].start ?? 0) <= livePos.offsetSec + 0.15) si = k;
          }
          const resumeSec =
            newSents[Math.min(si, newSents.length - 1)]?.start ?? 0;
          if (resumeSec > 0.05) segs[0].resumeAt = resumeSec;
          console.log(`[lang-switch] resume seg ${plan.segmentIndex} ` +
            `at sentence ${si} → ${resumeSec.toFixed(2)}s (${lang})`);
        }
      }

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
    // Switch settled — clear the in-flight marker and, if a floor resume was
    // deferred mid-switch, apply it now through the NEW manifest.
    if (langSwitchInFlightRef.current === lang) {
      langSwitchInFlightRef.current = null;
      applyDeferredResumeRef.current?.();
    }
  };
  languageChangeRef.current = handleLanguageChange;

  // V2: lecture completion is server-authoritative ('lecture-complete') — an
  // empty client queue between agent decisions must NOT end the lecture.

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

  // Checkpoints carrying `projected` (reconnect-after-resume) are
  // re-projected at apply time: the class kept playing while the client
  // fetched manifests and rebuilt its queue.
  const projOffsetSec = (cp) => {
    const p = cp.projected;
    if (!p) return (cp.playbackOffsetMs ?? 0) / 1000;
    const estNow = p.snapNowMs + (Date.now() - p.recvAtMs);
    let off = p.baseSec + Math.max(0, (estNow - p.atMs) / 1000);
    if (Number.isInteger(p.roomSeg) && cp.segmentIndex === p.roomSeg) {
      const frontier = p.roomOffSec + Math.max(0, (estNow - p.snapNowMs) / 1000);
      off = Math.min(off, frontier);
    }
    return off;
  };

  // NCIP Slice 2: the checkpoint segment is already in the local queue.
  // Trim everything before it, stamp the authoritative offset as resumeAt,
  // and keep it paused while the floor is held.
  const positionLectureAtCheckpoint = (cp, floorHeld) => {
    const msgs = speechCtlRef.current.messages || [];
    const segId = `${cp.lectureId}_seg_${cp.segmentIndex}`;
    const idx = msgs.findIndex((m) => m.type === 'lecture' && m.id === segId);
    if (idx < 0) return false;
    msgs[idx].resumeAt = projOffsetSec(cp);
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
      lectureManifestRef.current = data.segments;
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
          slideDoc: seg.slideDoc ?? null,
        }));
      if (!segs.length) return;
      segs[0].resumeAt = projOffsetSec(cp);
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
      withCredentials: true, // session cookie authenticates the handshake
      transports: ['websocket', 'polling'],
      reconnection: !import.meta.env.DEV,
      reconnectionAttempts: 2,
      reconnectionDelay: 3000,
      timeout: 5000,
    });
    socketRef.current = socket;
    voiceChatRef.current.attachSocket(socket);
    const stopClockSync = syncLectureClock(socket); // V2.4 shared lecture clock

    socket.on('connect', () => {
      console.log('[client] socket connected, id:', socket.id);
      // Trigger the join effect — the AUTHORITATIVE pid arrives via
      // 'self-info' after admission (server-minted for guests, users.id
      // for authenticated sessions).
      setMyId((prev) => prev || getParticipantId());
    });

    // Stage 2: server-issued guest credential — store for future reconnects.
    socket.on('guest-session', ({ guestToken }) => {
      if (guestToken) setGuestToken(guestToken);
    });

    // Server-resolved identity (authoritative — replaces the local pid).
    socket.on('self-info', (info) => {
      setSelfInfo(info);
      if (info?.participantId) setMyId(info.participantId);
    });

    // A restricted event was rejected (e.g. guest raise-hand / AI question).
    socket.on('auth-error', (d) => {
      console.warn('[auth] rejected event:', d?.event);
      setFloorError(d?.error || 'Authentication required');
      // A rejected lecture.start must not leave the button spinning.
      if (lectureStatusRef.current === 'loading') {
        setLectureStatus('error');
        setLectureError('The lecture could not be started. Try again or ask the classroom owner.');
      }
    });

    // Microphone permission lifecycle.
    socket.on('mic-state', (d) => setMicPerms(d?.permissions || {}));
    socket.on('mic-requested', () => {
      setFloorError('Microphone request sent — waiting for approval.');
    });
    socket.on('mic-granted', () => {
      setFloorError(null);
      if (!voiceChatRef.current?.voiceOn) voiceChatRef.current?.toggleVoice?.();
    });
    socket.on('mic-denied', () => setFloorError('Microphone request denied.'));
    socket.on('mic-revoked', () => {
      setFloorError('Microphone permission revoked.');
      if (voiceChatRef.current?.voiceOn) voiceChatRef.current?.toggleVoice?.();
    });

    // Server-assigned spawn slot — late joiners land spread around the room
    // instead of stacked on the course's single spawn point.
    socket.on('spawn-position', ({ position }) => {
      if (Array.isArray(position)) setSpawnPos(position);
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
      // Eval instrumentation: when each authoritative version is applied —
      // convergence latency = applied.t - server emit time.
      if (nxrdbg) {
        (window.__nxrApplied ??= []).push({ v: data?.stateVersion ?? null, t: Date.now() });
      }
      apply();
    };

    socket.on('floor-state', (data) => applyNcip(data, () => {
      console.log('[client] floor-state received:', data);
      setFloorQueue(data?.floorQueue || []);
      const newHolder = data?.activeSpeaker || null;
      if (newHolder?.userId !== floorHolderRef.current) {
        floorHolderRef.current = newHolder?.userId || null;
        if (newHolder && newHolder.userId !== myIdRef.current) {
          clearTimeout(floorNoticeTimer.current);
          setFloorNotice(`${newHolder.name || 'A student'} is asking a question`);
          floorNoticeTimer.current = setTimeout(() => setFloorNotice(null), 6000);
        }
      }
      setActiveSpeaker(newHolder);
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
      setAccessErrorTitle('Disconnected');
      setAccessError('This classroom was opened in another tab — this window was disconnected.');
    });

    socket.on('room-kicked', () => {
      // Host removed us (private room): leave the classroom UI cleanly.
      speechCtlRef.current?.stopAudio?.();
      speechCtlRef.current?.clearMessages?.();
      setJoinPending(false);
      setAccessErrorTitle('Removed');
      setAccessError('The host removed you from this room.');
    });

    socket.on('join-error', (data) => {
      console.warn('[client] join rejected:', data?.error);
      joinedRef.current = false;
      if (data?.private) {
        // Private-room rejection: show the access error, don't bounce the user
        // back to the name prompt (a name can't fix a bad invite).
        setJoinPending(false);
        setAccessErrorTitle('Private room');
        setAccessError(data.error || 'Invalid or expired invite link.');
        return;
      }
      sessionStorage.removeItem(DISPLAY_NAME_KEY);
      setDisplayName(null);
      setGuestNameNeeded(true); // cleared name → re-prompt before retry
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
      // Ended room: a unit in flight when the owner ended class must never
      // re-enter the queue — 'lecture-started' is the only thing that opens it.
      if (lectureEndedRef.current && data?.type === 'lecture') {
        console.log('[client] ignoring lecture unit after end:', data?.id);
        return;
      }
      // Completed: drop stale echoes of a finished playthrough — a real
      // restart resets status via 'lecture-started' before units arrive.
      if (!shouldAcceptLectureUnit(data, lectureStatusRef.current)) {
        console.log('[client] ignoring lecture unit after completion:', data?.id);
        return;
      }
      // Drop stale units from a DIFFERENT lecture (e.g. a lingering
      // Lecture_1 room run while this session is bound to Lecture_2) —
      // they must never enter this client's queue or reseed its manifest.
      if (data?.type === 'lecture' && data?.lectureId && lectureIdRef.current
          && data.lectureId !== lectureIdRef.current) {
        console.warn('[client] ignoring professor-speak for other lecture:', data.lectureId);
        return;
      }
      // Duplicate delivery (same run): an id already queued or played can
      // never legitimately arrive twice — replayed ids only come with a new
      // 'lecture-started', which clears the set first.
      if (data?.type === 'lecture' && data?.id) {
        if (deliveredUnitsRef.current.has(data.id)) {
          console.log('[client] ignoring duplicate lecture unit:', data.id);
          return;
        }
        deliveredUnitsRef.current.add(data.id);
      }
      // Resolve host-relative audio URLs against the backend origin.
      const audioUrl = data?.audioUrl?.startsWith('/') ? `${API_URL}${data.audioUrl}` : data?.audioUrl;
      if (data?.floorAnswer) {
        setFloorAnswering(false);
        speechCtlRef.current.prependMessages([{ ...data, audioUrl, fromRemote: true }]);
      } else {
        pushMessage({ ...data, audioUrl }, true);
      }
      // V2 server-driven lecture segment — reflect live state for every
      // member (starters, late joiners, guests) and lazily grab the manifest
      // for transcript seeding / language-switch rebuilds.
      if (data?.type === 'lecture') {
        setLectureStatus('teaching');
        if (data?.title) setLectureTitle(data.title);
        ensureLectureManifest(data.lectureId || lectureIdRef.current, lectureLangRef.current);
      }
    }));

    // V2: a (re)start — clear any leftovers from a previous playthrough and
    // reset the transcript seed so the script doesn't show stale/repeated rows.
    socket.on('lecture-started', (data) => applyNcip(data, () => {
      clearTimeout(startWatchdogRef.current);
      speechCtlRef.current.clearMessages();
      setChatOpen(true); // transcript opens with the class
      setLectureStatus('teaching');
      setLectureError(null);
      setFloorAnswering(false);
      maxSegRef.current = -1;
      deliveredUnitsRef.current.clear();
      lectureEndedRef.current = false;
      setScriptSeed([]);
      setTranscriptEpoch((e) => e + 1);
    }));

    // V2: the agent decided the lecture is complete — the server is
    // authoritative for completion, not an empty local queue.
    socket.on('lecture-complete', (data) => applyNcip(data, () => {
      console.log('[client] lecture-complete:', data?.reason);
      lectureEndedRef.current = true;
      setChatOpen(false); // transcript closes with the class
      speechCtlRef.current.floorPausedRef.current = false;
      speechCtlRef.current.setFloorPaused(false);
      speechCtlRef.current.clearMessages();
      setLectureStatus('completed');
      setFloorAnswering(false);
    }));

    // Cross-language resume: the canonical checkpoint's playbackOffsetMs is
    // the HOLDER's position in THEIR language. When it carries sentenceIndex
    // and this client's language differs, map it to our own segment's sentence
    // start so listeners neither skip nor repeat content. Same-language (and
    // missing-alignment) clients keep the exact raw offset.
    const localizeCheckpoint = (cp) => {
      if (!cp || !Number.isInteger(cp.sentenceIndex) || cp.segmentIndex == null) return cp;
      if (!cp.language || !lectureLangRef.current
          || cp.language === lectureLangRef.current) return cp;
      const sents = (lectureManifestRef.current || [])
        .find((s) => s.id === cp.segmentIndex)?.sentences;
      const start = sents?.[Math.min(cp.sentenceIndex, sents.length - 1)]?.start;
      if (!Number.isFinite(start)) return cp;
      return { ...cp, playbackOffsetMs: Math.round(start * 1000) };
    };

    // ---- eval instrumentation (read-only, gated on ?nxrdbg=1) ------------
    // window.__nxrPos()  -> live lecture position for a driver.
    // window.__nxrPauseLog() -> exact snapshots recorded at pause-for-floor
    // and resume (target + actual post-seek position). Read-only: it never
    // writes to playback or protocol state.
    const DBG_POS = new URLSearchParams(window.location.search).has('nxrdbg');
    // Ablation L1: legacy resume semantics on the client too — skips the
    // per-learner checkpoint emit AND the local/server checkpoint resume
    // branches, so every client uses the shared room checkpoint. The
    // position wiring (getLecturePosition + hooks) stays active.
    const NXRL1 = new URLSearchParams(window.location.search).has('nxrl1');
    const nxrSentenceAt = (segIndex, offSec) => {
      const sents = (lectureManifestRef.current || [])
        .find((s) => s.id === segIndex)?.sentences;
      if (!sents?.length || !Number.isFinite(offSec)) return null;
      let si = 0;
      for (let k = 0; k < sents.length; k++) {
        if ((sents[k].start ?? 0) <= offSec + 0.15) si = k;
      }
      return { sentenceIndex: si, sentenceCount: sents.length };
    };
    const nxrSnap = (event, segIndex, offSec, extra = {}) => ({
      event,
      tWall: Date.now(),
      tPerf: Math.round(performance.now()),
      pid: myIdRef.current,
      lang: lectureLangRef.current,
      segmentIndex: segIndex ?? null,
      segmentId: segIndex != null ? `${lectureIdRef.current}_seg_${segIndex}` : null,
      currentTimeSec: Number.isFinite(offSec) ? +offSec.toFixed(3) : null,
      ...(nxrSentenceAt(segIndex, offSec) || {}),
      ...extra,
    });
    const nxrLive = () => {
      const pos = speechCtlRef.current.getLecturePosition?.();
      return nxrSnap('live', pos?.segmentIndex, pos?.offsetSec, {
        paused: speechCtlRef.current.floorPausedRef?.current === true,
      });
    };
    if (DBG_POS) {
      window.__nxrPos = nxrLive;
      window.__nxrPauseLog = () => (window.__nxrPauseEvents ??= []);
      // Drift-eval hooks: applied-version log and a state sampler the
      // driver polls at 250ms for cross-client agreement.
      window.__nxrSocket = socket; // isolation eval: emit language.mine/chat
      window.__nxrApplied = window.__nxrApplied || [];
      window.__nxrSegEvents = window.__nxrSegEvents || [];
      window.__nxrState = () => {
        const head = (speechCtlRef.current.messages || [])[0];
        const pos = speechCtlRef.current.getLecturePosition?.();
        return {
          v: lastAppliedVersionRef.current,
          status: professorStatusRef.current,
          holder: floorHolderRef.current,
          seg: head?.type === 'lecture' ? head.id : null,
          segIndex: pos?.segmentIndex ?? null,
          offsetSec: pos?.offsetSec ?? null,
          slide: slidePageRef.current,
          slideDoc: slideDocRef.current,
          paused: speechCtlRef.current.floorPausedRef?.current === true,
          t: Date.now(),
        };
      };
    }
    const nxrLog = (entry) => {
      if (!DBG_POS || !entry) return;
      (window.__nxrPauseEvents ??= []).push(entry);
    };

    // Shared per-learner resume resolution (used by the 'resume' handler and
    // by the deferred-resume applier after a mid-pause language switch):
    //   1. LOCAL pause record — raw offset same-language, sentence+fraction
    //      re-grounded through the CURRENT manifest after a switch.
    //   2. Server per-pid checkpoint — reconnect path.
    //   3. Shared room checkpoint — logged fallback.
    const cpFromSentFrac = (m) => {
      const sents = (lectureManifestRef.current || [])
        .find((s) => s.id === m.segmentIndex)?.sentences;
      const s = Number.isInteger(m.sentenceIndex)
        ? sents?.[Math.min(m.sentenceIndex, (sents?.length || 1) - 1)]
        : null;
      if (s) {
        const frac = Number.isFinite(m.fractionWithinSentence)
          ? m.fractionWithinSentence : 0;
        const offsetSec = s.start + frac * ((s.end ?? s.start) - s.start);
        return {
          lectureId: m.lectureId || lectureIdRef.current,
          segmentIndex: m.segmentIndex,
          playbackOffsetMs: Math.round(offsetSec * 1000),
          language: lectureLangRef.current,
        };
      }
      console.warn('[ncip-resume] fallback: checkpoint lacks sentence ' +
        `alignment (seg ${m.segmentIndex}) — segment start`);
      return {
        lectureId: m.lectureId || lectureIdRef.current,
        segmentIndex: m.segmentIndex,
        playbackOffsetMs: 0,
        language: lectureLangRef.current,
      };
    };
    const resolveResumeCp = ({ localCp, mine, roomCp }) => {
      if (localCp && Number.isInteger(localCp.segmentIndex)) {
        if (localCp.language === lectureLangRef.current
            && Number.isFinite(localCp.playbackOffsetMs)) {
          console.log('[ncip-resume] local checkpoint: seg',
            localCp.segmentIndex,
            `offset ${(localCp.playbackOffsetMs / 1000).toFixed(2)}s`);
          return {
            lectureId: localCp.lectureId || lectureIdRef.current,
            segmentIndex: localCp.segmentIndex,
            playbackOffsetMs: localCp.playbackOffsetMs,
            language: lectureLangRef.current,
          };
        }
        return cpFromSentFrac(localCp);
      }
      if (mine && Number.isInteger(mine.segmentIndex)) {
        console.log('[ncip-resume] server checkpoint (reconnect path): seg',
          mine.segmentIndex);
        return cpFromSentFrac(mine);
      }
      console.warn('[ncip-resume] fallback: no per-learner checkpoint ' +
        'for me — using room checkpoint');
      return localizeCheckpoint(roomCp);
    };
    resolveResumeCpRef.current = resolveResumeCp;
    applyDeferredResumeRef.current = () => {
      const p = pendingResumeRef.current;
      if (!p) return;
      pendingResumeRef.current = null;
      const cp = resolveResumeCp(p);
      const roomCp = p.roomCp;
      if (roomCp?.slidePage != null) slidePageRef.current = roomCp.slidePage;
      if (roomCp?.slideDoc != null) slideDocRef.current = roomCp.slideDoc;
      speechCtlRef.current.resumeLecture(cp);
      console.log('[ncip-resume] deferred resume applied after language switch');
      nxrLog(nxrSnap('resume', cp?.segmentIndex, (cp?.playbackOffsetMs ?? 0) / 1000,
        { cpLanguage: cp?.language ?? null }));
      setTimeout(() => {
        const pos = speechCtlRef.current.getLecturePosition?.();
        nxrLog(nxrSnap('resume-actual', pos?.segmentIndex, pos?.offsetSec));
      }, 1200);
    };

    socket.on('lecture-control', (data) => applyNcip(data, () => {
      console.log('[client] lecture-control received:', data?.action);
      if (data?.action === 'pause-for-host') {
        // Host discussion pause (private rooms): same local pause as a floor
        // pause, but no checkpoint report — the server already projected the
        // canonical position.
        speechCtlRef.current.pauseLectureForFloor();
      } else if (data?.action === 'control-error') {
        clearTimeout(startWatchdogRef.current);
        setFloorError(data?.error || 'Lecture control rejected.');
        // A rejected lecture.start surfaces here — show it in the panel.
        setLectureStatus((s) => {
          if (s === 'loading') {
            setLectureError(data?.error || 'Failed to start the lecture.');
            return 'error';
          }
          return s;
        });
      } else if (data?.action === 'end') {
        // Owner ended the class: stop and clear local playback, reset slide
        // to the first segment's so the next start opens on slide 1.
        lectureEndedRef.current = true;
        speechCtlRef.current.floorPausedRef.current = false;
        speechCtlRef.current.setFloorPaused(false);
        speechCtlRef.current.clearMessages();
        setChatOpen(false); // transcript closes with the class
        setTranscriptEpoch((e) => e + 1); // next start re-seeds the script fresh
        const first = lectureManifestRef.current?.[0];
        if (first?.slidePage != null) slidePageRef.current = first.slidePage;
        if (first?.slideDoc != null) slideDocRef.current = first.slideDoc;
        setLectureStatus('idle');
        setFloorAnswering(false);
      } else if (data?.action === 'pause-for-floor') {
        pauseSeqRef.current += 1;
        const cp = speechCtlRef.current.pauseLectureForFloor();
        nxrLog(nxrSnap('pause', cp?.segmentIndex, (cp?.playbackOffsetMs ?? 0) / 1000));
        // Per-learner checkpoint: keep a LOCAL copy AND report it — segment,
        // sentence and fraction inside it, in MY language's alignment —
        // so resume can seek me to my own point, not the holder's.
        if (cp?.segmentIndex != null) {
          const offSec = cp.playbackOffsetMs / 1000;
          const sents = (lectureManifestRef.current || [])
            .find((s) => s.id === cp.segmentIndex)?.sentences;
          let sentenceIndex = null;
          let fractionWithinSentence = null;
          if (sents?.length) {
            sentenceIndex = 0;
            for (let k = 0; k < sents.length; k++) {
              if ((sents[k].start ?? 0) <= offSec + 0.15) sentenceIndex = k;
            }
            const s = sents[sentenceIndex];
            const span = (s?.end ?? 0) - (s?.start ?? 0);
            if (span > 0) {
              fractionWithinSentence = Math.min(1,
                Math.max(0, (offSec - s.start) / span));
            }
          }
          localResumeCpRef.current = {
            lectureId: lectureIdRef.current,
            segmentIndex: cp.segmentIndex,
            sentenceIndex,
            fractionWithinSentence,
            playbackOffsetMs: cp.playbackOffsetMs,
            language: lectureLangRef.current,
          };
          if (!NXRL1) socket.emit('lecture-checkpoint-mine', {
            lectureId: lectureIdRef.current,
            segmentIndex: cp.segmentIndex,
            sentenceIndex,
            fractionWithinSentence,
          });
        }
        // Only the holder reports the canonical checkpoint; a null
        // segmentIndex means "no lecture playing locally" but still counts
        // as a report so the floor can proceed.
        if (data?.activeSpeaker?.userId === myIdRef.current) {
          floorReadyRef.current = false;
          // Sentence index at the pause offset in MY language — other-language
          // listeners map it to their own audio's sentence start on resume,
          // so nobody skips/repeats content (raw ms is language-dependent).
          let sentenceIndex = null;
          if (cp?.segmentIndex != null && cp?.playbackOffsetMs > 0) {
            const sents = (lectureManifestRef.current || [])
              .find((s) => s.id === cp.segmentIndex)?.sentences;
            if (sents?.length) {
              const offSec = cp.playbackOffsetMs / 1000;
              sentenceIndex = 0;
              for (let k = 0; k < sents.length; k++) {
                if ((sents[k].start ?? 0) <= offSec + 0.15) sentenceIndex = k;
              }
            }
          }
          socket.emit('lecture-checkpoint', {
            lectureId: lectureIdRef.current,
            language: lectureLangRef.current,
            segmentIndex: cp?.segmentIndex ?? null,
            playbackOffsetMs: cp?.playbackOffsetMs ?? 0,
            sentenceIndex,
            slidePage: cp?.slidePage ?? null,
            slideDoc: cp?.slideDoc ?? null,
          });
        }
      } else if (data?.action === 'resume') {
        setFloorAnswering(false);
        // A personal language switch is mid-flight (queue still in the OLD
        // language): defer the resume — it is re-applied by
        // handleLanguageChange once the NEW-language queue is in place, so
        // the client never resumes in a language it just left.
        if (langSwitchInFlightRef.current) {
          const seqAtDefer = pauseSeqRef.current;
          pendingResumeRef.current = {
            pauseSeq: seqAtDefer,
            localCp: NXRL1 ? null : localResumeCpRef.current,
            mine: NXRL1 ? null : data?.perCheckpoints?.[myIdRef.current],
            roomCp: data?.checkpoint ?? null,
          };
          localResumeCpRef.current = null;
          console.log('[ncip-resume] deferred — language switch in flight');
          // Safety: if the switch never settles, resume anyway — but only
          // while THIS pause is still the current one.
          setTimeout(() => {
            const p = pendingResumeRef.current;
            if (p && p.pauseSeq === seqAtDefer
                && speechCtlRef.current.floorPausedRef?.current) {
              langSwitchInFlightRef.current = null;
              applyDeferredResumeRef.current?.();
            }
          }, 15000);
          return;
        }
        // Resume checkpoint resolution shared with the deferred path:
        //   1. LOCAL pause record — raw offset same-language, sentence+fraction
        //      re-grounded through the CURRENT manifest after a switch.
        //   2. Server per-pid checkpoint — the path taken after a reconnect
        //      (no local pause record exists).
        //   3. Shared room checkpoint (holder's) — logged fallback.
        const localCp = NXRL1 ? null : localResumeCpRef.current;
        localResumeCpRef.current = null;
        const mine = NXRL1 ? null : data?.perCheckpoints?.[myIdRef.current];
        const cp = resolveResumeCp({ localCp, mine, roomCp: data?.checkpoint });
        if (cp?.language && cp.language !== lectureLangRef.current) {
          console.warn('[client] resume checkpoint language differs from local lecture language:', cp.language, 'vs', lectureLangRef.current);
        }
        // Restore the exact board position saved at interrupt — the room
        // checkpoint carries slides (shared state, not per-learner); the
        // queued segment's own page/doc still wins when present.
        const roomCp = data?.checkpoint;
        if (roomCp?.slidePage != null) slidePageRef.current = roomCp.slidePage;
        if (roomCp?.slideDoc != null) slideDocRef.current = roomCp.slideDoc;
        speechCtlRef.current.resumeLecture(cp);
        // Eval: the localized checkpoint IS the seek target; a delayed read
        // records where the audio actually landed.
        nxrLog(nxrSnap('resume', cp?.segmentIndex, (cp?.playbackOffsetMs ?? 0) / 1000,
          { cpLanguage: cp?.language ?? null }));
        setTimeout(() => {
          const pos = speechCtlRef.current.getLecturePosition?.();
          nxrLog(nxrSnap('resume-actual', pos?.segmentIndex, pos?.offsetSec));
        }, 1200);
      } else if (data?.action === 'thinking' || data?.action === 'answering') {
        setFloorAnswering(true);
        setFloorError(null);
      } else if (data?.action === 'answer-error') {
        setFloorAnswering(false);
      } else if (data?.action === 'language-mine') {
        // Personal language override accepted — only THIS client's queue is
        // rebuilt; everyone else keeps the room language.
        console.log('[client] language-mine accepted:', data.language);
        myLangOverrideRef.current =
          data.language === roomLangRef.current ? null : data.language;
        languageChangeRef.current?.(data.language, data.segmentIndex);
      } else if (data?.action === 'language-change') {
        // NCIP Slice 3: room-wide change — members holding a personal
        // override keep their own language and queue untouched.
        console.log('[client] language-change received:', data.language);
        roomLangRef.current = data.language;
        if (!myLangOverrideRef.current) {
          languageChangeRef.current?.(data.language, data.segmentIndex);
        }
      } else if (data?.action === 'language-error') {
        console.warn('[client] language change rejected:', data?.error);
        flashLangNotice(data?.error || 'That language is not prepared for this lecture.');
        // Switch rejected — unblock any resume that was deferred for it.
        langSwitchInFlightRef.current = null;
        applyDeferredResumeRef.current?.();
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
      if (snap?.mic?.permissions) setMicPerms(snap.mic.permissions);
      if (activeSpeaker?.userId !== myIdRef.current) floorReadyRef.current = false;

      // NCIP Slice 3: adopt the authoritative language immediately —
      // myLanguage (personal override) wins over the room default so a
      // reconnecting member keeps hearing their own language.
      if (snap?.language?.roomLanguage) {
        roomLangRef.current = snap.language.roomLanguage;
        const myLang = snap.language.myLanguage || snap.language.roomLanguage;
        lectureLangRef.current = myLang;
        setLectureLang(myLang);
        myLangOverrideRef.current =
          myLang !== snap.language.roomLanguage ? myLang : null;
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

      // Lecture recovery at the canonical server position — never seg 0,
      // and only ever for the lecture this client actually entered
      // (a stale Lecture_1 run must not hijack a Lecture_2 session).
      const plan = planLectureRecovery(snap, speechCtlRef.current.messages, lectureIdRef.current);
      // Reconnect AFTER the room resumed: join at the PROJECTED own
      // position — my stored checkpoint sentence + class play-time since
      // the resume broadcast, mapped through MY language's sentences[],
      // clamped to the shared frontier. Never restart a segment from 0:
      // when sentence alignment is absent, fall back to the shared room
      // position rather than offset 0.
      const resumeCp = (() => {
        const myCp = snap?.resume?.myCp;
        if (!myCp || !Number.isInteger(myCp.segmentIndex)
            || myCp.lectureId !== lectureIdRef.current) return null;
        const recvAtMs = Date.now();
        const snapNowMs = Number(snap?.serverNow) || recvAtMs;
        const sents = (lectureManifestRef.current || [])
          .find((s) => s.id === myCp.segmentIndex)?.sentences;
        const s = Number.isInteger(myCp.sentenceIndex)
          ? sents?.[Math.min(myCp.sentenceIndex, (sents?.length || 1) - 1)] : null;
        const frac = Number.isFinite(myCp.fractionWithinSentence)
          ? myCp.fractionWithinSentence : 0;
        const roomSeg = snap?.lecture?.segmentIndex;
        const roomOff = (snap?.lecture?.playbackOffsetMs ?? 0) / 1000;
        // baseSec: my checkpoint position WITHOUT class-elapsed — elapsed is
        // added at apply time so manifest-fetch latency doesn't put the
        // seek seconds behind the live frontier.
        let segIdx = myCp.segmentIndex;
        let baseSec = s
          ? s.start + frac * ((s.end ?? s.start) - s.start)
          : null;
        let atMs = snap.resume.at;
        // Clamp to the shared segment in BOTH directions: never ahead of
        // the class, and catch up to the shared segment when behind.
        if (baseSec == null || (Number.isInteger(roomSeg) && segIdx !== roomSeg)) {
          segIdx = Number.isInteger(roomSeg) ? roomSeg : segIdx;
          baseSec = baseSec == null ? roomOff : roomOff;
          atMs = snapNowMs;
        }
        return {
          lectureId: myCp.lectureId, segmentIndex: segIdx,
          playbackOffsetMs: Math.round(
            (baseSec + Math.max(0, (snapNowMs - atMs) / 1000)) * 1000),
          language: lectureLangRef.current,
          // Re-projected at apply time by projOffsetSec().
          projected: {
            baseSec, atMs, snapNowMs, recvAtMs,
            roomSeg, roomOffSec: roomOff,
          },
        };
      })();
      if (resumeCp) {
        console.log('[ncip] reconnect-after-resume: projected seg',
          resumeCp.segmentIndex,
          `offset ${(resumeCp.playbackOffsetMs / 1000).toFixed(2)}s`);
        plan.checkpoint = resumeCp;
        if (plan.action === 'none') plan.action = 'reload';
      }
      if (plan.action === 'resume' || plan.action === 'reload') {
        // The room is actively lecturing — reflect that in the panel so a
        // late joiner sees "Class in Progress", not "Start Class", and so a
        // room-wide language change applies to this client too.
        setLectureStatus('teaching');
      }
      if (plan.action === 'resume') {
        if (floorHeld) {
          positionLectureAtCheckpoint(localizeCheckpoint(plan.checkpoint), true);
          if (answerMsg) speechCtlRef.current.prependMessages([answerMsg]);
        } else {
          const cp = localizeCheckpoint(plan.checkpoint);
          speechCtlRef.current.resumeLecture(
            cp.projected
              ? { ...cp, playbackOffsetMs: Math.round(projOffsetSec(cp) * 1000) }
              : cp);
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
      // Include this client's measured audio length — server telemetry
      // compares it against the server-side durationMs.
      const dur = audioElementRef.current?.duration;
      socket.emit('answer-ended', {
        id: msg.id,
        audioMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null,
      });
    };

    // A missing/unloadable audio asset (unbaked segment, TTS down) surfaces
    // as a visible error while the queue still advances past it.
    audioErrorRef.current = (msg) => {
      setLectureError(
        `Audio could not be loaded for this part — it was skipped. ` +
        `If the course was still building, re-enter once the build is ready.`);
    };

    // V2: report each lecture segment's completion to the server — it
    // idempotently advances to the next agent-selected unit.
    lectureSegmentEndedRef.current = (msg) => {
      const m = /^(.+)_seg_(\d+)$/.exec(msg?.id || '');
      const lid = msg?.lectureId || (m ? m[1] : lectureIdRef.current);
      if (!lid) return;
      socket.emit('lecture-segment-ended', {
        lectureId: lid,
        segmentId: m ? Number(m[2]) : null,
        messageId: msg.id,
      });
    };

    return () => {
      answerEndedRef.current = null;
      lectureSegmentEndedRef.current = null;
      stopClockSync();
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
        participantId: getParticipantId(), // ignored by the server unless dev-compat
        guestToken: getGuestToken() || undefined,
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

  // Controls intro on scene entry — FIRST visit only. The 'seen' flag lives in
  // localStorage (survives refresh and new sessions) and is set the moment the
  // hint is shown, so a refresh during the animation can't replay it either.
  useEffect(() => {
    if (!sceneReady) return;
    if (localStorage.getItem('nxr_seen_controls_intro') === '1') return;
    localStorage.setItem('nxr_seen_controls_intro', '1');
    setCamHint(true);
    const t = setTimeout(() => setCamHint(false), 15000);
    const onKey = (e) => {
      if (e.key === 'F5' || e.key.startsWith('Arrow')) setCamHint(false);
    };
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

  // Transcript seed: segments already reached (<= current index) so a
  // refreshed/late joiner sees the full script, not just the live tail.
  const [scriptSeed, setScriptSeed] = useState([]);
  // Bumped on each (re)start — ChatInterface clears accumulated transcript
  // lines so a replayed lecture can't stack stale rows.
  const [transcriptEpoch, setTranscriptEpoch] = useState(0);
  useEffect(() => {
    if (message?.type !== 'lecture' || !message.id) return;
    const n = Number(String(message.id).split('_seg_').pop());
    if (!Number.isFinite(n) || n <= maxSegRef.current) return;
    maxSegRef.current = n;
    setScriptSeed(
      lectureManifestRef.current
        .filter((seg) => seg.id <= n)
        .map((seg) => ({ id: `${lectureIdRef.current}_seg_${seg.id}`, text: seg.text }))
    );
  }, [message]);

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

  // Guests who joined (public directly, private via invite+host approval) may
  // raise hands and ask the professor — the server authorizes membership.
  const isGuest = !selfInfo || selfInfo.guest === true;
  const canModerate = isRoomHost || selfInfo?.user?.role === 'SUPER_ADMIN';
  const myMicState = (myId && micPerms[myId]) || null;
  const micAllowed = canModerate || myMicState === 'granted';

  const handleVoice = useCallback(() => {
    if (voiceChatRef.current?.voiceOn) { voiceChatRef.current.toggleVoice(); return; }
    if (micAllowed) { voiceChatRef.current?.toggleVoice?.(); return; }
    socketRef.current?.emit('mic.request');
  }, [micAllowed]);

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
        <h2 className='text-xl font-bold'>{accessErrorTitle}</h2>
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
                <p className='hidden text-[10px] text-slate-400 sm:block'>wants to join this private room</p>
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

      {/* Guest name prompt — registered users skip it (account name resolves
          via getMe); guests must enter a name before joining. */}
      {guestNameNeeded && !displayName && (
        <div className='fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90 backdrop-blur'>
          <form
            className='w-80 rounded-2xl border border-slate-700/50 bg-slate-900 p-6 shadow-2xl'
            onSubmit={(e) => {
              e.preventDefault();
              submitGuestName(e.currentTarget.elements.guestName.value);
            }}
          >
            <h2 className='text-lg font-bold text-white'>Enter your name</h2>
            <p className='mt-1 text-xs text-slate-400'>Your avatar will show this name in the classroom.</p>
            <input
              name='guestName'
              defaultValue={randomGuestName()}
              maxLength={32}
              autoFocus
              className='mt-4 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500'
            />
            <button
              type='submit'
              className='mt-4 w-full rounded-lg bg-cyan-500 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400'
            >
              Join class
            </button>
          </form>
        </div>
      )}

      {sceneReady && camHint && (
        <div
          className='fixed inset-0 z-40 flex items-center justify-center'
          onClick={() => setCamHint(false)}
        >
          <div className='rounded-2xl border border-slate-700/60 bg-slate-900/85 px-8 py-6 text-center shadow-2xl backdrop-blur'>
            <p className='text-base font-bold text-white'>Welcome to the classroom</p>
            <div className='mt-4 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-left'>
              <span className='flex gap-1'>
                {['↑', '↓', '←', '→'].map((k) => (
                  <kbd key={k} className='rounded-md bg-slate-700 px-2 py-0.5 font-mono text-cyan-300'>{k}</kbd>
                ))}
              </span>
              <span className='text-xs text-slate-300'>Walk around the room</span>
              <kbd className='rounded-md bg-slate-700 px-2 py-0.5 font-mono text-cyan-300'>Shift</kbd>
              <span className='text-xs text-slate-300'>Hold to run faster</span>
              <kbd className='rounded-md bg-slate-700 px-2 py-0.5 font-mono text-cyan-300'>Drag</kbd>
              <span className='text-xs text-slate-300'>Click &amp; drag to look around</span>
              <kbd className='rounded-md bg-slate-700 px-2 py-0.5 font-mono text-cyan-300'>F5</kbd>
              <span className='text-xs text-slate-300'>Switch first / third person view</span>
            </div>
            <p className='mt-4 text-[11px] text-slate-500'>Click anywhere or start moving to dismiss</p>
          </div>
        </div>
      )}

      {sceneReady && (
        <>
          <ClassroomPanel
            course={config}
            lectureId={lectureId}
            lectureTitle={lectureTitle}
            classTitle={classTitle}
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
            onVoice={handleVoice}
            voiceOn={voiceChat.voiceOn}
            micState={myMicState}
            isGuest={isGuest}
            canModerate={canModerate}
            micPerms={micPerms}
            onMicDecision={(userId, grant) => socketRef.current?.emit('mic.decision', { userId, grant })}
            onMicRevoke={(userId) => socketRef.current?.emit('mic.revoke', { userId })}
            language={lectureLang}
            onLanguage={requestLanguageChange}
            canChangeLanguage={canChangeLanguage}
            canCatchUp={canCatchUp}
            onCatchUp={requestCatchUp}
            isPrivateRoom={isPrivateRoom}
            isRoomHost={isRoomHost}
            roomMembers={roomMembers}
            avatars={USER_AVATARS}
            currentAvatar={userAvatarPath}
            onSelectAvatar={selectAvatar}
            displayName={displayName}
            onRename={renameTo}
            onKick={(userId) => socketRef.current?.emit('room.kick', { userId })}
            pauseReason={pauseReason}
            onCopyInvite={isRoomHost ? copyInvite : null}
            inviteCopied={inviteCopied}
            onHostPause={() => socketRef.current?.emit('lecture-control', { action: 'pause' })}
            onHostResume={() => socketRef.current?.emit('lecture-control', { action: 'resume' })}
            onHostEnd={() => socketRef.current?.emit('lecture-control', { action: 'end' })}
            canEndLecture={canEndLecture}
            langReadiness={langReadiness}
            onRepair={canChangeLanguage ? repairLectureAssets : null}
          />

          {langNotice && (
            <div className='fixed left-1/2 top-20 z-50 -translate-x-1/2 rounded-xl border border-amber-500/40 bg-slate-900/95 px-4 py-2.5 text-xs text-amber-200 shadow-2xl backdrop-blur'>
              {langNotice}
            </div>
          )}

          {floorNotice && (
            <div className='fixed left-1/2 top-20 z-50 -translate-x-1/2 rounded-xl border border-cyan-500/40 bg-slate-900/95 px-4 py-2.5 text-xs text-cyan-200 shadow-2xl backdrop-blur'>
              {floorNotice}
            </div>
          )}

          <ChatInterface
            hidden={!chatOpen}
            onMinimize={() => setChatOpen(false)}
            lectureId={lectureId}
            courseTitle={lectureTitle || config?.title || 'Class'}
            lectureScript={lectureScript}
            showLectureScript={canChangeLanguage}
            scriptSeed={scriptSeed}
            transcriptEpoch={transcriptEpoch}
            floorHolder={activeSpeaker}
            isFloorHolder={isActiveSpeaker}
            floorAnswering={floorAnswering}
            floorError={floorError}
            isGuest={isGuest}
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
          </div>
        </>
      )}

      {/* Scene assets (GLBs, environment, mixers) only start loading AFTER the
          user submits a name — the name modal sits on a clean backdrop, then a
          proper loading screen, then the classroom fades in. */}
      {displayName && <Canvas
        ref={canvasRef}
        dpr={[1, 2]}
        shadows
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
          // Filmic response curve — the single biggest "rendered look" upgrade:
          // highlights roll off instead of clipping, colors read natural.
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.0;
          gl.shadowMap.enabled = true;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
          gl.outputColorSpace = THREE.SRGBColorSpace;
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
            userStart={{ ...config.userStart, position: spawnPos || config.userStart.position }}
            professorStart={config.assistant}
            cameraBounds={config.cameraBounds}
            defaultLookAt={config.defaultLookAt}
            modelTransform={config.modelTransform}
            lectureId={lectureId}
            slidePage={slidePage}
            slideDoc={slideDoc}
            remoteStreams={voiceChat.remoteStreams}
          />
        </Suspense>
      </Canvas>}
    </div>
  );
}
