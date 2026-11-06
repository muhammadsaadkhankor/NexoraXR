# Persistent Whisper language-detection service. Runs inside the `voxcpm`
# conda env; loads the model ONCE and answers JSON-line requests on stdin
# so per-clip detection no longer pays the model-load cost every time.
#
# Protocol (newline-delimited JSON):
#   <- {"id": 3, "path": "/tmp/clip.wav", "window": 3.0}
#   -> {"id": 3, "langs": ["ar", "ar", "ar"]}
#   -> {"id": 3, "error": "..."}
# Prints "ready" on stdout once the model is loaded.
import sys
import os
import json
import warnings

warnings.filterwarnings('ignore')
import whisper  # noqa: E402

MODEL = sys.argv[1] if len(sys.argv) > 1 else 'base'
SR = 16000


def detect(path, window_sec):
    audio = whisper.load_audio(path)
    win = int(float(window_sec) * SR)
    langs = []
    for i in range(0, len(audio), win):
        chunk = audio[i:i + win]
        if len(chunk) < SR:  # skip <1s tail — too short to judge reliably
            break
        # Encoder-only language classification on the mel of the
        # 30s-padded window — ~10x cheaper than transcribe().
        mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(chunk)).to(m.device)
        _, probs = m.detect_language(mel)
        best = max(probs, key=probs.get)
        # Confidence matters: a 0.48 'pl' guess on a short intro window is
        # detector noise, not real drift — the caller decides per-window.
        langs.append({'lang': best, 'prob': round(float(probs[best]), 3)})
    return langs or [{'lang': 'unknown', 'prob': 1.0}]


def transcribe_lang(path):
    return [m.transcribe(path)['language']]


def pick_device():
    # GPU only when there is real headroom — the CUDA context alone costs
    # ~4-5 GiB, and a failed allocation by ANOTHER process (VoxCPM, Ollama)
    # kills that process. Override with WHISPER_DEVICE=cuda|cpu.
    forced = os.environ.get('WHISPER_DEVICE')
    if forced:
        return forced
    try:
        import torch
        if not torch.cuda.is_available():
            return 'cpu'
        free, _total = torch.cuda.mem_get_info()
        return 'cuda' if free > 7 * (1024**3) else 'cpu'
    except Exception:
        return 'cpu'


def main():
    global m
    m = whisper.load_model(MODEL, device=pick_device())
    device = next(m.parameters()).device.type
    print(f'ready {device}', flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            if req.get('mode') == 'transcribe':
                langs = transcribe_lang(req['path'])
            else:
                langs = detect(req['path'], req.get('window', 3.0))
            print(json.dumps({'id': req.get('id'), 'langs': langs}), flush=True)
        except Exception as e:  # keep serving — report the failure inline
            print(json.dumps({'id': req.get('id') if req else None,
                              'error': str(e)[:300]}), flush=True)


if __name__ == '__main__':
    main()
