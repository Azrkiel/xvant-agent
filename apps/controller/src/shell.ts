/**
 * The interactive shell's logic, kept apart from the terminal: what a typed
 * line means and which `xvant` command carries it out. The shell runs every
 * action as the same command line a user could type, so it adds no second
 * way of doing anything.
 */
export interface Session {
  /** The Git repository objectives run in. */
  repo: string;
  /** Who plans in a Codex and Claude pool; null uses the plain pool. */
  tandem: 'opus' | 'sol' | null;
  /** Runtimes to use; null means every qualified one. */
  only: string | null;
  checks: string[];
  criteria: string[];
  review: boolean;
  /** The last run started here, for /status, /diff and /accept. */
  lastId: string | null;
  lastBranch: string | null;
}
export type Action =
  | { kind: 'run'; args: string[] }
  | { kind: 'xvant'; args: string[] }
  | { kind: 'git'; args: string[] }
  | { kind: 'repo'; path: string }
  | { kind: 'share'; branch: string | null }
  | { kind: 'set'; session: Session; message: string }
  | { kind: 'say'; message: string }
  | { kind: 'quit' };

export const newSession = (repo: string): Session => ({
  repo,
  tandem: null,
  only: null,
  checks: [],
  criteria: [],
  review: true,
  lastId: null,
  lastBranch: null,
});

export const HELP = [
  'Type what you want done and press Enter. XVANT plans it, runs the workers,',
  'checks the result and leaves it on a branch for you to accept.',
  '',
  '  /repo PATH          work in another Git repository',
  '  /tandem opus|sol|off  who plans: Opus, GPT-6.1-Sol, or the plain pool',
  '  /only LIST|all      limit runtimes, e.g. /only claude',
  '  /check COMMAND      add a command the result must pass (/check clear)',
  '  /criterion TEXT     add an acceptance criterion (/criterion clear)',
  '  /review on|off      review the combined result',
  '  /settings           show the current settings',
  '  /runtimes           which runtimes are usable',
  '  /status [ID]        list runs, or show one (default: the last)',
  '  /diff               what the last run changed',
  '  /accept [ID]        accept a ready result',
  '  /merge [ID]         merge an accepted run (default: the last run)',
  '  /share BRANCH|stop  keep a branch in step with its remote',
  '  /help   /quit',
  '',
  'Ctrl+C stops a run in progress; at the prompt it leaves the shell.',
].join('\n');

/** The settings, one per line, as /settings prints them. */
export function describe(session: Session): string {
  return [
    'repo       ' + session.repo,
    'planner    ' +
      (session.tandem === 'opus'
        ? 'Opus plans; Sonnet and Haiku work, with Codex'
        : session.tandem === 'sol'
          ? 'GPT-6.1-Sol plans; Codex, Sonnet and Haiku work'
          : 'plain pool, each runtime on its own model'),
    'runtimes   ' + (session.only ?? 'all qualified'),
    'checks     ' + (session.checks.length ? session.checks.join(' | ') : '-'),
    'criteria   ' +
      (session.criteria.length ? session.criteria.join(' | ') : '-'),
    'review     ' + (session.review ? 'on' : 'off'),
    ...(session.lastId ? ['last run   ' + session.lastId] : []),
  ].join('\n');
}

/** The `xvant run` arguments for an objective under these settings. */
export function runArgs(session: Session, objective: string): string[] {
  return [
    'run',
    '--repo',
    session.repo,
    '--objective',
    objective,
    ...session.criteria.flatMap((c) => ['--criterion', c]),
    ...session.checks.flatMap((c) => ['--check', c]),
    ...(session.tandem ? ['--tandem', session.tandem] : []),
    ...(session.only ? ['--only', session.only] : []),
    ...(session.review ? [] : ['--no-review']),
  ];
}

/** Global Git coloring works for every subcommand, not just diff. */
export function gitArgs(args: string[], tty: boolean): string[] {
  return ['--no-pager', ...(tty ? ['-c', 'color.ui=always'] : []), ...args];
}

