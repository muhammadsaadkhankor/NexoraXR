import { useRef, useMemo, useEffect } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

export function RemoteUser({ modelPath, position, rotation, name }) {
  const group = useRef();
  const { scene } = useGLTF(modelPath);
  const model = useMemo(() => scene.clone(), [scene]);

  useEffect(() => {
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const max = Math.max(size.x, size.y, size.z);
    const s = 1.4 / max;
    model.position.set(-center.x, -box.min.y * s, -center.z);
    model.scale.set(s, s, s);
    model.traverse((child) => {
      if (child.isLine || child.isLineSegments || child.isLineLoop) {
        child.visible = false;
      }
    });
  }, [model]);

  useEffect(() => {
    if (!group.current) return;
    group.current.position.set(position[0] || 0, position[1] || 0, position[2] || 0);
    group.current.rotation.y = rotation || 0;
  }, [position, rotation]);

  return (
    <group ref={group}>
      <primitive object={model} />
    </group>
  );
}
