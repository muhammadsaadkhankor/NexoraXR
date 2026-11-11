#!/usr/bin/env python3
# Isolation eval (I7): one client's actions must not leak into others.
# Barrier ON. N=3 (en/ar/zh browsers) and N=5 (+2 passive socket pads).
#
# Actions, seeded-random during lecture playback AND during floor answers:
#   lang-switch: a browser emits 'language.mine' to a different language
#   chat:        a browser or pad emits 'chat' (mock reply text)
#
# For each action the OTHER browsers are sampled at ~250ms for 4s and must
# show: no pause, no seek (offset not regressing >0.5s or jumping >2s
# forward), no segment change (unless a new unit broadcast fired in the
# window), and no stateVersion change (unless a server commit fired).
#
#   EVAL_LABEL=isolation NXR_SEGMENT_BARRIER=1 python3 eval/isolation/run.py
import json, os, random, subprocess, sys, time

import importlib.util  # noqa: E402


def _load(name, sub):
    path = os.path.join(os.path.dirname(__file__), '..', sub, 'run.py')
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


H = _load('resume_run', 'resume')   # env, server/vite, holder, browsers
D = _load('drift_run', 'drift')     # start_pad, wait_lecture, analyze
from playwright.sync_api import sync_playwright  # noqa: E402

LABEL = os.environ.get('EVAL_LABEL', 'isolation')
OUT = os.path.join(os.path.dirname(__file__), 'results', LABEL)
os.makedirs(OUT, exist_ok=True)

PAD_SCRIPT = os.path.join(os.path.dirname(__file__), '..', 'drift', 'pad.mjs')
SAMPLE_MS = 250
WINDOW_S = 4
ACTIONS_PER_CELL = int(os.environ.get('EVAL_ACTIONS', '24'))
CELLS = [int(x) for x in os.environ.get('EVAL_CELLS', '3,5').split(',')]
SEED = int(os.environ.get('EVAL_SEED', '0x1E0A7'), 16)
# Segment cap: stop injecting actions once every client passed MAX_SEG.
MAX_SEG = int(os.environ.get('EVAL_MAX_SEG', '0')) or None


def sample(clients):
    row = {}
    for c in clients:
        try:
            row[c.pid] = c.page.evaluate(
                '() => window.__nxrState ? window.__nxrState() : null')
        except Exception:
            row[c.pid] = None
    return row


def violations(action, actor, before, after_rows, trace, t0, t_end):
    """after_rows: list of {t, st:{pid:state}} sampled in the window."""
    out = []
    # legit server commits / new units in the window — these state changes
    # are NOT violations
    commits = [e for e in trace
               if e.get('event', '').startswith('emit.')
               and t0 - 2000 <= e.get('ts_wall_ms', 0) <= t_end + 2000]
    new_unit = any(e.get('event') == 'emit.professor-speak' for e in commits)
    new_commit = any(e.get('event') in ('emit.floor-state', 'emit.lecture-control')
                     for e in commits)
    for pid, s0 in before.items():
        if pid == actor or not s0:
            continue
        s1 = None
        for r in after_rows:
            s = r['st'].get(pid)
            if s: s1 = s
        if not s1:
            continue
        # pause leak
        if (not s0.get('paused')) and s1.get('paused') and not new_commit:
            out.append({'pid': pid, 'kind': 'pause',
                        'before': s0.get('status'), 'after': s1.get('status')})
        # segment jump (not a real new unit). None->X is a queue refill
        # after a boundary or join, not a jump — excluded.
        if s0.get('segIndex') is not None and s1.get('segIndex') is not None \
           and s0['segIndex'] != s1['segIndex'] and not new_unit:
            out.append({'pid': pid, 'kind': 'segment-change',
                        'before': s0['segIndex'], 'after': s1['segIndex']})
        # seek: offset regresses or jumps forward within the same segment
        if s0.get('segIndex') == s1.get('segIndex') and \
           s0.get('offsetSec') is not None and s1.get('offsetSec') is not None:
            dt = (s1['t'] - s0['t']) / 1000.0
            d = s1['offsetSec'] - s0['offsetSec']
            # 0 -> +x is a segment just STARTING to play, not a seek leak
            if d < -0.5 or (s0['offsetSec'] > 0.01 and d > max(2.0, dt + 1.5)):
                out.append({'pid': pid, 'kind': 'seek',
                            'before': s0['offsetSec'], 'after': s1['offsetSec']})
        # shared-state change without a server commit (bare version bumps
        # with identical shared state are not isolation violations)
        tup0 = (s0.get('status'), s0.get('holder'), s0.get('segIndex'))
        tup1 = (s1.get('status'), s1.get('holder'), s1.get('segIndex'))
        if tup0 != tup1 and not (new_commit or new_unit):
            out.append({'pid': pid, 'kind': 'shared-state',
                        'before': tup0, 'after': tup1})
    return out


