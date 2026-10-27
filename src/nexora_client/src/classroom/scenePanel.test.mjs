// Regression guard for the "canEndLecture is not defined" crash:
// every permission/control variable referenced inside ClassroomPanel's JSX
// must be declared in its props signature AND passed by the Scene call site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'Scene.jsx'), 'utf-8');

const panelBody = SRC.slice(
  SRC.indexOf('function ClassroomPanel({'),
  SRC.indexOf('function Scene(') > 0 ? SRC.indexOf('function Scene(') : undefined);

const propsBlock = panelBody.slice(
  panelBody.indexOf('function ClassroomPanel({'), panelBody.indexOf('}) {'));

const propsDeclared = (name) =>
  new RegExp(`^\\s*${name}\\b`, 'm').test(propsBlock) || propsBlock.includes(`${name},`) || propsBlock.includes(`${name} =`);
const propsPassed = (name) => new RegExp(`<ClassroomPanel[\\s\\S]*${name}=`).test(SRC);

const PANEL_REFS = [
  'canEndLecture', 'onHostEnd', 'onHostPause', 'onHostResume',
  'isPrivateRoom', 'isRoomHost', 'professorStatus', 'pauseReason',
];

for (const name of PANEL_REFS) {
  test(`ClassroomPanel: '${name}' is declared in props and passed by Scene`, () => {
    assert.ok(propsDeclared(name), `'${name}' missing from ClassroomPanel props signature`);
    assert.ok(propsPassed(name), `'${name}' not passed into <ClassroomPanel>`);
  });
}

test('Scene defines canEndLecture from room-owner or SUPER_ADMIN (not room type)', () => {
  assert.match(SRC, /const canEndLecture\s*=\s*isRoomOwner\s*\|\|\s*selfInfo\?\.user\?\.role\s*===\s*'SUPER_ADMIN'/);
});

test('End control is gated on canEndLecture, not on isPrivateRoom alone', () => {
  const endBlock = panelBody.slice(panelBody.indexOf('{canEndLecture &&'),
    panelBody.indexOf('{canEndLecture &&') + 400);
  assert.match(endBlock, /canEndLecture &&/);
  assert.match(endBlock, /onClick=.*onHostEnd/s);
});
