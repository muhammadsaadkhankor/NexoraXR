// translateForLecture must never return the English source as a translation:
// empty Ollama output retries 3 times then throws a descriptive error.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let server;
let requests = 0;
let mode = 'empty';
let translateForLecture;

before(async () => {
  server = http.createServer((req, res) => {
    requests++;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'empty') res.end(JSON.stringify({ response: '  ' }));
      else if (mode === 'english') res.end(JSON.stringify({ response: 'Regression is a supervised learning technique used to predict continuous values from labeled training data.' }));
      else res.end(JSON.stringify({ response: 'La régression est une technique supervisée qui prédit des valeurs continues à partir de données étiquetées.' }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.OLLAMA_BASE_URL = `http://localhost:${server.address().port}`;
  ({ translateForLecture } = await import('./lectureRoutes.mjs'));
});

after(() => server.close());

const SRC = 'Regression is a supervised learning technique used to predict continuous values from labeled training data.';

test('en passthrough makes no calls', async () => {
  requests = 0;
  assert.equal(await translateForLecture(SRC, 'en'), SRC);
  assert.equal(requests, 0);
});

test('empty output: 3 attempts then throws, never returns source', async () => {
  mode = 'empty'; requests = 0;
  await assert.rejects(
    () => translateForLecture(SRC, 'fr', { lectureId: 'L1', segmentId: 3 }),
    /Translation failed: lecture=L1 segment=3 lang=fr reason=empty-output/);
  assert.equal(requests, 3);
});

test('identical-to-source output retries and fails', async () => {
  mode = 'english'; requests = 0;
  await assert.rejects(
    () => translateForLecture(SRC, 'de', { lectureId: 'L1', segmentId: 0 }),
    /Translation failed: lecture=L1 segment=0 lang=de reason=identical-to-source/);
  assert.equal(requests, 3);
});

test('valid translation returns translated text once', async () => {
  mode = 'ok'; requests = 0;
  const out = await translateForLecture(SRC, 'fr', { lectureId: 'L1', segmentId: 0 });
  assert.equal(requests, 1);
  assert.match(out, /régression/i);
});
