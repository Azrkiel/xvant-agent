import { describe, expect, it } from 'vitest';
import type { SkillEntry } from './catalog.ts';
import type { HookDeclaration } from '../../contracts/src/skills.ts';
import { HookRunner, planHooks } from './hooks.ts';
import type { HookHandler } from './hooks.ts';

function entry(id: string, hooks: HookDeclaration[]): SkillEntry {
  return {
    manifest: {
      id,
      version: '1.0.0',
      description: id,
      origin: 'xvant-original',
      license: 'Apache-2.0',
      inputs: [],
      outputs: [{ name: 'summary', description: 'x' }],
      steps: [{ id: 'work', description: 'x', evidence: 'y' }],
      requiredTools: [],
      runtimes: ['simulated'],
      maxContextTokens: 100,
      dependencies: [],
      hooks,
      fixtures: ['f-basic'],
      instructionsHash: 'a'.repeat(64),
    },
    instructions: '',
    hash: id.padEnd(64, '0').replace(/[^a-f0-9]/g, '0'),
  };
}
const check = (id: string, checkId = 'unit'): HookDeclaration => ({
  id,
  event: 'on_complete',
  action: { kind: 'require_check', checkId },
});
const note = (
  id: string,
  event: HookDeclaration['event'] = 'after_step',
): HookDeclaration => ({
  id,
  event,
  action: { kind: 'record_evidence', label: 'Step finished' },
});
const exec = (id: string, handler: string): HookDeclaration => ({
  id,
  event: 'after_tool',
  action: { kind: 'executable', handler },
});
const plan = (
  skills: SkillEntry[],
  handlers: Record<string, HookHandler> = {},
  options: { allowedHooks?: string[]; profile?: string } = {},
) =>
  planHooks(skills, {
    handlers: new Map(Object.entries(handlers)),
    allowedHooks: options.allowedHooks ?? Object.keys(handlers),
    profile: options.profile ?? 'trusted-local',
  });

describe('hook planning', () => {
  it('merges identical declarations from different skills', () => {
    const planned = plan([
      entry('test-change', [check('needs-unit'), note('log')]),
      entry('review-change', [check('also-unit'), note('record')]),
    ]);
    expect(planned.hooks).toEqual([
      {
        event: 'after_step',
        action: { kind: 'record_evidence', label: 'Step finished' },
        sources: ['review-change/record', 'test-change/log'],
      },
      {
        event: 'on_complete',
        action: { kind: 'require_check', checkId: 'unit' },
        sources: ['review-change/also-unit', 'test-change/needs-unit'],
      },
    ]);
    expect(planned.requiredChecks).toEqual(['unit']);
  });
  it('refuses executable hooks without registered, allowed and permitted code', () => {
    const handler: HookHandler = { effect: 'read', run: async () => {} };
    const writer: HookHandler = { effect: 'process', run: async () => {} };
    const skill = entry('s', [exec('lint', 'xvant.lint')]);
    expect(() => plan([skill])).toThrow('CAPABILITY_UNSUPPORTED');
    expect(() =>
      plan([skill], { 'xvant.lint': handler }, { allowedHooks: [] }),
    ).toThrow('POLICY_DENIED');
    expect(() =>
      plan([skill], { 'xvant.lint': writer }, { profile: 'read-only' }),
    ).toThrow('POLICY_DENIED');
    expect(() =>
      plan([skill], { 'xvant.lint': handler }, { profile: 'unknown' }),
    ).toThrow('CAPABILITY_UNSUPPORTED');
    expect(plan([skill], { 'xvant.lint': handler }).hooks).toHaveLength(1);
  });
});

describe('hook dispatch', () => {
  it('fires each hook once per event key and records evidence', async () => {
    const calls: unknown[] = [];
    const runner = new HookRunner(
      plan(
        [
          entry('a', [note('n'), exec('x', 'xvant.count')]),
          entry('b', [note('n2')]),
        ],
        {
          'xvant.count': {
            effect: 'read',
            run: async (payload) => {
              calls.push(payload);
            },
          },
        },
      ),
    );
    const first = await runner.dispatch('after_step', 'step-1', {
      step: 'work',
    });
    expect(first.evidence).toEqual([
      { label: 'Step finished', sources: ['a/n', 'b/n2'], key: 'step-1' },
    ]);
    expect(await runner.dispatch('after_step', 'step-1', {})).toEqual({
      evidence: [],
      failures: [],
    });
    expect(
      (await runner.dispatch('after_step', 'step-2', {})).evidence,
    ).toHaveLength(1);
    await runner.dispatch('after_tool', 'call-1', { tool: 'file.read' });
    await runner.dispatch('after_tool', 'call-1', { tool: 'file.read' });
    expect(calls).toEqual([{ tool: 'file.read' }]);
  });
  it('contains handler failures and hangs without granting anything', async () => {
    const runner = new HookRunner(
      plan(
        [entry('a', [exec('boom', 'xvant.boom'), exec('hang', 'xvant.hang')])],
        {
          'xvant.boom': {
            effect: 'read',
            run: async () => {
              throw new Error('C:\\secret\\trace');
            },
          },
          'xvant.hang': { effect: 'read', run: () => new Promise(() => {}) },
        },
      ),
      { timeoutMs: 30 },
    );
    const result = await runner.dispatch('after_tool', 'k', {});
    expect(result.failures).toEqual([
      { handler: 'xvant.boom', code: 'HOOK_FAILED' },
      { handler: 'xvant.hang', code: 'TIMEOUT' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
