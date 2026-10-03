import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScriptedProvider,
  lastResult,
  toolCall,
  type Script,
} from '../../../packages/native-agent/src/scripted.ts';
import { runLiveNative } from './live-native.ts';

const CLAMP =
  '\nexport function clamp(value, min, max) {\n' +
  "  if (min > max) throw new RangeError('min must not exceed max');\n" +
  '  return Math.min(Math.max(value, min), max);\n}\n';
const solve: Script = (messages, n) => {
  if (n === 1)
    return { toolCalls: [toolCall('file.read', { path: 'src/math.js' })] };
  if (n === 2) {
    const read = lastResult(messages).result as {
      hash: string;
      content: string;
    };
    return {
      toolCalls: [
        toolCall('file.apply_patch', {
          edits: [
            {
              path: 'src/math.js',
              expectedHash: read.hash,
              content: read.content + CLAMP,
            },
          ],
        }),
      ],
    };
  }
  if (n === 3)
    return { toolCalls: [toolCall('test.run', { commandId: 'tests' })] };
  return { text: 'Added clamp.' };
};
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-live-native-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('accepts a change the model made through registry tools', async () => {
  const report = await runLiveNative(root, {
    provider: new ScriptedProvider(solve),
    classification: 'offline',
  });
  expect(report.problems).toEqual([]);
  expect(report).toMatchObject({
    classification: 'offline',
    outcome: 'accepted',
    state: 'accepted',
    changedFiles: ['src/math.js'],
    modelCalls: 4,
    activeCount: 0,
  });
  expect(report.receipts).toEqual([
    { tool: 'file.read', status: 'succeeded' },
    { tool: 'file.apply_patch', status: 'succeeded' },
    { tool: 'test.run', status: 'succeeded' },
  ]);
}, 60000);

it('does not run a turn on a model that fails the tool-call probe', async () => {
  const provider = new ScriptedProvider(solve);
  provider.probe = async () => ({
    model: 'scripted',
    toolCalls: false,
    contextTokens: null,
  });
  const report = await runLiveNative(root, {
    provider,
    classification: 'offline',
  });
  expect(report.problems).toEqual([
    'model did not answer the probe with a tool call',
  ]);
  expect(report.outcome).toBeNull();
  expect(provider.seen).toHaveLength(0);
}, 60000);

it('reports a model that claims success without making the change', async () => {
  const report = await runLiveNative(root, {
    provider: new ScriptedProvider(() => ({ text: 'Done, clamp added.' })),
    classification: 'offline',
  });
  expect(report.outcome).toBe('verification_failed');
  expect(report.state).not.toBe('accepted');
  expect(report.problems).toContain(
    'no file.apply_patch receipt was journaled',
  );
  expect(report.problems).toContain('changed files: none');
}, 60000);
