import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp } from '../apps/controller/src/app.ts';
import {
  currentProcess,
  probeProcess,
} from '../packages/supervisor/src/process-identity.ts';
import { DaemonClock } from '../apps/controller/src/daemon-clock.ts';

const cli = fileURLToPath(new URL('xvant.mjs', import.meta.url));
const originPattern = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/;
const paths = (home) => ({
  dir: join(home, 'daemon'),
  manifest: join(home, 'daemon', 'endpoint.json'),
  log: join(home, 'daemon', 'daemon.log'),
});

function ensurePrivateState(home) {
  if (process.platform !== 'linux') throw new Error('DAEMON_REQUIRES_LINUX');
  const { dir } = paths(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('DAEMON_DIRECTORY_MUST_BE_PRIVATE');
}

export function daemonEndpoint(home) {
  const { manifest } = paths(home);
  const stat = lstatSync(manifest, { throwIfNoEntry: false });
  if (!stat) return null;
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('DAEMON_ENDPOINT_MUST_BE_PRIVATE');
  const entry = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!originPattern.test(entry.origin) || !/^[a-f0-9]{64}$/.test(entry.token))
    throw new Error('DAEMON_ENDPOINT_INVALID');
  return entry;
}

export async function daemonRequest(entry, path, body) {
  const response = await fetch(entry.origin + '/api/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: {
      origin: entry.origin,
      authorization: 'Bearer ' + entry.token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(2000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'DAEMON_REQUEST_FAILED');
  return data;
}

export async function daemonServe(home) {
  ensurePrivateState(home);
  process.umask(0o077);
  const { manifest } = paths(home);
  const token = randomBytes(32).toString('hex');
  let stopping = false;
  let app;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    const deadline = setTimeout(() => process.exit(1), 9_000);
    deadline.unref();
    const finish = async () => {
      if (!app) return;
      try {
        app.store.workflows.atomic(() => {
          if (daemonEndpoint(home)?.token === token) unlinkSync(manifest);
        });
      } catch (error) {
        if (error.code !== 'STALE_FENCE')
          console.error('Daemon endpoint cleanup failed.');
      }
      await app.close();
      clearTimeout(deadline);
    };
    void finish().catch(() => process.exit(1));
  };
  let startupSignal = false;
  const signal = () => {
    if (app) stop();
    else startupSignal = true;
  };
  process.on('SIGTERM', signal);
  process.on('SIGINT', signal);
  const configPath = process.env.XVANT_DAEMON_CONFIG;
  const config = configPath
    ? (await import(pathToFileURL(resolve(configPath)).href)).default
    : {};
  if (
    configPath &&
    (typeof config?.discover !== 'function' ||
      typeof config.runner !== 'function')
  )
    throw new Error('INVALID_DAEMON_CONFIG');
  const slots = Number(process.env.XVANT_DAEMON_WORKERS ?? 3);
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > 10)
    throw new Error('INVALID_DAEMON_WORKER_LIMIT');
  app = await startApp({
    home,
    ...(config.discover
      ? { discover: config.discover, runner: config.runner }
      : {}),
    daemon: {
      operatorToken: token,
      clock: new DaemonClock(),
      slots,
      shutdown: () => setImmediate(() => stop()),
      onError: (error) => {
        console.error(
          'Daemon scheduler stopped: ' + (error.code ?? 'DAEMON_RUNTIME_ERROR'),
        );
        if (app) stop(1);
        else startupSignal = true;
      },
    },
  });
  if (startupSignal) return stop(1);
  try {
    app.store.workflows.atomic(() => {
      const temporary = manifest + '.' + randomBytes(8).toString('hex');
      writeFileSync(
        temporary,
        JSON.stringify({
          origin: app.origin,
          token,
          process: currentProcess(),
          generation: app.store.ownership.generation,
        }),
        { mode: 0o600, flag: 'wx' },
      );
      renameSync(temporary, manifest);
    });
  } catch (error) {
    stop(1);
    throw error;
  }
  console.log('Daemon ready at ' + app.origin);
}

