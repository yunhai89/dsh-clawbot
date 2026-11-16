import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { WeixinAdapter } from '../src/adapter.js';

function makeEnv(replyText = '你好，我是 DSH。') {
  let sessionListener;
  const workspaces = [];
  const makeAgent = (sessionId) => ({
    id: sessionId,
    status: 'idle',
    session: { id: sessionId },
    whenIdle: async () => {},
    followup: () => {
      queueMicrotask(() => {
        sessionListener({ id: sessionId }, {
          type: 'assistant/message',
          data: {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: replyText }],
            },
          },
        });
        sessionListener({ id: sessionId }, {
          type: 'turn/end',
          data: { reason: 'completed' },
        });
      });
    },
    cancel: () => {},
  });
  const ctx = {
    on(name, listener) {
      if (name === 'session/event') sessionListener = listener;
      return () => {};
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) };
      }
      if (name === 'agentPresets') {
        return {
          resolve: async () => ({ id: 'standard' }),
          acquireScope: async () => ({ [Symbol.asyncDispose]: async () => {} }),
          mount: async () => {},
        };
      }
      if (name === 'permissionPresets') return { set: () => {} };
      if (name === 'sessionTitle') return { rename: () => {} };
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'p', name: 'Provider' }],
          listModels: async () => [
            { id: 'm1', name: 'Model 1' },
            { id: 'm2', name: 'Model 2' },
          ],
          resolveModelInfo: async () => ({ provider: 'p', model: 'm1' }),
        };
      }
      if (name === 'workspaceRegistry') {
        return {
          list: () => workspaces,
          create: async (workspacePath, title) => {
            let workspace = workspaces.find((item) => item.path === workspacePath);
            if (!workspace) {
              workspace = {
                id: workspacePath,
                path: workspacePath,
                title: title || workspacePath.split('/').pop(),
                sessionIds: [],
                setTitle: async (value) => {
                  workspace.title = value;
                },
              };
              workspaces.push(workspace);
            }
            return workspace;
          },
        };
      }
      if (name === 'workingDirectory') {
        return {
          get: () => undefined,
          set: async () => {},
        };
      }
      return undefined;
    },
    agents: {
      get: () => undefined,
      resume: async ({ resumeSessionId }) => {
        const agent = makeAgent(resumeSessionId);
        return { agent, dispose: async () => {} };
      },
      create: async ({ sessionId }) => {
        const agent = makeAgent(sessionId);
        return { agent, dispose: async () => {} };
      },
    },
  };
  const transport = {
    start: async () => {},
    stop: async () => {},
    send: async () => ({ messageId: 'm1' }),
  };
  return { ctx, transport };
}

test('A adapter creates a DSH agent and returns the final assistant text', async () => {
  const env = makeEnv();
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard', permissionPreset: 'workspace-write' },
    transport: env.transport,
    stateDir: `/tmp/opencode/clawbot-adapter-test-${process.pid}`,
    workspace: `/tmp/opencode/clawbot-adapter-test-${process.pid}/workspace`,
    log: () => {},
  });
  await adapter.start();

  const reply = await adapter.handleInbound({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    messageId: 'm1',
    text: '你好',
  });
  assert.deepEqual(reply, { text: '你好，我是 DSH。' });

  const status = adapter.status();
  assert.equal(status.sessions.length, 1);
  assert.equal(status.sessions[0].status, 'idle');

  await adapter.stop();
});

test('A adapter forwards an approval prompt and accepts /approve', async () => {
  const sent = [];
  const env = makeEnv();
  env.transport.send = async (message) => {
    sent.push(message);
    return { messageId: 'approval-1' };
  };
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard' },
    transport: env.transport,
    stateDir: `/tmp/opencode/clawbot-adapter-test-${process.pid}`,
    workspace: `/tmp/opencode/clawbot-adapter-test-${process.pid}/workspace`,
    log: () => {},
  });
  await adapter.start();
  adapter.agents.set('s1', {
    sessionId: 's1',
    accountId: 'acct',
    userId: 'u1@im.wechat',
    agent: { id: 's1', status: 'running', session: { id: 's1' } },
    handle: null,
  });

  const outcome = adapter.onApprovalRequest(
    { agent: { id: 's1' }, toolName: 'bash', reason: 'run tests' },
    async () => 'unavailable',
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /bash/);

  const reply = await adapter.handleInbound({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    messageId: 'm3',
    text: '/approve',
  });
  assert.deepEqual(reply, { text: '已允许这一次操作。' });
  assert.equal(await outcome, 'allowed-once');
  await adapter.stop();
});

