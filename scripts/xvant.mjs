// XVANT command line. Coordinates your Codex, Claude and OpenCode logins on
// a Git repository. Work happens in XVANT-owned worktrees and lands on an
// `xvant/<id>` branch; your checkout and branches are never changed.
//
//   npm run xvant -- runtimes
//   npm run xvant -- run --repo PATH --objective TEXT [--criterion TEXT]...
//                        [--check "COMMAND"]... [--max-active N] [--no-review]
//                        [--only codex,claude,opencode]
//   npm run xvant -- status [ID]
//   npm run xvant -- accept ID
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../packages/storage/src/store.ts';
import { ArtifactStore } from '../packages/storage/src/artifacts.ts';
import { discoverRuntime } from '../packages/adapters/src/live/discover.ts';
import { Orchestrator } from '../apps/controller/src/orchestrator.ts';
import { LiveTurnRunner } from '../apps/controller/src/turn-runner.ts';

const home = resolve(process.env.XVANT_HOME ?? join(homedir(), '.xvant'));
const [command, ...rest] = process.argv.slice(2);
const values = (name) =>
  rest.flatMap((arg, i) => (arg === name ? [rest[i + 1]] : [])).filter(Boolean);
const value = (name) => values(name)[0];
const open = () => {
  mkdirSync(home, { recursive: true });
  return {
    store: new Store(join(home, 'state.sqlite'), { owner: 'xvant-cli' }),
    objects: new ArtifactStore(join(home, 'objects')),
  };
};
const POOL = {
  codex: [
    ['codex-1', ['planner', 'worker', 'reviewer']],
    ['codex-2', ['worker']],
  ],
  claude: [
    ['claude-1', ['worker', 'reviewer']],
    ['claude-2', ['worker', 'reviewer']],
    ['claude-3', ['worker']],
  ],
  opencode: [1, 2, 3, 4, 5].map((i) => ['opencode-' + i, ['worker']]),
};
const QUOTA = {
  codex: 'codex-subscription',
  claude: 'claude-subscription',
  opencode: 'opencode-free',
};

function discover(only) {
  const runtimes = {};
  const table = [];
  for (const kind of only) {
    const found = discoverRuntime(kind);
    table.push(found);
    if (found.status === 'qualified')
      runtimes[kind] = { executable: found.executable, version: found.version };
  }
  return { runtimes, table };
}
function shellCheck(command) {
  // Checks are commands you register; they run in XVANT's worktrees.
  return process.platform === 'win32'
    ? {
        executable: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', command],
      }
    : { executable: '/bin/sh', args: ['-c', command] };
}

