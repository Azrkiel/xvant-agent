// Synthetic offline protocol peer. Never launch a model or execute a requested tool.
import { createInterface } from 'node:readline';
const scenario = process.argv[2];
let threadId = 'thread-1';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const turn = (status) => ({ id: 'turn-1', status, items: [] });
const complete = (status = 'completed') =>
  send({
    method: 'turn/completed',
    params: { threadId, turn: turn(status) },
  });
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  switch (request.method) {
    case 'initialize':
      send({
        id: request.id,
        result: {
          userAgent: 'offline-fixture',
          codexHome: '/fixture',
          platformFamily: 'fixture',
          platformOs: 'fixture',
        },
      });
      break;
    case 'initialized':
      break;
    case 'thread/start':
    case 'thread/resume': {
      if (scenario === 'thread-disconnect') {
        process.exit(31);
        break;
      }
      if (scenario === 'thread-timeout') break;
      if (scenario === 'thread-rpc-error') {
        send({
          id: request.id,
          error: { code: -32602, message: 'fixture error' },
        });
        break;
      }
      if (scenario === 'thread-malformed') {
        send({ id: request.id, result: {} });
        break;
      }
      threadId =
        scenario === 'thread-mismatch'
          ? 'other'
          : request.method === 'thread/start'
            ? 'created-1'
            : request.params.threadId;
      const thread = {
        id: threadId,
        cliVersion: '0.158.0-alpha.2.1',
        createdAt: 1,
        updatedAt: 1,
        cwd: process.cwd(),
        ephemeral: false,
        modelProvider: 'fixture',
        preview: '',
        projectId: null,
        sessionId: 'session-1',
        source: 'appServer',
        status: { type: 'idle' },
        turns: [],
      };
      send({ method: 'thread/started', params: { thread } });
      send({
        id: request.id,
        result: {
          approvalPolicy: 'untrusted',
          approvalsReviewer: 'user',
          cwd: process.cwd(),
          model: 'fixture',
          modelProvider: 'fixture',
          sandbox: { type: 'readOnly' },
          thread,
        },
      });
      break;
    }
    case 'turn/start':
      if (scenario === 'turn-rpc-error') {
        send({
          id: request.id,
          error: { code: -32603, message: 'fixture error' },
        });
        break;
      }
      if (scenario === 'disconnect') {
        process.exit(31);
        break;
      }
      if (scenario === 'malformed') {
        process.stdout.write('{bad}\n');
        break;
      }
      if (scenario === 'timeout') break;
      send({
        method: 'turn/started',
        params: { threadId, turn: turn('inProgress') },
      });
      send({ id: request.id, result: { turn: turn('inProgress') } });
      if (scenario === 'native-error' || scenario === 'native-retry') {
        send({
          method: 'error',
          params: {
            threadId,
            turnId: 'turn-1',
            error: {
              message: 'fixture error',
              codexErrorInfo: 'usageLimitExceeded',
            },
            willRetry: scenario === 'native-retry',
          },
        });
        break;
      }
      if (scenario === 'turn-failed') {
        complete('failed');
        break;
      }
      if (scenario === 'approval') {
        send({
          id: 'permission-1',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId,
            turnId: 'turn-1',
            itemId: 'item-1',
            startedAtMs: 1,
          },
        });
      } else if (scenario !== 'interrupt') {
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId,
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: 'Offline 雪 fixture',
          },
        });
        complete();
        if (scenario === 'late-malformed') process.stdout.write('{bad}\n');
        if (scenario === 'late-partial') process.stdout.write('{');
      }
      break;
    case 'turn/interrupt':
      send({ id: request.id, result: {} });
      complete('interrupted');
      break;
    default:
      if (
        request.id === 'permission-1' &&
        request.result?.decision === 'decline'
      )
        complete();
      else process.exit(32);
  }
});
