import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ConversationStore } from '../src/conversations.js';

function tempDir(name) {
  const dir = path.join('/tmp/opencode', `clawbot-conversations-${process.pid}-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('ConversationStore creates, lists, switches, renames, and stores models', () => {
  const dir = tempDir('basic');
  const store = new ConversationStore({
    filePath: path.join(dir, 'conversations.json'),
    legacyPath: path.join(dir, 'session-map.json'),
  });

  const first = store.current('acct', 'u1');
  assert.equal(store.list('acct', 'u1').length, 1);
  assert.equal(store.list('acct', 'u1')[0].current, true);

  const second = store.create('acct', 'u1', '工作');
  assert.notEqual(first.id, second.id);
  assert.equal(store.list('acct', 'u1').length, 2);
  assert.equal(store.list('acct', 'u1')[1].current, true);

  assert.equal(store.switch('acct', 'u1', '1').id, first.id);
  assert.equal(store.current('acct', 'u1').id, first.id);
  assert.equal(store.switch('acct', 'u1', '工作').id, second.id);
  assert.equal(store.switch('acct', 'u1', second.id.slice(0, 12)).id, second.id);

  store.rename('acct', 'u1', '新标题');
  assert.equal(store.current('acct', 'u1').title, '新标题');

  store.setModel('acct', 'u1', { provider: 'p', model: 'm' });
  assert.deepEqual(store.current('acct', 'u1').model, { provider: 'p', model: 'm' });

  const found = store.findBySessionId(second.id);
  assert.equal(found.accountId, 'acct');
  assert.equal(found.userId, 'u1');

  const reloaded = new ConversationStore({
    filePath: path.join(dir, 'conversations.json'),
    legacyPath: path.join(dir, 'session-map.json'),
  });
  assert.equal(reloaded.list('acct', 'u1').length, 2);
  assert.equal(reloaded.current('acct', 'u1').title, '新标题');
});

test('ConversationStore migrates the old session-map file', () => {
  const dir = tempDir('migrate');
  const legacy = { 'acct\u0000u1': 'clawbot-old' };
  fs.writeFileSync(path.join(dir, 'session-map.json'), JSON.stringify(legacy));
  const store = new ConversationStore({
    filePath: path.join(dir, 'conversations.json'),
    legacyPath: path.join(dir, 'session-map.json'),
  });
  const current = store.current('acct', 'u1');
  assert.equal(current.id, 'clawbot-old');
  assert.equal(store.list('acct', 'u1').length, 1);
});