test('A adapter lists, switches, titles, and selects models for conversations', async () => {
  const env = makeEnv();
  const stateDir = `/tmp/opencode/clawbot-adapter-commands-${process.pid}`;
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard' },
    transport: env.transport,
    stateDir,
    workspace: `${stateDir}/workspace`,
    log: () => {},
  });
  await adapter.start();

  const base = { accountId: 'acct', userId: 'u1@im.wechat' };
  const run = (text) => adapter.handleInbound({ ...base, messageId: text, text });

  const created = await run('/new 工作');
  assert.match(created.text, /工作/);

  const list = await run('/list');
  assert.match(list.text, /会话 1/);
  assert.match(list.text, /工作/);

  const used = await run('/use 1');
  assert.match(used.text, /已进入会话 #1/);

  const renamed = await run('/title 新标题');
  assert.match(renamed.text, /新标题/);

  const models = await run('/model');
  assert.match(models.text, /p\/m1/);
  assert.match(models.text, /p\/m2/);

  const switched = await run('/model 2');
  assert.match(switched.text, /p\/m2/);

  const status = await run('/status');
  assert.match(status.text, /新标题/);
  assert.match(status.text, /p\/m2/);

  await adapter.stop();
});

test('A adapter creates and switches workspaces, and /new inherits the workspace', async () => {
  const env = makeEnv();
  const stateDir = `/tmp/opencode/clawbot-adapter-workspaces-${process.pid}`;
  const workspacePath = `${stateDir}/project-a`;
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard' },
    transport: env.transport,
    stateDir,
    workspace: `${stateDir}/default-workspace`,
    log: () => {},
  });
  await adapter.start();

  const base = { accountId: 'acct', userId: 'u1@im.wechat' };
  const run = (text) => adapter.handleInbound({ ...base, messageId: text, text });

  const created = await run(`/workspace new ${workspacePath} 项目A`);
  assert.match(created.text, /项目A/);
  assert.match(created.text, new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const here = await run('/workspace here');
  assert.match(here.text, new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const newConversation = await run('/new 新话题');
  assert.match(newConversation.text, /新话题/);
  const hereAfterNew = await run('/workspace here');
  assert.match(hereAfterNew.text, new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const list = await run('/list');
  assert.match(list.text, /项目A/);
  assert.match(list.text, /新话题/);

  await adapter.stop();
});

test('workspaceRoots rejects paths outside the configured roots before mkdir', async () => {
  const env = makeEnv();
  const stateDir = `/tmp/opencode/clawbot-adapter-roots-${process.pid}`;
  const outside = `/tmp/opencode/clawbot-outside-${process.pid}`;
  fs.rmSync(outside, { recursive: true, force: true });
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard', workspaceRoots: [stateDir] },
    transport: env.transport,
    stateDir,
    workspace: stateDir,
    log: () => {},
  });
  await adapter.start();
  const reply = await adapter.handleInbound({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    messageId: 'roots',
    text: `/workspace new ${outside} outside`,
  });
  assert.match(reply.text, /workspaceRoots/);
  assert.equal(fs.existsSync(outside), false);
  await adapter.stop();
});

