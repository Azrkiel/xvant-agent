import { expect, it } from 'vitest';
import { nativeFailureSchema } from '../../../contracts/src/providers.ts';
import { classifyClaude, classifyCodex, classifyOpenCode } from './failures.ts';
import { pins } from './native-profiles.ts';

it.each([
  ['unauthorized', 'AUTH_REQUIRED', 'quota_group'],
  ['usageLimitExceeded', 'QUOTA_BLOCKED', 'quota_group'],
  ['rateLimitExceeded', 'QUOTA_BLOCKED', 'quota_group'],
  ['contextWindowExceeded', 'WORKER_FAILED', 'attempt'],
  ['serverOverloaded', 'WORKER_FAILED', 'attempt'],
  [
    { httpConnectionFailed: { httpStatusCode: 401 } },
    'AUTH_REQUIRED',
    'quota_group',
  ],
  [
    { responseStreamConnectionFailed: { httpStatusCode: 429 } },
    'QUOTA_BLOCKED',
    'quota_group',
  ],
  [
    { responseStreamDisconnected: { httpStatusCode: null } },
    'WORKER_FAILED',
    'attempt',
  ],
  [null, 'WORKER_FAILED', 'attempt'],
])('classifies Codex %j', (info, code, scope) => {
  const failure = classifyCodex(info);
  expect(failure).toMatchObject({ code, scope });
  expect(nativeFailureSchema.parse(failure)).toEqual(failure);
});
it('labels Codex HTTP variants without retaining message text', () => {
  expect(
    classifyCodex({ httpConnectionFailed: { httpStatusCode: 503 } }),
  ).toEqual({
    code: 'WORKER_FAILED',
    scope: 'attempt',
    native: 'httpConnectionFailed:503',
  });
  for (const input of ['has spaces: secret', { a: 1, b: 2 }, 42, ['x']])
    expect(classifyCodex(input).native).toBe('unrecognized');
});
it('covers every pinned Claude assistant error code', () => {
  const codes = pins.claude.unions['SDKAssistantMessageError']!;
  expect(codes.length).toBeGreaterThan(10);
  for (const code of codes) {
    const failure = classifyClaude(code);
    expect(failure.native).toBe(code);
    expect(nativeFailureSchema.parse(failure)).toEqual(failure);
  }
  expect(classifyClaude('authentication_failed').code).toBe('AUTH_REQUIRED');
  expect(classifyClaude('account_on_hold').scope).toBe('quota_group');
  expect(classifyClaude('rate_limit').code).toBe('QUOTA_BLOCKED');
  expect(classifyClaude('billing_error').code).toBe('QUOTA_BLOCKED');
  expect(classifyClaude('model_not_found')).toMatchObject({
    code: 'MODEL_UNAVAILABLE',
    scope: 'attempt',
  });
  expect(classifyClaude('overloaded').code).toBe('WORKER_FAILED');
});
it('falls back to Claude result subtypes and rejects unpinned codes', () => {
  expect(classifyClaude(undefined, 'error_max_turns')).toEqual({
    code: 'WORKER_FAILED',
    scope: 'attempt',
    native: 'error_max_turns',
  });
  expect(classifyClaude(undefined).native).toBe('none');
  expect(classifyClaude('made_up_code').native).toBe('unrecognized');
});
it('covers every pinned OpenCode error name', () => {
  const names = pins.opencode.unions['AssistantMessage.error']!;
  expect(names).toContain('ProviderAuthError');
  for (const name of names) {
    const failure = classifyOpenCode({ name, data: { message: 'secret' } });
    expect(failure.native).toBe(name);
    expect(JSON.stringify(failure)).not.toContain('secret');
  }
  expect(
    classifyOpenCode({ name: 'ProviderAuthError', data: {} }),
  ).toMatchObject({
    code: 'AUTH_REQUIRED',
    scope: 'quota_group',
  });
});
it.each([
  [401, 'AUTH_REQUIRED'],
  [403, 'AUTH_REQUIRED'],
  [429, 'QUOTA_BLOCKED'],
  [500, 'WORKER_FAILED'],
])('classifies OpenCode APIError %i', (statusCode, code) => {
  expect(
    classifyOpenCode({
      name: 'APIError',
      data: { message: 'x', statusCode, isRetryable: false },
    }),
  ).toMatchObject({ code, native: 'APIError:' + statusCode });
});
it('marks unknown OpenCode errors as unrecognized worker failures', () => {
  expect(classifyOpenCode({ name: 'Other' })).toEqual({
    code: 'WORKER_FAILED',
    scope: 'attempt',
    native: 'unrecognized',
  });
  expect(classifyOpenCode(undefined).native).toBe('unrecognized');
});
