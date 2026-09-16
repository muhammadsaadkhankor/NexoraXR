import { Suspense, forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, TransformControls, useGLTF } from '@react-three/drei';
import { Move, RotateCw, Maximize } from 'lucide-react';
import * as THREE from 'three';
import { SCENE_CONFIG } from '/src/sceneConfig';

const savedConfigs = import.meta.glob('/src/scenes/configs/*.json', { eager: true });
const SPAWN_POINT_URL = '/models/spawn-point.glb';

function loadSavedConfig(sceneName) {
  const m = savedConfigs[`/src/scenes/configs/${sceneName}.json`];
  return m?.default || null;
}

function toEuler(rot) {
  if (Array.isArray(rot)) return [...rot];
  if (typeof rot === 'number') return [0, rot, 0];
  return [0, 0, 0];
}

function getDefaultConfig(sceneName) {
  const base = SCENE_CONFIG[sceneName] || {};
  const userStart = base.userStart || { position: [0, 0, 0], rotation: [0, Math.PI, 0] };
  const assistant = base.assistant || { position: [0, 1.0, -6] };

  return {
    sceneName,
    sceneModel: {
      url: base.modelUrl || '/assets/scene/modified-classroom.glb',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    sceneCamera: {
      bounds: { min: [-10, 0, -10], max: [10, 5, 10] },
      defaultLookAt: base.assistant?.position ? [...base.assistant.position] : [0, 1.0, -6],
    },
    userSpawn: {
      position: [...userStart.position],
      rotation: toEuler(userStart.rotation),
      scale: [1, 1, 1],
    },
    professorSpawn: {
      position: [...assistant.position],
      rotation: [0, 0, 0],
      scale: [1.2, 1.2, 1.2],
    },
  };
}

function makeInitialConfig(sceneName) {
  const saved = loadSavedConfig(sceneName);
  const defaults = getDefaultConfig(sceneName);
  if (!saved) return defaults;
  return {
    ...defaults,
    ...saved,
    sceneName,
    sceneModel: {
      ...defaults.sceneModel,
      ...saved.sceneModel,
      position: saved.sceneModel?.position ?? defaults.sceneModel.position,
      rotation: toEuler(saved.sceneModel?.rotation ?? defaults.sceneModel.rotation),
      scale: saved.sceneModel?.scale ?? defaults.sceneModel.scale,
    },
    sceneCamera: {
      ...defaults.sceneCamera,
      ...saved.sceneCamera,
      bounds: { ...defaults.sceneCamera.bounds, ...saved.sceneCamera?.bounds },
      defaultLookAt: saved.sceneCamera?.defaultLookAt ?? defaults.sceneCamera.defaultLookAt,
    },
    userSpawn: {
      ...defaults.userSpawn,
      ...saved.userSpawn,
      rotation: toEuler(saved.userSpawn?.rotation ?? defaults.userSpawn.rotation),
      scale: saved.userSpawn?.scale ?? defaults.userSpawn.scale,
    },
    professorSpawn: {
      ...defaults.professorSpawn,
      ...saved.professorSpawn,
      rotation: toEuler(saved.professorSpawn?.rotation ?? defaults.professorSpawn.rotation),
      scale: saved.professorSpawn?.scale ?? defaults.professorSpawn.scale,
    },
  };
}

const SceneModel = forwardRef(({ url, ...props }, ref) => {
  const { scene } = useGLTF(url);
  return (
    <group ref={ref} {...props}>
      <primitive object={scene} />
    </group>
  );
});

function SpawnModel({ url, color }) {
  const { scene } = useGLTF(url);
  const model = useMemo(() => {
    const m = scene.clone();
    if (color) {
      m.traverse((child) => {
        if (child.isMesh) {
          if (Array.isArray(child.material)) {
            child.material = child.material.map((mat) => {
              const c = mat.clone();
              if (c.color) c.color.set(color);
              return c;
            });
          } else if (child.material) {
            child.material = child.material.clone();
            if (child.material.color) child.material.color.set(color);
          }
        }
      });
    }
    return m;
  }, [scene, color]);
  return <primitive object={model} />;
}

const CameraNode = forwardRef(({ position }, ref) => (
  <group ref={ref} position={position}>
    <mesh position={[0, 0, 0]}>
      <boxGeometry args={[0.2, 0.2, 0.2]} />
      <meshBasicMaterial color='#22c55e' />
    </mesh>
    <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.25]}>
      <coneGeometry args={[0.15, 0.4, 16]} />
      <meshBasicMaterial color='#22c55e' transparent opacity={0.8} />
    </mesh>
  </group>
));