test('large inbound files stream into attachments instead of buffering', async () => {
  const env = makeEnv();
  const dir = `/tmp/opencode/clawbot-adapter-stream-${process.pid}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'big.bin');
  fs.writeFileSync(filePath, Buffer.alloc(3 * 1024 * 1024, 1));

  let streamCalls = 0;
  const attachments = {
    saveFileStream: async ({ data, name }) => {
      streamCalls += 1;
      let bytes = 0;
      for await (const chunk of data) bytes += chunk.length;
      return { attachmentId: 'streamed', name, bytes };
    },
    saveFile: async ({ name }) => ({ attachmentId: 'buffered', name, bytes: 0 }),
  };
  const originalGet = env.ctx.get.bind(env.ctx);
  env.ctx.get = (name) => (name === 'attachments' ? attachments : originalGet(name));

  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: {},
    transport: env.transport,
    stateDir: dir,
    workspace: dir,
    log: () => {},
  });
  const content = await adapter.buildContent({
    media: [{ kind: 'file', path: filePath, mime: 'application/octet-stream', name: 'big.bin' }],
  });
  assert.equal(streamCalls, 1);
  assert.ok(content.some((part) => part.type === 'file' && part.attachment.attachmentId === 'streamed'));
});

test('approval prompts include tool arguments and redact secrets', async () => {
  const sent = [];
  const env = makeEnv();
  env.transport.send = async (message) => {
    sent.push(message);
    return { messageId: 'approval-args' };
  };
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard' },
    transport: env.transport,
    stateDir: `/tmp/opencode/clawbot-adapter-approval-${process.pid}`,
    workspace: `/tmp/opencode/clawbot-adapter-approval-${process.pid}/workspace`,
    log: () => {},
  });
  await adapter.start();
  adapter.agents.set('s1', {
    sessionId: 's1',
    accountId: 'acct',
    userId: 'u1@im.wechat',
    agent: { id: 's1', status: 'running', session: { id: 's1' } },
    handle: null,
  });
  adapter.onSessionEvent(
    { id: 's1' },
    {
      type: 'tool/call',
      data: {
        callId: 'c1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'API_KEY=super-secret npm test' }),
      },
    },
  );

  const outcome = adapter.onApprovalRequest(
    { agent: { id: 's1' }, toolName: 'bash', callId: 'c1', reason: 'run tests' },
    async () => 'unavailable',
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /npm test/);
  assert.match(sent[0].text, /\*\*\*/);
  assert.doesNotMatch(sent[0].text, /super-secret/);

  await adapter.handleInbound({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    messageId: 'approval-args-1',
    text: '/reject',
  });
  assert.equal(await outcome, 'rejected');
  await adapter.stop();
});

test('subagent approvals route to the owning WeChat conversation', async () => {
  const sent = [];
  const env = makeEnv();
  env.transport.send = async (message) => {
    sent.push(message);
    return { messageId: 'approval-child' };
  };
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard' },
    transport: env.transport,
    stateDir: `/tmp/opencode/clawbot-adapter-approval-child-${process.pid}`,
    workspace: `/tmp/opencode/clawbot-adapter-approval-child-${process.pid}/workspace`,
    log: () => {},
  });
  await adapter.start();
  adapter.agents.set('root', {
    sessionId: 'root',
    accountId: 'acct',
    userId: 'u1@im.wechat',
    agent: { id: 'root', status: 'running', session: { id: 'root' } },
    conversation: { title: '主会话' },
    handle: null,
  });
  const childSession = {
    id: 'child',
    header: { parentSession: 'root' },
  };
  adapter.onSessionEvent(childSession, {
    type: 'tool/call',
    data: { callId: 'c-child', name: 'bash', arguments: '{"command":"make test"}' },
  });

  const outcome = adapter.onApprovalRequest(
    { agent: { id: 'child', session: childSession }, toolName: 'bash', callId: 'c-child' },
    async () => 'unavailable',
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /子 Agent/);
  assert.match(sent[0].text, /make test/);

  await adapter.handleInbound({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    messageId: 'approval-child-1',
    text: '/reject',
  });
  assert.equal(await outcome, 'rejected');
  await adapter.stop();
});

test('approval requests are queued per chat instead of failing the second request', async () => {
  const sent = [];
  const env = makeEnv();
  env.transport.send = async (message) => {
    sent.push(message);
    return { messageId: 'approval-queue' };
  };
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard' },
    transport: env.transport,
    stateDir: `/tmp/opencode/clawbot-adapter-approval-queue-${process.pid}`,
    workspace: `/tmp/opencode/clawbot-adapter-approval-queue-${process.pid}/workspace`,
    log: () => {},
  });
  await adapter.start();
  adapter.agents.set('s1', {
    sessionId: 's1',
    accountId: 'acct',
    userId: 'u1@im.wechat',
    agent: { id: 's1', status: 'running', session: { id: 's1' } },
    handle: null,
  });

  const first = adapter.onApprovalRequest(
    { agent: { id: 's1' }, toolName: 'bash', reason: 'first' },
    async () => 'unavailable',
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = adapter.onApprovalRequest(
    { agent: { id: 's1' }, toolName: 'bash', reason: 'second' },
    async () => 'unavailable',
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.filter((message) => message.text.includes('【DSH 权限申请】')).length, 1);

  await adapter.handleInbound({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    messageId: 'approval-queue-1',
    text: '/approve',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.filter((message) => message.text.includes('【DSH 权限申请】')).length, 2);

  await adapter.handleInbound({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    messageId: 'approval-queue-2',
    text: '/reject',
  });
  assert.equal(await first, 'allowed-once');
  assert.equal(await second, 'rejected');
  await adapter.stop();
});

test('A adapter handles /whoami without creating an agent', async () => {
  const env = makeEnv();
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard' },
    transport: env.transport,
    stateDir: `/tmp/opencode/clawbot-adapter-test-${process.pid}`,
    workspace: `/tmp/opencode/clawbot-adapter-test-${process.pid}/workspace`,
    log: () => {},
  });
  await adapter.start();
  const reply = await adapter.handleInbound({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    messageId: 'm2',
    text: '/whoami',
  });
  assert.match(reply.text, /acct/);
  assert.match(reply.text, /u1@im\.wechat/);
  await adapter.stop();
});
