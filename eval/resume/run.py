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
import json, os, random, shutil, signal, subprocess, sys, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
# Alternate checkouts (e.g. a pre-fix git worktree for the honest baseline)
# via EVAL_SERVER_DIR / EVAL_CLIENT_DIR.
SERVER_DIR = Path(os.environ.get('EVAL_SERVER_DIR', str(REPO / 'src' / 'nexora_server')))
CLIENT_DIR = Path(os.environ.get('EVAL_CLIENT_DIR', str(REPO / 'src' / 'nexora_client')))
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
# Extra query params appended to every browser URL (ablation flags).
EXTRA_QS = os.environ.get('EVAL_EXTRA_QS', '')


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
        # Prefer the bundled chromium; fall back to system Chrome when the
        # playwright browser cache is absent.
        chrome = shutil.which('google-chrome') or shutil.which('chromium')
        launch_kw = dict(headless=True,
                         args=['--autoplay-policy=no-user-gesture-required',
                               '--use-fake-ui-for-media-stream',
                               '--use-fake-device-for-media-stream',
                               '--mute-audio'])
        if chrome and not os.environ.get('EVAL_PW_CHROMIUM'):
            launch_kw['executable_path'] = chrome
        self.ctx = pw.chromium.launch(**launch_kw).new_context()
        self.page = self.ctx.new_page()
        self.page.add_init_script(f"""
          sessionStorage.setItem('nexoraxr_display_name', '{self.pid}');
          sessionStorage.setItem('nexoraxr_participant_id', '{self.pid}');
        """)
        self.page.goto(f'{FRONT}{join_url}&nxrdbg=1{EXTRA_QS}',
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
                # DOM-level clicks bypass hit-testing — the floor/pause UI
                # overlays the toolbar and blocks real pointer clicks.
                self.page.evaluate("""(label) => {
                  const btns = [...document.querySelectorAll('button')];
                  const b = btns.find(x => x.innerText && x.innerText.includes('Language'));
                  if (b) {
                    b.click();
                    setTimeout(() => {
                      const o = [...document.querySelectorAll('button')]
                        .find(x => x.innerText && x.innerText.trim() === label);
                      if (o) o.click();
                    }, 400);
                  }
                }""", LANG_LABELS[self.lang])
            except Exception as e:
                print(f'[harness] {self.pid}: lang click retry ({e.__class__.__name__})')
            time.sleep(2)
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
        # The seek TARGET is the true resumed position. resume-actual is a
        # sanity read +1200ms later — near-segment-end resumes legitimately
        # advance to the next segment inside that window, so prefer actual
        # only when it lands within 1.5s of the target on the same segment.
        tgt, actual = r['resume'], r['actual']
        res = tgt
        if (tgt and actual and actual.get('segmentIndex') == tgt.get('segmentIndex')
                and abs((actual.get('currentTimeSec') or 0)
                        - (tgt.get('currentTimeSec') or 0)) <= 1.5):
            res = actual
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
                    holder.stdin.write('hold\n'); holder.stdin.flush()
                    try:
                        ev, _ = holder_event(holder, 'resume', timeout=40)
                    except TimeoutError:
                        print(f'[harness] n={n} rep {rep}: resume TIMEOUT')
                    time.sleep(0.8)  # resume-actual snapshot lands +1200ms
                    new_len = sum(len(c.pause_log()) for c in clients)
                    if rep % 10 == 0:
                        print(f'[harness] n={n} rep {rep} pause-log entries {new_len}')

                # Collect per-client pause/resume pairs (order-based pairing)
                # BEFORE extras — the reconnect case reloads pages, which
                # wipes window.__nxrPauseEvents.
                for c in clients:
                    for i, pr in enumerate(pair_events(c.pause_log())):
                        records.append(dict(
                            cell=f'n{n}', lang=c.lang, pid=c.pid, rep=i,
                            pause=pr['pause'], resume=pr['resume'],
                            actual=pr['actual']))

                # ---- extra cases: switch-while-paused, disconnect-reconnect
                if os.environ.get('EVAL_EXTRA', '1') == '1':
                    ex_reps = int(os.environ.get('EVAL_EXTRA_REPS', '5'))
                    switchers = [c for c in clients if c.lang != 'en'] or clients
                    for rep in range(ex_reps):
                        time.sleep(rng.uniform(1.5, 3.0))
                        holder.stdin.write('hold 20000\n'); holder.stdin.flush()
                        try:
                            holder_event(holder, 'granted', timeout=20)
                        except TimeoutError:
                            print(f'[harness] n={n} switch rep {rep}: no grant')
                            continue
                        time.sleep(0.6)
                        sw = switchers[rep % len(switchers)]
                        pre = [e for e in sw.pause_log() if e['event'] == 'pause']
                        saved = pre[-1] if pre else None
                        old_lang = sw.lang
                        sw.lang = {'ar': 'en', 'en': 'ar', 'zh': 'en'}.get(sw.lang, 'en')
                        sw.set_language(timeout=30)
                        try:
                            holder_event(holder, 'resume', timeout=45)
                        except TimeoutError:
                            print(f'[harness] n={n} switch rep {rep}: resume TIMEOUT')
                        time.sleep(1.0)
                        post = pair_events(sw.pause_log())[-1] if sw.pause_log() else {}
                        records.append(dict(
                            cell=f'n{n}-switch', lang=old_lang, pid=sw.pid, rep=rep,
                            pause=saved, resume=post.get('resume'),
                            actual=post.get('actual'), case='switch',
                            newLang=sw.lang))
                        sw.lang = old_lang
                        sw.set_language(timeout=30)
                    for rep in range(ex_reps):
                        time.sleep(rng.uniform(1.5, 3.0))
                        holder.stdin.write('hold 22000\n'); holder.stdin.flush()
                        try:
                            holder_event(holder, 'granted', timeout=20)
                        except TimeoutError:
                            continue
                        time.sleep(0.6)
                        rc = clients[rep % len(clients)]
                        pre = [e for e in rc.pause_log() if e['event'] == 'pause']
                        saved = pre[-1] if pre else None
                        try:
                            rc.page.reload(wait_until='domcontentloaded')
                        except Exception as e:
                            print(f'[harness] n={n} reconnect rep {rep}: reload {e}')
                        # Wait for the rejoined hook, then restore the
                        # language — a reload resets lectureLang to 'en'.
                        dl = time.time() + 60
                        while time.time() < dl and rc.pos() is None:
                            time.sleep(0.5)
                        if rc.lang != 'en':
                            rc.set_language(timeout=30)
                        try:
                            holder_event(holder, 'resume', timeout=45)
                        except TimeoutError:
                            print(f'[harness] n={n} reconnect rep {rep}: resume TIMEOUT')
                        time.sleep(1.0)
                        log = rc.pause_log()
                        res = next((e for e in log if e['event'] == 'resume'), None)
                        act = next((e for e in log if e['event'] == 'resume-actual'), None)
                        records.append(dict(
                            cell=f'n{n}-reconnect', lang=rc.lang, pid=rc.pid, rep=rep,
                            pause=saved, resume=res, actual=act,
                            case='reconnect'))
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
    def sents_for(lang, seg_id):
        segs = (manifests or {}).get(lang, {}).get('segments', [])
        seg = next((s for s in segs if s['id'] == seg_id), None)
        return (seg or {}).get('sentences') or []

    def expected_pos(pause, old_lang, new_lang):
        """Expected resume offset: fraction inside the paused sentence in the
        OLD language's alignment, re-grounded into the NEW language's."""
        if not pause or pause.get('segmentIndex') is None:
            return None
        si = pause.get('sentenceIndex')
        if si is None:
            return None
        s_old_list = sents_for(old_lang, pause['segmentIndex'])
        s_new_list = sents_for(new_lang, pause['segmentIndex'])
        if not s_old_list or not s_new_list:
            return None
        s_old = s_old_list[min(si, len(s_old_list) - 1)]
        s_new = s_new_list[min(si, len(s_new_list) - 1)]
        span_old = (s_old.get('end') or 0) - (s_old.get('start') or 0)
        t = pause.get('currentTimeSec') or 0
        frac = (max(0.0, min(1.0, (t - (s_old.get('start') or 0)) / span_old))
                if span_old > 0 else 0.0)
        return (s_new.get('start') or 0) + frac * (
            (s_new.get('end') or 0) - (s_new.get('start') or 0))

    rows = compute_metrics(records, durs)

    # Extra-case rows: switch (paused in lang A, resumed in lang B — expected
    # = A's sentence index + fraction re-grounded into B) and reconnect
    # (expected = the client's own pre-disconnect paused offset).
    ex_rows = []
    for r in records:
        if not r.get('case') or not r['pause'] or not (r['resume'] or r['actual']):
            continue
        res = r['actual'] if (r['actual'] and r['actual'].get('segmentIndex') is not None
                              and r['actual'].get('currentTimeSec') is not None) else r['resume']
        old_lang = r['pause'].get('lang') or 'en'
        new_lang = r.get('newLang') or old_lang
        exp = expected_pos(r['pause'], old_lang, new_lang)
        err = (abs((res.get('currentTimeSec') or 0) - exp) * 1000
               if exp is not None and res.get('segmentIndex') == r['pause'].get('segmentIndex')
               else None)
        ex_rows.append(dict(cell=r['cell'], case=r['case'], lang=r['pause'].get('lang'),
                            newLang=r.get('newLang'), ok=err is not None and err < 500,
                            err_ms=round(err, 1) if err is not None else None,
                            same_seg=res.get('segmentIndex') == r['pause'].get('segmentIndex')))
    ex_sum = {}
    for r in ex_rows:
        k = (r['cell'], r['case'])
        ex_sum.setdefault(k, []).append(r)
    ex_summary = [dict(cell=k[0], case=k[1], n=len(v),
                       ok_pct=round(100 * sum(1 for x in v if x['ok']) / len(v), 1),
                       same_seg_pct=round(100 * sum(1 for x in v if x['same_seg']) / len(v), 1))
                  for k, v in sorted(ex_sum.items())]
    csv_path = label_dir / f'summary_{LABEL}_{TS}.csv'
    with csv_path.open('w') as f:
        hdr = ['cell','lang','n','same_sentence_pct','err_p50','err_p95','err_max',
               'skipped_s','skipped_n','repeated_s','repeated_n']
        f.write(','.join(hdr) + '\n')
        for r in rows:
            f.write(','.join(str(r[h]) for h in hdr) + '\n')
    if ex_rows:
        with (label_dir / f'extras_{LABEL}_{TS}.csv').open('w') as f:
            f.write('cell,case,lang,newLang,ok,err_ms,same_seg\n')
            for r in ex_rows:
                f.write(f"{r['cell']},{r['case']},{r['lang']},{r['newLang']},"
                        f"{r['ok']},{r['err_ms']},{r['same_seg']}\n")
    print('\ncell   lang  n    same-sent%  err p50/p95/max (ms)   skipped s (n)  repeated s (n)')
    for r in rows:
        print(f"{r['cell']:5}  {r['lang']:4}  {r['n']:3}  {r['same_sentence_pct']:>9}  "
              f"{str(r['err_p50']):>7}/{str(r['err_p95']):>7}/{str(r['err_max']):>8}  "
              f"{r['skipped_s']:>7} ({r['skipped_n']})  {r['repeated_s']:>7} ({r['repeated_n']})")
    if ex_summary:
        print('\nextras: cell        case        n   ok%   same-seg%')
        for r in ex_summary:
            print(f"        {r['cell']:11} {r['case']:10} {r['n']:3}  {r['ok_pct']:>5}  {r['same_seg_pct']:>9}")
    print(f'\n[harness] records -> {out}\n[harness] summary -> {csv_path}')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'recompute':
        # Recompute metrics from existing JSONL(s) — metric logic fixes don't
        # require re-measuring.
        sys.path.insert(0, str(REPO / 'eval' / 'resume'))
        import importlib
        run = importlib.import_module('run')
        for f in sys.argv[2:]:
            recs = [json.loads(l) for l in open(f)]
            rows = run.compute_metrics(recs, {})
            print(f'\n=== {Path(f).parent.name}/{Path(f).name[:40]}')
            for r in rows:
                print(f"{r['cell']:5}  {r['lang']:4}  {r['n']:3}  {r['same_sentence_pct']:>9}  "
                      f"{str(r['err_p50']):>7}/{str(r['err_p95']):>7}/{str(r['err_max']):>8}  "
                      f"{r['skipped_s']:>7} ({r['skipped_n']})  {r['repeated_s']:>7} ({r['repeated_n']})")
    else:
        main()
