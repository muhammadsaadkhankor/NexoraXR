import { useEffect, useMemo, useRef, useState } from 'react';
import { useGLTF, useAnimations, Html } from '@react-three/drei';
import { useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DEFAULT_AVATAR_PATH, ANIMATION_URLS, ANIMATION_NAMES } from './UserAvatar';

const MIN_INTERP_MS = 60;
const MAX_INTERP_MS = 400;

export function RemoteAvatar({ state, handRaised }) {
  const group = useRef();

  // Load the same avatar model the remote user selected, and a unique GLTF instance
  // so skinned meshes/animations bind to their own bones
  const avatarUrl = state?.avatar || DEFAULT_AVATAR_PATH;
  const uniqueUrl = `${avatarUrl}?_=${state?.userId || 'remote'}`;
  const { scene } = useGLTF(uniqueUrl);

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

  useEffect(() => {
    if (actions[currentAnimation]) {
      actions[currentAnimation]
        .reset()
        .fadeIn(mixer.stats.actions.inUse === 0 ? 0 : 0.5)
        .play();
      return () => {
        if (actions[currentAnimation]) actions[currentAnimation].fadeOut(0.5);
      };
    }
  }, [currentAnimation, actions, mixer]);

  useFrame(() => {
    if (!group.current) return;

    if (actions[currentAnimation]) actions[currentAnimation].play().setEffectiveWeight(1);

    const now = Date.now();
    const cur = buffer.current;
    const t = Math.min(1, (now - cur.startAt) / cur.duration);

    pos.lerpVectors(cur.prevPos, cur.targetPos, t);

    // Trust the sender's Y (sender already ground-raycasts their own avatar)
    group.current.position.copy(pos);

    let diff = cur.targetYaw - cur.prevYaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    group.current.rotation.y = cur.prevYaw + diff * t;
  });

  return (
    <group ref={group} dispose={null}>
      <primitive object={scene} />
      <Html position={[0, 1.9, 0]} center className='pointer-events-none'>
        <div className='rounded-full bg-slate-900/80 px-2 py-0.5 text-xs font-semibold text-cyan-300 ring-1 ring-cyan-500/50'>
          {handRaised ? '✋ ' : ''}{state?.name || 'User'}
        </div>
      </Html>
    </group>
  );
}
