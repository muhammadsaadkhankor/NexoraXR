#!/usr/bin/env python3
# Drift / shared-context eval: real browsers (en/ar/zh) + optional passive
# socket pads, playing multimedia_L1 to completion under the REAL protocol.
# Measures per-segment start/end per client (drift between fastest and
# slowest), state agreement at 250ms, and commit->applied convergence.
#
#   EVAL_LABEL=drift_baseline  NXR_SEGMENT_BARRIER=0  python3 eval/drift/run.py
#   EVAL_LABEL=drift_barrier   NXR_SEGMENT_BARRIER=1  python3 eval/drift/run.py
#
# Cells: (total participants, browser clients) = (3,3) (5,3) (10,3)
# Pads are passive socket participants (never report segment-ended — under
# the barrier they honestly count as lagging clients and hit the timeout).
#
# Periodic 'hold 8000' floor exercises every ~45s inject real commits so
# convergence (emit -> applied) has data during an otherwise commit-sparse
# pure-lecture run.
import json, os, shutil, signal, subprocess, sys, time, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'resume'))
import run as H  # noqa: E402  (resume harness: env, server/vite, holder, browsers)
from playwright.sync_api import sync_playwright  # noqa: E402

LABEL = os.environ.get('EVAL_LABEL', 'drift')
OUT = os.path.join(os.path.dirname(__file__), 'results', LABEL)
os.makedirs(OUT, exist_ok=True)

PAD_SCRIPT = os.path.join(os.path.dirname(__file__), 'pad.mjs')
SAMPLE_MS = 250
HOLD_EVERY_S = 45
# Optional segment cap: stop sampling once every client's head segment
# passed MAX_SEG (bounded runs, e.g. first 4 segments only).
MAX_SEG = int(os.environ.get('EVAL_MAX_SEG', '0')) or None
CELLS = [tuple(int(x) for x in c.split(':'))
         for c in os.environ.get('EVAL_CELLS', '3:3,5:3,10:3').split(',')]
# (total participants, browser clients)


def start_pad(room, pid):
    p = subprocess.Popen(
        ['node', PAD_SCRIPT, H.BASE, room, pid],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1)
    return p


