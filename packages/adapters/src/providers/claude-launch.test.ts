import { expect, it } from 'vitest';
import { buildClaudeLaunch, validateClaudeLaunch } from './claude-launch.ts';
import { pins } from './native-profiles.ts';
const session = '6306ed11-5ca4-4c61-a177-5b64eddf5d5b';
it('creates a constrained launch with a host-selected UUID', () => {
  expect(buildClaudeLaunch('create', session, process.cwd())).toEqual({
    cwd: process.cwd(),
    sessionId: session,
    permissionMode: 'plan',
    tools: [],
    mcpServers: {},
    plugins: [],
    settingSources: [],
  });
});
it('resumes an explicit session without selecting a new session ID', () => {
  const launch = buildClaudeLaunch('resume', 'existing-session', process.cwd());
  expect(launch).toMatchObject({
    resume: 'existing-session',
    permissionMode: 'plan',
  });
  expect(launch).not.toHaveProperty('sessionId');
});
it.each([
  'not-a-uuid',
  'pending:connection',
  '',
  '6306ed11/5ca4/4c61/a177/5b64eddf5d5b',
])('rejects invalid creation ID %s', (id) => {
  expect(() => buildClaudeLaunch('create', id, process.cwd())).toThrow(
    'INVALID_INPUT',
  );
});
it.each(['continue', 'forkSession', 'resume'])(
  'rejects mixed creation option %s',
  (field) => {
    const input = {
      ...buildClaudeLaunch('create', session, process.cwd()),
      [field]: field === 'resume' ? session : true,
    };
    expect(() => validateClaudeLaunch(input)).toThrow('INVALID_INPUT');
  },
);
it.each(['tools', 'mcpServers', 'plugins', 'settingSources', 'permissionMode'])(
  'rejects expanded launch authority %s',
  (field) => {
    const value =
      field === 'permissionMode'
        ? 'bypassPermissions'
        : field === 'mcpServers'
          ? { external: {} }
          : ['external'];
    expect(() =>
      validateClaudeLaunch({
        ...buildClaudeLaunch('resume', session, process.cwd()),
        [field]: value,
      }),
    ).toThrow('INVALID_INPUT');
  },
);
it('requires an absolute working directory and an explicit nonprovisional resume ID', () => {
  expect(() => buildClaudeLaunch('create', session, 'relative')).toThrow(
    'INVALID_INPUT',
  );
  expect(() =>
    buildClaudeLaunch('resume', 'pending:connection', process.cwd()),
  ).toThrow('INVALID_INPUT');
});
it('pins the exact selected launch option surface', () => {
  expect(
    pins.claude.declarations.Options?.map((field) => field.name).sort(),
  ).toEqual(
    [
      'cwd',
      'sessionId',
      'resume',
      'continue',
      'forkSession',
      'permissionMode',
      'tools',
      'mcpServers',
      'plugins',
      'settingSources',
    ].sort(),
  );
});
