import { existsSync } from 'node:fs';

// Chromium-family browsers the offline browser checks may drive, in order of
// preference. Shared by scripts/browser-fixture.mjs and tests/e2e/ui.test.ts so
// the two cannot disagree about which hosts have a browser.
export function browserCandidates(env = process.env): string[] {
  // An explicit registration is authoritative. A typo must not silently
  // select an unrelated installed browser and produce misleading evidence.
  if (env.XVANT_BROWSER !== undefined) return [env.XVANT_BROWSER];
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((path): path is string => Boolean(path));
}

// The first installed candidate, or undefined. Callers must treat undefined as
// a failure, never as a skip or a pass.
export function findBrowser(env = process.env): string | undefined {
  return browserCandidates(env).find((path) => existsSync(path));
}
