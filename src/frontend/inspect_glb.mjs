global.self = global;
global.Blob = class { constructor(){} };
global.URL = { createObjectURL: () => '' };
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as fs from 'fs';
const loader = new GLTFLoader();
const buf = fs.readFileSync('/home/saadkhankori/Desktop/master-thesis/dtalk/frontend/public/assets/useravatar/avatars/anim_female_3.glb');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
loader.parse(ab, '', (gltf) => {
  let meshes = 0;
  let bones = 0;
  let anims = 0;
  gltf.scene.traverse((c) => {
    if (c.isMesh || c.isSkinnedMesh) meshes++;
    if (c.isBone) bones++;
  });
  anims = gltf.animations.length;
  console.log('meshes:', meshes, 'bones:', bones, 'animations:', anims);
}, (e) => console.error(e));