if (command === 'runtimes') {
  for (const found of discover(['codex', 'claude', 'opencode']).table)
    console.log(
      found.runtimeKind.padEnd(9),
      found.status.padEnd(17),
      (found.version ?? '-').padEnd(20),
      found.executable ?? '',
    );
} else if (command === 'run') {
  const repo = value('--repo');
  const objective = value('--objective');
  if (!repo || !objective) {
    console.error('run needs --repo PATH and --objective TEXT');
    process.exit(2);
  }
  const repository = realpathSync(resolve(repo));
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: repository,
    encoding: 'utf8',
  });
  if (top.status !== 0) {
    console.error('Not a Git repository: ' + repository);
    process.exit(2);
  }
  const only = (value('--only') ?? 'codex,claude,opencode').split(',');
  const { runtimes, table } = discover(only);
  for (const found of table)
    if (found.status !== 'qualified')
      console.log(
        'Skipping ' +
          found.runtimeKind +
          ': ' +
          found.status +
          (found.version ? ' ' + found.version : ''),
      );
  const workers = Object.keys(runtimes).flatMap((kind) =>
    POOL[kind].map(([alias, roles]) => ({
      alias,
      runtimeKind: kind,
      quotaGroupId: QUOTA[kind],
      roles,
    })),
  );
  if (!workers.length) {
    console.error('No qualified runtime. Run: npm run xvant -- runtimes');
    process.exit(1);
  }
  if (!workers.some((w) => w.roles.includes('planner')))
    workers[0].roles = ['planner', ...workers[0].roles];
  const checks = Object.fromEntries(
    values('--check').map((c, i) => ['check' + (i + 1), shellCheck(c)]),
  );
  const id =
    'x' +
    new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(2, 14) +
    '-' +
    objective
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24);
  const { store, objects } = open();
  const runner = new LiveTurnRunner(store, objects, workers, runtimes, {
    onEvent: (alias, _taskId, event) => {
      if (event.kind === 'activity' || event.kind === 'auth')
        console.log('  ' + alias.padEnd(11) + event.text.slice(0, 100));
    },
  });
  const orchestrator = new Orchestrator(store, runner, workers, {
    stateRoot: join(home, 'runs'),
    onChange: (state, kind) => {
      if (kind === 'graph.planned')
        for (const n of state.plan.nodes)
          console.log(
            'plan  ' +
              n.id.padEnd(16) +
              n.title +
              (n.dependsOn.length ? '  after ' + n.dependsOn.join(', ') : ''),
          );
      else if (kind === 'node.dispatched') {
        const running = Object.values(state.nodes).filter(
          (n) => n.status === 'running',
        );
        const latest = running.at(-1);
        if (latest)
          console.log(
            'start ' +
              latest.node.id.padEnd(16) +
              '→ ' +
              latest.route?.alias +
              '  (' +
              latest.route?.reasons.join('; ') +
              ')',
          );
      } else console.log(kind.padEnd(22) + state.phase);
    },
  });
  process.on('SIGINT', () => {
    console.log('Stopping: interrupting running workers…');
    orchestrator.cancel();
  });
  console.log('XVANT ' + id + ' on ' + repository);
  const state = await orchestrator.run({
    id,
    projectId: 'cli',
    repository,
    baseRevision: value('--base') ?? 'HEAD',
    objective,
    acceptanceCriteria: values('--criterion').length
      ? values('--criterion')
      : ['The objective is met'],
    checks,
    ...(value('--max-active')
      ? { maxActive: Number(value('--max-active')) }
      : {}),
    ...(rest.includes('--no-review') ? { review: false } : {}),
  });
  store.close();
  console.log(
    '\nResult: ' + state.phase + (state.reason ? ' — ' + state.reason : ''),
  );
  for (const c of state.checks)
    console.log('  check ' + c.id + ': ' + c.status);
  if (state.review)
    console.log(
      '  review by ' +
        state.review.alias +
        ': ' +
        (state.review.approve ? 'approved' : 'changes requested') +
        (state.review.independent
          ? state.review.sameRuntime
            ? ' (independent worker, same runtime as some of the work)'
            : ' (independent)'
          : ' (not independent: the reviewer also implemented)'),
      ...state.review.findings.map((f) => '\n    - ' + f),
    );
  if (state.integration)
    console.log(
      '\nBranch ' +
        state.integration.branch +
        ' holds the combined work.\nInspect: git -C "' +
        repository +
        '" diff HEAD...' +
        state.integration.branch +
        '\nAccept:  npm run xvant -- accept ' +
        id,
    );
  process.exitCode = state.phase === 'ready' ? 0 : 1;
} else if (command === 'status') {
  const { store } = open();
  try {
    const id = rest[0];
    if (id) {
      const record = store.graphs.get(id);
      console.log(
        JSON.stringify(
          {
            phase: record.state.phase,
            reason: record.state.reason,
            nodes: Object.fromEntries(
              Object.entries(record.state.nodes).map(([k, n]) => [k, n.status]),
            ),
            checks: record.state.checks,
            review: record.state.review,
            branch: record.state.integration?.branch,
          },
          null,
          2,
        ),
      );
      for (const e of store.graphs.events(id))
        console.log(String(e.sequence).padStart(5), e.kind);
    } else
      for (const g of store.graphs.list()) {
        const record = store.graphs.get(g.id);
        console.log(
          g.id.padEnd(42),
          record.state.phase.padEnd(16),
          record.state.integration?.branch ?? '',
        );
      }
  } finally {
    store.close();
  }
} else if (command === 'accept') {
  const { store } = open();
  try {
    const record = store.graphs.get(rest[0]);
    if (record.state.phase !== 'ready')
      throw new Error(
        'Only a ready result can be accepted (it is ' +
          record.state.phase +
          ')',
      );
    store.graphs.update(
      rest[0],
      record.rowVersion,
      { ...record.state, phase: 'accepted' },
      'graph.accepted',
      { actorId: 'user' },
    );
    console.log(
      'Accepted. Merge when you are ready: git merge ' +
        record.state.integration.branch,
    );
  } finally {
    store.close();
  }
} else {
  console.error('Commands: runtimes | run | status [ID] | accept ID');
  process.exit(2);
}
