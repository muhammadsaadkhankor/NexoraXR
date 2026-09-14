import { useEffect, useMemo, useRef, useState } from 'react';
import { useGLTF, useAnimations, Html } from '@react-three/drei';
import { useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DEFAULT_AVATAR_PATH, ANIMATION_URLS, ANIMATION_NAMES } from './UserAvatar';

const INTERP_DURATION = 100; // ms over which to blend between the last two received updates

export function RemoteAvatar({ state }) {
  const group = useRef();

  // Same body and animation library as the local UserAvatar — this is the "known-correct scale" setup
  const { scene } = useGLTF(DEFAULT_AVATAR_PATH);
  const model = useMemo(() => scene.clone(), [scene]);

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
    prev: { position: [0, 0, 0], rotation: [0, 0, 0], animation: 'Idle', timestamp: 0 },
    target: { position: [0, 0, 0], rotation: [0, 0, 0], animation: 'Idle', timestamp: 0 },
    startAt: 0
  });

  const a = useMemo(() => new THREE.Vector3(), []);
  const b = useMemo(() => new THREE.Vector3(), []);
  const pos = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const max = Math.max(size.x, size.y, size.z);
    if (max === 0 || !isFinite(max)) {
      console.warn('[RemoteAvatar] body mesh is empty', state?.userId, DEFAULT_AVATAR_PATH, 'children:', model.children.length);
    } else {
      console.log('[RemoteAvatar] body ready', state?.userId, DEFAULT_AVATAR_PATH, 'children:', model.children.length, 'box:', size.toArray());
    }
    model.position.set(0, 0, 0);
    model.scale.set(1, 1, 1);
    model.visible = true;
    model.traverse((child) => {
      if (child.isLine || child.isLineSegments || child.isLineLoop) {
        child.visible = false;
      } else if (child.isMesh || child.isSkinnedMesh || child.isGroup) {
        child.visible = true;
      }
    });
  }, [model, state?.userId]);

  useEffect(() => {
    if (!state) return;
    const { position, rotation, animation } = state;
    const now = Date.now();
    const old = buffer.current.target;
    buffer.current.prev = { ...old, timestamp: buffer.current.startAt };
    buffer.current.target = { position, rotation, animation, timestamp: now };
    buffer.current.startAt = now;
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
    const { prev, target, startAt } = buffer.current;
    const t = Math.min(1, (now - startAt) / INTERP_DURATION);

    a.set(...prev.position);
    b.set(...target.position);
    pos.lerpVectors(a, b, t);

    // Trust the sender's Y (sender already ground-raycasts their own avatar)
    group.current.position.copy(pos);

    const prevRot = Array.isArray(prev.rotation) ? (prev.rotation[1] ?? prev.rotation[0] ?? 0) : prev.rotation;
    const targetRot = Array.isArray(target.rotation) ? (target.rotation[1] ?? target.rotation[0] ?? 0) : target.rotation;
    let diff = targetRot - prevRot;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    group.current.rotation.y = prevRot + diff * t;
  });

  return (
    <group ref={group} dispose={null}>
      <primitive object={model} />
      <Html position={[0, 1.9, 0]} center className='pointer-events-none'>
        <div className='rounded-full bg-slate-900/80 px-2 py-0.5 text-xs font-semibold text-cyan-300 ring-1 ring-cyan-500/50'>
          {state?.name || 'User'}
        </div>
      </Html>
    </group>
  );
}
