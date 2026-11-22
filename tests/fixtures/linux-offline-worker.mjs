import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerSupervisor } from '../../packages/supervisor/src/index.ts';
import { validateWorkerReport } from '../../packages/supervisor/src/worker-artifact.ts';
import { startLinuxOfflineWorker } from '../../packages/supervisor/src/linux-offline-worker.ts';

assert.equal(process.platform, 'linux');
const home = mkdtempSync(join(tmpdir(), 'xvant-linux-offline-worker-'));
const runtimeRoot = join(home, 'runtime');
const stagedInput = join(home, 'input');
const supervisor = new WorkerSupervisor();
const marker = 'fixture-only';
const servers = [];
let connections = 0;

function prepareRuntime() {
  for (const point of ['usr/bin', 'input', 'workspace', 'proc', 'dev', 'tmp'])
    mkdirSync(join(runtimeRoot, point), { recursive: true });
  copyFileSync(process.execPath, join(runtimeRoot, 'usr/bin/node'));
  const libraries = execFileSync('ldd', [process.execPath], {
    encoding: 'utf8',
  });
  assert.doesNotMatch(libraries, /not found/);
  for (const [, pathname] of libraries.matchAll(/^\s*(?:\S+ => )?(\/\S+) /gm)) {
    const destination = join(runtimeRoot, pathname);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(pathname, destination);
  }
  writeFileSync(join(runtimeRoot, 'image-marker'), marker);
}

async function listen(options) {
  const server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  servers.push(server);
  server.listen(options);
  await once(server, 'listening');
  return server.address();
}

function launch(code, args = [], timeoutMs = 4000) {
  return startLinuxOfflineWorker(supervisor, {
    runtimeRoot,
    stagedInput,
    operatorApproved: true,
    program: 'node',
    args: ['--input-type=module', '-e', code, ...args],
    workerId: 'offline-fixture',
    attemptId: 'offline-fixture-attempt',
    generation: 1,
    timeoutMs,
    maxOutputBytes: 4096,
  });
}

function rejectedRequests() {
  const request = {
    runtimeRoot,
    stagedInput,
    operatorApproved: true,
    program: 'node',
    args: [],
    workerId: 'offline-fixture',
    attemptId: 'offline-fixture-attempt',
    generation: 1,
    timeoutMs: 4000,
    maxOutputBytes: 4096,
  };
  assert.throws(
    () =>
      startLinuxOfflineWorker(supervisor, {
        ...request,
        operatorApproved: false,
      }),
    /POLICY_DENIED/,
  );
  assert.throws(
    () =>
      startLinuxOfflineWorker(supervisor, { ...request, program: '../node' }),
    /INVALID_INPUT/,
  );
  assert.throws(
    () =>
      startLinuxOfflineWorker(supervisor, {
        ...request,
        stagedInput: runtimeRoot,
      }),
    /INVALID_INPUT/,
  );
  assert.throws(
    () => startLinuxOfflineWorker(supervisor, { ...request, profile: 'codex' }),
    /no qualified isolated profile/,
  );
  assert.throws(
    () =>
      startLinuxOfflineWorker(supervisor, {
        ...request,
        limits: {
          delegatedCgroup: runtimeRoot,
          cpuQuotaMicros: 20000,
          memoryBytes: 64 * 1024 * 1024,
          processes: 32,
          scratchBytes: 1024 * 1024,
        },
      }),
    /delegated cgroup v2/,
  );
  assert.equal(supervisor.activeCount, 0);
}

function hasDescendant(marker) {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .some((pid) => {
      try {
        const path = '/proc/' + pid;
        return (
          statSync(path).uid === process.getuid() &&
          readFileSync(path + '/cmdline', 'utf8')
            .split('\0')
            .includes(marker)
        );
      } catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        return false;
      }
    });
}

