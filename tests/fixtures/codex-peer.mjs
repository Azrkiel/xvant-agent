// Synthetic offline protocol peer. Never launch a model or execute a requested tool.
import { createInterface } from 'node:readline';
const scenario = process.argv[2];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const turn = (status) => ({ id: 'turn-1', status, items: [] });
const complete = (status = 'completed') =>
  send({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: turn(status) },
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
    case 'turn/start':
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
        params: { threadId: 'thread-1', turn: turn('inProgress') },
      });
      send({ id: request.id, result: { turn: turn('inProgress') } });
      if (scenario === 'approval') {
        send({
          id: 'permission-1',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            startedAtMs: 1,
          },
        });
      } else if (scenario !== 'interrupt') {
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: 'Offline 雪 fixture',
          },
        });
        complete();
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
