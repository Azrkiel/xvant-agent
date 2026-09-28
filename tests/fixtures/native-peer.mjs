// Fixed offline data peer. Never launches a provider or executes requested tools.
import { createInterface } from 'node:readline';
const [kind, scenario, sessionInput = 'session-1', request = 'request-1'] =
  process.argv.slice(2);
const session = scenario === 'wrong-session' ? 'other' : sessionInput;
const send = (value) =>
  process.stdout.write(
    kind === 'claude'
      ? JSON.stringify(value) + '\n'
      : 'data: ' + JSON.stringify(value) + '\r\n\r\n',
  );
const complete = () => {
  if (kind === 'claude')
    send({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: scenario === 'error',
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      result: 'Offline 雪 fixture',
      uuid: 'result-1',
      session_id: session,
      user_message_uuid: request,
    });
  else if (scenario === 'error')
    send({
      id: 'event-1',
      type: 'session.error',
      properties: {
        sessionID: session,
        error: { name: 'UnknownError', data: { message: 'fixture' } },
      },
    });
  else
    send({
      id: 'event-1',
      type: 'message.updated',
      properties: {
        sessionID: session,
        info: {
          id: 'assistant-1',
          sessionID: session,
          parentID: request,
          role: 'assistant',
          time: { created: 1, completed: 2 },
          modelID: 'fixture',
          providerID: 'fixture',
          mode: 'fixture',
          agent: 'fixture',
          path: { cwd: '/fixture', root: '/fixture' },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: 'stop',
        },
      },
    });
  if (scenario === 'partial') process.stdout.write('{');
};
let started = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!started && message.fixture === 'start') {
    started = true;
    if (scenario === 'timeout' || scenario === 'cancel') return;
    if (scenario === 'malformed') {
      process.stdout.write(kind === 'claude' ? '{bad}\n' : 'data: {bad}\n\n');
      return;
    }
    if (scenario === 'permission') {
      send(
        kind === 'claude'
          ? {
              type: 'control_request',
              request_id: 'permission-1',
              request: {
                subtype: 'can_use_tool',
                tool_name: 'Bash',
                input: {},
                tool_use_id: 'tool-1',
              },
            }
          : {
              id: 'event-1',
              type: 'permission.asked',
              properties: {
                id: 'permission-1',
                sessionID: session,
                permission: 'bash',
                patterns: ['*'],
                metadata: {},
                always: [],
              },
            },
      );
    } else complete();
  } else if (
    scenario === 'permission' &&
    (kind === 'claude'
      ? message.type === 'control_response' &&
        message.response?.request_id === 'permission-1' &&
        message.response?.response?.behavior === 'deny'
      : message.method === 'POST' &&
        message.path === '/permission/permission-1/reply' &&
        message.body?.reply === 'reject')
  )
    complete();
  else process.exit(32);
});
