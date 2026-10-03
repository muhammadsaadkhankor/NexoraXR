#!/usr/bin/env python3
# VoxCPM2 TTS service — drop-in replacement for the CosyVoice FastAPI server.
# Mirrors the contract used by src/backend/modules/cosyVoiceClient.mjs:
#   GET  /health
#   GET  /voices            -> [{voice_id}, ...]
#   POST /register_voice    -> {voice_id, prompt_text}
#   POST /synthesize        -> StreamingResponse of raw PCM16 @ 24kHz mono
#
# VoxCPM2 generates float32 audio at 48kHz; we decimate to 24kHz int16 so the
# Node backend's existing pcm16ToWav(24000) pipeline works unchanged.
#
# Run:  python voxcpm_server.py --port 5001
# Requires the 'voxcpm' conda env (torch + voxcpm installed).

import argparse
import asyncio
import json
import logging
import os
import shutil
import uuid

import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from scipy.signal import resample_poly

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT_DIR, 'voxcpm_data')
REGISTRY_DIR = os.path.join(DATA_DIR, 'voices')
REGISTRY_FILE = os.path.join(DATA_DIR, 'voice_registry.json')
os.makedirs(REGISTRY_DIR, exist_ok=True)

OUT_SAMPLE_RATE = 24000   # what the Node backend expects
SRC_SAMPLE_RATE = 48000   # VoxCPM2 native output

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

model = None
gen_lock = asyncio.Lock()


def get_model():
    global model
    if model is None:
        from voxcpm import VoxCPM
        model_id = os.environ.get('VOXCPM_MODEL_ID', 'openbmb/VoxCPM2')
        logging.info('loading VoxCPM model %s ...', model_id)
        model = VoxCPM.from_pretrained(model_id, load_denoiser=False)
        logging.info('VoxCPM model loaded, sample_rate=%s', model.tts_model.sample_rate)
    return model


def load_registry():
    if os.path.exists(REGISTRY_FILE):
        with open(REGISTRY_FILE, 'r', encoding='utf8') as f:
            return json.load(f)
    return {}


def save_registry(registry):
    with open(REGISTRY_FILE, 'w', encoding='utf8') as f:
        json.dump(registry, f, ensure_ascii=False, indent=2)


@app.get('/health')
async def health():
    return {'status': 'ok', 'model_loaded': model is not None}


@app.get('/voices')
async def list_voices():
    registry = load_registry()
    return [{'voice_id': vid, 'prompt_text': info.get('prompt_text', '')}
            for vid, info in registry.items()]


@app.post('/register_voice')
async def register_voice(
        prompt_wav: UploadFile = File(),
        voice_id: str = Form(''),
        prompt_text: str = Form('')):
    if not voice_id:
        voice_id = str(uuid.uuid4())[:8]
    registry = load_registry()
    if voice_id in registry:
        return JSONResponse(status_code=400, content={'error': 'voice_id already exists'})
    voice_dir = os.path.join(REGISTRY_DIR, voice_id)
    os.makedirs(voice_dir, exist_ok=True)
    wav_path = os.path.join(voice_dir, 'prompt.wav')
    with open(wav_path, 'wb') as f:
        shutil.copyfileobj(prompt_wav.file, f)
    registry[voice_id] = {'prompt_wav': wav_path, 'prompt_text': prompt_text}
    save_registry(registry)
    logging.info('registered voice %s (%s)', voice_id, wav_path)
    return {'voice_id': voice_id, 'prompt_text': prompt_text}


def generate_pcm16(text: str, ref_wav: str | None, prompt_text: str | None):
    """Yield PCM16 mono @24kHz chunks from VoxCPM2's 48kHz stream."""
    m = get_model()
    kwargs = {}
    if ref_wav:
        # VoxCPM2 isolated reference channel — no transcript required.
        kwargs['reference_wav_path'] = ref_wav
    for chunk in m.generate_streaming(text=text, **kwargs):
        pcm_f32 = np.asarray(chunk, dtype=np.float32)
        if pcm_f32.ndim > 1:
            pcm_f32 = pcm_f32.mean(axis=-1)
        # 48kHz -> 24kHz decimation, then float32 -> int16
        pcm_f32 = resample_poly(pcm_f32, OUT_SAMPLE_RATE, SRC_SAMPLE_RATE)
        pcm16 = np.clip(pcm_f32, -1.0, 1.0)
        yield (pcm16 * 32767).astype(np.int16).tobytes()


@app.post('/synthesize')
async def synthesize(
        tts_text: str = Form(),
        voice_id: str = Form(''),
        speed: float = Form(1.0),
        stream: bool = Form(False)):
    registry = load_registry()
    info = registry.get(voice_id) if voice_id else None
    ref_wav = info['prompt_wav'] if info and os.path.exists(info.get('prompt_wav', '')) else None
    prompt_text = info.get('prompt_text') or None if info else None

    if voice_id and not info:
        return JSONResponse(status_code=404, content={'error': 'voice not found'})

    def _next_chunk(gen):
        # StopIteration can't propagate through a Future — wrap with a sentinel.
        try:
            return next(gen), False
        except StopIteration:
            return None, True

    async def locked_stream():
        async with gen_lock:
            # run the blocking generator off the event loop
            loop = asyncio.get_running_loop()
            gen = generate_pcm16(tts_text, ref_wav, prompt_text)
            while True:
                chunk, done = await loop.run_in_executor(None, _next_chunk, gen)
                if done:
                    break
                yield chunk

    return StreamingResponse(locked_stream(), media_type='audio/wav')


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5001)
    parser.add_argument('--preload', action='store_true', help='load the model before serving')
    args = parser.parse_args()
    if args.preload:
        get_model()
    # Serve the primary port AND legacy 5000 (if free) so a backend started
    # without COSYVOICE_BASE_URL still reaches us (CosyVoice default).
    import socket as _socket
    def port_free(p):
        s = _socket.socket()
        try:
            s.bind(('0.0.0.0', p)); s.close(); return True
        except OSError:
            s.close(); return False
    ports = {args.port}
    if 5000 not in ports and port_free(5000):
        ports.add(5000)
    elif 5000 not in ports:
        logging.warning('port 5000 busy (CosyVoice running?) — serving only %d', args.port)
    async def main():
        await asyncio.gather(*(
            uvicorn.Server(uvicorn.Config(app, host='0.0.0.0', port=p)).serve()
            for p in ports
        ))
    asyncio.run(main())
