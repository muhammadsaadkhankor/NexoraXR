import { CameraControls, Environment, useGLTF } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Avatar } from "./Avatar";
import { UserAvatar } from "./UserAvatar";
import { RemoteAvatar } from "./RemoteAvatar";
import { SCENE_CONFIG } from "../sceneConfig";

const HEAD_HEIGHT = 1.6;
const TP_DISTANCE = 4.0;
const TP_HEIGHT = 0.8;
const TALK_RADIUS = 2.0;

const PRESETS = {
  "third-person": {
    minDistance: 2.5,
    maxDistance: 6.0,
    maxPolarAngle: Math.PI / 2,
  },
  "first-person": {
    minDistance: 0.1,
    maxDistance: 0.1,
    maxPolarAngle: Math.PI - 0.1,
  },
};

function ReadyGate({ onReady }) {
  useEffect(() => {
    onReady?.();
  }, [onReady]);
  return null;
}

function AuraZone({ ringY }) {
  const ringMat = {
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.9,
    toneMapped: false,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  };

  return (
    <group position={[0, ringY, -6]} rotation={[-Math.PI / 2, 0, 0]}>
      {/* Thin glowing ring on the floor */}
      <mesh renderOrder={100}>
        <torusGeometry args={[2.0, 0.05, 16, 100]} />
        <meshBasicMaterial {...ringMat} />
      </mesh>
    </group>
  );
}

export const Scenario = ({
  currentAvatarPath,
  userAvatarPath = '/assets/useravatar/UserAvatar.glb',
  showUserAvatar = true,
  onUserState,
  remotePlayers = [],
  joystick,
  cameraPreset = "third-person",
  setCameraPreset,
  onInRangeChange,
  onReady,
  modelUrl = '/assets/scene/scene.glb',
  environmentPreset = 'sunset',
  userStart = { position: [0, 0, 0], rotation: [0, Math.PI, 0], scale: [1, 1, 1] },
  professorStart = { position: [0, 1.0, -6], rotation: [0, 0, 0], scale: [1, 1, 1] },
  cameraBounds = { min: [-20, 0, -20], max: [20, 10, 20] },
  defaultLookAt = [0, 0, 0],
  modelTransform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
}) => {
  const cameraControls = useRef();
  const userAvatarRef = useRef();
  const lastPreset = useRef(null);
  const avatarYawRef = useRef(Math.atan2(defaultLookAt[0] - userStart.position[0], defaultLookAt[2] - userStart.position[2]));
  const inRangeRef = useRef(false);
  const boundarySet = useRef(false);
  const [ringY, setRingY] = useState(0.05);
  const { scene } = useGLTF(modelUrl);

  useEffect(() => {
    if (!scene) return;
    const box = new THREE.Box3().setFromObject(scene);
    const raycaster = new THREE.Raycaster();
    const origin = new THREE.Vector3(0, 10, -6);
    const dir = new THREE.Vector3(0, -1, 0);
    raycaster.set(origin, dir);
    const hits = raycaster.intersectObject(scene, true);
    if (hits.length > 0) {
      setRingY(hits[0].point.y + 0.02);
    }
  }, [scene]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key.toLowerCase() === 'c' && setCameraPreset) {
        setCameraPreset((prev) => (prev === "third-person" ? "first-person" : "third-person"));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setCameraPreset]);

  useFrame((_, delta) => {
    if (!cameraControls.current || !userAvatarRef.current) return;

    if (!boundarySet.current) {
      const min = new THREE.Vector3(...cameraBounds.min);
      const max = new THREE.Vector3(...cameraBounds.max);
      cameraControls.current.setBoundary(new THREE.Box3(min, max));
      cameraControls.current.boundaryEnclosesCamera = true;
      cameraControls.current.boundaryFriction = 0;
      cameraControls.current.minPolarAngle = 0.1;
      cameraControls.current.maxPolarAngle = Math.PI - 0.1;
      boundarySet.current = true;
    }

    const preset = PRESETS[cameraPreset] || PRESETS["third-person"];

    if (lastPreset.current !== cameraPreset) {
      cameraControls.current.minDistance = preset.minDistance;
      cameraControls.current.maxDistance = preset.maxDistance;
      cameraControls.current.maxPolarAngle = preset.maxPolarAngle;
      lastPreset.current = cameraPreset;
    }

    const userPos = userAvatarRef.current.position;
    const userHead = new THREE.Vector3(userPos.x, userPos.y + HEAD_HEIGHT, userPos.z);
    const avatarYaw = avatarYawRef.current;
    const forward = new THREE.Vector3(Math.sin(avatarYaw), 0, Math.cos(avatarYaw));

    if (cameraPreset === "first-person") {
      const lookTarget = userHead.clone().add(forward.multiplyScalar(0.1));
      cameraControls.current.setLookAt(
        userHead.x, userHead.y, userHead.z,
        lookTarget.x, lookTarget.y, lookTarget.z,
        false
      );
    } else {
      // Third-person over-the-shoulder chase
      const target = new THREE.Vector3(userPos.x, userPos.y + 1.2, userPos.z);
      const eye = new THREE.Vector3(
        target.x - forward.x * TP_DISTANCE,
        target.y + TP_HEIGHT,
        target.z - forward.z * TP_DISTANCE
      );

      cameraControls.current.setLookAt(
        eye.x, eye.y, eye.z,
        target.x, target.y, target.z,
        false
      );
    }

    cameraControls.current.update(delta);

    const assistantPos = new THREE.Vector3(professorStart.position[0], 0, professorStart.position[2]);
    const horizontalDist = new THREE.Vector3(userPos.x, 0, userPos.z).distanceTo(assistantPos);
    const inRange = horizontalDist <= TALK_RADIUS;
    if (inRange !== inRangeRef.current) {
      inRangeRef.current = inRange;
      onInRangeChange?.(inRange);
    }
  });

  return (
    <>
      <CameraControls ref={cameraControls} enabled={false} />
      <Environment preset={environmentPreset} />
      <group position={modelTransform.position} rotation={modelTransform.rotation} scale={modelTransform.scale}>
        <primitive object={scene} />
      </group>
      <AuraZone ringY={ringY} />
      <UserAvatar
        ref={userAvatarRef}
        modelPath={userAvatarPath}
        visible={showUserAvatar}
        onStateUpdate={onUserState}
        joystick={joystick}
        position={userStart.position}
        rotation={userStart.rotation}
        scale={userStart.scale}
        cameraPreset={cameraPreset}
        floorScene={scene}
        avatarYawRef={avatarYawRef}
      />
      {console.log('[Scenario] rendering remote players:', remotePlayers.length, remotePlayers.map((p) => p.userId))}
      {remotePlayers.map((p) => (
        <RemoteAvatar key={p.userId} state={p} />
      ))}
      <Avatar modelPath={currentAvatarPath} position={professorStart.position} rotation={professorStart.rotation} scale={professorStart.scale} />
      <ReadyGate onReady={onReady} />
    </>
  );
};

Object.values(SCENE_CONFIG).forEach(({ modelUrl }) => {
  if (modelUrl) useGLTF.preload(modelUrl);
});
