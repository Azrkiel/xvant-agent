// Clean-install check (P10.3). Usage: node scripts/clean-install-check.mjs
//   [--include-working-tree] [--keep]
// Clones this repository's HEAD into a fresh temp directory with a short path
// (leaving out docs/, whose evidence paths are long), runs `npm ci`, the type
// check, `xvant runtimes`, and a CLI smoke on an empty XVANT_HOME: status, then
// a backup and restore round trip. Needs the network for `npm ci`.
// --include-working-tree copies this checkout's uncommitted and untracked
// files (except docs/) over the clone, to check changes before they are
// committed; the receipt says so. Writes docs/evidence/P10-clean-install.json.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, platform, release, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { archiveRun, sourceHash } from './evidence-bundle.ts';
import { runBounded } from './bounded-run.ts';

const args = process.argv.slice(2);
const overlay = args.includes('--include-working-tree');
const root = resolve('.');
const gateId = 'P10-clean-install';
const git = (cwd, ...command) =>
  spawnSync('git', command, { cwd, encoding: 'utf8', windowsHide: true });
const gitOut = (...command) => (git(root, ...command).stdout ?? '').trim();

// npm.cmd cannot be started without a shell; run npm's own script with node.
function npmCli() {
  if (process.env.npm_execpath?.endsWith('.js'))
    return process.env.npm_execpath;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const base of [dir, dirname(dir)]) {
      const script = join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (dir && existsSync(script)) return script;
    }
  }
  return null;
}

const dirty = git(root, 'status', '--porcelain')
  .stdout.split('\n')
  .filter((l) => l && !l.slice(3).startsWith('docs/'));
const report = {
  gateId,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  classification: 'offline',
  operatingSystem: platform() + ' ' + release(),
  executionHost: hostname(),
  nodeVersion: process.version,
  sourceHash: sourceHash(root),
  commit: gitOut('rev-parse', 'HEAD'),
  source: overlay ? 'HEAD plus this working tree (except docs/)' : 'HEAD',
  uncommittedOutsideDocs: dirty.length,
  network: 'npm registry (npm ci); nothing paid, no model',
  steps: [],
  limitations: [
    'Same host, same Node, same git and npm cache as development: this is a clean checkout and a clean node_modules, not a fresh machine.',
    'Needs the network for npm ci (prebuilt native binaries are downloaded).',
    'The runtimes step needs three lines, not qualified runtimes: it does not prove a Codex, Claude or OpenCode login works.',
    'Windows only; Linux is deferred by the operator. Upgrade and rollback between versions are not exercised.',
    overlay
      ? 'The clone was built from HEAD with this working tree copied over it, so it proves the uncommitted state, not a commit.'
      : 'Only HEAD is tested; uncommitted changes are not in the clone.',
  ],
  problems: [],
};
if (!overlay && dirty.length)
  report.problems.push(
    dirty.length +
      ' uncommitted change(s) outside docs/ are not part of HEAD; commit them or pass --include-working-tree',
  );

const base = realpathSync(mkdtempSync(join(tmpdir(), 'xci-')));
const clone = join(base, 'r');
const logs = join(base, 'logs');
mkdirSync(logs);
const run = async (name, command, commandArgs, options = {}) => {
  const started = Date.now();
  // runBounded passes the environment through, so set the variables around the call.
  const vars = options.vars ?? {};
  Object.assign(process.env, vars);
  const result = await runBounded(command, commandArgs, {
    cwd: options.cwd ?? clone,
    timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
    logPath: join(logs, name + '.log'),
  }).finally(() => {
    for (const key of Object.keys(vars)) delete process.env[key];
  });
  const tail = result.output.trim().split('\n').slice(-12).join('\n');
  const step = {
    name,
    command: [command === process.execPath ? 'node' : command, ...commandArgs]
      .join(' ')
      .replaceAll(base, '<tmp>'),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    passed: result.exitCode === 0 && !result.timedOut,
    outputTail: tail.replaceAll(base, '<tmp>'),
  };
  report.steps.push(step);
  console.log(
    name +
      ': ' +
      (step.passed ? 'ok' : 'FAILED') +
      ' (' +
      step.durationMs +
      ' ms)',
  );
  if (!step.passed) {
    // The first error line names the cause; the last is often only a log path.
    const lines = result.output.split('\n').map((l) => l.trim());
    step.errorLines = lines
      .filter((l) => /error/i.test(l) && !/complete log/i.test(l))
      .slice(0, 8)
      .map((l) => l.replaceAll(base, '<tmp>'));
    const cause =
      lines.find(
        (l) =>
          /error/i.test(l) &&
          !/complete log/i.test(l) &&
          l.replace(/npm error/i, '').trim() &&
          !/^npm error (code|$)/i.test(l),
      ) ?? lines.filter(Boolean).at(-1);
    report.problems.push(name + ' failed: ' + cause);
  }
  return { step, output: result.output };
};

