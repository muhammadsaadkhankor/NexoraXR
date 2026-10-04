global.self = global;
global.Blob = class { constructor(){} };
global.URL = { createObjectURL: () => '' };
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as fs from 'fs';
const loader = new GLTFLoader();
const buf = fs.readFileSync('/home/saadkhankori/Desktop/master-thesis/dtalk/frontend/public/assets/useravatar/avatars/anim_female_3.glb');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
loader.parse(ab, '', (gltf) => {
  console.log('animations:', gltf.animations.map(a => a.name));
}, (e) => console.error(e));
