// Fixed offline data peer. Never launches a provider or executes requested tools.
import { createInterface } from 'node:readline';
import { validateClaudeLaunch } from '../../packages/adapters/src/providers/claude-launch.ts';
const [
  kind,
  scenario,
  sessionInput = 'session-1',
  request = 'request-1',
  launchJson,
] = process.argv.slice(2);
if (launchJson !== undefined) {
  if (kind !== 'claude') throw new Error('INVALID_INPUT');
  const launch = validateClaudeLaunch(JSON.parse(launchJson));
  if (
    ('sessionId' in launch ? launch.sessionId : launch.resume) !==
      sessionInput ||
    launch.cwd !== process.cwd()
  )
    throw new Error('INVALID_INPUT');
}
if (scenario === 'launch-error') process.exit(42);
let session = scenario === 'wrong-session' ? 'other' : sessionInput;
const interrupting = scenario.startsWith('interrupt');
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
      is_error: scenario === 'error' || interrupting,
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
          ...(interrupting
            ? {
                error: {
                  name: 'MessageAbortedError',
                  data: { message: 'fixture interrupted' },
                },
              }
            : {}),
        },
      },
    });
  if (scenario === 'partial' || scenario === 'interrupt-partial')
    process.stdout.write('{');
};
let started = false;
let configured = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (scenario === 'launch-timeout') return;
  if (
    !configured &&
    !started &&
    kind === 'opencode' &&
    message.method === 'POST' &&
    message.path === '/session' &&
    message.requestId === 'setup'
  ) {
    configured = true;
    if (scenario === 'setup-timeout') return;
    if (scenario === 'create-partial') {
      process.stdout.write('data: {"fixture":');
      return;
    }
    session = scenario === 'create-reused' ? sessionInput : 'created-1';
    send({
      fixture: 'http-response',
      requestId: 'setup',
      method: 'POST',
      path: '/session',
      status: scenario === 'setup-error' ? 400 : 200,
      body: {
        id: scenario === 'create-malformed' ? '' : session,
        slug: 'fixture',
        projectID: 'project',
        directory: scenario === 'setup-mismatch' ? '/wrong' : process.cwd(),
        title: 'fixture',
        version: 'fixture',
        permission: [
          {
            permission: '*',
            pattern: '*',
            action: scenario === 'create-permission' ? 'allow' : 'deny',
          },
        ],
        time: { created: 1, updated: 1 },
      },
    });
    return;
  }
  if (
    !configured &&
    !started &&
    (kind === 'claude'
      ? message.type === 'control_request' &&
        message.request?.subtype === 'initialize' &&
        message.request_id === 'setup'
      : message.method === 'GET' &&
        message.path === '/session/' + encodeURIComponent(sessionInput) &&
        message.requestId === 'setup')
  ) {
    configured = true;
    if (scenario === 'setup-timeout') return;
    send(
      kind === 'claude'
        ? {
            type: 'control_response',
            response: {
              subtype: scenario === 'setup-error' ? 'error' : 'success',
              request_id: scenario === 'setup-mismatch' ? 'other' : 'setup',
              pending_permission_requests: [],
              pending_user_dialog_requests: [],
              response: {
                commands: [],
                agents: [],
                output_style: 'default',
                available_output_styles: [],
                models: [],
                account: {},
              },
            },
          }
        : {
            fixture: 'http-response',
            requestId: 'setup',
            method: 'GET',
            path: message.path,
            status: scenario === 'setup-error' ? 400 : 200,
            body: {
              id: scenario === 'setup-mismatch' ? 'other' : sessionInput,
              slug: 'fixture',
              projectID: 'project',
              directory: process.cwd(),
              title: 'fixture',
              version: 'fixture',
              time: { created: 1, updated: 1 },
            },
          },
    );
    return;
  }
  if (
    started &&
    interrupting &&
    (kind === 'claude'
      ? message.type === 'control_request' &&
        message.request?.subtype === 'interrupt' &&
        message.request.cancel_queued === true &&
        message.request_id === 'interrupt'
      : message.method === 'POST' &&
        message.path === '/session/' + encodeURIComponent(session) + '/abort' &&
        message.requestId === 'interrupt')
  ) {
    if (scenario === 'interrupt-timeout') return;
    if (scenario === 'interrupt-result-first') complete();
    send(
      kind === 'claude'
        ? {
            type: 'control_response',
            response: {
              subtype: scenario === 'interrupt-error' ? 'error' : 'success',
              request_id:
                scenario === 'interrupt-mismatch' ? 'other' : 'interrupt',
              response: { still_queued: [], cancelled: [] },
            },
          }
        : {
            fixture: 'http-response',
            requestId: 'interrupt',
            method: 'POST',
            path:
              scenario === 'interrupt-mismatch'
                ? '/session/other/abort'
                : message.path,
            status: scenario === 'interrupt-error' ? 400 : 200,
            body: true,
          },
    );
    if (
      scenario !== 'interrupt-result-first' &&
      scenario !== 'interrupt-ack-only'
    )
      complete();
    return;
  }
  if (!started && message.fixture === 'start') {
    started = true;
    if (configured && kind === 'claude')
      send({
        type: 'system',
        subtype: 'init',
        session_id: session,
        uuid: 'init-message',
        apiKeySource: 'none',
        claude_code_version: '2.1.283',
        cwd: process.cwd(),
        tools: [],
        mcp_servers: [],
        model: 'fixture',
        permissionMode: 'plan',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
        capabilities:
          scenario === 'interrupt-unsupported'
            ? ['interrupt_receipt_v1']
            : ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
      });
    if (interrupting) return;
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
