import { describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillCatalog } from './catalog.ts';
import { compatibilityMatrix } from './compatibility.ts';

const skillsDir = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
  'skills',
);
const tools = [
  { name: 'file.read', effect: 'read' },
  { name: 'file.apply_patch', effect: 'workspace-write' },
  { name: 'repo.search', effect: 'read' },
  { name: 'git.inspect', effect: 'read' },
  { name: 'test.run', effect: 'process' },
  { name: 'command.run', effect: 'process' },
  { name: 'artifact.publish', effect: 'read' },
  { name: 'agent.read_result', effect: 'read' },
  { name: 'agent.request_work', effect: 'read' },
  { name: 'memory.search', effect: 'read' },
  { name: 'memory.propose', effect: 'read' },
] as const;

describe('compatibility matrix', () => {
  const rows = compatibilityMatrix({
    catalog: loadSkillCatalog(skillsDir),
    tools,
    profiles: ['read-only', 'trusted-local'],
  });
  const row = (skill: string, runtime: string, profile: string) =>
    rows.find(
      (entry) =>
        entry.skill === skill &&
        entry.runtime === runtime &&
        entry.profile === profile,
    )!;
  it('covers every skill, runtime and profile', () => {
    expect(rows).toHaveLength(10 * 5 * 2);
  });
  it('blocks restricted profiles wherever native tools bypass XVANT', () => {
    expect(row('review-change', 'codex', 'read-only')).toMatchObject({
      status: 'blocked',
    });
    expect(row('review-change', 'native-local', 'read-only').status).not.toBe(
      'blocked',
    );
  });
  it('marks skills whose tools the profile forbids as unsupported', () => {
    const implement = row('implement-change', 'native-local', 'read-only');
    expect(implement.status).toBe('unsupported');
    expect(implement.reasons.join('\n')).toMatch(/file\.apply_patch|test\.run/);
    expect(
      row('implement-change', 'native-local', 'trusted-local').status,
    ).toBe('supported');
  });
  it('supports external runtimes under trusted-local only with acknowledged bypass risks', () => {
    // Their MCP clients reached XVANT's bridge in the live G05 gate.
    const external = row('implement-change', 'opencode', 'trusted-local');
    expect(external).toMatchObject({
      status: 'supported',
      requiresAcknowledgement: true,
    });
    expect(external.risks.join('\n')).toMatch(/bypasses XVANT approvals/);
  });
  it('keeps a runtime unverified while its MCP client is untested', () => {
    const [untested] = compatibilityMatrix({
      catalog: loadSkillCatalog(skillsDir),
      tools,
      profiles: ['trusted-local'],
      runtimes: [{ runtime: 'codex', nativeTools: [], mcpClient: 'untested' }],
    }).filter((entry) => entry.skill === 'implement-change');
    expect(untested!.status).toBe('unverified');
    expect(untested!.reasons.join('\n')).toMatch(/MCP/);
  });
});
