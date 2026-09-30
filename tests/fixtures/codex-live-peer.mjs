// Synthetic stand-in for a live `codex app-server` 0.158.0-alpha.2.1, shaped
// after traffic observed on 2026-09-30: emittedAtMs on notifications, an
// account/updated auth report, workspace-write threads and item events.
// It edits only its own working directory and never calls a model.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { followInstruction, followMcpInstruction } from './fake-edit.mjs';
// The bridge Codex would load from -c mcp_servers={xvant={url=...}}.
const mcpUrl = /url="([^"]+)"/.exec(process.argv.join(' '))?.[1];
const mcp = process.argv[2] !== 'no-mcp' &&
  mcpUrl && { url: mcpUrl, token: process.env.XVANT_MCP_TOKEN };

const scenario = process.argv[2] ?? 'write';
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.158.0-alpha.2.1\n');
  process.exit(0);
}
// Each process mints its own thread, like the real app-server.
let threadId = (await import('node:crypto')).randomUUID();
const turnId = '01a0f355-24f5-7903-b322-6915d609062d';
const now = () => Date.now();
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const note = (method, params) => send({ method, params, emittedAtMs: now() });
const turn = (status, items = []) => ({
  id: turnId,
  items,
  itemsView: 'summary',
  status,
  error:
    status === 'failed'
      ? { message: 'x', codexErrorInfo: 'usageLimitExceeded' }
      : null,
  startedAt: 1,
  completedAt: status === 'inProgress' ? null : 2,
  durationMs: status === 'inProgress' ? null : 1,
});
const answer = {
  type: 'agentMessage',
  id: 'msg_1',
  text: 'Created hello.txt.',
  phase: 'final_answer',
  memoryCitation: null,
  delivery: null,
  questions: null,
};
const input = createInterface({ input: process.stdin });
input.on('close', () => process.exit(0));
input.on('line', async (line) => {
  const request = JSON.parse(line);
  switch (request.method) {
    case 'initialize':
      send({
        id: request.id,
        result: {
          userAgent: 'live-fixture',
          codexHome: '/fixture',
          platformFamily: 'windows',
          platformOs: 'windows',
        },
      });
      note('account/updated', {
        authMode: scenario === 'api-key' ? 'apikey' : 'chatgpt',
        planType: 'plus',
      });
      break;
    case 'initialized':
      break;
    case 'thread/start':
    case 'thread/resume': {
      if (request.method === 'thread/resume')
        threadId = request.params.threadId;
      const thread = {
        id: threadId,
        cliVersion: '0.158.0-alpha.2.1',
        createdAt: 1,
        updatedAt: 1,
        cwd: request.params.cwd,
        ephemeral: false,
        modelProvider: 'openai',
        preview: '',
        projectId: null,
        sessionId: 'session-1',
        source: 'appServer',
        status: { type: 'idle' },
        turns: [],
      };
      note('thread/started', { thread });
      send({
        id: request.id,
        result: {
          approvalPolicy: request.params.approvalPolicy,
          approvalsReviewer: 'user',
          cwd: request.params.cwd,
          model: 'fixture-model',
          modelProvider: 'openai',
          sandbox:
            request.params.sandbox === 'workspace-write'
              ? {
                  type: 'workspaceWrite',
                  writableRoots: [],
                  networkAccess: false,
                  excludeTmpdirEnvVar: false,
                  excludeSlashTmp: false,
                }
              : { type: 'readOnly' },
          thread,
        },
      });
      note('mcpServer/startupStatus/updated', {
        threadId,
        name: 'fixture',
        status: 'ready',
        error: null,
        failureReason: null,
      });
      break;
    }
    case 'turn/start':
      note('turn/started', { threadId, turn: turn('inProgress') });
      send({ id: request.id, result: { turn: turn('inProgress') } });
      const text = request.params.input?.[0]?.text ?? '';
      const followed = (await followMcpInstruction(text, mcp))
        ? 'edited'
        : followInstruction(text);
      if (scenario === 'hang' || followed === 'hang') break;
      if (scenario === 'fail') {
        note('turn/completed', { threadId, turn: turn('failed') });
        break;
      }
      if (scenario === 'approval') {
        send({
          id: 'permission-1',
          method: 'item/commandExecution/requestApproval',
          params: { threadId, turnId, itemId: 'item-1', startedAtMs: 1 },
        });
        break;
      }
      note('item/started', {
        item: { type: 'commandExecution', id: 'cmd_1' },
        threadId,
        turnId,
        startedAtMs: 1,
      });
      if (followed === 'unmatched')
        writeFileSync(join(process.cwd(), 'hello.txt'), 'hi from codex\n');
      note('item/commandExecution/outputDelta', {
        threadId,
        turnId,
        itemId: 'cmd_1',
        delta: 'ok',
      });
      note('item/completed', {
        item: { type: 'commandExecution', id: 'cmd_1' },
        threadId,
        turnId,
        completedAtMs: 2,
      });
      note('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: 'msg_1',
        delta: 'Created hello.txt.',
      });
      note('item/completed', {
        item: answer,
        threadId,
        turnId,
        completedAtMs: 3,
      });
      note('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: { total: { totalTokens: 1234 } },
      });
      note('turn/completed', { threadId, turn: turn('completed', [answer]) });
      break;
    case 'turn/interrupt':
      send({ id: request.id, result: {} });
      note('turn/completed', { threadId, turn: turn('interrupted') });
      break;
    default:
      process.exit(32);
  }
});
