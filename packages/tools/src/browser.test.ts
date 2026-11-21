import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../storage/src/store.ts';
import { ArtifactStore } from '../../storage/src/artifacts.ts';
import { WorkerSupervisor } from '../../supervisor/src/index.ts';
import { ToolRegistry } from './registry.ts';
import type { ToolContext } from './registry.ts';
import { createBrowserTool } from './browser.ts';

const fake = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/fake-browser.mjs',
);
let root: string;
let store: Store;
let objects: ArtifactStore;
let supervisor: WorkerSupervisor;
const profilesBefore = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith('xvant-browser-'));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-btest-'));
  store = new Store(join(root, 'state.sqlite'), { owner: 'controller' });
  objects = new ArtifactStore(join(root, 'objects'));
  supervisor = new WorkerSupervisor();
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Inspect the page',
    requiredCheckIds: ['test'],
    acceptanceCriteria: ['Page renders'],
  });
  process.env.FAKE_BROWSER_ARGS_OUT = join(root, 'args.json');
});
afterEach(() => {
  delete process.env.FAKE_BROWSER_ARGS_OUT;
  supervisor.stopAll();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function call(
  input: unknown,
  timeoutMs?: number,
  browserArgs: string[] = [],
  launchTimeoutMs?: number,
) {
  const tool = createBrowserTool({
    browser: { program: process.execPath, args: [fake, ...browserArgs] },
    allowedOrigins: ['http://127.0.0.1:4173'],
    supervisor,
    store,
    objects,
    ...(timeoutMs ? { loadTimeoutMs: timeoutMs } : {}),
    ...(launchTimeoutMs ? { launchTimeoutMs } : {}),
  });
  const context: ToolContext = {
    projectId: 'project',
    taskId: 'task',
    attemptId: 'attempt',
    workerId: 'claude-1',
    permissionProfile: 'trusted-local',
    allowedTools: ['browser.inspect'],
    approvals: [],
    now: () => 1,
  };
  return new ToolRegistry([tool], { record: () => {} }).invoke(
    { tool: 'browser.inspect', input },
    context,
  );
}

describe('browser.inspect', () => {
  it('waits for a page registered after the DevTools port without relaunching', async () => {
    const receipt = await call(
      { url: 'http://127.0.0.1:4173/app' },
      undefined,
      ['--fake-target-delay-ms=500'],
      5000,
    );
    expect(receipt.status).toBe('succeeded');
    expect(supervisor.activeCount).toBe(0);
  });
  it('fails and cleans up when no page becomes ready before the launch deadline', async () => {
    const before = profilesBefore();
    const receipt = await call(
      { url: 'http://127.0.0.1:4173/app' },
      undefined,
      ['--fake-target-delay-ms=30000'],
      1000,
    );
    expect(receipt).toMatchObject({ status: 'failed', code: 'TIMEOUT' });
    expect(profilesBefore()).toEqual(before);
    expect(supervisor.activeCount).toBe(0);
  });
  it('fails on a DevTools protocol error instead of treating it as readiness', async () => {
    const receipt = await call(
      { url: 'http://127.0.0.1:4173/app' },
      undefined,
      ['--fake-target-status=invalid'],
    );
    expect(receipt).toMatchObject({ status: 'failed', code: 'TOOL_FAILED' });
    expect(supervisor.activeCount).toBe(0);
  });
  it('captures page evidence in an isolated, deleted profile', async () => {
    const before = profilesBefore();
    const receipt = await call({ url: 'http://127.0.0.1:4173/app' });
    expect(receipt.status).toBe('succeeded');
    const result = receipt.result as {
      title: string;
      status: number;
      text: string;
      consoleErrors: string[];
      blockedRequests: string[];
      screenshot: string;
    };
    expect(result).toMatchObject({
      url: 'http://127.0.0.1:4173/app',
      title: 'Fake Title',
      status: 200,
      consoleErrors: ['boom at load'],
      blockedRequests: ['http://evil.example/steal.js'],
    });
    expect(result.text).toContain('token=[REDACTED]');
    expect(receipt.artifacts).toEqual([result.screenshot]);
    expect(objects.get(result.screenshot).subarray(0, 4).toString('hex')).toBe(
      '89504e47',
    );
    expect(store.artifactHashes()).toContain(result.screenshot);
    const args = JSON.parse(
      readFileSync(join(root, 'args.json'), 'utf8'),
    ) as string[];
    const profile = args
      .find((arg) => arg.startsWith('--user-data-dir='))!
      .slice('--user-data-dir='.length);
    expect(args).toEqual(
      expect.arrayContaining([
        '--headless=new',
        '--remote-debugging-port=0',
        '--disable-extensions',
        '--proxy-server=http://127.0.0.1:9',
      ]),
    );
    expect(existsSync(profile)).toBe(false);
    expect(profilesBefore()).toEqual(before);
    expect(supervisor.activeCount).toBe(0);
  });
  it.each([
    'https://example.com/',
    'http://127.0.0.1:9999/',
    'file:///C:/Windows/win.ini',
    'http://user:pass@127.0.0.1:4173/',
    'javascript:alert(1)',
  ])('refuses %s before launching anything', async (url) => {
    const receipt = await call({ url });
    expect(receipt).toMatchObject({ status: 'failed', code: 'POLICY_DENIED' });
    expect(existsSync(join(root, 'args.json'))).toBe(false);
  });
  it('stops the browser and removes the profile when the page never loads', async () => {
    const before = profilesBefore();
    const receipt = await call({ url: 'http://127.0.0.1:4173/hang' }, 500);
    expect(receipt).toMatchObject({ status: 'failed', code: 'TIMEOUT' });
    expect(profilesBefore()).toEqual(before);
    expect(supervisor.activeCount).toBe(0);
  });
  it('only accepts loopback origins from the host', () => {
    expect(() =>
      createBrowserTool({
        browser: { program: process.execPath, args: [fake] },
        allowedOrigins: ['https://example.com'],
        supervisor,
        store,
        objects,
      }),
    ).toThrow('INVALID_INPUT');
  });
});
