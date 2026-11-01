// Post-clone asset wiring: public/ holds symlinks into the shared
// /src/assets directory (gitignored, downloaded separately). Creating a
// symlink does NOT require the target to exist, so this is safe to run
// before or after the asset zip is extracted — and it's idempotent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUB = path.join(ROOT, 'src', 'nexora_client', 'public');

const LINKS = [
  ['assets', '../../assets'],
  ['models', '../../assets/models'],
  ['animations', '../../assets/animations-fbx'],
  ['animatio.glb', '../../assets/animatio.glb'],
];

let made = 0;
for (const [name, target] of LINKS) {
  const linkPath = path.join(PUB, name);
  try {
    // lstat throws if nothing is there; a real dir/file wins over a link.
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      const cur = fs.readlinkSync(linkPath);
      if (cur === target || cur === target + '/') continue;
      fs.rmSync(linkPath);
    } else if (st.isDirectory() && name === 'assets') {
      // Real directory (fresh checkout where assets live inside public) —
      // leave it; it already serves /assets/*.
      continue;
    } else {
      fs.rmSync(linkPath);
    }
  } catch { /* ENOENT — nothing exists */ }
  fs.symlinkSync(target, linkPath);
  made++;
  console.log(`[assets] public/${name} -> ${target}`);
}

const assetsDir = path.join(ROOT, 'src', 'assets');
if (!fs.existsSync(assetsDir)) {
  console.log('[assets] NOTE: src/assets/ does not exist yet — download and extract');
  console.log('         WuFlux_assets.zip into src/ before running the app.');
}
if (!made) console.log('[assets] symlinks already in place');