def wait_lecture(clients, timeout=90):
    """All browser clients show a live lecture position."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        poss = [c.pos() for c in clients]
        if all(p and p.get('segmentIndex') is not None
               and not p.get('paused') for p in poss):
            return poss
        time.sleep(0.5)
    return [c.pos() for c in clients]


def pct(vals, q):
    if not vals: return None
    vals = sorted(vals)
    return vals[min(len(vals) - 1, max(0, int(len(vals) * q + 0.999) - 1))]


def seg_index_of(msg_id):
    if not msg_id: return None
    i = msg_id.rfind('_seg_')
    if i < 0: return None
    try: return int(msg_id[i + 5:])
    except Exception: return None


def seg_timeline(events):
    """__nxrSegEvents -> ordered [(segIdx, start_ms, end_ms)] — end = next
    transition (or end of recording)."""
    out = []
    for e in events:
        if e.get('ev') != 'head-change': continue
        if out and out[-1][2] is None:
            out[-1][2] = e['t']
        idx = seg_index_of(e.get('to'))
        if idx is not None:
            out.append([idx, e['t'], None])
    return out


def run_cell(pw, total, n_br, seed):
    print(f'[drift] cell total={total} browsers={n_br} — starting eval server')
    cell_start_ms = int(time.time() * 1000)
    server = H.start_server()
    pads, clients = [], []
    try:
        room_meta = H.lecture_room()
        room = room_meta['roomId']
        print(f"[drift] room {room} ({room_meta.get('className')})")
        pads = [start_pad(room, f'pad-{i}') for i in range(total - n_br)]

        langs = ['en', 'ar', 'zh'][:n_br]
        for i, lang in enumerate(langs):
            c = H.BrowserClient(pw, room_meta['joinUrl'], lang, i)
            clients.append(c)
        # hooks installed
        deadline = time.time() + 40
        while time.time() < deadline:
            if all(c.pos() is not None for c in clients):
                break
            time.sleep(0.3)
        if n_br > 1:
            time.sleep(1)
        holder = H.start_holder(room)
        try:
            H.holder_event(holder, 'joined', timeout=30)
        except TimeoutError:
            print('[drift] holder never joined')
            return None
        holder.stdin.write('start\n'); holder.stdin.flush()
        print(f'[drift] waiting for lecture on {n_br} browsers')
        poss = wait_lecture(clients)
        if any(not p or p.get('segmentIndex') is None for p in poss):
            print(f'[drift] lecture did not start: {poss}')
            return None

        samples, last_hold = [], time.time()
        idle_streak = 0
        deadline = time.time() + 30 * 60
        while time.time() < deadline:
            row = {}
            for c in clients:
                try:
                    row[c.pid] = c.page.evaluate(
                        '() => window.__nxrState ? window.__nxrState() : null')
                except Exception:
                    row[c.pid] = None
            samples.append({'t': int(time.time() * 1000), 'st': row})
            live = [s for s in row.values() if s]
            if MAX_SEG is not None and live and all(
                    (s.get('segIndex') is None or s['segIndex'] > MAX_SEG)
                    for s in live):
                break
            if live and all(s.get('seg') is None and
                            s.get('status') in ('IDLE', None) for s in live):
                idle_streak += 1
                if idle_streak >= 20:  # ~5s fully idle => lecture over
                    break
            else:
                idle_streak = 0
            # periodic floor exercise => real commits for convergence
            if time.time() - last_hold > HOLD_EVERY_S:
                last_hold = time.time()
                try:
                    holder.stdin.write('hold 8000\n'); holder.stdin.flush()
                except Exception:
                    pass
            time.sleep(SAMPLE_MS / 1000)

        # per-client logs
        seg_evs, applied = {}, {}
        for c in clients:
            try:
                seg_evs[c.pid] = c.page.evaluate(
                    '() => window.__nxrSegEvents || []')
                applied[c.pid] = c.page.evaluate(
                    '() => window.__nxrApplied || []')
            except Exception:
                seg_evs[c.pid], applied[c.pid] = [], []

        return {'samples': samples, 'segEvents': seg_evs,
                'applied': applied, 'langs': langs,
                'cell_start_ms': cell_start_ms}
    finally:
        for p in pads:
            try: p.kill()
            except Exception: pass
        if clients:
            for c in clients:
                try: c.close()
                except Exception: pass
        server.terminate()
        try: server.wait(timeout=10)
        except Exception: server.kill()
        time.sleep(1)


def analyze(cell_key, cell, trace):
    clients = cell['segEvents']
    timelines = {pid: seg_timeline(evs) for pid, evs in clients.items()}
    # close open segment ends at the last sample time
    end_t = cell['samples'][-1]['t'] if cell['samples'] else 0
    for tl in timelines.values():
        if tl and tl[-1][2] is None: tl[-1][2] = end_t

    # --- per-segment lag (fastest vs slowest end)
    all_idx = sorted({i for tl in timelines.values() for i, _, _ in tl})
    lag_rows, max_lag = [], 0.0
    for idx in all_idx:
        ends = [t[2] for tl in timelines.values()
                for t in tl if t[0] == idx]
        if len(ends) < 2: continue
        lag = (max(ends) - min(ends)) / 1000.0
        lag_rows.append({'seg': idx, 'lag_s': round(lag, 2)})
        max_lag = max(max_lag, lag)

    # --- position spread (segments) at each sample
    seg_spread = 0
    for s in cell['samples']:
        idxs = [v['segIndex'] for v in s['st'].values()
                if v and v.get('segIndex') is not None]
        if len(idxs) >= 2:
            seg_spread = max(seg_spread, max(idxs) - min(idxs))

    # --- state agreement: all live clients identical on
    # {v, segId, slide, status, holder}
    agree_strict = agree_state = n = 0
    for s in cell['samples']:
        sts = [v for v in s['st'].values() if v]
        if len(sts) < 2: continue
        n += 1
        sig = [(v['seg'], v['slide'], v['status'], v['holder']) for v in sts]
        if all(x == sig[0] for x in sig): agree_state += 1
        if agree_state and all(v['v'] == sts[0]['v'] for v in sts):
            pass
        if all(x == sig[0] for x in sig) and \
           all(v['v'] == sts[0]['v'] for v in sts):
            agree_strict += 1
    agreement = {'samples': n,
                 'state_pct': round(100 * agree_state / n, 1) if n else None,
                 'strict_pct': round(100 * agree_strict / n, 1) if n else None}

    # --- convergence: emit (trace) -> applied (client). Each applied record
    # matches the LATEST emit of that version before it — re-emitted versions
    # (floor-state after a disconnect) would otherwise count join latency.
    emits_by_v = {}
    for e in trace:
        v = e.get('stateVersion')
        if v is None: continue
        if str(e.get('event', '')).startswith('emit.'):
            emits_by_v.setdefault(v, []).append(e['ts_wall_ms'])
    import bisect
    lags_by_v = {}
    for pid, apps in cell['applied'].items():
        for a in apps:
            v, t = a.get('v'), a.get('t')
            ts = emits_by_v.get(v)
            if not ts: continue
            i = bisect.bisect_right(ts, t + 50)
            if i == 0: continue
            lags_by_v.setdefault(v, []).append(t - ts[i - 1])
    conv = [{'v': v, 'max_ms': max(ls), 'min_ms': min(ls)}
            for v, ls in lags_by_v.items()]
    conv_lags = [c['max_ms'] for c in conv]

    # --- barrier events
    waits = [e for e in trace if e.get('event') == 'in.barrier-wait']
    timeouts = [e for e in trace if e.get('event') == 'in.barrier-timeout']
    passes = [e for e in trace if e.get('event') == 'in.barrier-pass']

    # --- boundary wait per client: idle gap between seg end and next start
    bwait = {}
    for pid, tl in timelines.items():
        for i in range(len(tl) - 1):
            bwait.setdefault(pid, []).append((tl[i + 1][1] - tl[i][2]) / 1000.0)

    out = {
        'cell': cell_key,
        'seg_lag_max_s': round(max_lag, 2),
        'seg_spread_max': seg_spread,
        'lag_rows': lag_rows,
        'agreement': agreement,
        'convergence': {
            'commits': len(conv),
            'p50': pct(conv_lags, 0.5), 'p95': pct(conv_lags, 0.95),
            'max': max(conv_lags) if conv_lags else None,
        },
        'barrier': {'waits': len(waits), 'passes': len(passes),
                    'timeouts': len(timeouts),
                    'timeout_detail': [
                        {'unit': (e.get('payloadSummary') or {}).get('unitId'),
                         'lagging': (e.get('payloadSummary') or {}).get('lagging')}
                        for e in timeouts]},
        'boundary_wait_s': {
            pid: {'n': len(w), 'p50': pct(w, 0.5), 'p95': pct(w, 0.95),
                  'max': round(max(w), 2) if w else None}
            for pid, w in bwait.items()},
        'timelines': timelines,
    }
    return out


def main():
    print(f'[drift] label={LABEL} results -> {OUT}')
    H.start_vite()
    results = {}
    with sync_playwright() as pw:
        try:
            for total, n_br in CELLS:
                key = f'n{total}'
                cell = run_cell(pw, total, n_br, seed=42)
                if not cell:
                    continue
                with open(os.path.join(OUT, f'raw_{key}_{LABEL}.json'), 'w') as f:
                    json.dump(cell, f)
                time.sleep(2)
                # locate this cell's eval trace (the latest for this runId)
                traces = sorted(
                    (os.path.join('logs/eval', d) for d in os.listdir('logs/eval')
                     if 'drift' in d or f'{LABEL}' in d),
                    key=os.path.getmtime)
                trace = []
                if traces:
                    # Each cell's eval server truncates the shared runId
                    # file on boot — snapshot this cell's trace now.
                    shutil.copy(traces[-1],
                                os.path.join(OUT, f'trace_{key}_{LABEL}.jsonl'))
                    # The runId is shared across cells — keep only this
                    # cell's events (ts_wall_ms >= cell start).
                    for line in open(traces[-1]):
                        try:
                            e = json.loads(line)
                            if (e.get('ts_wall_ms') or 0) >= cell['cell_start_ms'] - 2000:
                                trace.append(e)
                        except Exception:
                            pass
                results[key] = analyze(key, cell, trace)
        finally:
            pass

    # Merge with any earlier partial-run summary for the same label.
    summary_path = os.path.join(OUT, f'summary_{LABEL}.json')
    if os.path.exists(summary_path):
        try:
            old = json.load(open(summary_path))
            if isinstance(old, dict):
                old.update(results)
                results = old
        except Exception:
            pass
    with open(summary_path, 'w') as f:
        json.dump(results, f, indent=2)

    print('\ncell  lag_s  spread  agree% (strict%)  conv p50/p95/max  barrier pass/timeouts')
    for k, r in results.items():
        c = r['convergence']; b = r['barrier']; a = r['agreement']
        print(f"{k:4}  {r['seg_lag_max_s']:5}  {r['seg_spread_max']:5}   "
              f"{a['state_pct']} ({a['strict_pct']})    "
              f"{c['p50']}/{c['p95']}/{c['max']}      {b['passes']}/{b['timeouts']}")
    print(f'\n[drift] summary -> {OUT}/summary_{LABEL}.json')


if __name__ == '__main__':
    main()
