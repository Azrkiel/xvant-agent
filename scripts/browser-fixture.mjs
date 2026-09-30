import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/storage/src/store.ts';
import { ArtifactStore } from '../packages/storage/src/artifacts.ts';
import { WorkerSupervisor } from '../packages/supervisor/src/index.ts';
import { ToolRegistry } from '../packages/tools/src/registry.ts';
import { createBrowserTool } from '../packages/tools/src/browser.ts';

// Real-browser qualification for browser.inspect on this host. A missing
// browser is reported as unavailable, never as a pass.
const candidates = [
  process.env.XVANT_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);
const executable = candidates.find((path) => existsSync(path));
if (!executable) {
  console.log(
    JSON.stringify({ classification: 'offline', status: 'unavailable' }),
  );
  process.exit(2);
}
const page = `<!doctype html><title>XVANT fixture</title>
<h1>Local inspection fixture</h1>
<script>
  console.error('fixture console error');
  fetch('http://example.com/leak').catch(() => {});
</script>`;
const server = createServer((req, res) => {
  res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' });
  res.end(req.url === '/' ? page : 'missing');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const root = mkdtempSync(join(tmpdir(), 'xvant-browser-fixture-'));
const profiles = () =>
  readdirSync(tmpdir()).filter(
    (name) =>
      name.startsWith('xvant-browser-') &&
      !name.startsWith('xvant-browser-fixture-'),
  );
const before = profiles();
const store = new Store(join(root, 'state.sqlite'), { owner: 'controller' });
const supervisor = new WorkerSupervisor();
try {
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Inspect the fixture page',
    requiredCheckIds: ['render'],
    acceptanceCriteria: ['The page renders'],
  });
  const objects = new ArtifactStore(join(root, 'objects'));
  const tool = createBrowserTool({
    browser: { program: executable },
    allowedOrigins: [origin],
    supervisor,
    store,
    objects,
  });
  const receipt = await new ToolRegistry([tool], { record: () => {} }).invoke(
    { tool: 'browser.inspect', input: { url: origin + '/', waitMs: 500 } },
    {
      projectId: 'project',
      taskId: 'task',
      attemptId: 'attempt',
      workerId: 'fixture',
      permissionProfile: 'trusted-local',
      allowedTools: ['browser.inspect'],
      approvals: [],
      now: () => Date.now(),
    },
  );
  const result = receipt.result ?? {};
  const png = result.screenshot
    ? objects.get(result.screenshot)
    : Buffer.alloc(0);
  const report = {
    classification: 'offline',
    browser: executable.split(/[\\/]/).at(-1),
    status: receipt.status,
    code: receipt.code ?? null,
    title: result.title ?? null,
    httpStatus: result.status ?? null,
    textSeen: String(result.text ?? '').includes('Local inspection fixture'),
    consoleErrors: result.consoleErrors ?? [],
    blockedRequests: result.blockedRequests ?? [],
    screenshotPng: png.subarray(0, 4).toString('hex') === '89504e47',
    screenshotBytes: png.length,
    profileRemoved: JSON.stringify(profiles()) === JSON.stringify(before),
    activeCount: supervisor.activeCount,
  };
  console.log(JSON.stringify(report));
  const passed =
    report.status === 'succeeded' &&
    report.title === 'XVANT fixture' &&
    report.httpStatus === 200 &&
    report.textSeen &&
    report.consoleErrors.some((line) =>
      line.includes('fixture console error'),
    ) &&
    report.blockedRequests.some((url) =>
      url.startsWith('http://example.com/'),
    ) &&
    report.screenshotPng &&
    report.profileRemoved &&
    report.activeCount === 0;
  if (!passed) process.exitCode = 1;
} finally {
  supervisor.stopAll();
  store.close();
  server.close();
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
