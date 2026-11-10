#!/usr/bin/env python3
"""Resume-accuracy harness — real Playwright browsers + protocol holder.

Measures per-learner pause/resume accuracy across languages:
  N real browsers (mixed EN/AR/ZH) play a real lecture on an isolated eval
  stack (eval backend :EVAL_PORT + vite :EVAL_VITE_PORT with VITE_API_URL).
  A protocol holder (eval/resume/holder.mjs) interrupts at random mid-segment
  points; browsers snapshot exact positions via the ?nxrdbg=1 hook
  (__nxrPos / __nxrPauseLog). 30 interruptions per cell.

  EVAL_LABEL=resume_baseline|resume_fixed  EVAL_SEED=...  EVAL_REPS=30
  EVAL_NS='2,4'  EVAL_PORT=4120  EVAL_VITE_PORT=5174
"""
import json, os, random, signal, subprocess, sys, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SERVER_DIR = REPO / 'src' / 'nexora_server'
CLIENT_DIR = REPO / 'src' / 'nexora_client'
RESULTS = REPO / 'eval' / 'resume' / 'results'

PORT = int(os.environ.get('EVAL_PORT', '4120'))
VITE_PORT = int(os.environ.get('EVAL_VITE_PORT', '5174'))
LABEL = os.environ.get('EVAL_LABEL', 'resume_baseline')
REPS = int(os.environ.get('EVAL_REPS', '30'))
SEED = int(os.environ.get('EVAL_SEED', '0xC0FFEE'), 16)
NS = [int(x) for x in os.environ.get('EVAL_NS', '2,4').split(',')]
LECTURE = os.environ.get('EVAL_LECTURE', 'multimedia_L1')
BASE = f'http://localhost:{PORT}'
FRONT = f'http://localhost:{VITE_PORT}'
MIXES = {2: ['en', 'ar'], 4: ['en', 'en', 'ar', 'zh']}
LANG_LABELS = {'en': 'English', 'ar': 'العربية', 'zh': '中文', 'fr': 'Français',
               'de': 'Deutsch', 'es': 'Español'}
TS = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%f')[:23] + 'Z'


def http_json(url, tries=80, delay=0.25):
    for _ in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(delay)
    raise RuntimeError(f'no response from {url}')


