// Tiny clarification classifier for the re-explain policy. Runs OUTSIDE
// ProfessorAgent.decide (which stays pure) — the orchestrator calls this when
// a floor question is answered, stores the flag on the interaction, and the
// deterministic decide() reads it.
//
// Output contract: { needsReexplanation: boolean, reason: string }
// Any failure -> needsReexamination:false — continuing the lecture is always
// the safe path.
import { generate as generateOllama } from '../../nexora_ai/modules/ollamaClient.mjs';

export async function classifyClarification({ question, topicTitle, segmentText }) {
  try {
    const prompt = `You are classifying a student's question during a lecture.
Topic: ${topicTitle || 'unknown'}
Material just taught: ${(segmentText || '').slice(0, 1200)}

Student question: "${question}"

Does this question indicate the student did not understand the material and the topic should be briefly re-explained? Clarification/confusion questions (e.g. "I don't get it", "can you explain again", "what does X mean") => true. Factual extension questions, requests for new information, or off-topic questions => false.

Answer with ONLY a JSON object: {"needsReexamination": true|false, "reason": "short"}`;

    const raw = (await generateOllama(prompt, { temperature: 0, numPredict: 60 })).trim();
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) return { needsReexplanation: false, reason: 'unparseable' };
    const parsed = JSON.parse(match[0]);
    // Accept either spelling the model might emit.
    const flag = parsed.needsReexamination === true || parsed.needsReexplanation === true;
    return { needsReexplanation: flag, reason: String(parsed.reason || '').slice(0, 200) };
  } catch (err) {
    return { needsReexamination: false, needsReexplanation: false, reason: `classifier_error: ${err.message}` };
  }
}
