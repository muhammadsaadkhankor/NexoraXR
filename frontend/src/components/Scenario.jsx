import { CameraControls, Environment, useGLTF } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Avatar } from "./Avatar";
import { UserAvatar } from "./UserAvatar";

const HEAD_HEIGHT = 1.6;
const TP_DISTANCE = 4.0;
const TP_HEIGHT = 0.8;
const TALK_RADIUS = 2.0;
const ASSISTANT_POS = new THREE.Vector3(0, 0, -6);

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

export const Scenario = ({ currentAvatarPath, cameraPreset = "third-person", setCameraPreset, onInRangeChange }) => {
  const cameraControls = useRef();
  const userAvatarRef = useRef();
  const lastPreset = useRef(null);
  const avatarYawRef = useRef(Math.PI);
  const inRangeRef = useRef(false);
  const [ringY, setRingY] = useState(0.05);
  const { scene } = useGLTF('/assets/scene/scene.glb');

  useEffect(() => {
    if (!scene) return;
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

    const horizontalDist = new THREE.Vector3(userPos.x, 0, userPos.z).distanceTo(ASSISTANT_POS);
    const inRange = horizontalDist <= TALK_RADIUS;
    if (inRange !== inRangeRef.current) {
      inRangeRef.current = inRange;
      onInRangeChange?.(inRange);
    }
  });

  return (
    <>
      <CameraControls ref={cameraControls} enabled={false} />
      <Environment preset="sunset" />
      <primitive object={scene} />
      <AuraZone ringY={ringY} />
      <UserAvatar ref={userAvatarRef} position={[0, 0, 0]} rotation={[0, Math.PI, 0]} cameraPreset={cameraPreset} floorScene={scene} avatarYawRef={avatarYawRef} />
      <Avatar modelPath={currentAvatarPath} position={[0, 1.0, -6]} />
    </>
  );
};

useGLTF.preload('/assets/scene/scene.glb');