export function daemonSubmit(rest, value, values) {
  const commandId = value('--id');
  const repository = value('--repo');
  const objective = value('--objective');
  if (!commandId || !repository || !objective)
    throw new Error(
      'Usage: daemon submit --id KEY --repo PATH --objective TEXT',
    );
  const supported = new Set([
    '--id',
    '--repo',
    '--objective',
    '--criterion',
    '--check',
    '--max-active',
    '--priority',
    '--due-at',
    '--only',
  ]);
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--no-review' || arg === '--no-lessons' || arg === '--daemon')
      continue;
    if (!supported.has(arg) || index + 1 === rest.length)
      throw new Error('Unsupported daemon submit argument: ' + arg);
    index++;
  }
  return {
    commandId,
    repository: resolve(repository),
    objective,
    criteria: values('--criterion'),
    checks: values('--check'),
    review: !rest.includes('--no-review'),
    ...(rest.includes('--no-lessons') ? { lessons: false } : {}),
    ...(value('--max-active') !== undefined
      ? { maxActive: Number(value('--max-active')) }
      : {}),
    ...(value('--priority') !== undefined
      ? { priority: Number(value('--priority')) }
      : {}),
    ...(value('--due-at') !== undefined
      ? { dueAt: Date.parse(value('--due-at')) }
      : {}),
    ...(value('--only') ? { runtimes: value('--only').split(',') } : {}),
  };
}

export async function daemonCli(home, rest, value, values) {
  const [action, id] = rest;
  if (action === 'serve') return daemonServe(home);
  if (action === 'start') {
    ensurePrivateState(home);
    const current = daemonEndpoint(home);
    if (current) {
      const status = await daemonRequest(current, 'daemon').catch(() => null);
      if (status?.ready) return status;
    }
    const { log } = paths(home);
    const fd = openSync(log, 'a', 0o600);
    let child;
    try {
      child = spawn(
        process.env.XVANT_DAEMON_INIT ?? 'tini',
        ['-s', '--', process.execPath, cli, 'daemon', 'serve'],
        {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          detached: true,
          stdio: ['ignore', fd, fd],
        },
      );
    } finally {
      closeSync(fd);
    }
    let launchError;
    child.once('error', (error) => {
      launchError = error;
    });
    child.unref();
    const deadline = performance.now() + 5000;
    do {
      const entry = daemonEndpoint(home);
      if (entry) {
        const status = await daemonRequest(entry, 'daemon').catch(() => null);
        if (status?.ready) return status;
      }
      if (launchError) throw launchError;
      await delay(50);
    } while (performance.now() < deadline);
    throw new Error('Daemon readiness timed out. See ' + log);
  }
  const entry = daemonEndpoint(home);
  if (!entry) {
    if (action === 'status') return { ready: false };
    throw new Error('DAEMON_NOT_RUNNING');
  }
  if (action === 'status')
    return daemonRequest(entry, id ? 'roots/' + id : 'daemon');
  if (action === 'submit')
    return daemonRequest(
      entry,
      'roots',
      daemonSubmit(rest.slice(1), value, values),
    );
  if (
    [
      'pause-intake',
      'pause-dispatch',
      'drain',
      'continue',
      'stop',
      'resume',
      'cancel',
      'accept',
    ].includes(action)
  ) {
    const commandId = value('--id');
    if (!commandId)
      throw new Error('Use --id KEY to identify this command across retries.');
    if (action === 'resume' || action === 'cancel' || action === 'accept') {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id ?? ''))
        throw new Error('A run ID is required.');
      return daemonRequest(entry, 'roots/' + id + '/' + action, {
        commandId,
        ...(action === 'accept'
          ? {
              expectedVersion: Number(value('--expected-version')),
              head: value('--head'),
            }
          : {}),
        ...(action === 'resume' && value('--retry-at')
          ? { retryAt: Date.parse(value('--retry-at')) }
          : {}),
      });
    }
    if (action === 'stop') {
      const reply = await daemonRequest(entry, 'daemon/control', {
        action: 'shutdown',
        commandId,
      });
      if (reply.generation !== entry.generation)
        return { ...reply, stopped: false };
      const deadline = performance.now() + 10000;
      while (performance.now() < deadline) {
        if (
          probeProcess(entry.process) === 'exited' ||
          probeProcess(entry.process) === 'pid_reused'
        )
          return { ...reply, stopped: true };
        await delay(75);
      }
      throw new Error('DAEMON_SHUTDOWN_TIMEOUT');
    }
    return daemonRequest(entry, 'daemon/control', { commandId, action });
  }
  throw new Error(
    'Commands: daemon start | status [RUN] | submit | resume RUN | cancel RUN | accept RUN | pause-intake | pause-dispatch | drain | continue | stop',
  );
}
