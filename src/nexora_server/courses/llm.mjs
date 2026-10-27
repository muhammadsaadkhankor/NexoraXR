// LLM/embeddings for the course-builder. Provider order:
//   1. OPENAI_API_KEY set → OpenAI API (gpt-4o-mini + text-embedding-3-small)
//   2. otherwise → local Ollama (OLLAMA_BASE_URL/OLLAMA_MODEL; embeddings via
//      COURSE_EMBED_MODEL or nomic-embed-text). Direct fetch, no extra deps.

const KEY = () => process.env.OPENAI_API_KEY;
const OLLAMA = () => process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const MODEL_CHAT_OA = process.env.COURSE_LLM_MODEL || 'gpt-4o-mini';
const MODEL_EMBED_OA = process.env.COURSE_EMBED_MODEL || 'text-embedding-3-small';
// Course-builder chat model: qwen3:8b follows strict JSON schemas reliably —
// qwen2.5 drifts into schema.org envelopes on structured prompts.
const MODEL_CHAT_OL = process.env.COURSE_LLM_MODEL || 'qwen3:8b';
const MODEL_EMBED_OL = process.env.COURSE_EMBED_MODEL || 'nomic-embed-text';

export const usingOllama = () => !KEY();
export function llmConfigured() {
  return !!KEY() || !!OLLAMA(); // ollama always has a default URL; failures surface at call time
}

export async function embed(texts) {
  if (!texts.length) return [];
  if (KEY()) {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY()}` },
      body: JSON.stringify({ model: MODEL_EMBED_OA, input: texts }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`embeddings: ${d.error?.message || r.status}`);
    return d.data.map((x) => x.embedding);
  }
  const r = await fetch(`${OLLAMA()}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(Number(process.env.COURSE_EMBED_TIMEOUT_MS || 120000)),
    body: JSON.stringify({ model: MODEL_EMBED_OL, input: texts }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`ollama embeddings: ${d.error || r.status}`);
  return d.embeddings;
}

// json:true → constrained JSON output; returns parsed object.
export async function chat(messages, { json = false, maxTokens = 4000 } = {}) {
  // One transparent retry on transport blips — Ollama under GPU contention
  // occasionally drops requests mid-flight ("fetch failed").
  try {
    return await chatOnce(messages, { json, maxTokens });
  } catch (e) {
    if (!/fetch failed|timeout|ECONN|ETIMEDOUT|aborted/i.test(String(e?.message || e))) throw e;
    console.warn(`[course-llm] retrying after transport error: ${e.message}`);
    return chatOnce(messages, { json, maxTokens });
  }
}

async function chatOnce(messages, { json = false, maxTokens = 4000 } = {}) {
  if (KEY()) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY()}` },
      body: JSON.stringify({
        model: MODEL_CHAT_OA, messages, temperature: 0.4, max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`chat: ${d.error?.message || r.status}`);
    const content = d.choices?.[0]?.message?.content || '';
    return json ? JSON.parse(content) : content;
  }
  const r = await fetch(`${OLLAMA()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(Number(process.env.COURSE_LLM_TIMEOUT_MS || 480000)),
    body: JSON.stringify({
      model: MODEL_CHAT_OL, messages, stream: false, think: false,
      ...(json ? { format: 'json' } : {}),
      options: {
        temperature: 0.4, num_predict: maxTokens,
        // Big course-generation contexts need headroom — Ollama's default
        // 4096 ctx silently truncates the prompt and the model refuses.
        num_ctx: Number(process.env.COURSE_LLM_CTX || 16384),
      },
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`ollama chat: ${d.error || r.status}`);
  // Real inference telemetry for eval records — Ollama exposes per-call token
  // counts + durations; capture them on every call (no char-count guesses).
  lastUsage = {
    promptTokens: d.prompt_eval_count ?? null,
    genTokens: d.eval_count ?? null,
    loadDurationNs: d.load_duration ?? null,
    promptEvalDurationNs: d.prompt_eval_duration ?? null,
    evalDurationNs: d.eval_duration ?? null,
    totalDurationNs: d.total_duration ?? null,
  };
  const content = d.message?.content || '';
  return json ? JSON.parse(content) : content;
}

// Usage for the most recent chat() call on this connection — read after each
// call to accumulate real prompt/generated token counts.
let lastUsage = null;
export function takeLlmUsage() { const u = lastUsage; lastUsage = null; return u; }

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // both providers return unit-normed embeddings
}
