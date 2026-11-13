import { expect, it } from 'vitest';
import { browserCandidates, findBrowser } from '../scripts/browser-path.ts';

it('uses the registered browser without falling back to a system installation', () => {
  const env = { XVANT_BROWSER: process.execPath };
  expect(browserCandidates(env)).toEqual([process.execPath]);
  expect(findBrowser(env)).toBe(process.execPath);
});
it('fails closed for a missing registered browser even on a browser-equipped host', () => {
  expect(
    findBrowser({ XVANT_BROWSER: '/xvant-does-not-exist/chromium' }),
  ).toBeUndefined();
});
it('does not silently reinterpret an empty explicit registration as discovery', () => {
  expect(findBrowser({ XVANT_BROWSER: '' })).toBeUndefined();
});
it('retains system discovery when there is no explicit registration', () => {
  expect(browserCandidates({})).toContain('/usr/bin/chromium');
  expect(browserCandidates({})).toContain(
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  );
});

it('A00 controlled failing fixture remains a real failure', () => {
  expect('controlled failure').toBe('passed');
});
