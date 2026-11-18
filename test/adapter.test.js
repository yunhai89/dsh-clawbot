import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { WeixinAdapter } from '../src/adapter.js';

function makeEnv(replyText = '你好，我是 DSH。', options = {}) {
  let sessionListener;
  const workspaces = [];
  const assistantContent =
    options.assistantContent ?? [{ type: 'text', text: replyText }];
  const reason = options.reason ?? 'completed';
  const makeAgent = (sessionId) => ({
    id: sessionId,
    status: 'idle',
    session: { id: sessionId },
    whenIdle: async () => {},
    followup: () => {
      queueMicrotask(() => {
        for (const event of options.events ?? []) {
          sessionListener({ id: sessionId }, event);
        }
        sessionListener({ id: sessionId }, {
          type: 'assistant/message',
          data: {
            message: {
              role: 'assistant',
              content: assistantContent,
            },
          },
        });
        sessionListener({ id: sessionId }, {
          type: 'turn/end',
          data: { reason },
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

function installGoalService(env) {
  let goal;
  let nextId = 0;
  const clone = () => (goal ? { ...goal } : undefined);
  const service = {
    get: () => clone(),
    create: (_agent, { objective, maxGoalRounds = 10 }) => {
      nextId += 1;
      goal = {
        id: `goal-${nextId}`,
        revision: 1,
        objective,
        phase: 'active',
        roundsStarted: 0,
        maxGoalRounds,
        activation: 'armed',
      };
      return clone();
    },
    edit: (_agent, ref, request) => {
      assert.equal(ref.revision, goal.revision);
      goal = {
        ...goal,
        revision: goal.revision + 1,
        ...(request.objective === undefined ? {} : { objective: request.objective }),
        ...(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds }),
      };
      return clone();
    },
    pause: () => {
      goal = { ...goal, revision: goal.revision + 1, phase: 'paused', activation: 'disarmed' };
      return clone();
    },
    resume: () => {
      goal = { ...goal, revision: goal.revision + 1, phase: 'active', activation: 'armed' };
      return clone();
    },
    complete: () => {
      goal = { ...goal, revision: goal.revision + 1, phase: 'complete', activation: 'disarmed' };
      return clone();
    },
    block: (_agent, _ref, reason) => {
      goal = {
        ...goal,
        revision: goal.revision + 1,
        phase: 'blocked',
        activation: 'disarmed',
        blockedReason: reason,
      };
      return clone();
    },
    clear: () => {
      const cleared = { id: goal.id, revision: goal.revision + 1 };
      goal = undefined;
      return cleared;
    },
  };
  const originalGet = env.ctx.get.bind(env.ctx);
  env.ctx.get = (name) => (name === 'goals' ? service : originalGet(name));
  return { service, state: () => goal };
}

test('A adapter creates and controls goals with the /goal command', async () => {
  const env = makeEnv();
  const { state } = installGoalService(env);
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard' },
    transport: env.transport,
    stateDir: `/tmp/opencode/clawbot-adapter-goal-${process.pid}`,
    workspace: `/tmp/opencode/clawbot-adapter-goal-${process.pid}/workspace`,
    log: () => {},
  });
  await adapter.start();

  const base = { accountId: 'acct', userId: 'u1@im.wechat' };
  const run = (text) => adapter.handleInbound({ ...base, messageId: text, text });

  const absent = await run('/goal');
  assert.match(absent.text, /当前没有目标/);

  const created = await run('/goal 修复所有失败的测试');
  assert.match(created.text, /目标已创建/);
  assert.match(created.text, /修复所有失败的测试/);
  assert.equal(state().phase, 'active');

  const shown = await run('/goal');
  assert.match(shown.text, /修复所有失败的测试/);
  assert.match(shown.text, /进行中/);

  const edited = await run('/goal edit 修复所有测试并提交');
  assert.match(edited.text, /修复所有测试并提交/);

  const rounds = await run('/goal rounds 12');
  assert.match(rounds.text, /12/);
  assert.equal(state().maxGoalRounds, 12);

  const paused = await run('/goal pause');
  assert.match(paused.text, /已暂停/);

  const resumed = await run('/goal resume');
  assert.match(resumed.text, /已恢复/);
  assert.equal(state().activation, 'armed');

  const completed = await run('/goal complete');
  assert.match(completed.text, /已完成/);

  const replacement = await run('/goal 新目标');
  assert.match(replacement.text, /目标已创建/);
  assert.match(state().objective, /新目标/);

  const cleared = await run('/goal clear');
  assert.match(cleared.text, /已清除/);
  assert.equal(state(), undefined);

  await adapter.stop();
});

test('goal rounds are delivered back to WeChat', async () => {
  const sent = [];
  const env = makeEnv();
  env.transport.send = async (message) => {
    sent.push(message);
    return { messageId: 'goal-round' };
  };
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard', goalProgress: true },
    transport: env.transport,
    stateDir: `/tmp/opencode/clawbot-adapter-goal-round-${process.pid}`,
    workspace: `/tmp/opencode/clawbot-adapter-goal-round-${process.pid}/workspace`,
    log: () => {},
  });
  await adapter.start();

  await adapter.handleInbound({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    messageId: 'goal-setup',
    text: '你好',
  });
  const sessionId = [...adapter.agents.keys()][0];
  assert.ok(sessionId);

  adapter.onSessionEvent(
    { id: sessionId },
    {
      type: 'user/message',
      data: { source: { kind: 'goal', goalId: 'g1', revision: 1, round: 3 } },
    },
  );
  adapter.onSessionEvent(
    { id: sessionId },
    {
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '第 3 轮已完成一部分。' }],
        },
      },
    },
  );
  adapter.onSessionEvent(
    { id: sessionId },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /目标 · 第 3 轮/);
  assert.match(sent[0].text, /第 3 轮已完成一部分/);
  await adapter.stop();
});

