global.self = global;
global.Blob = class { constructor(){} };
global.URL = { createObjectURL: () => '' };
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Box3, Vector3 } from 'three';
import * as fs from 'fs';
const loader = new GLTFLoader();
for (const p of ['/home/saadkhankori/Desktop/master-thesis/dtalk/frontend/public/assets/useravatar/UserAvatar.glb', '/home/saadkhankori/Desktop/master-thesis/dtalk/frontend/public/assets/useravatar/avatars/UserAvatar.glb', '/home/saadkhankori/Desktop/master-thesis/dtalk/frontend/public/assets/useravatar/avatars/anim_female_3.glb']) {
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  loader.parse(ab, '', (gltf) => {
    const box = new Box3().setFromObject(gltf.scene);
    const v = new Vector3();
    console.log(p, 'size:', box.getSize(v).toArray());
  }, (e) => console.error(e));
}