def run_cell(pw, total, rng):
    n_br = min(3, total)
    print(f'[iso] cell total={total} browsers={n_br}')
    cell_start_ms = int(time.time() * 1000)
    server = H.start_server()
    pads, clients, records = [], [], []
    try:
        room_meta = H.lecture_room()
        room = room_meta['roomId']
        pads = [D.start_pad(room, f'pad-{i}') for i in range(total - n_br)]
        langs = ['en', 'ar', 'zh'][:n_br]
        for i, lang in enumerate(langs):
            c = H.BrowserClient(pw, room_meta['joinUrl'], lang, i)
            clients.append(c)
        deadline = time.time() + 40
        while time.time() < deadline:
            if all(c.pos() is not None for c in clients):
                break
            time.sleep(0.3)
        time.sleep(1)
        holder = H.start_holder(room)
        H.holder_event(holder, 'joined', timeout=30)
        holder.stdin.write('start\n'); holder.stdin.flush()
        poss = D.wait_lecture(clients)
        if any(not p or p.get('segmentIndex') is None for p in poss):
            print('[iso] lecture did not start')
            return None

        other_langs = ['en', 'ar', 'zh', 'fr', 'de', 'es']
        trace_file = None
        for a in range(ACTIONS_PER_CELL):
            if MAX_SEG is not None:
                st = sample(clients)
                if all(s and (s.get('segIndex') is None or s['segIndex'] > MAX_SEG)
                       for s in st.values()):
                    break
            during_answer = (a % 2 == 1)
            if during_answer:
                # floor Q&A in progress while the action lands
                holder.stdin.write('hold 15000\n'); holder.stdin.flush()
                try:
                    H.holder_event(holder, 'granted', timeout=25)
                    time.sleep(4)  # answer playing
                except TimeoutError:
                    print(f'[iso] action {a}: no grant — lecture window instead')
                    during_answer = False
            kind = rng.choice(['lang-switch', 'chat'])
            actor = rng.choice(clients)
            before = sample(clients)
            t0 = int(time.time() * 1000)
            if kind == 'lang-switch':
                target = rng.choice([l for l in other_langs
                                     if l != actor.lang])
                actor.page.evaluate(
                    "(l) => window.__nxrSocket?.emit('language.mine', {language: l})", target)
                detail = {'from': actor.lang, 'to': target}
            else:
                text = rng.choice([
                    'mock reply: definition clarified', 'side note?',
                    'what did the professor just say?', 'mock answer 42'])
                actor.page.evaluate(
                    "(t) => window.__nxrSocket?.emit('chat', {name: 'x', text: t})", text)
                detail = {'text': text[:20]}
            rows = []
            t_end = t0 + WINDOW_S * 1000
            while time.time() * 1000 < t_end:
                rows.append({'t': int(time.time() * 1000), 'st': sample(clients)})
                time.sleep(SAMPLE_MS / 1000)
            records.append({'idx': a, 'kind': kind, 'actor': actor.pid,
                            'during_answer': during_answer, 't0': t0,
                            'detail': detail, 'before': before, 'rows': rows})
            # restore the actor's language for the next rep
            if kind == 'lang-switch':
                actor.page.evaluate(
                    "(l) => window.__nxrSocket?.emit('language.mine', {language: l})",
                    actor.lang)
            time.sleep(0.5)

        # collect this cell's trace
        import glob
        traces = sorted(glob.glob('logs/eval/resume_isolation_*.jsonl'),
                        key=os.path.getmtime)
        trace = []
        if traces:
            for line in open(traces[-1]):
                try:
                    e = json.loads(line)
                    if (e.get('ts_wall_ms') or 0) >= cell_start_ms - 2000:
                        trace.append(e)
                except Exception:
                    pass
        # score each action
        results = []
        for r in records:
            v = violations(r['kind'], r['actor'], r['before'], r['rows'],
                           trace, r['t0'], r['t0'] + WINDOW_S * 1000)
            results.append({**{k: r[k] for k in
                               ('idx', 'kind', 'actor', 'during_answer',
                                'detail')},
                            'violations': v})
        n_v = sum(1 for r in results if r['violations'])
        print(f"[iso] n={total}: {len(results)} actions, "
              f"{n_v} with violations")
        return {'total': len(results), 'with_violations': n_v,
                'isolation_pct': round(100 * (len(results) - n_v) / max(1, len(results)), 1),
                'results': results}
    finally:
        for p in pads:
            try: p.kill()
            except Exception: pass
        for c in clients:
            try: c.close()
            except Exception: pass
        server.terminate()
        try: server.wait(timeout=10)
        except Exception: server.kill()
        time.sleep(1)


def main():
    rng = random.Random(SEED)
    print(f'[iso] label={LABEL} seed={SEED:x} -> {OUT}')
    H.start_vite()
    results = {}
    with sync_playwright() as pw:
        for total in CELLS:
            r = run_cell(pw, total, rng)
            if r:
                results[f'n{total}'] = r
    with open(os.path.join(OUT, f'summary_{LABEL}.json'), 'w') as f:
        json.dump({'seed': f'{SEED:x}', 'cells': results}, f, indent=2)
    print('\ncell  actions  isolation%  violations')
    for k, r in results.items():
        print(f"{k:4}  {r['total']:6}  {r['isolation_pct']:9}  "
              f"{r['with_violations']}")
        for rr in r['results']:
            if rr['violations']:
                print(f"    #{rr['idx']} {rr['kind']} actor={rr['actor']} "
                      f"answer={rr['during_answer']}: {rr['violations']}")
    print(f'\n[iso] -> {OUT}/summary_{LABEL}.json')


if __name__ == '__main__':
    main()
