// Shared bake/repair counters — build status, the repair job and the
// final report all read from this single in-process store.
const counters = {
  translationRetries: 0,      // rejected translation attempts (normal model)
  translationStrongModel: 0,  // segments rescued by the qwen3:8b fallback
  ttsSentenceSplits: 0,       // segments synthesized sentence-by-sentence
};

export const bakeStats = counters;
export const resetBakeStats = () => { for (const k of Object.keys(counters)) counters[k] = 0; };
export const bakeStatsSnapshot = () => ({ ...counters });
