import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, Check, Mic, Play, Volume2, Loader2, Upload, Trash2, Plus } from 'lucide-react';

const API_URL = 'http://localhost:5000';
const SAMPLE_RATE = 24000; // CosyVoice2-0.5B output sample rate

const SUPPORTED_LANGUAGES = [
  { code: '', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'yue', label: 'Cantonese' },
  { code: 'ko', label: 'Korean' },
];

const SUPPORTED_TTS_LANGUAGES = 'Chinese, English, Japanese, Cantonese, Korean';

function bufferToWave(abuffer, len) {
  const numOfChan = abuffer.numberOfChannels;
  const length = len * numOfChan * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  const channels = [];
  let pos = 0;
  let offset = 0;

  function setUint16(data) {
    view.setUint16(pos, data, true);
    pos += 2;
  }
  function setUint32(data) {
    view.setUint32(pos, data, true);
    pos += 4;
  }

  setUint32(0x46464952); // 'RIFF'
  setUint32(length - 8); // file size
  setUint32(0x45564157); // 'WAVE'
  setUint32(0x20746d66); // 'fmt '
  setUint32(16); // chunk size
  setUint16(1); // PCM
  setUint16(numOfChan);
  setUint32(abuffer.sampleRate);
  setUint32(abuffer.sampleRate * 2 * numOfChan); // bytes/sec
  setUint16(numOfChan * 2); // block align
  setUint16(16); // bits per sample
  setUint32(0x61746164); // 'data'
  setUint32(length - pos - 4); // data chunk size

  for (let i = 0; i < abuffer.numberOfChannels; i++) {
    channels.push(abuffer.getChannelData(i));
  }

  while (offset < len) {
    for (let i = 0; i < numOfChan; i++) {
      let sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      sample = Math.round(sample);
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function pcm16ToWav(pcmArrayBuffer, sampleRate) {
  const dataSize = pcmArrayBuffer.byteLength;
  const totalSize = 44 + dataSize;
  const wavBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(wavBuffer);
  let pos = 0;

  const setUint32 = (v) => {
    view.setUint32(pos, v, true);
    pos += 4;
  };
  const setUint16 = (v) => {
    view.setUint16(pos, v, true);
    pos += 2;
  };

  setUint32(0x46464952); // 'RIFF'
  setUint32(totalSize - 8); // file size
  setUint32(0x45564157); // 'WAVE'
  setUint32(0x20746d66); // 'fmt '
  setUint32(16); // chunk size
  setUint16(1); // PCM
  setUint16(1); // mono
  setUint32(sampleRate);
  setUint32(sampleRate * 2); // bytes/sec
  setUint16(2); // block align
  setUint16(16); // bits per sample
  setUint32(0x61746164); // 'data'
  setUint32(dataSize); // data size

  new Uint8Array(wavBuffer, 44).set(new Uint8Array(pcmArrayBuffer));
  return new Blob([wavBuffer], { type: 'audio/wav' });
}

function getVoiceMeta() {
  try {
    return JSON.parse(localStorage.getItem('cosyvoice_voice_meta') || '{}');
  } catch {
    return {};
  }
}

function saveVoiceMeta(meta) {
  localStorage.setItem('cosyvoice_voice_meta', JSON.stringify(meta));
}

function getApiKeys() {
  try {
    return JSON.parse(localStorage.getItem('cosyvoice_api_keys') || '[]');
  } catch {
    return [];
  }
}

function saveApiKeys(keys) {
  localStorage.setItem('cosyvoice_api_keys', JSON.stringify(keys));
}

function generateKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'cv-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function makeKeyId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36);
}

export default function SpeechSystem() {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [voiceName, setVoiceName] = useState('');
  const [manualVoiceId, setManualVoiceId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [voices, setVoices] = useState([]);
  const [voiceMeta, setVoiceMeta] = useState({});
  const [transcribeLang, setTranscribeLang] = useState('');

  const [text, setText] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('');
  const [audioUrl, setAudioUrl] = useState(null);

  const [apiKeys, setApiKeys] = useState([]);
  const [apiKeyName, setApiKeyName] = useState('');

  const [recording, setRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);

  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);

  useEffect(() => {
    setApiKeys(getApiKeys());
    fetchVoices();
    return () => {
      clearInterval(recordingTimerRef.current);
    };
  }, []);

  const fetchVoices = async () => {
    try {
      const res = await fetch(`${API_URL}/voices`);
      const data = await res.json();
      const ids = data.voices || [];
      const meta = getVoiceMeta();
      const updatedMeta = { ...meta };
      ids.forEach((id) => {
        if (!updatedMeta[id]) updatedMeta[id] = { name: id };
      });
      setVoiceMeta(updatedMeta);
      saveVoiceMeta(updatedMeta);
      setVoices(ids);
    } catch (err) {
      console.error('Failed to load voices:', err);
    }
  };

  const handleFile = (e) => {
    if (e.target.files && e.target.files[0]) {
      const f = e.target.files[0];
      setFile(f);
      setPreviewUrl(URL.createObjectURL(f));
      setTranscript('');
      setVoiceId('');
      setAudioUrl(null);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      recordingChunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const webmBlob = new Blob(recordingChunksRef.current, { type: 'audio/webm' });
        const arrayBuffer = await webmBlob.arrayBuffer();
        const tmpCtx = new AudioContext();
        const decoded = await tmpCtx.decodeAudioData(arrayBuffer);
        const offlineCtx = new OfflineAudioContext(1, Math.ceil(16000 * decoded.duration), 16000);
        const source = offlineCtx.createBufferSource();
        source.buffer = decoded;
        source.connect(offlineCtx.destination);
        source.start();
        const resampled = await offlineCtx.startRendering();
        const wavBlob = bufferToWave(resampled, resampled.length);
        const wavFile = new File([wavBlob], `recording-${Date.now()}.wav`, { type: 'audio/wav' });
        setFile(wavFile);
        setPreviewUrl(URL.createObjectURL(wavBlob));
        setRecording(false);
        clearInterval(recordingTimerRef.current);
      };
      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      setRecording(true);
      setRecordingDuration(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((d) => d + 1);
      }, 1000);
    } catch (err) {
      alert(`Microphone access failed: ${err.message}`);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && recording) {
      mediaRecorderRef.current.stop();
    }
  };

  const fetchTranscript = async () => {
    if (!file) return;
    setLoading(true);
    const form = new FormData();
    form.append('prompt_wav', file);
    if (transcribeLang) {
      form.append('language', transcribeLang);
    }
    try {
      const res = await fetch(`${API_URL}/transcribe`, { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok) {
        setTranscript(data.text || '');
      } else {
        alert(data.error || 'Transcription failed');
      }
    } catch (err) {
      alert(`Transcription failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const registerVoice = async () => {
    if (!file) return;
    if (!voiceName.trim()) {
      alert('Please enter a voice name before saving.');
      return;
    }
    setLoading(true);
    const form = new FormData();
    form.append('prompt_wav', file);
    if (manualVoiceId.trim()) {
      form.append('voice_id', manualVoiceId.trim());
    }
    if (transcript.trim()) {
      form.append('prompt_text', transcript.trim());
    }
    if (transcribeLang) {
      form.append('language', transcribeLang);
    }
    try {
      const res = await fetch(`${API_URL}/register_voice`, { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok && data.voice_id) {
        setVoiceId(data.voice_id);
        setSelectedVoice(data.voice_id);
        setTranscript(data.prompt_text || transcript);
        const meta = getVoiceMeta();
        meta[data.voice_id] = {
          name: voiceName.trim(),
          prompt_text: data.prompt_text || transcript,
          language: transcribeLang,
          createdAt: new Date().toISOString(),
        };
        saveVoiceMeta(meta);
        setVoiceMeta(meta);
        setVoices((prev) => (prev.includes(data.voice_id) ? prev : [...prev, data.voice_id]));
      } else {
        alert(data.error || 'Voice registration failed');
      }
    } catch (err) {
      alert(`Registration failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const copyVoiceId = () => {
    navigator.clipboard.writeText(voiceId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const generateSpeech = async () => {
    if (!selectedVoice || !text.trim()) return;
    setLoading(true);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }
    setAudioUrl(null);
    const form = new FormData();
    form.append('tts_text', text.trim());
    form.append('voice_id', selectedVoice);
    form.append('stream', 'false');
    try {
      const res = await fetch(`${API_URL}/synthesize`, { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Synthesis failed');
        return;
      }
      const pcm = await res.arrayBuffer();
      if (pcm.byteLength === 0) {
        alert('Synthesis returned empty audio');
        return;
      }
      const wavBlob = pcm16ToWav(pcm, SAMPLE_RATE);
      const url = URL.createObjectURL(wavBlob);
      setAudioUrl(url);
    } catch (err) {
      alert(`Synthesis failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const createApiKey = () => {
    const name = apiKeyName.trim() || 'Default key';
    const key = generateKey();
    const keys = [...apiKeys, { id: makeKeyId(), name, key, createdAt: new Date().toISOString() }];
    setApiKeys(keys);
    saveApiKeys(keys);
    setApiKeyName('');
  };

  const deleteApiKey = (id) => {
    const keys = apiKeys.filter((k) => k.id !== id);
    setApiKeys(keys);
    saveApiKeys(keys);
  };

  const copyKey = (key) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const displayName = (id) => {
    const meta = voiceMeta[id];
    return meta && meta.name ? `${meta.name} (${id})` : id;
  };

  const formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className='min-h-screen w-full bg-slate-950 text-slate-100'>
      <div className='mx-auto max-w-3xl p-6'>
        <div className='rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl'>
          <div className='mb-6 flex items-center gap-3'>
            <button
              onClick={() => navigate(-1)}
              className='flex h-10 w-10 items-center justify-center rounded-full bg-slate-800 text-slate-300 transition hover:bg-slate-700'
              title='Go back'
            >
              <ArrowLeft size={20} />
            </button>
            <h1 className='text-2xl font-bold text-cyan-400'>CosyVoice Studio</h1>
          </div>

          {/* 1. Upload or record voice */}
          <section className='space-y-4'>
            <h2 className='text-lg font-semibold text-slate-200'>1. Upload or record a voice sample</h2>

            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
              <div
                onClick={() => fileInputRef.current?.click()}
                className='cursor-pointer rounded-xl border border-dashed border-slate-600 bg-slate-900/50 p-6 text-center transition hover:border-cyan-500'
              >
                <input ref={fileInputRef} type='file' accept='audio/*' onChange={handleFile} className='hidden' />
                <Upload size={32} className='mx-auto text-slate-300' />
                <p className='mt-2 text-slate-300'>{file ? file.name : 'Click to upload audio'}</p>
              </div>

              <div className='flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-600 bg-slate-900/50 p-6 text-center'>
                {!recording ? (
                  <button
                    onClick={startRecording}
                    disabled={loading}
                    className='flex flex-col items-center justify-center gap-2 text-slate-300 transition hover:text-cyan-400'
                  >
                    <Mic size={32} />
                    <span>Record from microphone</span>
                  </button>
                ) : (
                  <div className='flex flex-col items-center gap-3'>
                    <div className='text-2xl font-mono text-red-400'>{formatTime(recordingDuration)}</div>
                    <button
                      onClick={stopRecording}
                      className='rounded-full bg-red-600 p-3 text-white transition hover:bg-red-500'
                    >
                      <Mic size={24} />
                    </button>
                    <span className='text-sm text-slate-400'>Recording... click to stop</span>
                  </div>
                )}
              </div>
            </div>

            {previewUrl && <audio src={previewUrl} controls className='w-full' />}

            <div>
              <label className='mb-1 block text-sm font-medium text-slate-400'>Transcript language (for Whisper)</label>
              <select
                value={transcribeLang}
                onChange={(e) => setTranscribeLang(e.target.value)}
                className='w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
              >
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>

            {file && (
              <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                <button
                  onClick={fetchTranscript}
                  disabled={loading}
                  className='flex items-center justify-center gap-2 rounded-xl bg-cyan-600 px-4 py-2.5 font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50'
                >
                  {loading ? <Loader2 className='animate-spin' size={18} /> : <Volume2 size={18} />}
                  Fetch transcript
                </button>

                <button
                  onClick={registerVoice}
                  disabled={loading}
                  className='flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50'
                >
                  {loading ? <Loader2 className='animate-spin' size={18} /> : <Check size={18} />}
                  Register voice
                </button>
              </div>
            )}

            {transcript && (
              <div className='rounded-xl bg-slate-800/50 p-4'>
                <p className='text-sm font-medium text-slate-400'>Transcript</p>
                <p className='mt-1 text-slate-100'>{transcript}</p>
              </div>
            )}

            {voiceId && (
              <div className='flex flex-col gap-2 rounded-xl bg-slate-800/50 p-4 sm:flex-row sm:items-center sm:justify-between'>
                <div>
                  <p className='text-sm font-medium text-slate-400'>Voice ID</p>
                  <code className='text-cyan-400'>{voiceId}</code>
                </div>
                <button
                  onClick={copyVoiceId}
                  className='flex items-center justify-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-sm text-white transition hover:bg-slate-600'
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}

            <div className='space-y-3'>
              <div>
                <label className='mb-1 block text-sm font-medium text-slate-400'>Voice name (required for saving)</label>
                <input
                  type='text'
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                  placeholder='e.g. My Voice'
                  className='w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none'
                />
              </div>

              <div>
                <label className='mb-1 block text-sm font-medium text-slate-400'>Optional custom voice ID</label>
                <input
                  type='text'
                  value={manualVoiceId}
                  onChange={(e) => setManualVoiceId(e.target.value)}
                  placeholder='auto-generated if empty'
                  className='w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none'
                />
              </div>
            </div>
          </section>

          <hr className='my-8 border-slate-800' />

          {/* 2. Generate speech */}
          <section className='space-y-4'>
            <h2 className='text-lg font-semibold text-slate-200'>2. Generate speech with a saved voice</h2>

            <div>
              <label className='mb-1 block text-sm font-medium text-slate-400'>Select voice</label>
              <select
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                className='w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
              >
                <option value=''>-- select a voice --</option>
                {voices.map((v) => (
                  <option key={v} value={v}>
                    {displayName(v)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className='mb-1 block text-sm font-medium text-slate-400'>Text to speak</label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                placeholder='Type the text you want the cloned voice to say...'
                className='w-full resize-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none'
              />
            </div>

            <div className='rounded-lg bg-slate-800/30 p-3 text-sm text-slate-400'>
              Supported languages: {SUPPORTED_TTS_LANGUAGES}
            </div>

            <button
              onClick={generateSpeech}
              disabled={loading || !selectedVoice || !text.trim()}
              className='flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-600 px-4 py-2.5 font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50'
            >
              {loading ? <Loader2 className='animate-spin' size={18} /> : <Play size={18} />}
              Generate speech
            </button>

            {audioUrl && (
              <div className='rounded-xl bg-slate-800/50 p-4'>
                <p className='mb-2 text-sm font-medium text-slate-400'>Generated audio</p>
                <audio src={audioUrl} controls className='w-full' />
              </div>
            )}
          </section>

          <hr className='my-8 border-slate-800' />

          {/* 3. API keys */}
          <section className='space-y-4'>
            <h2 className='text-lg font-semibold text-slate-200'>3. API access for external applications</h2>

            <div className='rounded-xl border border-slate-700 bg-slate-900/50 p-4'>
              <p className='text-sm text-slate-400'>
                Base URL: <code className='text-cyan-400'>{API_URL}</code>
              </p>
              <p className='mt-1 text-sm text-slate-400'>
                Send your API key in the <code className='text-cyan-400'>X-API-Key</code> header.
              </p>
            </div>

            <div className='flex gap-2'>
              <input
                type='text'
                value={apiKeyName}
                onChange={(e) => setApiKeyName(e.target.value)}
                placeholder='Key label'
                className='flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none'
              />
              <button
                onClick={createApiKey}
                disabled={loading}
                className='flex items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2 font-medium text-white transition hover:bg-cyan-500'
              >
                <Plus size={18} />
                Create key
              </button>
            </div>

            {apiKeys.length > 0 && (
              <div className='space-y-2'>
                {apiKeys.map((k) => (
                  <div
                    key={k.id}
                    className='flex flex-col gap-2 rounded-xl bg-slate-800/50 p-4 sm:flex-row sm:items-center sm:justify-between'
                  >
                    <div className='min-w-0 flex-1'>
                      <p className='text-sm font-medium text-slate-300'>{k.name}</p>
                      <code className='block truncate text-xs text-cyan-400'>{k.key}</code>
                    </div>
                    <div className='flex items-center gap-2'>
                      <button
                        onClick={() => copyKey(k.key)}
                        className='flex items-center gap-1 rounded-lg bg-slate-700 px-3 py-2 text-sm text-white transition hover:bg-slate-600'
                      >
                        {copiedKey === k.key ? <Check size={16} /> : <Copy size={16} />}
                        {copiedKey === k.key ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        onClick={() => deleteApiKey(k.id)}
                        className='rounded-lg bg-red-600/80 p-2 text-white transition hover:bg-red-600'
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {selectedVoice && apiKeys.length > 0 && (
              <div className='rounded-xl bg-slate-800/50 p-4'>
                <p className='mb-2 text-sm font-medium text-slate-400'>Example curl for speech synthesis</p>
                <pre className='overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-300'>
{`curl -X POST ${API_URL}/synthesize \\
  -H "X-API-Key: ${apiKeys[0].key}" \\
  -F "tts_text=Hello, this is my cloned voice." \\
  -F "voice_id=${selectedVoice}" \\
  --output generated.wav`}
                </pre>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
