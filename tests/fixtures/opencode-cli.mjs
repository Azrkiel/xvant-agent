import { randomBytes } from 'node:crypto';
const args = process.argv.slice(2);
const scenario = args.shift();
if (args.includes('--version')) {
  console.log(scenario === 'version' ? 'opencode v9.0.0' : 'opencode v2.0.19');
  process.exit(0);
}
if (args.includes('session.create')) {
  if (scenario === 'create-malformed') {
    console.log('broken');
    process.exit(0);
  }
  console.log(
    JSON.stringify({
      data: {
        id: 'ses_' + randomBytes(16).toString('hex'),
        location: {
          directory: scenario === 'create-wrong-root' ? 'C:/' : process.cwd(),
        },
        model: { id: 'big-pickle', providerID: 'opencode' },
      },
    }),
  );
  process.exit(scenario === 'create-nonzero' ? 1 : 0);
}
const sessionID = args[args.indexOf('--session') + 1];
// Native `run` consumes piped stdin before starting its turn.
await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.on('end', resolve);
});
const messageID = 'msg_fixture';
const base = { timestamp: Date.now(), sessionID };
if (scenario === 'auth-malformed') {
  console.log(
    JSON.stringify({
      ...base,
      type: 'error',
      error: { type: 'provider.auth', status: 403, message: 'private error' },
    }),
  );
  console.log('broken');
  process.exit(1);
}
if (scenario === 'auth') {
  console.log(
    JSON.stringify({
      ...base,
      type: 'error',
      error: { type: 'provider.auth', status: 403, message: 'private error' },
    }),
  );
  process.exit(1);
}
if (scenario === 'timeout') {
  setInterval(() => {}, 1000);
} else {
  console.log(
    JSON.stringify({
      ...base,
      type: 'step_start',
      part: { id: 'prt_start', sessionID, messageID, type: 'step-start' },
    }),
  );
  if (scenario === 'interrupt') {
    setInterval(() => {}, 1000);
  } else {
    if (scenario === 'malformed') console.log('not json');
    else
      console.log(
        JSON.stringify({
          ...base,
          type: 'text',
          part: {
            id: 'prt_text',
            sessionID: scenario === 'wrong-session' ? 'ses_wrong' : sessionID,
            messageID,
            type: 'text',
            text: 'XVANT_LIVE_OK',
            time: { start: 1, end: 2 },
          },
        }),
      );
    if (scenario === 'nonzero') process.exitCode = 1;
  }
}
