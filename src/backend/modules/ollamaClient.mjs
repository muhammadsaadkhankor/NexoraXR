const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';

export async function generate(prompt, opts = {}) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: opts.numPredict ?? 180,
        num_gpu: 0,
        ...opts.ollamaOptions,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Ollama error: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.response?.trim() || '';
}
