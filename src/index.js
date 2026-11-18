import fs from 'node:fs';

import { WeixinAdapter } from './adapter.js';
import { OpenClawCompat } from './compat/index.js';
import { resolveStateDir, resolveWorkspace } from './paths.js';
import { createRoutes } from './web/routes.js';
import { errorMessage } from './transport.js';

export const name = 'dsh-clawbot';
export const inject = ['agents', 'sessions'];

function normalizeConfig(input = {}) {
  return {
    enabled: input.enabled !== false,
    stateDir: input.stateDir,
    workspace: input.workspace,
    workspaceRoots: Array.isArray(input.workspaceRoots)
      ? input.workspaceRoots.map((value) => String(value).trim()).filter(Boolean)
      : [],
    agentPreset: input.agentPreset || 'standard',
    permissionPreset: input.permissionPreset || 'workspace-write',
    provider: input.provider,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    maxTokens: input.maxTokens,
    allowUsers: Array.isArray(input.allowUsers)
      ? input.allowUsers.map((value) => String(value).trim()).filter(Boolean)
      : [],
    allowAllUsers: input.allowAllUsers === true,
    replyProgress: input.replyProgress !== false,
    goalProgress: input.goalProgress !== false,
    autoStart: input.autoStart !== false,
    approvalTimeoutMs: input.approvalTimeoutMs,
    idleAgentTimeoutMs:
      Number.isFinite(Number(input.idleAgentTimeoutMs)) && Number(input.idleAgentTimeoutMs) >= 0
        ? Number(input.idleAgentTimeoutMs)
        : 30 * 60_000,
    debug: Boolean(input.debug),
    botAgent: input.botAgent || 'DSH-ClawBot/0.1',
  };
}

export async function apply(ctx, input = {}) {
  const config = normalizeConfig(input);
  if (!config.enabled) return;

  const named = typeof ctx.logger === 'function' ? ctx.logger('dsh-clawbot') : ctx.logger;
  const log = (message) => {
    try {
      named?.info?.(String(message));
    } catch {
      // logging must never break the bridge
    }
  };

  const stateDir = resolveStateDir(config);
  const workspace = resolveWorkspace(config, stateDir);

  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDir, 0o700);
  } catch {
    // A read-only or shared state directory is a deployment choice; credential
    // files themselves are still written with mode 0600.
  }

  const compat = new OpenClawCompat({ ctx, config, stateDir, log });
  const adapter = new WeixinAdapter({ ctx, config, transport: compat, stateDir, workspace, log });

  ctx.effect(
    () => () => {
      void adapter.stop().catch(() => {});
      void compat.stop().catch(() => {});
    },
    'dsh-clawbot lifecycle',
  );

  try {
    await compat.init();
  } catch (error) {
    compat.lastError = errorMessage(error);
    log(`compat layer init failed: ${compat.lastError}`);
  }

  // The Web card exists in every web profile; headless profiles simply skip it.
  ctx.inject(['webServer', 'connection'], (sctx) => {
    const webServer = sctx.get('webServer');
    sctx.effect(() => {
      const routes = createRoutes({
        compat,
        adapter,
        connection: sctx.get('connection'),
        allowDebug: config.debug,
      });
      const disposers = routes.map((route) => webServer.register(route));
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            // best-effort
          }
        }
      };
    }, 'dsh-clawbot web routes');
  });

  if (config.autoStart && config.enabled) {
    try {
      await adapter.start();
      log('ClawBot adapter started');
    } catch (error) {
      compat.lastError = errorMessage(error);
      log(`adapter start failed: ${compat.lastError}`);
    }
  }
}
