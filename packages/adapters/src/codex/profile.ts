import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { versionAccepted } from '../../../contracts/src/live.ts';

export const CODEX_VERSION = '0.158.0-alpha.2.1';
/** The pin, or a later version a live probe qualified against the same schema. */
export const codexVersionAccepted = (version: string) =>
  versionAccepted('codex', version);
const bundle = z
  .object({
    runtimeVersion: z.literal(CODEX_VERSION),
    sources: z.array(
      z.object({
        file: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
    definitions: z.record(z.string(), z.unknown()),
    schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .parse(
    JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')),
  );
const validators = new Map<string, z.ZodType>();
export function pinInfo() {
  return {
    runtimeVersion: bundle.runtimeVersion,
    sources: structuredClone(bundle.sources),
  };
}
export function validateNative(name: string, input: unknown): void {
  if (!Object.hasOwn(bundle.schemas, name))
    throw new Error('VERSION_UNSUPPORTED');
  let validator = validators.get(name);
  if (!validator) {
    validator = z.fromJSONSchema({
      ...bundle.schemas[name],
      definitions: bundle.definitions,
    });
    validators.set(name, validator);
  }
  if (!validator.safeParse(input).success) throw new Error('INVALID_EVENT');
}
