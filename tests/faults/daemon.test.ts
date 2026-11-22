import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL('../../scripts/xvant.mjs', import.meta.url),
);
const config = fileURLToPath(
  new URL('../fixtures/daemon-runner.ts', import.meta.url),
);
const readinessMs = 5_000;
const dispatchMs = 2_000;
const stopMs = 10_000;
const idleMs = 3_000;
let dir: string;
let home: string;
let env: NodeJS.ProcessEnv;
const daemons = new Set<ChildProcess>();
type Endpoint = { origin: string; token: string; process: { pid: number } };
type Call = {
  taskId: string;
  alias: string;
  operationId: string;
  attemptId: string;
};

const endpoint = (): Endpoint =>
  JSON.parse(readFileSync(join(home, 'daemon', 'endpoint.json'), 'utf8'));
const calls = (): Call[] => {
  try {
    return readFileSync(join(dir, 'calls'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};
const forRoot = (id: string) =>
  calls().filter(({ taskId }) => taskId.startsWith(id + '-'));
const release = (id: string) => writeFileSync(join(dir, 'release-' + id), '');
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function repo(name: string) {
  const path = join(dir, name);
  mkdirSync(path);
  git(path, 'init', '-q');
  git(path, 'add', '-A');
  git(
    path,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'base',
    '--allow-empty',
  );
  return path;
}

async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  ms: number,
): Promise<T> {
  const limit = performance.now() + ms;
  let last: T | undefined;
  do {
    last = await read();
    if (done(last)) return last;
    await delay(30);
  } while (performance.now() < limit);
  throw new Error(
    'Fixture deadline elapsed. Last observation: ' + JSON.stringify(last),
  );
}

function launch() {
  const child = spawn(process.execPath, [script, 'daemon', 'serve'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemons.add(child);
  let output = '';
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exit = new Promise<number | null>((resolve) =>
    child.once('exit', resolve),
  );
  return { child, exit, output: () => output };
}

async function ready(started: ReturnType<typeof launch>) {
  const pid = started.child.pid;
  await until(
    () => {
      if (started.child.exitCode !== null) throw new Error(started.output());
      try {
        return endpoint().process.pid;
      } catch {
        return undefined;
      }
    },
    (seen) => seen === pid,
    readinessMs,
  );
  const reply = await api('daemon');
  expect(reply.status).toBe(200);
  return reply.data;
}
async function cli(...args: string[]) {
  const { stdout } = await exec(process.execPath, [script, 'daemon', ...args], {
    env,
    timeout: stopMs,
  });
  return JSON.parse(stdout);
}
const submit = (
  key: string,
  path: string,
  objective: string,
  runtime = 'codex',
  ...options: string[]
) =>
  cli(
    'submit',
    '--id',
    key,
    '--repo',
    path,
    '--objective',
    objective,
    '--only',
    runtime,
    '--max-active',
    '1',
    '--no-review',
    ...options,
  );
async function api(
  path: string,
  body?: object,
  entry = endpoint(),
  authenticated = true,
) {
  const response = await fetch(entry.origin + '/api/v1/' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      origin: entry.origin,
      ...(authenticated ? { authorization: 'Bearer ' + entry.token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(dispatchMs),
  });
  return { status: response.status, data: await response.json() };
}

function db() {
  return new Database(join(home, 'state.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
}
function processUse(pid: number) {
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
    .split(') ')
    .at(-1)!
    .split(' ');
  const rss = readFileSync('/proc/' + pid + '/status', 'utf8').match(
    /^VmRSS:\s+(\d+) kB/m,
  )![1];
  return { cpuTicks: Number(stat[11]) + Number(stat[12]), rssKb: Number(rss) };
}

async function measureIdle(pid: number, label: string) {
  const before = calls();
  const stats = (await api('daemon')).data;
  const idle = processUse(pid);
  await delay(idleMs);
  expect(calls()).toEqual(before);
  expect((await api('daemon')).data.schedulerPasses).toBe(
    stats.schedulerPasses,
  );
  const after = processUse(pid);
  const ticksPerSecond = Number(
    execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }),
  );
  expect(
    ((after.cpuTicks - idle.cpuTicks) * 1000) / ticksPerSecond,
  ).toBeLessThanOrEqual(200);
  expect(after.rssKb).toBeLessThanOrEqual(256 * 1024);
  console.info('A04 ' + label + ' sample', {
    cpuMs: ((after.cpuTicks - idle.cpuTicks) * 1000) / ticksPerSecond,
    rssKb: after.rssKb,
    intervalMs: idleMs,
    extraTurns: calls().length - before.length,
  });
}

describe('A04 daemon process fixtures', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xvant-a04-'));
    home = join(dir, 'state');
    env = {
      ...process.env,
      XVANT_HOME: home,
      XVANT_DAEMON_CONFIG: config,
      XVANT_DAEMON_FIXTURE_DIR: dir,
      XVANT_DAEMON_WORKERS: '2',
    };
  });

  afterEach(async () => {
    const exits = [];
    for (const child of daemons) {
      if (child.exitCode === null && child.signalCode === null) {
        exits.push(new Promise((resolve) => child.once('exit', resolve)));
        child.kill('SIGKILL');
      }
    }
    await Promise.all(exits);
    for (const call of calls()) release(call.taskId);
    daemons.clear();
    await delay(60);
    rmSync(dir, { recursive: true, force: true });
  });

  it('pins the lessons comparison setting in separate stores for identical Git input', async () => {
    const enabledRepo = repo('lessons-enabled');
    const disabledRepo = join(dir, 'lessons-disabled');
    git(dir, 'clone', '-q', enabledRepo, disabledRepo);
    expect(git(disabledRepo, 'rev-parse', 'HEAD')).toBe(
      git(enabledRepo, 'rev-parse', 'HEAD'),
    );
    const observations = [];
    for (const [cohort, path, flags] of [
      ['enabled', enabledRepo, []],
      ['disabled', disabledRepo, ['--no-lessons']],
    ] as const) {
      home = join(dir, 'state-' + cohort);
      env.XVANT_HOME = home;
      await ready(launch());
      await cli('pause-dispatch', '--id', 'study-pause');
      const result = await submit(
        'study-task',
        path,
        'fixture',
        'codex',
        ...flags,
      );
      await cli('stop', '--id', 'study-stop');
      const database = db();
      try {
        const { body } = database
          .prepare('SELECT body FROM work_checkpoints WHERE graph_id=?')
          .get(result.id) as { body: string };
        observations.push(JSON.parse(body).spec);
        expect(
          database.prepare('SELECT COUNT(*) AS count FROM lesson_nodes').get(),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    }
    expect(observations[0]).toMatchObject({
      lessons: true,
      lessonScope: expect.any(String),
    });
    expect(observations[1]).toMatchObject({
      lessons: false,
      lessonScope: null,
    });
    expect(observations[1].baseRevision).toBe(observations[0].baseRevision);
    expect(observations[1].objective).toBe(observations[0].objective);
    expect(calls()).toEqual([]);
  }, 25_000);

  it('retains one durable acceptance and the pinned base after a daemon kill and client reconnect', async () => {
    const path = repo('original');
    const base = git(path, 'rev-parse', 'HEAD');
    const first = launch();
    const owner = await ready(first);
    await cli('pause-dispatch', '--id', 'pause-first');
    const work = await submit('original-command', path, 'hold-root');
    expect(await submit('original-command', path, 'hold-root')).toEqual(work);
    await expect(
      submit('original-command', path, 'changed payload'),
    ).rejects.toThrow('CONFLICT');
    expect((await cli('status', work.id)).job.status).toBe('queued');
    expect(calls()).toEqual([]);
    git(
      path,
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'later',
      '--allow-empty',
    );
    first.child.kill('SIGKILL');
    await first.exit;
    await delay(3_100);
    const second = launch();
    expect((await ready(second)).generation).toBe(owner.generation + 1);
    expect((await cli('status', work.id)).job.status).toBe('queued');
    await cli('continue', '--id', 'resume-dispatch');
    const running = await until(
      () => forRoot(work.id),
      (seen) => seen.length === 1,
      dispatchMs,
    );
    expect(await submit('original-command', path, 'hold-root')).toEqual(work);
    expect((await api('daemon', undefined, endpoint(), false)).status).toBe(
      401,
    );
    const { data } = await api('daemon/bootstrap', {});
    const browser = await fetch(endpoint().origin + '/api/v1/session', {
      method: 'POST',
      headers: {
        origin: endpoint().origin,
        authorization: 'Bearer ' + data.bootstrapToken,
      },
    });
    expect(browser.status).toBe(200);
    await browser.text();
    release(running[0]!.taskId);
    const state = await until(
      async () => (await api('roots/' + work.id)).data,
      (value) => value.job?.status === 'done',
      readinessMs,
    );
    expect(state.state).toMatchObject({
      phase: 'ready',
      integration: { baseCommit: base },
    });
    expect(
      forRoot(work.id).filter(({ taskId }) => taskId.includes('-plan-')),
    ).toHaveLength(1);
    const sqlite = db();
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) count FROM commands WHERE key='original-command' AND kind='schedule.command'",
        )
        .get(),
    ).toEqual({ count: 1 });
    sqlite.close();
    const accept = [
      'accept',
      work.id,
      '--id',
      'manual-accept',
      '--expected-version',
      String(state.rowVersion),
      '--head',
      state.state.integration.head,
    ];
    const receipt = await cli(...accept);
    expect(await cli(...accept)).toEqual(receipt);
    await measureIdle(second.child.pid!, 'idle');
    const stopped = await cli('stop', '--id', 'stop-tested');
    expect(stopped).toMatchObject({
      stopping: true,
      stopped: true,
    });
    expect(await second.exit).toBe(0);
    const third = launch();
    await ready(third);
    expect(await cli('stop', '--id', 'stop-tested')).toEqual({
      ...stopped,
      stopped: false,
    });
    expect(await cli('status')).toMatchObject({
      ready: true,
      generation: stopped.generation + 1,
    });
    await cli('stop', '--id', 'stop-third');
  }, 25_000);

  it('races daemon starts and fences a late result while an unrelated project remains eligible', async () => {
    const path = repo('contended');
    const a = launch();
    const b = launch();
    const winner = await until(
      () => {
        try {
          return endpoint().process.pid;
        } catch {
          return 0;
        }
      },
      (pid) => pid > 0,
      readinessMs,
    );
    const [old, loser] = winner === a.child.pid ? [a, b] : [b, a];
    expect(await loser.exit).toBe(1);
    expect(loser.output()).toContain('LEASE_BUSY');
    const original = endpoint();
    const oldStatus = (await api('daemon')).data;
    const work = await submit('ambiguous-turn', path, 'hold-root');
    const running = await until(
      () => forRoot(work.id),
      (seen) => seen.length === 1,
      dispatchMs,
    );
    expect(old.child.kill('SIGSTOP')).toBe(true);
    await delay(3_100);
    const next = launch();
    const newStatus = await ready(next);
    expect(newStatus.generation).toBe(oldStatus.generation + 1);
    expect((await api('roots/' + work.id)).data).toMatchObject({
      job: { status: 'blocked', reason: 'UNRESOLVED_WORKFLOW_ACTION' },
      recovery: [
        {
          classification: 'owned_running',
          decision: 'block',
          attemptId: running[0]!.attemptId,
        },
      ],
    });
    expect(
      (
        await api(
          'daemon/control',
          { action: 'continue', commandId: 'old-credential' },
          {
            ...endpoint(),
            token: original.token,
          },
        )
      ).status,
    ).toBe(401);
    release(running[0]!.taskId);
    await until(
      () =>
        existsSync(join(dir, 'release-' + running[0]!.taskId + '.finished')),
      Boolean,
      dispatchMs,
    );
    expect(old.child.kill('SIGCONT')).toBe(true);
    expect(await old.exit).toBe(1);
    expect((await api('roots/' + work.id)).data.job.status).toBe('blocked');
    const blocked = await submit(
      'blocked-other',
      repo('same-worker'),
      'blocked fixture',
    );
    const independent = await submit(
      'independent',
      repo('other-worker'),
      'independent fixture',
      'claude',
    );
    const done = await until(
      async () => (await api('roots/' + independent.id)).data,
      (value) => value.job.status === 'done',
      readinessMs,
    );
    expect(done.state.phase).toBe('ready');
    expect((await api('roots/' + blocked.id)).data.job.reason).toBe(
      'RECONCILIATION_REQUIRED',
    );
    await measureIdle(next.child.pid!, 'blocked');
    expect(await cli('stop', '--id', 'stop-after-takeover')).toMatchObject({
      stopped: true,
    });
  }, 30_000);

  it('distinguishes intake, dispatch, drain, cancellation and shutdown for busy and due projects', async () => {
    const first = launch();
    await ready(first);
    await cli('pause-intake', '--id', 'pause-accept');
    const path = repo('busy');
    await expect(submit('new-root', path, 'hold-root')).rejects.toThrow(
      'INTAKE_PAUSED',
    );
    await cli('continue', '--id', 'continue-intake');
    const work = await submit('new-root', path, 'hold-root');
    await until(
      () => forRoot(work.id).length,
      (count) => count === 1,
      dispatchMs,
    );
    const queued = await submit('competing-root', path, 'never dispatched');
    const due = await submit(
      'due-root',
      repo('due'),
      'due fixture',
      'claude',
      '--due-at',
      new Date(Date.now() + 600).toISOString(),
    );
    await until(
      () => forRoot(due.id).length,
      (count) => count > 0,
      dispatchMs,
    );
    expect(forRoot(work.id)).toHaveLength(1);
    const draining = await cli('drain', '--id', 'drain-again');
    expect(draining).toMatchObject({ intake: 0, dispatch: 0, draining: 1 });
    expect((await api('daemon')).data.drained).toBe(false);
    await cli('cancel', queued.id, '--id', 'cancel-queued');
    expect((await api('roots/' + queued.id)).data).toMatchObject({
      state: { phase: 'cancelled' },
      job: { status: 'cancelled' },
    });
    expect(forRoot(queued.id)).toEqual([]);
    await cli('cancel', work.id, '--id', 'cancel-running');
    const cancelled = await until(
      async () => (await api('roots/' + work.id)).data,
      (value) => value.job.status === 'cancelled',
      dispatchMs,
    );
    expect(cancelled.state.phase).toBe('cancelled');
    expect(forRoot(work.id)).toHaveLength(1);
    await until(
      async () => (await api('daemon')).data.drained,
      Boolean,
      dispatchMs,
    );
    expect(await cli('stop', '--id', 'stop-drained')).toMatchObject({
      stopped: true,
    });
    expect(await first.exit).toBe(0);
  }, 25_000);

  it('stops an active daemon on SIGTERM and preserves uncertainty through restart and cancellation', async () => {
    const first = launch();
    await ready(first);
    const work = await submit('shutdown-active', repo('shutdown'), 'hold-root');
    await until(
      () => forRoot(work.id).length,
      (count) => count === 1,
      dispatchMs,
    );
    expect(first.child.kill('SIGTERM')).toBe(true);
    await until(
      () => first.child.exitCode,
      (code) => code !== null,
      stopMs,
    );
    expect(await first.exit).toBe(0);
    const next = launch();
    await ready(next);
    const status = await api('roots/' + work.id);
    expect(status.data).toMatchObject({
      job: { status: 'blocked', reason: 'UNRESOLVED_WORKFLOW_ACTION' },
      recovery: [{ classification: 'stopped_incomplete', decision: 'block' }],
    });
    await cli('cancel', work.id, '--id', 'cancel-unresolved');
    expect((await api('roots/' + work.id)).data.job).toMatchObject({
      status: 'blocked',
      cancelRequested: 1,
    });
    expect(forRoot(work.id)).toHaveLength(1);
    expect(await cli('stop', '--id', 'stop-recovered')).toMatchObject({
      stopped: true,
    });
  }, 25_000);

  it('stores an owner backlog through the daemon without submitting work', async () => {
    const repository = repo('backlog');
    const first = launch();
    await ready(first);
    const project = {
      schemaVersion: 1,
      id: 'backlog',
      version: 1,
      ownerIntent: {
        actorId: 'owner',
        objective: 'Prepare an offline fixture',
      },
      requirements: [{ id: 'fixture', description: 'Confirm the fixture' }],
      exclusions: [],
      scope: { repository, paths: ['.'], excludedPaths: [] },
    };
    const policy = {
      schemaVersion: 1,
      projectId: project.id,
      projectVersion: project.version,
      version: 1,
      ownerId: 'owner',
      authority: {
        scope: project.scope,
        actions: ['read', 'report'],
        providers: ['codex'],
        budget: { attempts: 1, wallTimeMs: 1000, tokens: 0, costMicros: 0 },
        delivery: { localCandidate: false, createPr: false, merge: false },
      },
      verifier: { id: 'fixture', configHash: 'a'.repeat(64), checks: [] },
      review: { required: false },
      automaticAcceptance: false,
      escalation: { onBlock: 'stop', allowManualException: false },
    };
    expect(
      (
        await api('contracts', {
          kind: 'project',
          commandId: 'owner-project',
          expectedVersion: 0,
          project,
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await api('contracts', {
          kind: 'policy',
          commandId: 'owner-policy',
          expectedVersion: 0,
          policy,
        })
      ).status,
    ).toBe(202);
    const backlog = {
      schemaVersion: 1,
      projectId: project.id,
      projectVersion: project.version,
      policyVersion: policy.version,
      revision: 1,
      reason: 'Record the requested fixture',
      milestones: [
        {
          id: 'confirm',
          title: 'Confirm fixture',
          reason: 'Observe it first',
          priority: 0,
          dependsOn: [],
          requirementIds: ['fixture'],
        },
      ],
      notes: [],
    };
    const path = join(dir, 'backlog.json');
    writeFileSync(
      path,
      JSON.stringify({
        kind: 'backlog',
        commandId: 'owner-backlog',
        expectedRevision: 0,
        backlog,
      }),
    );
    const applied = await exec(
      process.execPath,
      [script, 'contracts', 'apply', '--file', path],
      { env, timeout: stopMs },
    );
    expect(JSON.parse(applied.stdout)).toEqual(backlog);
    await cli('stop', '--id', 'stop-backlog');
    expect(await first.exit).toBe(0);
    const next = launch();
    const scheduler = await ready(next);
    expect(scheduler.jobs).toEqual([]);
    const inspected = await exec(
      process.execPath,
      [script, 'contracts', 'backlog', project.id],
      { env, timeout: stopMs },
    );
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      status: 'current',
      backlog,
    });
    expect(calls()).toEqual([]);
    await cli('stop', '--id', 'stop-backlog-next');
  }, 25_000);
});
