import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGLTF, useAnimations } from "@react-three/drei";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";



export const ANIMATION_URLS = [
  "/assets/animations/idle.glb",
  "/assets/animations/walk.glb",
  "/assets/animations/walkBack.glb",
  "/assets/animations/walkLeft.glb",
  "/assets/animations/walkRight.glb",
  "/assets/animations/run.glb",
  "/assets/animations/runBack.glb",
  "/assets/animations/runLeft.glb",
  "/assets/animations/runRight.glb",
];

export const ANIMATION_NAMES = [
  "Idle",
  "walk_forward",
  "walk_back",
  "walk_left",
  "walk_right",
  "run_forward",
  "run_back",
  "run_left",
  "run_right",
];

const WALK_SPEED = 3.5;
const RUN_SPEED = 7.0;
const FOOT_OFFSET = 0.02;
const SMOOTH_RATE = 12.0;
const MAX_STEP_DELTA = 0.18;
const RAY_OFFSET = 0.35;
const RAY_HEIGHT = 2.0;
const WALL_MARGIN = 0.3;
const MOUSE_SENSITIVITY = 0.005;
export const DEFAULT_AVATAR_PATH = '/assets/useravatar/UserAvatar.glb';

export const UserAvatar = React.forwardRef(({ cameraPreset = "third-person", floorScene, avatarYawRef, modelPath = DEFAULT_AVATAR_PATH, visible = true, onStateUpdate, joystick, ...props }, ref) => {
  const group = useRef();
  const { scene } = useGLTF(modelPath);
  const { gl } = useThree();
  const raycaster = useRef(new THREE.Raycaster());
  const wallRaycaster = useRef(new THREE.Raycaster());
  const isDragging = useRef(false);
  const lastX = useRef(0);

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

  const [animation, setAnimation] = useState("Idle");
  const animationRef = useRef("Idle");
  const keys = useRef({});
  const lastEmit = useRef(0);
  const lastEmittedState = useRef(null);

  const setGroup = (node) => {
    group.current = node;
    if (typeof ref === "function") {
      ref(node);
    } else if (ref) {
      ref.current = node;
    }
  };

  useEffect(() => {
    scene.traverse((child) => {
      if (child.isLine || child.isLineSegments || child.isLineLoop) {
        child.visible = false;
      }
    });
    scene.visible = visible && cameraPreset !== "first-person";
  }, [scene, cameraPreset, visible]);

  useEffect(() => {
    const canvas = gl.domElement;
    if (!canvas) return;

    const onPointerDown = (e) => {
      isDragging.current = true;
      lastX.current = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e) => {
      if (!isDragging.current) return;
      const dx = e.clientX - lastX.current;
      avatarYawRef.current -= dx * MOUSE_SENSITIVITY;
      lastX.current = e.clientX;
    };

    const onPointerUp = (e) => {
      isDragging.current = false;
      canvas.releasePointerCapture(e.pointerId);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerUp);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerUp);
    };
  }, [gl, avatarYawRef]);

  useEffect(() => {
    const onKeyDown = (e) => {
      keys.current[e.key.toLowerCase()] = true;
      if (e.key === "Shift") keys.current.shift = true;
    };
    const onKeyUp = (e) => {
      keys.current[e.key.toLowerCase()] = false;
      if (e.key === "Shift") keys.current.shift = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    if (actions[animation]) {
      actions[animation]
        .reset()
        .fadeIn(mixer.stats.actions.inUse === 0 ? 0 : 0.5)
        .play();
      return () => {
        if (actions[animation]) actions[animation].fadeOut(0.5);
      };
    }
  }, [animation, actions, mixer]);

  useLayoutEffect(() => {
    if (!group.current || !floorScene) return;

    const pos = group.current.position;
    const raycaster = new THREE.Raycaster();
    const rayDir = new THREE.Vector3(0, -1, 0);
    const originY = pos.y + RAY_HEIGHT;
    const forward = new THREE.Vector3(Math.sin(avatarYawRef.current), 0, Math.cos(avatarYawRef.current));
    const forwardOffset = forward.clone().multiplyScalar(RAY_OFFSET);

    const origins = [
      new THREE.Vector3(pos.x, originY, pos.z),
      new THREE.Vector3(pos.x + forwardOffset.x, originY, pos.z + forwardOffset.z),
    ];

    const heights = [];
    for (const origin of origins) {
      raycaster.set(origin, rayDir);
      const hits = raycaster.intersectObject(floorScene, true);
      if (hits.length > 0) {
        heights.push(hits[0].point.y);
      }
    }

    if (heights.length > 0) {
      pos.y = heights.reduce((a, b) => a + b, 0) / heights.length + FOOT_OFFSET;
    }
  }, [floorScene]);

  useFrame((state, delta) => {
    if (!group.current) return;

    if (actions[animation]) actions[animation].play().setEffectiveWeight(1);

    const k = keys.current;
    const isShift = !!k["shift"];
    const pos = group.current.position;
    const avatarYaw = avatarYawRef.current;

    // Apply mouselook rotation immediately
    group.current.rotation.y = avatarYaw;

    // Movement vectors are now relative to the avatar's own yaw
    const forward = new THREE.Vector3(Math.sin(avatarYaw), 0, Math.cos(avatarYaw));
    const right = forward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);

    const moveDir = new THREE.Vector3(0, 0, 0);
    if (k["w"] || k["arrowup"]) moveDir.add(forward);
    if (k["s"] || k["arrowdown"]) moveDir.sub(forward);
    if (k["a"] || k["arrowleft"]) moveDir.sub(right);
    if (k["d"] || k["arrowright"]) moveDir.add(right);

    if (joystick && joystick.current && (joystick.current.x !== 0 || joystick.current.y !== 0)) {
      const jx = joystick.current.x;
      const jy = joystick.current.y;
      moveDir.add(forward.clone().multiplyScalar(-jy).add(right.clone().multiplyScalar(jx)));
    }

    let nextAnim = "Idle";
    if (moveDir.lengthSq() > 0) {
      moveDir.normalize();
      const speed = isShift ? RUN_SPEED : WALK_SPEED;
      let move = moveDir.clone().multiplyScalar(speed * delta);

      if (floorScene) {
        const wallOrigin = new THREE.Vector3(pos.x, pos.y + 0.8, pos.z);
        wallRaycaster.current.set(wallOrigin, moveDir);
        wallRaycaster.current.far = move.length() + WALL_MARGIN;
        const hits = wallRaycaster.current.intersectObject(floorScene, true);
        if (hits.length > 0 && hits[0].distance < move.length() + WALL_MARGIN) {
          const allowed = Math.max(0, hits[0].distance - WALL_MARGIN);
          move = moveDir.clone().multiplyScalar(allowed);
        }
      }

      group.current.position.add(move);

      const fDot = moveDir.dot(forward);
      const rDot = moveDir.dot(right);
      const forwardDominant = Math.abs(fDot) >= Math.abs(rDot);

      if (forwardDominant) {
        nextAnim = isShift
          ? (fDot >= 0 ? "run_forward" : "run_back")
          : (fDot >= 0 ? "walk_forward" : "walk_back");
      } else {
        nextAnim = isShift
          ? (rDot >= 0 ? "run_right" : "run_left")
          : (rDot >= 0 ? "walk_right" : "walk_left");
      }
    }

    // Ground raycasting: keep the avatar's feet on the floor/steps
    if (floorScene && group.current) {
      const rayDir = new THREE.Vector3(0, -1, 0);
      const originY = pos.y + RAY_HEIGHT;
      const forwardOffset = forward.clone().multiplyScalar(RAY_OFFSET);

      const origins = [
        new THREE.Vector3(pos.x, originY, pos.z),
        new THREE.Vector3(pos.x + forwardOffset.x, originY, pos.z + forwardOffset.z),
      ];

      const heights = [];
      for (const origin of origins) {
        raycaster.current.set(origin, rayDir);
        const hits = raycaster.current.intersectObject(floorScene, true);
        if (hits.length > 0) {
          heights.push(hits[0].point.y);
        }
      }

      if (heights.length > 0) {
        const avgY = heights.reduce((a, b) => a + b, 0) / heights.length;
        const targetY = avgY + FOOT_OFFSET;

        // Clamp per-frame height change to avoid pops
        const diff = targetY - pos.y;
        const clamped = Math.sign(diff) * Math.min(Math.abs(diff), MAX_STEP_DELTA);
        const desiredY = pos.y + clamped;

        // Frame-rate independent exponential smoothing
        const t = 1 - Math.exp(-SMOOTH_RATE * delta);
        pos.y = THREE.MathUtils.lerp(pos.y, desiredY, t);
      }
    }

    if (animationRef.current !== nextAnim) {
      animationRef.current = nextAnim;
      setAnimation(nextAnim);
    }

    const nextState = {
      position: [pos.x, pos.y, pos.z],
      rotation: avatarYaw,
      animation: animationRef.current,
    };

    const now = Date.now();

    // Establish the first emitted state without sending it, so we don't spam
    // state-update on mount or after the component re-mounts (e.g. WebGL restore).
    if (!lastEmittedState.current) {
      lastEmittedState.current = nextState;
      lastEmit.current = now;
    } else if (now - lastEmit.current > 250) {
      const p1 = lastEmittedState.current.position;
      const p2 = nextState.position;
      const posSame = p1.every((v, i) => Math.abs(v - p2[i]) < 0.05);
      const rotSame = Math.abs(lastEmittedState.current.rotation - nextState.rotation) < 0.05;
      const animSame = lastEmittedState.current.animation === nextState.animation;

      if (!posSame || !rotSame || !animSame) {
        lastEmit.current = now;
        lastEmittedState.current = nextState;
        onStateUpdate?.(nextState);
      }
    }
  });

  return (
    <group ref={setGroup} {...props} dispose={null}>
      <primitive object={scene} />
    </group>
  );
});

UserAvatar.displayName = "UserAvatar";


