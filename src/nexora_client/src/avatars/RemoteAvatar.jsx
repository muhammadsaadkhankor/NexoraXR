import { useEffect, useMemo, useRef, useState } from 'react';
import { useGLTF, useAnimations, Html } from '@react-three/drei';
import { useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { DEFAULT_AVATAR_PATH, ANIMATION_URLS, ANIMATION_NAMES } from './UserAvatar';
import { analyseViseme, attachStreamAnalyser } from './utils/realtimeLipSync';

const MIN_INTERP_MS = 60;
const MAX_INTERP_MS = 400;
const _listenerPos = new THREE.Vector3();
const _localPos = new THREE.Vector3();

// User-avatar rigs only expose mouthOpen/mouthSmile — no viseme morphs — but
// the classifier's viseme class still tells us HOW open the mouth should be:
// sibilants/fricatives stay narrow, vowels open wide.
const OPENNESS_BY_VISEME = {
  viseme_sil: 0,
  viseme_SS: 0.3,
  viseme_FF: 0.35,
  viseme_TH: 0.45,
  viseme_U: 0.55,
  viseme_O: 0.8,
  viseme_E: 0.9,
  viseme_aa: 1,
};

const VOICE_REF_DIST = 1.5;   // full volume within this radius (meters)
const VOICE_MAX_DIST = 15;    // silent beyond this distance
const VOICE_ROLLOFF = 1.8;
// Authored clip ground speeds (m/s) — same anchors as the local avatar so a
// 'walk_forward' packet looks identical in cadence on both screens.
const WALK_CLIP_SPEED = 3.5;
const RUN_CLIP_SPEED = 7.0;

export function RemoteAvatar(props) {
  // Keyed remount on model change: an AnimationMixer binds clip tracks to the
  // skeleton present at bind time — if the GLB scene swaps under a live mixer
  // the bindings keep driving the detached bones and the avatar freezes in
  // bind pose. Remounting guarantees mixer, clone and actions are built for
  // the same skeleton instance.
  return <RemoteAvatarInner key={props.state?.avatar || 'default'} {...props} />;
}

function RemoteAvatarInner({ state, handRaised, audioStream, audioListener, floorScene }) {
  const group = useRef();
  const floorRay = useRef(new THREE.Raycaster());
  const prevFramePos = useRef(null);
  const speedEMA = useRef(0);      // measured ground speed (m/s)
  const playingAnim = useRef('Idle');
  const floorPos = useRef(null); // most recent floor height under this avatar
  const voiceRef = useRef(null); // { source, panner, gain, analyser }
  const mouthLevelRef = useRef(0);

  // Load the same avatar model the remote user selected, and a unique GLTF instance
  // so skinned meshes/animations bind to their own bones
  const avatarUrl = state?.avatar || DEFAULT_AVATAR_PATH;
  const { scene: sourceScene } = useGLTF(avatarUrl);
  // SkeletonUtils.clone gives every remote avatar its OWN skeleton/skinning —
  // without it, cached GLTF scenes can share bones across mixers and a remote
  // avatar can freeze in bind (T/A) pose when the mixer binds the shared copy.
  const scene = useMemo(() => {
    const clone = SkeletonUtils.clone(sourceScene);
    clone.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.castShadow = true; });
    return clone;
  }, [sourceScene]);

  // Some rigs originate at the hips — rendering them at the remote's
  // foot-level position sinks them under the floor. Bind-pose bounds lie for
  // skinned meshes (vertices live near the origin; bones pose them), so we
  // compute the SKINNED bounding box once the mixer has posed the skeleton.
  const [modelLift, setModelLift] = useState(0);
  const liftComputed = useRef(false);

  // Mouth morph targets (Wolf3D_Head.mouthOpen/mouthSmile) — driven per-frame
  // by the remote voice stream's amplitude for live lipsync.
  const mouthTargets = useMemo(() => {
    const list = [];
    scene.traverse((c) => {
      const dict = c.morphTargetDictionary;
      if (c.isMesh && dict && ('mouthOpen' in dict || 'mouthSmile' in dict)) {
        list.push({
          influences: c.morphTargetInfluences,
          open: dict.mouthOpen,
          smile: dict.mouthSmile,
        });
      }
    });
    return list;
  }, [scene]);

  const animGltfs = useLoader(GLTFLoader, ANIMATION_URLS);
  const allAnimations = useMemo(() =>
    animGltfs.flatMap((gltf, i) =>
      gltf.animations.map((clip) => {
        const clone = clip.clone();
        clone.name = ANIMATION_NAMES[i];
        return clone;
      })
    ),
    [animGltfs]
  );

  const { actions, mixer } = useAnimations(allAnimations, group);
  const [currentAnimation, setCurrentAnimation] = useState('Idle');

  const buffer = useRef({
    prevPos: new THREE.Vector3(),
    targetPos: new THREE.Vector3(),
    prevYaw: 0,
    targetYaw: 0,
    startAt: 0,
    duration: 120,
    lastArrival: 0,
  });

  const pos = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const max = Math.max(size.x, size.y, size.z);
    if (max === 0 || !isFinite(max)) {
      console.warn('[RemoteAvatar] body mesh is empty', state?.userId, DEFAULT_AVATAR_PATH, 'children:', scene.children.length);
    } else {
      console.log('[RemoteAvatar] body ready', state?.userId, DEFAULT_AVATAR_PATH, 'children:', scene.children.length, 'box:', size.toArray());
    }
    scene.position.set(0, 0, 0);
    scene.scale.set(1, 1, 1);
    scene.visible = true;
    scene.traverse((child) => {
      if (child.isLine || child.isLineSegments || child.isLineLoop) {
        child.visible = false;
      } else if (child.isMesh || child.isSkinnedMesh || child.isGroup) {
        child.visible = true;
      }
    });
  }, [scene, state?.userId]);

  useEffect(() => {
    if (!state) return;
    const { position, rotation, animation } = state;
    const now = Date.now();
    const cur = buffer.current;
    const yaw = Array.isArray(rotation) ? (rotation[1] ?? rotation[0] ?? 0) : (rotation ?? 0);

    if (cur.lastArrival === 0) {
      // First snapshot: snap directly, no interpolation
      cur.prevPos.set(...position);
      cur.targetPos.set(...position);
      cur.prevYaw = yaw;
      cur.targetYaw = yaw;
      cur.duration = MIN_INTERP_MS;
    } else {
      // Freeze the currently rendered pose as the start of this segment so a
      // mid-flight packet never causes a snap-back
      const t = Math.min(1, (now - cur.startAt) / cur.duration);
      cur.prevPos.lerpVectors(cur.prevPos, cur.targetPos, t);
      let d = cur.targetYaw - cur.prevYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      cur.prevYaw += d * t;

      cur.targetPos.set(...position);
      cur.targetYaw = yaw;
      // Match interpolation duration to the measured packet spacing
      cur.duration = THREE.MathUtils.clamp(now - cur.lastArrival, MIN_INTERP_MS, MAX_INTERP_MS);
    }
    cur.startAt = now;
    cur.lastArrival = now;

    const nextAnim = animation || 'Idle';
    if (nextAnim !== currentAnimation) setCurrentAnimation(nextAnim);
  }, [state, currentAnimation]);

  // Fall back to Idle when the remote sends an animation name this model's
  // clip set doesn't contain — otherwise the avatar stays in bind pose.
  const resolvedAnimation = actions[currentAnimation] ? currentAnimation : 'Idle';
  useEffect(() => {
    const action = actions[resolvedAnimation];
    if (!action) return;
    action.reset().fadeIn(mixer.stats.actions.inUse === 0 ? 0 : 0.5).play();
    playingAnim.current = resolvedAnimation;
    if (!liftComputed.current) {
      liftComputed.current = true;
      // Pose the skeleton once, then measure the SKINNED bounds — a bind-pose
      // Box3 lies because bones reposition the vertices on the GPU.
      mixer.update(0.001);
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3();
      const tmp = new THREE.Box3();
      scene.traverse((c) => {
        if (c.isSkinnedMesh && c.computeBoundingBox) {
          c.computeBoundingBox();
          if (c.boundingBox) box.union(tmp.copy(c.boundingBox).applyMatrix4(c.matrixWorld));
        }
      });
      if (Number.isFinite(box.min.y) && box.min.y < -0.01) setModelLift(-box.min.y);
    }
    return () => {
      if (actions[resolvedAnimation]) actions[resolvedAnimation].fadeOut(0.5);
    };
  }, [resolvedAnimation, actions, mixer]);

  useFrame((_, delta) => {
    if (!group.current) return;

    const now = Date.now();
    const cur = buffer.current;
    const t = Math.min(1, (now - cur.startAt) / cur.duration);

    pos.lerpVectors(cur.prevPos, cur.targetPos, t);

    // Ground clamp: raycast down from the avatar's position — feet always sit
    // on whatever surface is below (floor, steps, raised platform). Falls back
    // to the sender's reported Y only when no surface is hit.
    if (floorScene) {
      floorRay.current.set(new THREE.Vector3(pos.x, pos.y + 4, pos.z), new THREE.Vector3(0, -1, 0));
      let hits = floorRay.current.intersectObject(floorScene, true);
      if (hits.length === 0) {
        // Reported position may sit below the floor (stale slot) — look up.
        floorRay.current.set(new THREE.Vector3(pos.x, pos.y - 1, pos.z), new THREE.Vector3(0, 1, 0));
        hits = floorRay.current.intersectObject(floorScene, true);
      }
      if (hits.length > 0) pos.y = hits[0].point.y;
    }

    // Measured ground speed from the interpolated position — drives clip
    // timeScale so feet match real velocity instead of sliding (float look),
    // and lets us sit in Idle when a stale 'walk' state arrives while stopped.
    const dt = Math.max(1e-3, delta || 0.016);
    if (prevFramePos.current) {
      const inst = Math.hypot(pos.x - prevFramePos.current.x, pos.z - prevFramePos.current.z) / dt;
      speedEMA.current += (inst - speedEMA.current) * Math.min(1, dt * 10);
    } else {
      prevFramePos.current = new THREE.Vector3();
    }
    prevFramePos.current.copy(pos);

    const loco = /walk|run/i.test(resolvedAnimation);
    const want = loco && speedEMA.current < 0.15 && actions['Idle'] ? 'Idle' : resolvedAnimation;
    if (want !== playingAnim.current && actions[want]) {
      const prev = actions[playingAnim.current];
      if (prev && prev !== actions[want]) prev.fadeOut(0.25);
      actions[want].reset().fadeIn(0.25).play();
      playingAnim.current = want;
    }
    const act = actions[playingAnim.current];
    if (act) {
      act.play().setEffectiveWeight(1);
      if (loco && playingAnim.current === resolvedAnimation) {
        const authored = /run/i.test(resolvedAnimation) ? RUN_CLIP_SPEED : WALK_CLIP_SPEED;
        act.timeScale = THREE.MathUtils.clamp(speedEMA.current / authored, 0.35, 2.0);
      } else {
        act.timeScale = 1;
      }
    }

    group.current.position.copy(pos);

    let diff = cur.targetYaw - cur.prevYaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    group.current.rotation.y = cur.prevYaw + diff * t;

    // Distance-based voice volume: fade the remote stream with proximity and
    // pan it to the avatar's side relative to the listener (camera).
    if (voiceRef.current && audioListener) {
      _listenerPos.setFromMatrixPosition(audioListener.matrixWorld);
      const dist = pos.distanceTo(_listenerPos);
      const volume = dist >= VOICE_MAX_DIST
        ? 0
        : Math.min(1, Math.pow(Math.max(dist, 0.05) / VOICE_REF_DIST, -VOICE_ROLLOFF));
      voiceRef.current.gain.gain.value = volume;
      _localPos.copy(pos);
      audioListener.worldToLocal(_localPos);
      voiceRef.current.panner.pan.value = THREE.MathUtils.clamp(_localPos.x * 0.35, -1, 1);
    }

    // Lipsync: spectral classification gives a per-sound openness target —
    // snappier than raw amplitude, and sibilants stay narrow instead of
    // flapping fully open. Fast attack, slower release, like the professor.
    let target = 0;
    const analyser = voiceRef.current?.analyser;
    if (analyser) {
      // Boosted tap (see attachStreamAnalyser) — thresholds scaled to match.
      const { viseme, level } = analyseViseme(analyser, { silenceRms: 0.02, fullOpenRms: 0.2 });
      target = level * (OPENNESS_BY_VISEME[viseme] ?? 0.8);
    }
    const smoothing = target > mouthLevelRef.current ? 0.55 : 0.18;
    mouthLevelRef.current += (target - mouthLevelRef.current) * smoothing;
    for (const t of mouthTargets) {
      if (t.open != null) t.influences[t.open] = mouthLevelRef.current;
      if (t.smile != null) t.influences[t.smile] = mouthLevelRef.current * 0.25;
    }
  });

  // Proximity voice: route the remote user's WebRTC stream through a
  // gain/stereo-pan chain whose volume is driven per-frame by avatar distance.
  useEffect(() => {
    if (!audioStream || !audioListener) return;
    const ctx = audioListener.context;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(audioStream);
    // Separate boosted tap for lipsync — remote mic RMS is far below TTS
    // playback levels, so the classifier needs the amplified signal.
    const tap = attachStreamAnalyser(source, ctx, 4);
    const panner = ctx.createStereoPanner();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(panner);
    panner.connect(gain);
    gain.connect(audioListener.getInput());
    voiceRef.current = { source, panner, gain, analyser: tap?.analyser || null };
    return () => {
      voiceRef.current = null;
      try { source.disconnect(); } catch {}
      try { tap?.gain.disconnect(); } catch {}
      try { tap?.analyser.disconnect(); } catch {}
      try { panner.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    };
  }, [audioStream, audioListener]);

  return (
    <group ref={group} dispose={null}>
      <group position={[0, modelLift, 0]}>
        <primitive object={scene} />
      </group>
      <Html position={[0, 1.9, 0]} center className='pointer-events-none'>
        <div className='rounded-full bg-slate-900/80 px-2 py-0.5 text-xs font-semibold text-cyan-300 ring-1 ring-cyan-500/50'>
          {handRaised ? '✋ ' : ''}{state?.name || 'User'}
        </div>
      </Html>
    </group>
  );
}
