const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
// Translation phase may use a different model than the rest of the app.
const OLLAMA_TRANSLATE_MODEL = process.env.OLLAMA_TRANSLATE_MODEL || OLLAMA_MODEL;

export async function generate(prompt, opts = {}) {
  const model = opts.translate ? OLLAMA_TRANSLATE_MODEL : OLLAMA_MODEL;
  const options = {
    temperature: opts.temperature ?? 0.7,
    num_predict: opts.numPredict ?? 180,
    // OLLAMA_NUM_GPU unset → let Ollama pick (GPU when available).
    ...(process.env.OLLAMA_NUM_GPU != null && process.env.OLLAMA_NUM_GPU !== ''
      ? { num_gpu: Number(process.env.OLLAMA_NUM_GPU) } : {}),
    ...opts.ollamaOptions,
  };
  const body = {
    model,
    prompt,
    stream: false,
    options,
  };
  // qwen3 emits hidden reasoning unless told otherwise — translation wants
  // the direct answer only.
  if (/^qwen3/i.test(model)) body.think = false;
  // Translation keeps the model warm between segments (keep_alive "30m" is
  // the default for translation callers; anything else passes its own).
  if (opts.keepAlive != null) body.keep_alive = opts.keepAlive;
  const isChat = Array.isArray(opts.messages);
  if (isChat) {
    body.messages = opts.messages;
    delete body.prompt;
  }
  const response = await fetch(`${OLLAMA_BASE_URL}${isChat ? '/api/chat' : '/api/generate'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Ollama error: ${response.status} ${text}`);
  }

  const data = await response.json();
  return (isChat ? data.message?.content : data.response)?.trim() || '';
}

// Evict a model from memory (GPU/CPU) so a different service — VoxCPM2 TTS —
// can claim the VRAM. Call after the translation phase, before audio bake.
// Default evicts BOTH the translation model and the main model — the
// translate keep_alive (30m) otherwise keeps weights resident through the
// whole bake even after an explicit unload of the other model.
export async function unloadModel(model = null) {
  const models = model ? [model]
    : [...new Set([OLLAMA_TRANSLATE_MODEL, OLLAMA_MODEL])];
  for (const m of models) {
    try {
      await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, prompt: '', keep_alive: 0, stream: false }),
      });
    } catch { /* best-effort — an unreachable Ollama is fine here */ }
  }
}
