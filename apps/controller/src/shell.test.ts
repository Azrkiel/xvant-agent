import { expect, it } from 'vitest';
import {
  describe as describeSession,
  interpret,
  newSession,
  observe,
  restore,
  runArgs,
  type Session,
} from './shell.ts';

const session = (over: Partial<Session> = {}): Session => ({
  ...newSession('C:/work/app'),
  ...over,
});
const after = (line: string, from = session()) => {
  const action = interpret(line, from);
  if (action.kind !== 'set') throw new Error('not a setting: ' + line);
  return action.session;
};

it('runs plain text as an objective under the current settings', () => {
  expect(interpret('  Add a health endpoint  ', session())).toEqual({
    kind: 'run',
    args: [
      'run',
      '--repo',
      'C:/work/app',
      '--objective',
      'Add a health endpoint',
      '--tandem',
      'opus',
    ],
  });
  expect(
    runArgs(
      session({
        tandem: null,
        only: 'claude',
        checks: ['npm test', 'npm run lint'],
        criteria: ['returns 200'],
        review: false,
      }),
      'x',
    ),
  ).toEqual([
    'run',
    '--repo',
    'C:/work/app',
    '--objective',
    'x',
    '--criterion',
    'returns 200',
    '--check',
    'npm test',
    '--check',
    'npm run lint',
    '--only',
    'claude',
    '--no-review',
  ]);
  expect(interpret('   ', session())).toEqual({ kind: 'say', message: '' });
});

it('changes settings with slash commands and refuses what it does not know', () => {
  expect(after('/tandem sol').tandem).toBe('sol');
  expect(after('/tandem off').tandem).toBeNull();
  expect(interpret('/tandem gpt', session()).kind).toBe('say');
  expect(after('/only claude, codex').only).toBe('claude,codex');
  expect(after('/only all', session({ only: 'claude' })).only).toBeNull();
  expect(interpret('/only gemini', session()).kind).toBe('say');
  const checked = after('/check npm test -- --run');
  expect(checked.checks).toEqual(['npm test -- --run']);
  expect(after('/check clear', checked).checks).toEqual([]);
  expect(after('/criterion It works').criteria).toEqual(['It works']);
  expect(after('/review off').review).toBe(false);
  expect(interpret('/frobnicate', session())).toEqual({
    kind: 'say',
    message: 'Unknown command /frobnicate. /help lists them.',
  });
  expect(interpret('/QUIT', session())).toEqual({ kind: 'quit' });
  expect(interpret('/repo ../other', session())).toEqual({
    kind: 'repo',
    path: '../other',
  });
});

it('follows the last run for status, diff, accept and merge', () => {
  expect(interpret('/status', session())).toEqual({
    kind: 'xvant',
    args: ['status'],
  });
  expect(interpret('/accept', session()).kind).toBe('say');
  expect(interpret('/diff', session()).kind).toBe('say');
  let s = observe(session(), 'XVANT x261008-add-api on C:\\work\\app');
  s = observe(s, 'plan  api   API');
  s = observe(s, 'Branch xvant/x261008-add-api holds the combined work.');
  expect(s).toMatchObject({
    lastId: 'x261008-add-api',
    lastBranch: 'xvant/x261008-add-api',
  });
  expect(interpret('/status', s)).toEqual({
    kind: 'xvant',
    args: ['status', 'x261008-add-api'],
  });
  expect(interpret('/accept', s)).toEqual({
    kind: 'xvant',
    args: ['accept', 'x261008-add-api'],
  });
  expect(interpret('/accept other', s)).toEqual({
    kind: 'xvant',
    args: ['accept', 'other'],
  });
  expect(interpret('/diff', s)).toEqual({
    kind: 'git',
    args: ['diff', 'HEAD...xvant/x261008-add-api'],
  });
  expect(interpret('/merge', s)).toEqual({
    kind: 'git',
    args: ['merge', '--no-edit', 'xvant/x261008-add-api'],
  });
  // A new run that produced no branch leaves nothing to diff.
  expect(observe(s, 'XVANT x2 on C:\\work\\app').lastBranch).toBeNull();
});

it('starts and stops sharing, and describes and restores a session', () => {
  expect(interpret('/share team', session())).toEqual({
    kind: 'share',
    branch: 'team',
  });
  expect(interpret('/share stop', session())).toEqual({
    kind: 'share',
    branch: null,
  });
  expect(describeSession(session({ checks: ['npm test'] }))).toContain(
    'checks     npm test',
  );
  expect(
    restore(
      { tandem: 'sol', only: 'claude', checks: ['a'], criteria: [1], x: 2 },
      'C:/r',
    ),
  ).toEqual({
    ...newSession('C:/r'),
    tandem: 'sol',
    only: 'claude',
    checks: ['a'],
  });
  expect(restore('junk', 'C:/r')).toEqual(newSession('C:/r'));
});