def start_server():
    env = dict(os.environ, PORT=str(PORT), EVAL_LOG='1',
               EVAL_RUN_ID=f'resume_{LABEL}_{TS}',
               EVAL_MOCK_PROFESSOR='1', NXR_DEV_UNAUTH_PROTOCOL='1',
               NXR_START_REQUIRES_ALL_LANGS='0', NXR_AGENT_DYNAMIC='0',
               OLLAMA_BASE_URL='http://127.0.0.1:9', TTS_URL='http://127.0.0.1:9',
               NXR_REPAIR_ON_BOOT='0', DATABASE_URL='',
               CORS_ORIGINS=f'{FRONT},http://127.0.0.1:{VITE_PORT}')
    p = subprocess.Popen(['node', 'server.js'], cwd=SERVER_DIR, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    http_json(f'{BASE}/api/rooms/public')
    return p


def start_vite():
    env = dict(os.environ, VITE_API_URL=BASE)
    p = subprocess.Popen([str(CLIENT_DIR / 'node_modules' / '.bin' / 'vite'),
                          '--port', str(VITE_PORT), '--strictPort'],
                         cwd=CLIENT_DIR, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            urllib.request.urlopen(FRONT, timeout=2)
            return p
        except Exception:
            time.sleep(0.25)
    raise RuntimeError('vite did not start')


def start_holder(room):
    env = dict(os.environ, BASE=BASE, ROOM=room, PID='holder', LECTURE=LECTURE)
    p = subprocess.Popen(['node', str(REPO / 'eval' / 'resume' / 'holder.mjs')],
                         env=env, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, text=True, bufsize=1)
    return p


def holder_event(p, want, timeout=30):
    deadline = time.time() + timeout
    buf = []
    while time.time() < deadline:
        line = p.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        buf.append(ev)
        if ev.get('ev') == want:
            return ev, buf
    raise TimeoutError(f'holder event {want} not seen; got {buf[-5:]}')


def lecture_room():
    """Resolve the deterministic public room for the lecture."""
    req = urllib.request.Request(
        f'{BASE}/api/rooms/for-lecture', method='POST',
        headers={'Content-Type': 'application/json'},
        data=json.dumps({'lectureId': LECTURE}).encode())
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


class BrowserClient:
    def __init__(self, pw, join_url, lang, idx):
        self.lang = lang
        self.pid = f'br-{lang}-{idx}'
        self.ctx = pw.chromium.launch(
            headless=True,
            args=['--autoplay-policy=no-user-gesture-required',
                  '--use-fake-ui-for-media-stream',
                  '--use-fake-device-for-media-stream',
                  '--mute-audio']).new_context()
        self.page = self.ctx.new_page()
        self.page.add_init_script(f"""
          sessionStorage.setItem('nexoraxr_display_name', '{self.pid}');
          sessionStorage.setItem('nexoraxr_participant_id', '{self.pid}');
        """)
        self.page.goto(f'{FRONT}{join_url}&nxrdbg=1',
                       wait_until='domcontentloaded', timeout=30000)

    def set_language(self, timeout=90):
        """Drive the language menu until the live position reports my lang."""
        try:
            # The loading overlay intercepts toolbar clicks until the 3D
            # scene finishes — wait until it turns pointer-events:none.
            self.page.wait_for_function(
                """() => {
                    const orb = document.querySelector('.loadorb');
                    if (!orb) return true;
                    let el = orb;
                    while (el && !String(el.className).includes('transition-opacity'))
                        el = el.parentElement;
                    return !el || el.className.includes('opacity-0')
                        || getComputedStyle(el).opacity === '0';
                }""", timeout=180000)
            time.sleep(1)
        except Exception:
            print(f'[harness] {self.pid}: overlay never cleared')
        deadline = time.time() + timeout
        while time.time() < deadline:
            pos = self.pos()
            if pos and pos.get('lang') == self.lang:
                return True
            try:
                self.page.get_by_text('Language', exact=True).first.click(timeout=5000)
                self.page.get_by_text(LANG_LABELS[self.lang], exact=True).first.click(timeout=4000)
            except Exception as e:
                print(f'[harness] {self.pid}: lang click retry ({e.__class__.__name__})')
            time.sleep(1.5)
        print(f'[harness] {self.pid}: FAILED to set language {self.lang}')
        return False

    def pos(self):
        try:
            return self.page.evaluate('window.__nxrPos ? window.__nxrPos() : null')
        except Exception:
            return None

    def pause_log(self):
        try:
            return self.page.evaluate('window.__nxrPauseLog ? window.__nxrPauseLog() : []')
        except Exception:
            return []

    def close(self):
        try:
            self.ctx.close()
        except Exception:
            pass


def seg_durations(manifests):
    """{lang: {segIndex: durationSec}} from baked sentence alignment."""
    out = {}
    for lang, m in manifests.items():
        out[lang] = {}
        for s in m.get('segments', []):
            sents = s.get('sentences') or []
            out[lang][s['id']] = (sents[-1]['end'] if sents else None)
    return out


def pair_events(log):
    """Pair each 'pause' with the next 'resume' + 'resume-actual' by order."""
    events = sorted(log, key=lambda e: e.get('tPerf') or 0)
    pairs = []
    cur = None
    for e in events:
        if e['event'] == 'pause':
            if cur:
                pairs.append(cur)
            cur = dict(pause=e, resume=None, actual=None)
        elif e['event'] == 'resume' and cur and not cur['resume']:
            cur['resume'] = e
        elif e['event'] == 'resume-actual' and cur and cur['resume'] and not cur['actual']:
            cur['actual'] = e
    if cur:
        pairs.append(cur)
    return pairs


def compute_metrics(records, durs):
    """records: [{cell,lang,pause:{...},resume:{...},actual:{...}}]"""
    per = {}
    for r in records:
        if not r['pause'] or not (r['resume'] or r['actual']):
            continue
        actual = r['actual']
        res = (actual if actual and actual.get('segmentIndex') is not None
               and actual.get('currentTimeSec') is not None
               else r['resume'])
        p, s = r['pause'], res
        key = (r['cell'], r['pause'].get('lang') or r['lang'])
        per.setdefault(key, []).append((p, s, r['resume']))
    rows = []
    for (cell, lang), pairs in sorted(per.items()):
        same_sent = 0
        errs, skips, repeats = [], [], []
        n = 0
        for p, s, tgt in pairs:
            if p['segmentIndex'] is None or s['segmentIndex'] is None:
                continue
            n += 1
            if s['segmentIndex'] == p['segmentIndex']:
                err_ms = abs((s['currentTimeSec'] or 0) - (p['currentTimeSec'] or 0)) * 1000
                errs.append(err_ms)
                if p.get('sentenceIndex') is not None:
                    if s.get('sentenceIndex') == p.get('sentenceIndex'):
                        same_sent += 1
                delta = (s['currentTimeSec'] or 0) - (p['currentTimeSec'] or 0)
                if delta > 0.25:
                    skips.append(delta)
                elif delta < -0.25:
                    repeats.append(-delta)
            elif s['segmentIndex'] > p['segmentIndex']:
                # dragged forward: lost the rest of paused seg + jumped into
                # a later one. skipped = remaining-of-old + offset-in-new.
                dur = durs.get(lang, {}).get(p['segmentIndex'])
                remain = max(0, (dur or 0) - (p['currentTimeSec'] or 0))
                skips.append(remain + (s['currentTimeSec'] or 0))
            else:
                repeats.append((p['currentTimeSec'] or 0))
        def pct(xs, q):
            if not xs: return None
            ys = sorted(xs)
            return round(ys[min(len(ys)-1, int((q/100)*len(ys)))], 1)
        rows.append(dict(cell=cell, lang=lang, n=n,
                         same_sentence_pct=round(100*same_sent/max(n,1), 1),
                         err_p50=pct(errs, 50), err_p95=pct(errs, 95),
                         err_max=round(max(errs),1) if errs else None,
                         skipped_s=round(sum(skips)/max(len(skips),1), 2) if skips else 0,
                         skipped_n=len(skips),
                         repeated_s=round(sum(repeats)/max(len(repeats),1), 2) if repeats else 0,
                         repeated_n=len(repeats)))
    return rows


def main():
    from playwright.sync_api import sync_playwright
    RESULTS.mkdir(parents=True, exist_ok=True)
    label_dir = RESULTS / LABEL
    label_dir.mkdir(exist_ok=True)
    rng = random.Random(SEED)

    print(f'[harness] starting vite :{VITE_PORT}')
    vite = start_vite()
    print('[harness] vite up')

    records = []
    manifests = None
    server = None
    try:
        with sync_playwright() as pw:
            for n in NS:
                # Fresh server per cell — clean room state for every cell.
                print(f'[harness] cell n={n}: starting eval server :{PORT}')
                server = start_server()
                if manifests is None:
                    manifests = {l: http_json(
                        f'{BASE}/api/lecture/segments/{LECTURE}?lang={l}')
                        for l in {'en', 'ar', 'zh'}}
                    durs = seg_durations(manifests)
                room_meta = lecture_room()
                print(f"[harness] room {room_meta['roomId']} "
                      f"({room_meta['className']})")
                mix = MIXES[n]
                room = room_meta['roomId']
                clients = [BrowserClient(pw, room_meta['joinUrl'], l, i)
                           for i, l in enumerate(mix)]
                # Wait for every client's debug hook (scene mounted).
                deadline = time.time() + 40
                while time.time() < deadline:
                    if all(c.pos() is not None for c in clients):
                        break
                    time.sleep(0.5)
                for c in clients:
                    if c.lang != 'en':
                        c.set_language()
                time.sleep(1)
                holder = start_holder(room)
                ev, _ = holder_event(holder, 'joined')
                holder.stdin.write('start\n'); holder.stdin.flush()
                # Wait for every browser to be mid-segment.
                deadline = time.time() + 60
                while time.time() < deadline:
                    poss = [c.pos() for c in clients]
                    if all(p and p.get('segmentIndex') is not None
                           and (p.get('currentTimeSec') or 0) > 0.5
                           and not p.get('paused') for p in poss):
                        break
                    time.sleep(0.5)
                print(f'[harness] n={n} lecture playing:',
                      {c.pid: c.pos() for c in clients})

                for rep in range(REPS):
                    # dwell until a random mid-segment moment
                    time.sleep(rng.uniform(2.0, 8.0))
                    base_len = sum(len(c.pause_log()) for c in clients)
                    holder.stdin.write('hold\n'); holder.stdin.flush()
                    try:
                        ev, _ = holder_event(holder, 'resume', timeout=40)
                    except TimeoutError:
                        print(f'[harness] n={n} rep {rep}: resume TIMEOUT')
                    time.sleep(0.6)  # resume-actual snapshot lands +200ms
                    new_len = sum(len(c.pause_log()) for c in clients)
                    if rep % 10 == 0:
                        print(f'[harness] n={n} rep {rep} pause-log entries {new_len}')
                # Collect per-client pause/resume pairs (order-based pairing).
                for c in clients:
                    for i, pr in enumerate(pair_events(c.pause_log())):
                        records.append(dict(
                            cell=f'n{n}', lang=c.lang, pid=c.pid, rep=i,
                            pause=pr['pause'], resume=pr['resume'],
                            actual=pr['actual']))
                for c in clients:
                    c.close()
                holder.stdin.write('quit\n'); holder.stdin.flush()
                holder.wait(timeout=5)
                server.terminate()
                server.wait(timeout=10)
    finally:
        try:
            server.terminate()
        except Exception:
            pass
        vite.terminate()

    out = label_dir / f'resume_{LABEL}_{TS}.jsonl'
    with out.open('w') as f:
        for r in records:
            f.write(json.dumps(r) + '\n')
    rows = compute_metrics(records, durs)
    csv_path = label_dir / f'summary_{LABEL}_{TS}.csv'
    with csv_path.open('w') as f:
        hdr = ['cell','lang','n','same_sentence_pct','err_p50','err_p95','err_max',
               'skipped_s','skipped_n','repeated_s','repeated_n']
        f.write(','.join(hdr) + '\n')
        for r in rows:
            f.write(','.join(str(r[h]) for h in hdr) + '\n')
    print('\ncell   lang  n    same-sent%  err p50/p95/max (ms)   skipped s (n)  repeated s (n)')
    for r in rows:
        print(f"{r['cell']:5}  {r['lang']:4}  {r['n']:3}  {r['same_sentence_pct']:>9}  "
              f"{str(r['err_p50']):>7}/{str(r['err_p95']):>7}/{str(r['err_max']):>8}  "
              f"{r['skipped_s']:>7} ({r['skipped_n']})  {r['repeated_s']:>7} ({r['repeated_n']})")
    print(f'\n[harness] records -> {out}\n[harness] summary -> {csv_path}')


if __name__ == '__main__':
    main()