function SceneGraphLogger({ selectedId }) {
  const { scene } = useThree();
  useEffect(() => {
    if (selectedId === 'sceneCamera') {
      const names = scene.children
        .filter((c) => c !== scene)
        .map((c) => `${c.type}:${c.name || 'unnamed'}`)
        .join(', ');
      console.log('[SceneEditor] scene children count:', scene.children.length);
      console.log('[SceneEditor] scene children:', names);
    }
  }, [selectedId, scene]);
  return null;
}

function BoundsBox({ min, max, selected }) {
  const [cx, cy, cz, sx, sy, sz] = useMemo(() => {
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const size = [Math.max(0.01, max[0] - min[0]), Math.max(0.01, max[1] - min[1]), Math.max(0.01, max[2] - min[2])];
    return [...center, ...size];
  }, [min, max]);

  return (
    <mesh position={[cx, cy, cz]} scale={[sx, sy, sz]} raycast={() => null}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color={selected ? '#fb923c' : '#f97316'} wireframe transparent opacity={selected ? 0.75 : 0.35} />
    </mesh>
  );
}

function VectorInput({ label, vec, onChange, step = 0.1, unit }) {
  const display = (v) => (unit === 'deg' ? (v * 180 / Math.PI) : v);
  const store = (v) => (unit === 'deg' ? (v * Math.PI / 180) : v);

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}{unit === 'deg' ? ' (deg)' : ''}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {['x', 'y', 'z'].map((axis, i) => (
          <input
            key={axis}
            type='number'
            step={step}
            value={Number(display(vec[i])).toFixed(2)}
            onChange={(e) => {
              const next = [...vec];
              next[i] = store(parseFloat(e.target.value) || 0);
              onChange(next);
            }}
            style={{ width: 58, fontSize: 12, padding: 5, borderRadius: 4, border: '1px solid #334155', background: '#0f172a', color: '#f8fafc' }}
          />
        ))}
      </div>
    </div>
  );
}

const HIERARCHY = [
  { id: 'sceneModel', label: 'Scene Model', type: 'model' },
  { id: 'sceneCamera', label: 'Scene Camera', type: 'camera' },
  { id: 'userSpawn', label: 'User Avatar Spawn Point', type: 'spawn' },
  { id: 'professorSpawn', label: 'Professor Avatar Spawn Point', type: 'spawn' },
];