const KINDS = ['codex', 'claude', 'opencode'];
/** What one typed line asks for. Unknown commands say so; nothing is guessed. */
export function interpret(input: string, session: Session): Action {
  const line = input.trim();
  if (!line) return { kind: 'say', message: '' };
  if (!line.startsWith('/'))
    return { kind: 'run', args: runArgs(session, line) };
  const space = line.indexOf(' ');
  const name = (space === -1 ? line : line.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : line.slice(space + 1).trim();
  const set = (change: Partial<Session>, message: string): Action => ({
    kind: 'set',
    session: { ...session, ...change },
    message,
  });
  const say = (message: string): Action => ({ kind: 'say', message });
  switch (name) {
    case '/help':
    case '/?':
      return say(HELP);
    case '/quit':
    case '/exit':
    case '/q':
      return { kind: 'quit' };
    case '/settings':
      return say(describe(session));
    case '/repo':
      return rest ? { kind: 'repo', path: rest } : say('repo ' + session.repo);
    case '/tandem':
      if (rest === 'opus' || rest === 'sol')
        return set(
          { tandem: rest },
          rest === 'opus' ? 'Opus plans.' : 'GPT-6.1-Sol plans.',
        );
      if (rest === 'off') return set({ tandem: null }, 'Plain pool.');
      return say('Use /tandem opus, /tandem sol or /tandem off.');
    case '/only': {
      if (rest === 'all' || rest === '')
        return set({ only: null }, 'Using every qualified runtime.');
      const kinds = rest.split(/[\s,]+/).filter(Boolean);
      if (!kinds.every((k) => KINDS.includes(k)))
        return say('Runtimes are ' + KINDS.join(', ') + '.');
      return set({ only: kinds.join(',') }, 'Using ' + kinds.join(', ') + '.');
    }
    case '/check':
      if (!rest) return say('Give the command, or /check clear.');
      return rest === 'clear'
        ? set({ checks: [] }, 'No checks.')
        : set(
            { checks: [...session.checks, rest] },
            'The result must pass: ' + rest,
          );
    case '/criterion':
      if (!rest) return say('Give the criterion, or /criterion clear.');
      return rest === 'clear'
        ? set({ criteria: [] }, 'No criteria.')
        : set({ criteria: [...session.criteria, rest] }, 'Added.');
    case '/review':
      if (rest !== 'on' && rest !== 'off') return say('Use /review on or off.');
      return set({ review: rest === 'on' }, 'Review ' + rest + '.');
    case '/runtimes':
      return { kind: 'xvant', args: ['runtimes'] };
    case '/status': {
      const id = rest || session.lastId;
      return { kind: 'xvant', args: id ? ['status', id] : ['status'] };
    }
    case '/accept': {
      const id = rest || session.lastId;
      return id
        ? { kind: 'xvant', args: ['accept', id] }
        : say('No run yet. Give an ID from /status.');
    }
    case '/diff':
      return session.lastBranch
        ? { kind: 'git', args: ['diff', 'HEAD...' + session.lastBranch] }
        : say('No run has produced a branch in this session.');
    case '/merge': {
      const id = rest || session.lastId;
      return id
        ? { kind: 'xvant', args: ['merge', id, '--repo', session.repo] }
        : say('No run yet. Give an accepted ID from /status.');
    }
    case '/share':
      if (!rest) return say('Give the branch to share, or /share stop.');
      return { kind: 'share', branch: rest === 'stop' ? null : rest };
    default:
      return say('Unknown command ' + name + '. /help lists them.');
  }
}

/** Picks the run ID and result branch out of a line `xvant run` printed. */
export function observe(session: Session, line: string): Session {
  const started = /^XVANT (\S+) on /.exec(line);
  if (started) return { ...session, lastId: started[1]!, lastBranch: null };
  const branch = /^Branch (\S+) holds the combined work\.$/.exec(line);
  return branch ? { ...session, lastBranch: branch[1]! } : session;
}

/** A saved session, if it is one; settings from an older shape are dropped. */
export function restore(saved: unknown, repo: string): Session {
  const base = newSession(repo);
  if (!saved || typeof saved !== 'object') return base;
  const s = saved as Record<string, unknown>;
  const strings = (value: unknown) =>
    Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? (value as string[])
      : [];
  return {
    ...base,
    tandem:
      s.tandem === 'opus' || s.tandem === 'sol' || s.tandem === null
        ? s.tandem
        : base.tandem,
    only: typeof s.only === 'string' ? s.only : null,
    checks: strings(s.checks),
    criteria: strings(s.criteria),
    review: s.review !== false,
  };
}
