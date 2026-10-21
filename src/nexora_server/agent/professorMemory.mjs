// ProfessorMemory — simple room/lecture-scoped session memory (V2.3).
// Plain object + pure helper functions. No persistence, no DB, no RAG.
// The server/orchestrator owns writes; ProfessorAgent receives it read-only.

const MAX_QUESTIONS = 50;

export function createProfessorMemory(lectureId) {
  return {
    lectureId,
    topicsTaught: [],
    questions: [],
    reexplainedTopics: [],
    clarificationCountByTopic: {},
    lastInteraction: null,
  };
}

export function resetProfessorMemory(lectureId) {
  return createProfessorMemory(lectureId);
}

export function recordTopicTaught(memory, topicId) {
  if (!memory || !topicId) return memory;
  if (!memory.topicsTaught.includes(topicId)) memory.topicsTaught.push(topicId);
  memory.lastInteraction = { type: 'topic_taught', topicId, timestamp: Date.now() };
  return memory;
}

export function recordQuestion(memory, { participantId, topicId, segmentId, question, answer, timestamp }) {
  if (!memory) return memory;
  memory.questions.push({
    participantId: participantId ?? null,
    topicId: topicId ?? null,
    segmentId: segmentId ?? null,
    question: typeof question === 'string' ? question.slice(0, 500) : '',
    answer: typeof answer === 'string' ? answer.slice(0, 2000) : '',
    timestamp: timestamp ?? Date.now(),
  });
  while (memory.questions.length > MAX_QUESTIONS) memory.questions.shift();
  memory.lastInteraction = {
    type: 'question_answered',
    topicId: topicId ?? null,
    segmentId: segmentId ?? null,
    question: typeof question === 'string' ? question.slice(0, 500) : '',
    timestamp: timestamp ?? Date.now(),
  };
  return memory;
}

export function incrementClarification(memory, topicId) {
  if (!memory || !topicId) return memory;
  memory.clarificationCountByTopic[topicId] =
    (memory.clarificationCountByTopic[topicId] || 0) + 1;
  return memory;
}

export function recordReexplanation(memory, topicId) {
  if (!memory || !topicId) return memory;
  if (!memory.reexplainedTopics.includes(topicId)) memory.reexplainedTopics.push(topicId);
  memory.lastInteraction = { type: 'reexplanation', topicId, timestamp: Date.now() };
  return memory;
}

export function getTopicClarificationCount(memory, topicId) {
  return memory?.clarificationCountByTopic?.[topicId] || 0;
}

export function hasTopicBeenReexplained(memory, topicId) {
  return !!memory?.reexplainedTopics?.includes(topicId);
}

// Compact, safe summary — small enough to embed in logs/debug payloads.
export function getProfessorMemorySummary(memory) {
  if (!memory) return null;
  return {
    lectureId: memory.lectureId,
    topicsTaughtCount: memory.topicsTaught.length,
    topicsTaught: [...memory.topicsTaught],
    questionCount: memory.questions.length,
    clarificationCountByTopic: { ...memory.clarificationCountByTopic },
    reexplainedTopics: [...memory.reexplainedTopics],
    lastInteractionType: memory.lastInteraction?.type ?? null,
  };
}