export default function SceneEditor() {
  const query = new URLSearchParams(window.location.search);
  const [sceneName, setSceneName] = useState(query.get('scene') || 'ELG5121');
  const [config, setConfig] = useState(() => makeInitialConfig(sceneName));
  const [selectedId, setSelectedId] = useState('sceneCamera');
  const [gizmoMode, setGizmoMode] = useState('translate');
  const [status, setStatus] = useState('');

  const [modelNode, setModelNode] = useState(null);
  const [cameraNode, setCameraNode] = useState(null);
  const [userNode, setUserNode] = useState(null);
  const [professorNode, setProfessorNode] = useState(null);
  const [minNode, setMinNode] = useState(null);
  const [maxNode, setMaxNode] = useState(null);

  useEffect(() => {
    const next = makeInitialConfig(sceneName);
    setConfig(next);
    setSelectedId('sceneCamera');
    setStatus('');
  }, [sceneName]);

  useEffect(() => {
    if (modelNode) {
      modelNode.position.set(...config.sceneModel.position);
      modelNode.rotation.set(...config.sceneModel.rotation);
      modelNode.scale.set(...config.sceneModel.scale);
    }
    if (cameraNode) {
      cameraNode.position.set(...config.sceneCamera.defaultLookAt);
    }
    if (userNode) {
      userNode.position.set(...config.userSpawn.position);
      userNode.rotation.set(...config.userSpawn.rotation);
      userNode.scale.set(...config.userSpawn.scale);
    }
    if (professorNode) {
      professorNode.position.set(...config.professorSpawn.position);
      professorNode.rotation.set(...config.professorSpawn.rotation);
      professorNode.scale.set(...config.professorSpawn.scale);
    }
    if (minNode) minNode.position.set(...config.sceneCamera.bounds.min);
    if (maxNode) maxNode.position.set(...config.sceneCamera.bounds.max);
  }, [config, modelNode, cameraNode, userNode, professorNode, minNode, maxNode]);

  const updateFromMeshes = () => {
    setConfig((prev) => ({
      ...prev,
      sceneCamera: {
        ...prev.sceneCamera,
        bounds: {
          ...prev.sceneCamera.bounds,
        },
        defaultLookAt: cameraNode
          ? [cameraNode.position.x, cameraNode.position.y, cameraNode.position.z]
          : prev.sceneCamera.defaultLookAt,
      },
      sceneModel: modelNode
        ? {
            ...prev.sceneModel,
            position: [modelNode.position.x, modelNode.position.y, modelNode.position.z],
            rotation: [modelNode.rotation.x, modelNode.rotation.y, modelNode.rotation.z],
            scale: [modelNode.scale.x, modelNode.scale.y, modelNode.scale.z],
          }
        : prev.sceneModel,
      userSpawn: userNode
        ? {
            position: [userNode.position.x, userNode.position.y, userNode.position.z],
            rotation: [userNode.rotation.x, userNode.rotation.y, userNode.rotation.z],
            scale: [userNode.scale.x, userNode.scale.y, userNode.scale.z],
          }
        : prev.userSpawn,
      professorSpawn: professorNode
        ? {
            position: [professorNode.position.x, professorNode.position.y, professorNode.position.z],
            rotation: [professorNode.rotation.x, professorNode.rotation.y, professorNode.rotation.z],
            scale: [professorNode.scale.x, professorNode.scale.y, professorNode.scale.z],
          }
        : prev.professorSpawn,
    }));
  };

  const publish = async () => {
    try {
      const res = await fetch('/api/save-scene-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneName, config }),
      });
      const data = await res.json();
      if (data.ok) setStatus(`Published to src/scenes/configs/${sceneName}.json`);
      else setStatus(`Publish failed: ${data.error || 'unknown'}`);
    } catch (err) {
      setStatus(`Publish failed: ${err.message}`);
    }
  };

  const fileInputRef = useRef(null);

  const handleFile = async (file) => {
    if (!file || !file.name.endsWith('.glb')) {
      setStatus('Only .glb files are supported');
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setConfig((p) => ({ ...p, sceneModel: { ...p.sceneModel, url: previewUrl } }));
    setStatus('Uploading model...');
    try {
      const res = await fetch('/api/upload-scene-model', {
        method: 'POST',
        headers: { 'X-Filename': file.name, 'Content-Type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      const data = await res.json();
      if (data.ok) {
        setConfig((p) => ({ ...p, sceneModel: { ...p.sceneModel, url: data.url } }));
        setStatus(`Model uploaded: ${data.url}`);
      } else {
        setStatus(`Upload failed: ${data.error || 'unknown'}`);
      }
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`);
    }
  };

  const selectedNode = HIERARCHY.find((n) => n.id === selectedId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', background: '#020617', color: '#f8fafc', fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid #1e293b', background: '#0f172a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontWeight: 700 }}>Spoke Studio — NexoraXR</span>
          <select
            value={sceneName}
            onChange={(e) => {
              const next = e.target.value;
              setSceneName(next);
              window.history.replaceState({}, '', `?scene=${next}`);
            }}
            style={{ padding: 5, borderRadius: 4, background: '#0f172a', color: '#f8fafc', border: '1px solid #334155' }}
          >
            {Object.keys(SCENE_CONFIG).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={publish}
          style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#0ea5e9', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
        >
          Publish to src/scenes/configs
        </button>
      </header>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <Canvas camera={{ position: [8, 6, 8], fov: 50 }} style={{ background: '#0f172a' }}>
            <OrbitControls makeDefault enableDamping dampingFactor={0.1} />
            <ambientLight intensity={0.8} />
            <directionalLight position={[5, 10, 5]} intensity={1.2} />
            <gridHelper args={[40, 40, '#334155', '#1e293b']} />

            <Suspense fallback={null}>
              <SceneModel
                ref={setModelNode}
                url={config.sceneModel.url}
                position={config.sceneModel.position}
                rotation={config.sceneModel.rotation}
                scale={config.sceneModel.scale}
              />
            </Suspense>

            <group ref={setUserNode} position={config.userSpawn.position} rotation={config.userSpawn.rotation} scale={config.userSpawn.scale}>
              <SpawnModel url={SPAWN_POINT_URL} color='#22d3ee' />
            </group>
            <group ref={setProfessorNode} position={config.professorSpawn.position} rotation={config.professorSpawn.rotation} scale={config.professorSpawn.scale}>
              <SpawnModel url={SPAWN_POINT_URL} color='#f472b6' />
            </group>

            {selectedId === 'sceneCamera' && (
              <>
                <CameraNode ref={setCameraNode} position={config.sceneCamera.defaultLookAt} />
                <SceneGraphLogger selectedId={selectedId} />
              </>
            )}

            {selectedId === 'sceneCamera' && cameraNode && (
              <TransformControls
                object={cameraNode}
                mode='translate'
                onObjectChange={updateFromMeshes}
                translationSnap={0.1}
              />
            )}

            {selectedId === 'userSpawn' && userNode && (
              <TransformControls
                object={userNode}
                mode={gizmoMode}
                onObjectChange={updateFromMeshes}
                translationSnap={0.1}
                rotationSnap={0.01}
                scaleSnap={0.05}
              />
            )}

            {selectedId === 'professorSpawn' && professorNode && (
              <TransformControls
                object={professorNode}
                mode={gizmoMode}
                onObjectChange={updateFromMeshes}
                translationSnap={0.1}
                rotationSnap={0.01}
                scaleSnap={0.05}
              />
            )}

            {selectedId === 'sceneModel' && modelNode && (
              <TransformControls
                object={modelNode}
                mode={gizmoMode}
                onObjectChange={updateFromMeshes}
                translationSnap={0.1}
                rotationSnap={0.01}
                scaleSnap={0.05}
              />
            )}
          </Canvas>
        </div>

        <aside style={{ width: 300, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #1e293b', background: '#0f172a' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Hierarchy</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {HIERARCHY.map((node) => (
                <li
                  key={node.id}
                  onClick={() => setSelectedId(node.id)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 4,
                    cursor: 'pointer',
                    background: selectedId === node.id ? '#0ea5e9' : 'transparent',
                    color: selectedId === node.id ? '#fff' : '#cbd5e1',
                    marginBottom: 4,
                    border: '1px solid ' + (selectedId === node.id ? '#0ea5e9' : '#1e293b'),
                  }}
                >
                  <span style={{ fontSize: 10, color: selectedId === node.id ? '#fff' : '#64748b', marginRight: 6 }}>{node.type.toUpperCase()}</span>
                  {node.label}
                </li>
              ))}
            </ul>
          </div>

          <div style={{ borderTop: '1px solid #1e293b', padding: 12, maxHeight: '55%', overflowY: 'auto' }}>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Properties — {selectedNode?.label}</div>

            {(selectedId === 'userSpawn' || selectedId === 'professorSpawn' || selectedId === 'sceneModel') && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                {[
                  { id: 'translate', label: 'Position', Icon: Move },
                  { id: 'rotate', label: 'Rotation', Icon: RotateCw },
                  { id: 'scale', label: 'Scale', Icon: Maximize },
                ].map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    onClick={() => setGizmoMode(id)}
                    title={label}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                      padding: '5px 0',
                      borderRadius: 4,
                      border: '1px solid #334155',
                      background: gizmoMode === id ? '#0ea5e9' : '#0f172a',
                      color: '#f8fafc',
                      cursor: 'pointer',
                      fontSize: 11,
                    }}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </div>
            )}

            {selectedId === 'sceneModel' && (
              <div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Scene Model</div>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files[0];
                    if (file) handleFile(file);
                  }}
                  style={{
                    padding: 16,
                    border: '2px dashed #334155',
                    borderRadius: 6,
                    textAlign: 'center',
                    cursor: 'pointer',
                    background: '#0f172a',
                    color: '#94a3b8',
                    fontSize: 12,
                  }}
                >
                  <div>Drop a .glb here or click to upload</div>
                  <div style={{ fontSize: 10, marginTop: 4, color: '#64748b', wordBreak: 'break-all' }}>{config.sceneModel.url}</div>
                </div>
                <input
                  ref={fileInputRef}
                  type='file'
                  accept='.glb'
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files[0];
                    if (file) handleFile(file);
                    e.target.value = '';
                  }}
                />
                <VectorInput label='Position' vec={config.sceneModel.position} onChange={(v) => setConfig((p) => ({ ...p, sceneModel: { ...p.sceneModel, position: v } }))} />
                <VectorInput label='Rotation' vec={config.sceneModel.rotation} onChange={(v) => setConfig((p) => ({ ...p, sceneModel: { ...p.sceneModel, rotation: v } }))} step={1} unit='deg' />
                <VectorInput label='Scale' vec={config.sceneModel.scale} onChange={(v) => setConfig((p) => ({ ...p, sceneModel: { ...p.sceneModel, scale: v } }))} step={0.05} />
              </div>
            )}

            {selectedId === 'sceneCamera' && (
              <>
                <VectorInput label='Bounds Min' vec={config.sceneCamera.bounds.min} onChange={(v) => setConfig((p) => ({ ...p, sceneCamera: { ...p.sceneCamera, bounds: { ...p.sceneCamera.bounds, min: v } } }))} />
                <VectorInput label='Bounds Max' vec={config.sceneCamera.bounds.max} onChange={(v) => setConfig((p) => ({ ...p, sceneCamera: { ...p.sceneCamera, bounds: { ...p.sceneCamera.bounds, max: v } } }))} />
                <VectorInput label='Default Look At' vec={config.sceneCamera.defaultLookAt} onChange={(v) => setConfig((p) => ({ ...p, sceneCamera: { ...p.sceneCamera, defaultLookAt: v } }))} />
              </>
            )}

            {selectedId === 'userSpawn' && (
              <>
                <VectorInput label='Position' vec={config.userSpawn.position} onChange={(v) => setConfig((p) => ({ ...p, userSpawn: { ...p.userSpawn, position: v } }))} />
                <VectorInput label='Rotation' vec={config.userSpawn.rotation} onChange={(v) => setConfig((p) => ({ ...p, userSpawn: { ...p.userSpawn, rotation: v } }))} step={1} unit='deg' />
                <VectorInput label='Scale' vec={config.userSpawn.scale} onChange={(v) => setConfig((p) => ({ ...p, userSpawn: { ...p.userSpawn, scale: v } }))} step={0.05} />
              </>
            )}

            {selectedId === 'professorSpawn' && (
              <>
                <VectorInput label='Position' vec={config.professorSpawn.position} onChange={(v) => setConfig((p) => ({ ...p, professorSpawn: { ...p.professorSpawn, position: v } }))} />
                <VectorInput label='Rotation' vec={config.professorSpawn.rotation} onChange={(v) => setConfig((p) => ({ ...p, professorSpawn: { ...p.professorSpawn, rotation: v } }))} step={1} unit='deg' />
                <VectorInput label='Scale' vec={config.professorSpawn.scale} onChange={(v) => setConfig((p) => ({ ...p, professorSpawn: { ...p.professorSpawn, scale: v } }))} step={0.05} />
              </>
            )}

            {status && <div style={{ marginTop: 12, color: '#22d3ee', fontSize: 11 }}>{status}</div>}
          </div>
        </aside>
      </div>

      <footer style={{ height: 120, borderTop: '1px solid #1e293b', background: '#0f172a', padding: 12 }}>
        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Assets / Elements</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {HIERARCHY.map((node) => (
            <button
              key={node.id}
              onClick={() => setSelectedId(node.id)}
              style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #334155', background: selectedId === node.id ? '#0ea5e9' : '#0f172a', color: '#f8fafc', cursor: 'pointer' }}
            >
              {node.label}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}