test('mid-turn model errors are reported instead of a bare tool list', async () => {
  const env = makeEnv('', {
    assistantContent: [
      { type: 'tool-call', name: 'create_goal', callId: 'c1', arguments: '{"objective":"x"}' },
      { type: 'tool-call', name: 'bash', callId: 'c2', arguments: '{"command":"ls"}' },
    ],
    reason: {
      kind: 'error',
      error: { message: 'Insufficient Balance', code: 'QUOTA', status: 402 },
    },
  });
  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard' },
    transport: env.transport,
    stateDir: `/tmp/opencode/clawbot-adapter-error-${process.pid}`,
    workspace: `/tmp/opencode/clawbot-adapter-error-${process.pid}/workspace`,
    log: () => {},
  });
  await adapter.start();

  const reply = await adapter.handleInbound({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    messageId: 'error-turn',
    text: '帮我完成目标',
  });

  assert.match(reply.text, /^本轮执行失败/);
  assert.match(reply.text, /余额不足/);
  assert.match(reply.text, /Insufficient Balance/);
  assert.match(reply.text, /QUOTA/);
  assert.match(reply.text, /HTTP 402/);
  assert.match(reply.text, /失败前调用过：create_goal, bash/);

  await adapter.stop();
});

test('A adapter sends workspace media, voice files, and present deliverables', async () => {
  const sent = [];
  const env = makeEnv('报告已生成。', {
    events: [
      {
        type: 'deliverables/presented',
        data: { files: [{ path: 'report.pdf', description: '测试报告' }] },
      },
    ],
  });
  env.transport.send = async (message) => {
    sent.push(message);
    return { messageId: `media-${sent.length}` };
  };
  const stateDir = `/tmp/opencode/clawbot-adapter-media-${process.pid}`;
  const workspace = path.join(stateDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'report.pdf'), '%PDF-1.4 test');
  fs.writeFileSync(path.join(workspace, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(workspace, 'voice.mp3'), Buffer.from('ID3test'));

  const adapter = new WeixinAdapter({
    ctx: env.ctx,
    config: { agentPreset: 'standard' },
    transport: env.transport,
    stateDir,
    workspace,
    log: () => {},
  });
  await adapter.start();

  const base = { accountId: 'acct', userId: 'u1@im.wechat' };
  const run = (text) => adapter.handleInbound({ ...base, messageId: text, text });

  const reply = await run('生成报告');
  assert.deepEqual(reply, { text: '报告已生成。' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mediaPath, fs.realpathSync(path.join(workspace, 'report.pdf')));
  assert.equal(sent[0].text, '测试报告');

  const image = await run('/send image.png 截图');
  assert.equal(image, null);
  assert.equal(sent.at(-1).mediaPath, fs.realpathSync(path.join(workspace, 'image.png')));
  assert.equal(sent.at(-1).text, '截图');

  const voice = await run('/voice voice.mp3 听一下');
  assert.equal(voice, null);
  assert.equal(sent.at(-1).voicePath, fs.realpathSync(path.join(workspace, 'voice.mp3')));
  assert.equal(sent.at(-1).text, '听一下');

  const outside = await run('/send /etc/passwd');
  assert.match(outside.text, /只能发送工作区内的文件/);

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
