import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sceneEditorPlugin() {
  return {
    name: 'scene-editor-save',
    configureServer(server) {
      server.middlewares.use('/api/save-scene-config', async (req, res, next) => {
        if (req.method !== 'POST') return next();
        try {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          await new Promise((resolve, reject) => {
            req.on('end', resolve);
            req.on('error', reject);
          });
          const { sceneName, config } = JSON.parse(body);
          const dir = path.resolve(__dirname, 'src/scenes/configs');
          await fs.mkdir(dir, { recursive: true });
          const file = path.join(dir, `${sceneName}.json`);
          await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });

      server.middlewares.use('/api/upload-scene-model', async (req, res, next) => {
        if (req.method !== 'POST') return next();
        try {
          const filename = req.headers['x-filename'];
          if (!filename || !filename.endsWith('.glb')) {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'Missing or invalid .glb filename' }));
            return;
          }
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          await new Promise((resolve, reject) => {
            req.on('end', resolve);
            req.on('error', reject);
          });
          const buffer = Buffer.concat(chunks);
          const dir = path.resolve(__dirname, 'public/assets/scene');
          await fs.mkdir(dir, { recursive: true });
          const outFile = path.join(dir, filename);
          await fs.writeFile(outFile, new Uint8Array(buffer));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, url: `/assets/scene/${filename}` }));
        } catch (err) {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), sceneEditorPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
