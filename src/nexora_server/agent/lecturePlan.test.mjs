import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLecturePlan,
  getTopicForSegment,
  getNextSegment,
  _clearPlanCache,
} from './lecturePlan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFBRAIN_DIR = path.join(__dirname, '..', '..', '..', 'profbrain', 'lectures');

const FIXTURE = 'Lecture_99999_test';
const fixtureDir = path.join(PROFBRAIN_DIR, FIXTURE);
const fixturePath = path.join(fixtureDir, 'lecture_plan.json');

function writeFixture(plan) {
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(fixturePath, JSON.stringify(plan));
}
function rmFixture() {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  _clearPlanCache();
}

const VALID = {
  lectureId: FIXTURE,
  title: 'Test Lecture',
  topics: [
    { id: 't0', title: 'Intro', segmentIds: [0], slidePages: [1] },
    { id: 't1', title: 'Body', segmentIds: [1, 2], slidePages: [5] },
    { id: 't2', title: 'End', segmentIds: [3], slidePages: [] },
  ],
};

test('valid plan loads and indexes', () => {
  writeFixture(VALID);
  const plan = getLecturePlan(FIXTURE);
  assert.equal(plan.title, 'Test Lecture');
  assert.equal(plan.topics.length, 3);
  assert.equal(getTopicForSegment(FIXTURE, 2).id, 't1');
  rmFixture();
});

test('missing plan returns null', () => {
  rmFixture();
  assert.equal(getLecturePlan('Lecture_does_not_exist'), null);
  assert.equal(getTopicForSegment('Lecture_does_not_exist', 0), null);
});

test('malformed JSON throws clearly', () => {
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(fixturePath, '{not json');
  assert.throws(() => getLecturePlan(FIXTURE), /not valid JSON/);
  rmFixture();
});

test('malformed schema throws clearly', () => {
  writeFixture({ lectureId: FIXTURE, title: 'x', topics: 'nope' });
  assert.throws(() => getLecturePlan(FIXTURE), /invalid/);
  rmFixture();
});

test('duplicate segment ids rejected', () => {
  writeFixture({
    lectureId: FIXTURE,
    title: 'x',
    topics: [
      { id: 't0', title: 'a', segmentIds: [0, 1], slidePages: [] },
      { id: 't1', title: 'b', segmentIds: [1], slidePages: [] },
    ],
  });
  assert.throws(() => getLecturePlan(FIXTURE), /more than one topic/);
  rmFixture();
});

test('duplicate topic ids rejected', () => {
  writeFixture({
    lectureId: FIXTURE,
    title: 'x',
    topics: [
      { id: 't0', title: 'a', segmentIds: [0], slidePages: [] },
      { id: 't0', title: 'b', segmentIds: [1], slidePages: [] },
    ],
  });
  assert.throws(() => getLecturePlan(FIXTURE), /duplicate topic id/);
  rmFixture();
});

test('unknown segment lookup is safe', () => {
  writeFixture(VALID);
  assert.equal(getTopicForSegment(FIXTURE, 99), null);
  rmFixture();
});

test('getNextSegment walks plan order', () => {
  writeFixture(VALID);
  const plan = getLecturePlan(FIXTURE);
  assert.equal(getNextSegment(plan, null), 0);
  assert.equal(getNextSegment(plan, 0), 1);
  assert.equal(getNextSegment(plan, 2), 3);
  assert.equal(getNextSegment(plan, 3), null); // end of plan
  assert.equal(getNextSegment(plan, 42), null); // unknown current
  assert.equal(getNextSegment(null, 0), null);
  rmFixture();
});

test('real Lecture_1 plan: 10 topics, segment->topic correct', () => {
  const plan = getLecturePlan('Lecture_1');
  assert.ok(plan, 'Lecture_1 plan should exist');
  assert.equal(plan.topics.length, 10);
  assert.equal(getTopicForSegment('Lecture_1', 0).title, 'Welcome');
  assert.equal(getTopicForSegment('Lecture_1', 8).title, 'Digital Twin');
  assert.equal(getTopicForSegment('Lecture_1', 9).title, 'Wrap-Up');
  assert.equal(getNextSegment(plan, null), 0);
  assert.equal(getNextSegment(plan, 8), 9);
  assert.equal(getNextSegment(plan, 9), null);
});
