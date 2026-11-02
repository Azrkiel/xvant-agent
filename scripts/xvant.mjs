// XVANT command line. Coordinates your Codex, Claude and OpenCode logins on
// a Git repository. Work happens in XVANT-owned worktrees and lands on an
// `xvant/<id>` branch. Only an explicit, accepted `merge` changes your checkout.
//
//   npm run xvant                      (the interactive shell; also `shell`)
//   npm run xvant -- ui [--no-open] [--port N]
//   npm run xvant -- runtimes
//   npm run xvant -- run --repo PATH --objective TEXT [--criterion TEXT]...
//                        [--check "COMMAND"]... [--max-active N] [--no-review]
//                        [--only codex,claude,opencode]
//                        [--model KIND=MODEL]... [--planner-model MODEL]
//                        [--tier light=MODEL] [--tier standard=MODEL]
//                        [--tandem opus|sol]
//   npm run xvant -- status [ID]
//   npm run xvant -- accept ID
//   npm run xvant -- merge ID [--repo PATH]
//   npm run xvant -- share --repo PATH --branch NAME [--remote origin]
//                          [--interval SECONDS] [--once]
//   npm run xvant -- backup [--out DIR]
//   npm run xvant -- restore --from DIR [--force]
//   npm run xvant -- lessons [list [--all] | show ID | search TEXT | export [--all]
//                            | stats | forget ID --reason TEXT]
//                            [--format md|mermaid|json] [--project ID | --repo PATH]
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { lessonsLine } from '../packages/memory/src/lessons.ts';
import { Store } from '../packages/storage/src/store.ts';
import { ArtifactStore } from '../packages/storage/src/artifacts.ts';
import { discoverRuntime } from '../packages/adapters/src/live/discover.ts';
import { Orchestrator } from '../apps/controller/src/orchestrator.ts';
import { LiveTurnRunner } from '../apps/controller/src/turn-runner.ts';
import { defaultWorkers, shellCheck } from '../apps/controller/src/app.ts';
import {
  activeRouting,
  applyRouting,
  applyTiers,
} from '../apps/controller/src/routing-default.ts';

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
const KINDS = ['codex', 'claude', 'opencode'];
// --tandem: Codex and Claude in one pool. The named model plans and reviews;
// Claude's other workers split into sonnet (standard) and haiku (light).
const TANDEM = {
  opus: { kind: 'claude', plannerModel: 'opus' },
  sol: { kind: 'codex', plannerModel: 'gpt-6.1-sol' },
};

// Bind the durable result to a real checkout, its integration worktree and
// the exact verified revision. Read-only Git probes precede any merge.
function checkedIntegration(state, repository) {
  const changed = () => {
    throw new Error(
      'INTEGRATION_CHANGED: repository, branch or verified HEAD no longer matches',
    );
  };
  const readGit = (cwd, args) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) changed();
    return result.stdout.trim();
  };
  try {
    const integration = state.integration;
    if (
      !integration ||
      typeof integration.branch !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(integration.head)
    )
      changed();
    const ref = 'refs/heads/' + integration.branch;
    readGit(repository, ['check-ref-format', ref]);
    const path = realpathSync(integration.path);
    if (
      realpathSync(readGit(repository, ['rev-parse', '--show-toplevel'])) !==
        repository ||
      realpathSync(readGit(path, ['rev-parse', '--show-toplevel'])) !== path ||
      realpathSync(
        readGit(repository, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ]),
      ) !==
        realpathSync(
          readGit(path, [
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ]),
        ) ||
      readGit(path, ['symbolic-ref', '--quiet', 'HEAD']) !== ref ||
      readGit(path, ['rev-parse', '--verify', 'HEAD']) !== integration.head ||
      readGit(repository, ['rev-parse', '--verify', ref]) !== integration.head
    )
      changed();
    return integration;
  } catch {
    changed();
  }
}

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

