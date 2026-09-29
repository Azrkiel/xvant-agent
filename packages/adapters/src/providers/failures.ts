import { z } from 'zod';
import type { NativeFailure } from '../../../contracts/src/providers.ts';
import { pins } from './native-profiles.ts';

// Classification uses only pinned vendor code labels; message text is never read
// or retained because it can carry account details or secrets.
const claudeCodes = new Set(pins.claude.unions['SDKAssistantMessageError']);
const opencodeNames = new Set(pins.opencode.unions['AssistantMessage.error']);
const account = (code: 'AUTH_REQUIRED' | 'QUOTA_BLOCKED', native: string) =>
  ({ code, scope: 'quota_group', native }) as const;
const attempt = (
  code: 'MODEL_UNAVAILABLE' | 'WORKER_FAILED',
  native: string,
): NativeFailure => ({ code, scope: 'attempt', native });
const unrecognized = attempt('WORKER_FAILED', 'unrecognized');

/** Codex `CodexErrorInfo` (pinned app-server schema) from an error or failed turn. */
export function classifyCodex(info: unknown): NativeFailure {
  if (info === null || info === undefined)
    return attempt('WORKER_FAILED', 'none');
  if (typeof info === 'string') {
    if (info === 'unauthorized') return account('AUTH_REQUIRED', info);
    if (['usageLimitExceeded', 'rateLimitExceeded'].includes(info))
      return account('QUOTA_BLOCKED', info);
    return /^[A-Za-z]{1,64}$/.test(info)
      ? attempt('WORKER_FAILED', info)
      : unrecognized;
  }
  const variant = z
    .record(z.string().regex(/^[A-Za-z]{1,48}$/), z.unknown())
    .refine((value) => Object.keys(value).length === 1)
    .safeParse(info);
  if (!variant.success) return unrecognized;
  const [name, detail] = Object.entries(variant.data)[0]!;
  const status = z
    .object({ httpStatusCode: z.number().int().min(0).max(999).nullish() })
    .safeParse(detail);
  const code = status.success ? status.data.httpStatusCode : undefined;
  const native = code ? `${name}:${code}` : name;
  if (code === 401 || code === 403) return account('AUTH_REQUIRED', native);
  if (code === 429) return account('QUOTA_BLOCKED', native);
  return attempt('WORKER_FAILED', native);
}

/** Claude `SDKAssistantMessageError`, or a result subtype when no error code exists. */
export function classifyClaude(
  error: unknown,
  subtype?: string,
): NativeFailure {
  if (typeof error === 'string' && claudeCodes.has(error)) {
    if (
      [
        'authentication_failed',
        'oauth_org_not_allowed',
        'account_on_hold',
        'verification_required',
        'cloud_credential_error',
      ].includes(error)
    )
      return account('AUTH_REQUIRED', error);
    if (['billing_error', 'rate_limit'].includes(error))
      return account('QUOTA_BLOCKED', error);
    if (error === 'model_not_found') return attempt('MODEL_UNAVAILABLE', error);
    return attempt('WORKER_FAILED', error);
  }
  if (error !== undefined) return unrecognized;
  return attempt(
    'WORKER_FAILED',
    subtype && /^[A-Za-z0-9_.:-]{1,64}$/.test(subtype) ? subtype : 'none',
  );
}

/** OpenCode `AssistantMessage.error` / `session.error` union member. */
export function classifyOpenCode(error: unknown): NativeFailure {
  const parsed = z
    .object({ name: z.string(), data: z.unknown().optional() })
    .safeParse(error);
  if (!parsed.success || !opencodeNames.has(parsed.data.name))
    return unrecognized;
  const name = parsed.data.name;
  if (name === 'ProviderAuthError') return account('AUTH_REQUIRED', name);
  if (name === 'APIError') {
    const status = z
      .object({ statusCode: z.number().int().min(100).max(599).optional() })
      .safeParse(parsed.data.data);
    const code = status.success ? status.data.statusCode : undefined;
    const native = code ? `${name}:${code}` : name;
    if (code === 401 || code === 403) return account('AUTH_REQUIRED', native);
    if (code === 429) return account('QUOTA_BLOCKED', native);
    return attempt('WORKER_FAILED', native);
  }
  return attempt('WORKER_FAILED', name);
}
