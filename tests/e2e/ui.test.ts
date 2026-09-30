import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { LIVE_ROUTES } from '../../packages/contracts/src/live.ts';
import type { ProviderKind } from '../../packages/contracts/src/providers.ts';
import { startApp } from '../../apps/controller/src/app.ts';

vi.setConfig({ testTimeout: 180000, hookTimeout: 60000 });
const fixture = (name: string) =>
  fileURLToPath(new URL('../fixtures/' + name, import.meta.url));
const FAKES: Record<ProviderKind, string[]> = {
  codex: [fixture('codex-live-peer.mjs'), 'write'],
  claude: [fixture('claude-live-peer.mjs'), 'write'],
  opencode: [fixture('opencode-cli.mjs'), 'tools'],
};
// The host's own Chromium browser; a missing browser fails, as in the G05 browser fixture.
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((path) => existsSync(path));
let browser: Browser;
let root: string,
  repo: string,
  app: Awaited<ReturnType<typeof startApp>>,
  page: Page;
beforeAll(async () => {
  if (!EDGE) throw new Error('No Chromium browser installed for UI tests');
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
});
afterAll(async () => browser?.close());
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-ui-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  app = await startApp({
    home: join(root, 'home'),
    discover: (kind) => ({
      runtimeKind: kind,
      status: 'qualified',
      executable: process.execPath,
      version: LIVE_ROUTES[kind].runtimeVersion,
      expectedVersion: LIVE_ROUTES[kind].runtimeVersion,
      candidates: 1,
      prefixArgs: FAKES[kind],
    }),
  });
  page = await (await browser.newContext()).newPage();
  page.on('pageerror', (error) => {
    throw error;
  });
});
afterEach(async () => {
  await page?.context().close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
const objective =
  'Create a file named app.txt in the current directory whose entire content is the single line: hello ui. Do not change anything else.';
const status = () => page.locator('#status');

it('completes a run keyboard-first, from sign-in to acceptance', async () => {
  await page.goto(app.origin + '/#bootstrap=' + app.bootstrapToken);
  // The capability leaves the address bar once used.
  await expect.poll(() => page.url()).toBe(app.origin + '/');
  await expect
    .poll(() => page.locator('#compose-title').isVisible())
    .toBe(true);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    'compose-title',
  );
  expect(await page.locator('#runtimes li').allTextContents()).toEqual([
    expect.stringContaining('codex'),
    expect.stringContaining('claude'),
    expect.stringContaining('opencode'),
  ]);
  // Empty submission is explained, not sent.
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect.poll(() => status().textContent()).toContain('required');
  // Focus moves to the first missing field; fill the form with the keyboard only.
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('repo');
  await page.keyboard.type(repo);
  await page.keyboard.press('Tab');
  await page.keyboard.type(objective);
  await page
    .getByLabel('Check commands')
    .fill(
      `"${process.execPath}" -e "if(require('fs').readFileSync('app.txt','utf8').trim()!=='hello ui')process.exit(1)"`,
    );
  // A double submit creates one run.
  // Two submissions in the same instant: one command ID, one run.
  await page.evaluate(() => {
    const form = document.querySelector('form')!;
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect
    .poll(() => page.locator('#run-title').textContent(), { timeout: 30000 })
    .toBe(objective);
  await expect
    .poll(() => page.locator('article .badge').first().textContent(), {
      timeout: 90000,
    })
    .toBe('Ready for you');
  expect(await page.locator('#runs li').count()).toBe(1);
  // Status is announced in text, not only colour.
  await expect.poll(() => status().textContent()).toContain('Ready for you');
  expect(await page.getByText('check1').isVisible()).toBe(true);
  expect(await page.getByText('independent reviewer').isVisible()).toBe(true);
  await page.getByRole('button', { name: 'Show diff' }).click();
  await expect
    .poll(() => page.locator('pre.diff').textContent())
    .toContain('+hello ui');
  // Reload keeps the session and restores the run without resubmitting it.
  await page.reload();
  await expect
    .poll(() => page.locator('#run-title').textContent())
    .toBe(objective);
  expect(await page.locator('#runs li').count()).toBe(1);
  // Accept with the keyboard; the dialog names the exact branch and head.
  await page.getByRole('button', { name: 'Accept result' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('#confirm');
  await expect.poll(() => dialog.isVisible()).toBe(true);
  expect(await page.locator('#confirm-body').textContent()).toMatch(
    /xvant\/r[a-f0-9]{20} at [a-f0-9]{12}/,
  );
  await page.locator('#confirm-ok').click();
  await expect
    .poll(() => page.locator('article .badge').first().textContent())
    .toBe('Accepted');
  expect(await page.getByText(/git merge xvant\//).isVisible()).toBe(true);
  expect(
    execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
    }),
  ).toBe('');
});

it('shows worker output as text and stops running work from the page', async () => {
  await page.goto(app.origin + '/#bootstrap=' + app.bootstrapToken);
  await page.getByLabel('Repository folder').fill(repo);
  // Markup in an objective is shown literally, never interpreted.
  await page
    .getByLabel('What should be done')
    .fill(
      '<img src=x onerror="window.pwned=1"> Create 40 files named step_01.txt through step_40.txt one at a time.',
    );
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect
    .poll(() => page.locator('#run-title').textContent(), { timeout: 30000 })
    .toContain('<img src=x');
  expect(
    await page.evaluate(() => (window as unknown as { pwned?: number }).pwned),
  ).toBeUndefined();
  await expect
    .poll(() => page.locator('#workers .s-running').count(), { timeout: 60000 })
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop all work' }).click();
  await page.locator('#confirm-ok').click();
  await expect
    .poll(() => page.locator('article .badge').first().textContent(), {
      timeout: 60000,
    })
    .toBe('Stopped');
});

it('refuses to run without the one-time capability', async () => {
  await page.goto(app.origin + '/');
  await expect
    .poll(() => page.locator('[role=alert]').textContent())
    .toContain('session ended');
});