try {
  // A sparse checkout without docs/ keeps the path length down.
  const cloned = git(
    base,
    '-c',
    'core.longpaths=true',
    'clone',
    '--quiet',
    '--no-checkout',
    root,
    clone,
  );
  if (cloned.status !== 0) throw new Error('clone failed: ' + cloned.stderr);
  for (const step of [
    ['config', 'core.longpaths', 'true'],
    ['sparse-checkout', 'set', '--no-cone', '/*', '!/docs/'],
    ['checkout', '--quiet', report.commit],
  ]) {
    const done = git(clone, ...step);
    if (done.status !== 0)
      throw new Error('git ' + step[0] + ' failed: ' + done.stderr);
  }
  report.docsInClone = existsSync(join(clone, 'docs'));
  if (report.docsInClone) report.problems.push('docs/ is present in the clone');
  if (overlay) {
    const listing = gitOut(
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    );
    for (const path of listing
      .split('\0')
      .filter((p) => p && !p.startsWith('docs/'))) {
      const from = join(root, path);
      const to = join(clone, path);
      if (existsSync(from)) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      } else rmSync(to, { force: true });
    }
  }

  const npm = npmCli();
  if (!npm) throw new Error('Cannot find npm-cli.js on PATH');
  report.npmVersion = spawnSync(process.execPath, [npm, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout.trim();
  const install = await run(
    'npm-ci',
    process.execPath,
    [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      timeoutMs: 15 * 60 * 1000,
    },
  );
  if (install.step.passed) {
    await run('typecheck', process.execPath, [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
    ]);
    const runtimes = await run('runtimes', process.execPath, [
      'scripts/xvant.mjs',
      'runtimes',
    ]);
    const lines = runtimes.output.trim().split('\n').filter(Boolean);
    const kinds = lines
      .map((l) => l.split(/\s+/)[0])
      .sort()
      .join(',');
    report.runtimeLines = lines.length;
    if (runtimes.step.passed && kinds !== 'claude,codex,opencode')
      report.problems.push(
        'runtimes printed ' + lines.length + ' line(s) for: ' + kinds,
      );

    // A real database and object, so the round trip compares something.
    const home = join(base, 'home');
    const restored = join(base, 'restored');
    const backup = join(base, 'backup');
    const env = { vars: { XVANT_HOME: home } };
    const inline = (body) => [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      body,
    ];
    await run(
      'status-empty-home',
      process.execPath,
      ['scripts/xvant.mjs', 'status'],
      env,
    );
    const seed = await run(
      'seed-state',
      process.execPath,
      inline(
        "import {Store} from './packages/storage/src/store.ts';import {ArtifactStore} from './packages/storage/src/artifacts.ts';" +
          "const s=new Store(process.env.XVANT_HOME+'/state.sqlite',{owner:'seed'});" +
          "s.create('c',{id:'seed-task',projectId:'p',objective:'o',requiredCheckIds:['t'],acceptanceCriteria:['a']});s.close();" +
          "console.log(new ArtifactStore(process.env.XVANT_HOME+'/objects').put(Buffer.from('clean-install')))",
      ),
      env,
    );
    const hash = seed.output.trim().split('\n').at(-1);
    await run(
      'backup',
      process.execPath,
      ['scripts/xvant.mjs', 'backup', '--out', backup],
      env,
    );
    const restore = await run(
      'restore',
      process.execPath,
      ['scripts/xvant.mjs', 'restore', '--from', backup],
      { vars: { XVANT_HOME: restored } },
    );
    if (
      restore.step.passed &&
      !restore.output.includes('Database integrity: ok')
    )
      report.problems.push('restore did not report an ok integrity check');
    await run(
      'verify-restored',
      process.execPath,
      inline(
        "import {Store} from './packages/storage/src/store.ts';import {ArtifactStore} from './packages/storage/src/artifacts.ts';" +
          "const s=new Store(process.env.XVANT_HOME+'/state.sqlite',{owner:'verify'});" +
          "if(s.getTask('seed-task').id!=='seed-task'||s.integrity()!=='ok')process.exit(1);s.close();" +
          "if(new ArtifactStore(process.env.XVANT_HOME+'/objects').get(process.env.HASH).toString()!=='clean-install')process.exit(1)",
      ),
      { vars: { XVANT_HOME: restored, HASH: hash } },
    );
    const backups = [backup, restored].every((p) => existsSync(p));
    if (!backups) report.problems.push('backup or restore directory missing');
  }
} catch (error) {
  report.problems.push('Check could not complete: ' + error.message);
} finally {
  if (args.includes('--keep')) console.log('kept ' + base);
  else
    rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
}
if (sourceHash(root) !== report.sourceHash)
  report.problems.push('Source changed during the run');
report.status = report.problems.length === 0 ? 'passed' : 'failed';
mkdirSync('docs/evidence', { recursive: true });
const receiptFile = resolve(root, 'docs/evidence/' + gateId + '.json');
writeFileSync(receiptFile, JSON.stringify(report, null, 2) + '\n');
console.log(gateId + ': ' + report.status);
if (report.problems.length) console.log(report.problems.join('\n'));
process.exitCode = report.status === 'passed' ? 0 : 1;
try {
  const bundle = archiveRun({
    receiptFile,
    sourceRoot: root,
    destination: resolve(root, 'docs/evidence/runs'),
  });
  console.log('evidence bundle: ' + bundle.bundleId + ' ' + bundle.integrity);
} catch (error) {
  console.error('Evidence archival failed: ' + error.message);
  process.exitCode = 1;
}