if (command === undefined || command === 'shell') {
  const { startShell } = await import('./xvant-shell.mjs');
  await startShell({ home });
  process.exit(0);
} else if (command === 'ui') {
  const { startApp } = await import('../apps/controller/src/app.ts');
  const app = await startApp({
    home,
    ...(value('--port') ? { port: Number(value('--port')) } : {}),
  });
  // The single-use capability rides in the URL fragment, which browsers never send.
  const url = app.origin + '/#bootstrap=' + app.bootstrapToken;
  console.log('XVANT is running at ' + app.origin + ' (Ctrl+C to stop).');
  if (rest.includes('--no-open') || process.platform !== 'win32')
    console.log('Open this once to sign in: ' + url);
  else
    spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'start "" "' + url + '"'],
      {
        windowsVerbatimArguments: true,
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      },
    ).unref();
  const stop = async () => {
    console.log('Stopping XVANT; running workers are interrupted.');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else if (command === 'runtimes') {
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
  const tandem = rest.includes('--tandem') ? TANDEM[value('--tandem')] : null;
  if (tandem === undefined) {
    console.error('--tandem needs opus or sol (the model that plans)');
    process.exit(2);
  }
  const only = (
    value('--only') ?? (tandem ? 'codex,claude' : 'codex,claude,opencode')
  ).split(',');
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
  const workers = defaultWorkers(Object.keys(runtimes));
  if (!workers.length) {
    console.error('No qualified runtime. Run: npm run xvant -- runtimes');
    process.exit(1);
  }
  // The promoted routing default, with --model and --planner-model over it.
  const routing = activeRouting(home);
  const settings = {
    models: { ...routing?.settings.models },
    ...(routing?.settings.plannerModel
      ? { plannerModel: routing.settings.plannerModel }
      : {}),
  };
  for (const pair of values('--model')) {
    const [kind, model] = pair.split('=');
    if (!model || !KINDS.includes(kind)) {
      console.error('--model needs KIND=MODEL, e.g. claude=haiku');
      process.exit(2);
    }
    settings.models[kind] = model;
  }
  if (tandem) {
    // Tandem names its planner's runtime only, so the planner model is unambiguous.
    for (const kind of Object.keys(settings.models))
      if (kind !== tandem.kind) delete settings.models[kind];
    settings.models[tandem.kind] ??= 'default';
  }
  // --planner-model: one worker plans and reviews on that model and implements nothing.
  const plannerModel = value('--planner-model') ?? tandem?.plannerModel;
  if (plannerModel) {
    settings.plannerModel = plannerModel;
    // A model belongs to one runtime. With one runtime in play it is that one.
    const kinds = Object.keys(runtimes);
    if (!Object.keys(settings.models).length && kinds.length === 1)
      settings.models[kinds[0]] = 'default';
  }
  const applied = applyRouting(workers, runtimes, settings);
  // --tier: Claude's implementers split into standard and light, each on its model.
  const tiers = tandem ? { light: 'haiku', standard: 'sonnet' } : {};
  for (const pair of values('--tier')) {
    const [tier, model] = pair.split('=');
    if (!model || !['light', 'standard'].includes(tier)) {
      console.error('--tier needs light=MODEL or standard=MODEL');
      process.exit(2);
    }
    tiers[tier] = model;
  }
  if (Object.keys(tiers).length && runtimes.claude)
    applied.push(...applyTiers(workers, 'claude', tiers));
  if (applied.length)
    console.log(
      'Routing' +
        (routing ? ' (default ' + routing.version + ')' : '') +
        ': ' +
        applied.join('; '),
    );
  if (plannerModel && !workers.some((w) => w.model === plannerModel)) {
    console.error(
      "--planner-model was not applied. Name its runtime with --model KIND=MODEL (use KIND=default to keep that runtime's own model), and make sure another worker can implement.",
    );
    process.exit(2);
  }
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
  const learned = lessonsLine(state.lessons);
  if (learned) console.log('  ' + learned);
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
      const learned = lessonsLine(record.state.lessons);
      if (learned) console.log(learned);
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
  } catch (error) {
    console.error(
      error.message === 'NOT_FOUND'
        ? 'No run named ' + rest[0] + '. List them with: status'
        : 'Status failed: ' + error.message,
    );
    process.exitCode = 1;
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
    checkedIntegration(record.state, realpathSync(record.state.repository));
    store.graphs.update(
      rest[0],
      record.rowVersion,
      { ...record.state, phase: 'accepted' },
      'graph.accepted',
      { actorId: 'user' },
    );
    console.log(
      'Accepted. Merge when you are ready: npm run xvant -- merge ' +
        rest[0] +
        ' --repo "' +
        record.state.repository +
        '"',
    );
  } catch (error) {
    console.error(
      error.message === 'NOT_FOUND'
        ? 'No run named ' + rest[0] + '. List them with: status'
        : error.message,
    );
    process.exitCode = 1;
  } finally {
    store.close();
  }
} else if (command === 'merge') {
  const { store } = open();
  try {
    const record = store.graphs.get(rest[0]);
    if (record.state.phase !== 'accepted')
      throw new Error(
        'Only an accepted result can be merged (it is ' +
          record.state.phase +
          ')',
      );
    const repository = realpathSync(resolve(value('--repo') ?? process.cwd()));
    if (
      !record.state.repository ||
      repository !== realpathSync(record.state.repository)
    )
      throw new Error(
        "REPOSITORY_MISMATCH: merge must use the run's repository checkout",
      );
    const integration = checkedIntegration(record.state, repository);
    // Merge the immutable verified commit, not a branch that can move after
    // validation. Git still applies its ordinary dirty-tree/conflict checks.
    const merged = spawnSync(
      'git',
      ['--no-pager', 'merge', '--no-edit', integration.head],
      { cwd: repository, encoding: 'utf8', windowsHide: true },
    );
    if (merged.stdout) process.stdout.write(merged.stdout);
    if (merged.stderr) process.stderr.write(merged.stderr);
    process.exitCode = merged.status ?? 1;
  } catch (error) {
    console.error(
      error.message === 'NOT_FOUND'
        ? 'No run named ' + rest[0] + '. List them with: status'
        : error.message,
    );
    process.exitCode = 1;
  } finally {
    store.close();
  }
} else if (command === 'backup') {
  // state.sqlite (a consistent snapshot) and objects/; never runs/.
  const { backupState, describeBackup } =
    await import('../packages/storage/src/backup.ts');
  const version = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ).version;
  const out = resolve(
    value('--out') ??
      join(home + '-backups', new Date().toISOString().replace(/[:.]/g, '-')),
  );
  try {
    const { directory, manifest } = backupState({
      home,
      out,
      xvantVersion: version,
    });
    console.log('Backup written to ' + directory);
    console.log(describeBackup(manifest));
    console.log(
      'Not included: runs/ (worktrees belong to their repositories).',
    );
  } catch (error) {
    console.error('Backup failed: ' + error.message);
    process.exit(1);
  }
} else if (command === 'restore') {
  const { restoreState, describeBackup } =
    await import('../packages/storage/src/backup.ts');
  const from = value('--from');
  if (!from) {
    console.error('restore needs --from DIR [--force]');
    process.exit(2);
  }
  try {
    const result = restoreState({
      from: resolve(from),
      home,
      force: rest.includes('--force'),
    });
    console.log('Restored ' + describeBackup(result.manifest));
    console.log('Database integrity: ' + result.integrity);
    if (result.movedAside)
      console.log('Previous state moved to ' + result.movedAside);
    console.log('State directory: ' + result.home);
  } catch (error) {
    console.error('Restore failed: ' + error.message);
    process.exit(1);
  }
} else if (command === 'lessons') {
  // The challenge/solution graph runs record: what went wrong and what fixed it.
  const { lessonsToMarkdown, lessonsToMermaid, renderLessons } =
    await import('../packages/memory/src/lessons.ts');
  const { store } = open();
  try {
    // Lessons are scoped per repository: the one given, else the current
    // one, else the legacy shared scope.
    let project = value('--project');
    if (!project) {
      const { lessonScope } =
        await import('../packages/storage/src/lesson-scope.ts');
      try {
        project = lessonScope(resolve(value('--repo') ?? process.cwd()));
      } catch {
        project = 'cli';
      }
    }
    const format = value('--format') ?? 'md';
    const flags = new Set(['--project', '--repo', '--format', '--reason']);
    const all = rest.includes('--all');
    const words = rest.filter(
      (arg, i) => arg !== '--all' && !flags.has(arg) && !flags.has(rest[i - 1]),
    );
    const [action = 'list', ...args] = words;
    const usage = () => {
      console.error(
        'Usage: lessons [list [--all] | show ID | search TEXT | export [--all] | stats | forget ID --reason TEXT] [--format md|mermaid|json] [--project ID | --repo PATH]',
      );
      process.exitCode = 2;
    };
    // Forgotten nodes stay in the graph for audit; reads hide them unless --all.
    const everything = store.lessons.nodes(project);
    const allEdges = store.lessons.edges(project);
    const nodes = all ? everything : everything.filter((n) => !n.forgotten);
    const kept = new Set(nodes.map((n) => n.id));
    const edges = allEdges.filter((e) => kept.has(e.from) && kept.has(e.to));
    if (action === 'forget') {
      const reason = (value('--reason') ?? '').trim();
      if (args.length !== 1 || !reason) usage();
      else
        try {
          const node = store.lessons.forget(project, args[0], reason);
          console.log(
            'Forgot ' +
              node.kind +
              ' ' +
              node.id +
              ' (' +
              node.forgotten.reason +
              '). It stays in the graph for audit: lessons list --all',
          );
        } catch (error) {
          console.error(
            error.message === 'NOT_FOUND'
              ? 'No lesson ' +
                  args[0] +
                  ' in ' +
                  project +
                  '. List them with: lessons list --all'
              : 'Forget failed: ' + error.message,
          );
          process.exitCode = 1;
        }
    } else if (action === 'stats') {
      const { lessonReport, renderReport } =
        await import('../packages/memory/src/lessons.ts');
      // Only this scope's newest runs are read, filtered in the database.
      const report = lessonReport(
        store.graphs.lessonSummaries(project, 200).map((r) => r.lessons),
        everything,
        allEdges,
        200,
      );
      console.log(
        format === 'json'
          ? JSON.stringify({ project, ...report }, null, 2)
          : renderReport(project, report),
      );
    } else if (action === 'list') {
      const count = (id, relation) =>
        edges.filter((e) => e.from === id && e.relation === relation).length;
      const challenges = nodes.filter((n) => n.kind === 'challenge');
      if (!challenges.length) console.log('No lessons recorded for ' + project);
      for (const n of challenges.sort((a, b) => b.lastSeenAt - a.lastSeenAt))
        console.log(
          n.id.padEnd(20),
          ('seen ' + n.occurrences + '×').padEnd(9),
          ('fixes ' + count(n.id, 'solved_by')).padEnd(8),
          ('dead ends ' + count(n.id, 'not_solved_by')).padEnd(12),
          (n.forgotten ? '[forgotten] ' : '') +
            n.title.split('\n')[0].slice(0, 90),
        );
    } else if (action === 'show' && args[0]) {
      const node = store.lessons.get(project, args[0]);
      if (node.forgotten)
        console.log(
          'FORGOTTEN ' +
            new Date(node.forgotten.at).toISOString() +
            ': ' +
            node.forgotten.reason,
        );
      console.log(JSON.stringify(node, null, 2));
      for (const e of allEdges.filter(
        (e) => e.from === node.id || e.to === node.id,
      ))
        console.log(e.from, '--' + e.relation + ' ×' + e.count + '->', e.to);
    } else if (action === 'search' && args.length) {
      const matches = store.lessons.find(project, {
        query: args.join(' '),
        limit: 5,
      });
      console.log(
        format === 'json'
          ? JSON.stringify(matches, null, 2)
          : renderLessons(matches, 20000) || 'No matching lessons.',
      );
    } else if (action === 'export') {
      console.log(
        format === 'json'
          ? JSON.stringify({ project, nodes, edges }, null, 2)
          : format === 'mermaid'
            ? lessonsToMermaid(nodes, edges)
            : lessonsToMarkdown(nodes, edges),
      );
    } else usage();
  } finally {
    store.close();
  }
} else if (command === 'share') {
  // Keeps one branch of a checkout in step with its remote, so several
  // accounts on several devices edit the same files. Git is the store.
  const { syncOnce, describeSync } =
    await import('../apps/controller/src/share.ts');
  const repo = value('--repo');
  const branch = value('--branch');
  if (!repo || !branch) {
    console.error(
      'share needs --repo PATH and --branch NAME [--remote origin] [--interval SECONDS] [--once]',
    );
    process.exit(2);
  }
  const options = {
    repository: realpathSync(resolve(repo)),
    branch,
    ...(value('--remote') ? { remote: value('--remote') } : {}),
  };
  const seconds = Number(value('--interval') ?? 5);
  if (!(seconds >= 1 && seconds <= 3600)) {
    console.error('--interval must be 1 to 3600 seconds');
    process.exit(2);
  }
  const cycle = () => {
    const stamp = new Date().toTimeString().slice(0, 8);
    const result = syncOnce(options);
    for (const line of describeSync(result)) console.log(stamp + '  ' + line);
    return result;
  };
  try {
    const result = cycle();
    // syncOnce reserves notes for unreachable remotes / rejected publication.
    // Continuous sharing retries those races; a one-shot caller needs failure.
    if (rest.includes('--once') && result.note) process.exitCode = 1;
  } catch (error) {
    // The first cycle's failure is a setup problem: say so and stop.
    console.error('Share failed: ' + error.message);
    if (error.message.startsWith('WRONG_BRANCH'))
      console.error(
        'Switch first: git -C "' +
          options.repository +
          '" switch ' +
          branch +
          '   (add -c to create it)',
      );
    process.exit(1);
  }
  if (!rest.includes('--once')) {
    console.log(
      'Sharing ' +
        options.repository +
        ' on ' +
        branch +
        ' every ' +
        seconds +
        ' s (Ctrl+C to stop).',
    );
    const timer = setInterval(() => {
      try {
        cycle();
      } catch (error) {
        console.error('Cycle failed, retrying: ' + error.message);
      }
    }, seconds * 1000);
    process.on('SIGINT', () => {
      clearInterval(timer);
      console.log('Stopped sharing. Nothing is lost; run it again to resume.');
    });
  }
} else {
  console.error(
    'Commands: shell | ui | runtimes | run | status [ID] | accept ID | merge ID [--repo PATH] | share | backup | restore | lessons',
  );
  process.exit(2);
}