const previousMarker = process.env.XVANT_OFFLINE_FIXTURE_MARKER;
try {
  prepareRuntime();
  mkdirSync(stagedInput);
  rejectedRequests();
  writeFileSync(join(stagedInput, 'granted'), marker);
  const unrelated = join(home, 'outside');
  mkdirSync(unrelated);
  const privateFiles = [
    'controller.sqlite',
    'other-workspace',
    'credential',
  ].map((name) => join(unrelated, name));
  for (const file of privateFiles) writeFileSync(file, marker);
  symlinkSync(privateFiles[2], join(stagedInput, 'outside-link'));
  process.env.XVANT_OFFLINE_FIXTURE_MARKER = marker;

  const { port } = await listen({ host: '127.0.0.1', port: 0 });
  const socket = join(unrelated, 'host.sock');
  await listen({ path: socket });
  const result = await launch(
    `import { readFileSync, writeFileSync } from 'node:fs';
    import { createConnection } from 'node:net';
    const [port, socket, ...privateFiles] = process.argv.slice(1);
    const denied = (operation) => {
      try { operation(); return false; }
      catch (error) { return ['ENOENT', 'EACCES', 'EPERM', 'EROFS'].includes(error.code); }
    };
    const unreachable = (options) => new Promise((resolve, reject) => {
      const peer = createConnection(options);
      peer.once('error', (error) =>
        resolve(['ECONNREFUSED', 'ENOENT', 'ENETUNREACH'].includes(error.code)));
      peer.once('connect', () => { peer.destroy(); resolve(false); });
      peer.setTimeout(800, () => { peer.destroy(); reject(new Error('probe timed out')); });
    });
    writeFileSync('scratch', 'private');
    console.log(JSON.stringify({
      input: readFileSync('/input/granted', 'utf8'),
      scratch: readFileSync('scratch', 'utf8'),
      inputReadOnly: denied(() => writeFileSync('/input/granted', 'changed')),
      imageReadOnly: denied(() => writeFileSync('/image-marker', 'changed')),
      otherPathsDenied: privateFiles.every((file) =>
        denied(() => readFileSync(file)) && denied(() => writeFileSync(file, 'changed'))),
      outsideSymlinkDenied: denied(() => readFileSync('/input/outside-link')),
      cleanEnvironment: !('XVANT_OFFLINE_FIXTURE_MARKER' in process.env),
      hostTcpDenied: await unreachable({ host: '127.0.0.1', port: Number(port) }),
      hostSocketDenied: await unreachable({ path: socket }),
    }));`,
    [String(port), socket, ...privateFiles],
  ).result;
  assert.equal(result.reason, 'exited');
  assert.equal(result.exitCode, 0, result.stderr);
  const observations = JSON.parse(result.stdout);
  assert.deepEqual(observations, {
    input: marker,
    scratch: 'private',
    inputReadOnly: true,
    imageReadOnly: true,
    otherPathsDenied: true,
    outsideSymlinkDenied: true,
    cleanEnvironment: true,
    hostTcpDenied: true,
    hostSocketDenied: true,
  });
  for (const file of privateFiles)
    assert.equal(readFileSync(file, 'utf8'), marker);
  assert.equal(readFileSync(join(stagedInput, 'granted'), 'utf8'), marker);
  assert.equal(connections, 0);

  const reportRun = launch(
    `console.log(JSON.stringify({ version: 1, report: 'fixture report' }))`,
  );
  const reportResult = await reportRun.result;
  const binding = {
    actionId: 'fixture-report',
    inputHash: 'a'.repeat(64),
    profileHash: 'b'.repeat(64),
  };
  const report = validateWorkerReport(
    reportResult,
    reportRun.identity,
    binding,
  );
  assert.equal(report.bytes.toString(), 'fixture report');
  assert.equal(report.receipt.actionId, binding.actionId);
  assert.throws(
    () =>
      validateWorkerReport(
        {
          ...reportResult,
          stdout: JSON.stringify({
            version: 1,
            report: 'ok',
            path: '../outside',
          }),
        },
        reportRun.identity,
        binding,
      ),
    /INVALID_WORKER_ARTIFACT/,
  );
  assert.throws(
    () =>
      validateWorkerReport(
        { ...reportResult, outputTruncated: true },
        reportRun.identity,
        binding,
      ),
    /INVALID_WORKER_ARTIFACT/,
  );
  assert.throws(
    () =>
      validateWorkerReport(
        reportResult,
        { ...reportRun.identity, generation: 2 },
        binding,
      ),
    /INVALID_WORKER_ARTIFACT/,
  );

  const identifier = randomUUID();
  const descendantMarker = 'xvant-descendant-' + identifier;
  const running = launch(
    `import { spawn } from 'node:child_process';
    import { readlinkSync } from 'node:fs';
    const child = spawn(process.execPath, [
      '-e', 'setInterval(() => {}, 1000)', '--', 'xvant-descendant-' + process.argv[1],
    ], { detached: true, stdio: 'ignore' });
    child.once('spawn', () => console.log(readlinkSync('/proc/self/ns/pid')));
    child.unref();
    setInterval(() => {}, 1000);`,
    [identifier],
    1500,
  );
  const startupDeadline = performance.now() + 1000;
  while (
    !hasDescendant(descendantMarker) &&
    performance.now() < startupDeadline
  )
    await delay(25);
  assert.ok(
    hasDescendant(descendantMarker),
    'detached descendant was never observed',
  );
  const expired = await running.result;
  assert.equal(expired.reason, 'timeout', expired.stderr);
  assert.match(expired.stdout.trim(), /^pid:\[\d+\]$/);
  const reapingDeadline = performance.now() + 2000;
  while (hasDescendant(descendantMarker) && performance.now() < reapingDeadline)
    await delay(25);
  assert.equal(hasDescendant(descendantMarker), false);
  console.log(
    JSON.stringify({
      ...observations,
      connections,
      detachedDescendantStopped: true,
      boundArtifactValidated: true,
    }),
  );
} finally {
  supervisor.stopAll();
  if (previousMarker === undefined)
    delete process.env.XVANT_OFFLINE_FIXTURE_MARKER;
  else process.env.XVANT_OFFLINE_FIXTURE_MARKER = previousMarker;
  for (const server of servers) server.close();
  rmSync(home, { recursive: true, force: true });
}
