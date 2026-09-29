import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { nativeIdSchema } from '../../../contracts/src/providers.ts';
const base = {
  cwd: z.string().refine(isAbsolute),
  permissionMode: z.literal('plan'),
  tools: z.array(z.never()).length(0),
  mcpServers: z.strictObject({}),
  plugins: z.array(z.never()).length(0),
  settingSources: z.array(z.never()).length(0),
};
const launchSchema = z.union([
  z.strictObject({ ...base, sessionId: z.uuid() }),
  z.strictObject({
    ...base,
    resume: nativeIdSchema.refine((id) => !id.startsWith('pending:')),
  }),
]);
export type ClaudeLaunchOptions = z.infer<typeof launchSchema>;
/** Pinned SDK option projection. This describes a synthetic launch, never executes an SDK. */
export function validateClaudeLaunch(input: unknown): ClaudeLaunchOptions {
  const parsed = launchSchema.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_INPUT');
  return parsed.data;
}
export function buildClaudeLaunch(
  mode: 'create' | 'resume',
  sessionId: string,
  cwd: string,
): ClaudeLaunchOptions {
  if (mode !== 'create' && mode !== 'resume') throw new Error('INVALID_INPUT');
  return validateClaudeLaunch({
    cwd,
    permissionMode: 'plan',
    tools: [],
    mcpServers: {},
    plugins: [],
    settingSources: [],
    ...(mode === 'create' ? { sessionId } : { resume: sessionId }),
  });
}
