import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import {
  collectRepository,
  repositoryContextItems,
  searchRepository,
} from '../../../packages/context/src/retrieval.ts';
import {
  createHandoff,
  handoffPacket,
} from '../../../packages/context/src/handoff.ts';
import { inspectContext } from '../../../packages/context/src/inspect.ts';
import { verifyContextPacket } from '../../../packages/context/src/packet.ts';
import {
  anchorFiles,
  assessMemory,
  memoryContextItems,
} from '../../../packages/memory/src/relevance.ts';
import type { MemoryProposal } from '../../../packages/contracts/src/memory.ts';

export interface HandoffFixtureReport {
  classification: 'offline';
  liveProvidersTested: string[];
  runtimeKind: 'simulated';
  from: string;
  to: string;
  packetHash: string;
  packetVerified: boolean;
  requiredFacts: { expected: number; present: number };
  sentinelsAbsent: boolean;
  memory: {
    included: string[];
    excluded: { id: string; reason: string }[];
  };
  retrievalOmitted: { path: string; reason: string }[];
  recipient: { exitCode: number; completed: boolean };
  check: 'passed' | 'failed';
  inspectionEntries: number;
}
const recipientScript = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/handoff-recipient.mjs',
);
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Offline G04 scenario: a Codex-named worker hands a partly done task to a
 * Claude-named worker. The recipient runs in a separate process and sees only
 * the sealed packet. A random continuation value exists only in the handoff,
 * so completing the task proves the packet carried the evidence. Secret,
 * stale, unaccepted and cross-project sentinels must never reach it.
 */
export async function runHandoffFixture(
  root: string,
  options: { scenario?: 'complete' | 'missing-token' | 'tampered' } = {},
): Promise<HandoffFixtureReport> {
  const scenario = options.scenario ?? 'complete';
  const secrets = {
    env: 'API_TOKEN=' + 'envsentinel'.repeat(3),
    aws: 'AKIA' + 'Z4'.repeat(8),
    foreign: 'FOREIGN-PROJECT-SENTINEL rotation plan',
    stale: 'fetch lives in lib/net.js',
    draft: 'DRAFT-SENTINEL unreviewed idea',
  };
  const repo = join(root, 'repo');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.autocrlf=false',
        '-c',
        'user.name=xvant-fixture',
        '-c',
        'user.email=fixture@xvant.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8', windowsHide: true },
    ).trim();
  mkdirSync(repo, { recursive: true });
  git('init', '-q');
  write(
    'src/fetch.ts',
    'export const MAX_RETRIES = 0;\nexport async function fetchWithRetry(url: string) {\n  // retry loop without a limit\n  return url;\n}\n',
  );
  write('src/ui.ts', 'export const label = "Retry";\n');
  write('README.md', 'Fetch helper project.\n');
  write('.env', secrets.env + '\n');
  write('config/deploy.ts', 'export const key = "' + secrets.aws + '";\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const baseRevision = git('rev-parse', 'HEAD');
  const token = String(randomInt(100000, 999999));

  const store = new Store(join(root, 'state.sqlite'), { owner: 'controller' });
  try {
    store.create('create', {
      id: 'task',
      projectId: 'project',
      objective: 'Enforce the retry limit in fetchWithRetry',
      requiredCheckIds: ['retry-limit'],
      acceptanceCriteria: [
        'MAX_RETRIES equals the value agreed in the handoff',
        'fetchWithRetry stops after MAX_RETRIES attempts',
      ],
    });
    store.queue('queue', 'task', 0);
    store.dispatch('dispatch', {
      taskId: 'task',
      workerId: 'codex-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace',
      sessionId: 'session',
      scenario: 'success',
      expectedVersion: store.getTask('task').rowVersion,
    });
    const collection = collectRepository(repo);
    const accepted = (proposal: MemoryProposal) => {
      store.memory.propose(proposal);
      store.memory.decide(proposal.projectId, proposal.id, {
        decision: 'accept',
        actorId: 'owner',
        expectedVersion: 0,
      });
    };
    const base = {
      namespace: 'architecture',
      confidence: 'reported' as const,
      provenance: { source: 'user' as const, actorId: 'owner' },
    };
    accepted({
      ...base,
      id: 'retry-decision',
      projectId: 'project',
      kind: 'decision',
      content: 'Retries are bounded by MAX_RETRIES; no unbounded loops.',
      anchors: anchorFiles(collection.files, ['src/fetch.ts']),
    });
    accepted({
      ...base,
      id: 'old-layout',
      projectId: 'project',
      kind: 'fact',
      content: secrets.stale,
      anchors: [{ path: 'src/fetch.ts', hash: sha256('older content') }],
    });
    store.memory.propose({
      ...base,
      id: 'draft-idea',
      projectId: 'project',
      kind: 'fact',
      content: secrets.draft,
      provenance: {
        source: 'worker',
        actorId: 'codex-1',
        taskId: 'task',
        attemptId: 'attempt-1',
      },
    });
    accepted({
      ...base,
      id: 'foreign-note',
      projectId: 'other',
      kind: 'fact',
      content: secrets.foreign,
    });
    const objects = new ArtifactStore(join(root, 'objects'));
    const handoff = createHandoff(
      store.getTask('task'),
      {
        id: 'handoff-1',
        attemptId: 'attempt-1',
        fromWorkerId: 'codex-1',
        toWorkerId: 'claude-1',
        baseRevision,
        summary: 'Declared MAX_RETRIES; the loop does not use it yet.',
        completed: ['Declared MAX_RETRIES'],
        remaining: [
          scenario === 'missing-token'
            ? 'Set MAX_RETRIES to the agreed value'
            : 'Set MAX_RETRIES to ' + token,
          'Stop the loop after MAX_RETRIES attempts',
        ],
        openQuestions: ['Should 429 responses count toward the limit?'],
        failedAttempts: [
          {
            attemptId: 'attempt-0',
            reason: 'verifier_failed',
            summary: 'Retry test hung without a limit',
          },
        ],
        artifacts: [
          {
            hash: objects.put(Buffer.from('+export const MAX_RETRIES = 0;\n')),
            mediaType: 'text/x-diff',
            description: 'Partial patch declaring MAX_RETRIES',
          },
        ],
      },
      Date.now(),
    );
    const task = store.getTask('task');
    const fileItems = repositoryContextItems({
      projectId: 'project',
      revision: baseRevision,
      files: collection.files,
      results: searchRepository(collection.files, task.objective),
    });
    // The foreign record is fed in deliberately: project scoping must hold
    // even if a caller mixes search results from two projects.
    const records = [
      ...store.memory.searchForTask('task', {
        statuses: ['accepted', 'proposed', 'superseded'],
      }),
      ...store.memory.search('other'),
    ];
    const assessed = assessMemory(records, collection.files);
    const memory = memoryContextItems(assessed, 'project');
    const packet = handoffPacket(handoff, {
      recipient: { workerId: 'claude-1', role: 'worker' },
      ownership: { writablePaths: ['src/fetch.ts'] },
      policy: { permissionProfile: 'simulation', allowedTools: ['file.read'] },
      skills: [],
      budget: { maxTokens: 8192 },
      items: [...fileItems, ...memory.items],
    });
    const inspection = inspectContext({
      packet,
      retrieval: collection.omitted,
      memory: { assessed, excluded: memory.excluded },
    });
    const serialized = JSON.stringify(packet);
    const facts = [
      task.objective,
      ...task.acceptanceCriteria,
      handoff.summary,
      ...handoff.remaining,
      ...handoff.openQuestions,
      'Retry test hung without a limit',
      handoff.artifacts[0]!.hash,
      'Retries are bounded by MAX_RETRIES',
      'export const MAX_RETRIES = 0;',
    ];
    const payload =
      scenario === 'tampered'
        ? JSON.stringify({ ...packet, acceptanceCriteria: ['Anything'] })
        : serialized;
    const child = spawnSync(process.execPath, [recipientScript], {
      input: payload,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    const exitCode = child.status ?? 1;
    let applied = false;
    if (exitCode === 0) {
      const { edits } = JSON.parse(child.stdout) as {
        edits: {
          path: string;
          baseHash: string;
          find: string;
          replace: string;
        }[];
      };
      for (const edit of edits) {
        // Host-side policy: owned paths only, against the exact base content.
        if (!packet.ownership.writablePaths.includes(edit.path)) continue;
        const target = join(repo, ...edit.path.split('/'));
        const current = readFileSync(target, 'utf8');
        if (
          sha256(current) !== edit.baseHash ||
          current.split(edit.find).length !== 2
        )
          continue;
        writeFileSync(target, current.replace(edit.find, edit.replace));
        applied = true;
      }
    }
    const result = readFileSync(join(repo, 'src', 'fetch.ts'), 'utf8');
    const passed =
      scenario !== 'missing-token' &&
      result.includes('export const MAX_RETRIES = ' + token + ';');
    const visible = serialized + JSON.stringify(inspection);
    return {
      classification: 'offline',
      liveProvidersTested: [],
      runtimeKind: 'simulated',
      from: handoff.fromWorkerId,
      to: packet.recipient.workerId,
      packetHash: packet.packetHash,
      packetVerified:
        verifyContextPacket(JSON.parse(serialized)) === packet.packetHash,
      requiredFacts: {
        expected: facts.length,
        present: facts.filter((fact) => serialized.includes(fact)).length,
      },
      sentinelsAbsent: Object.values(secrets).every(
        (secret) => !visible.includes(secret),
      ),
      memory: {
        included: packet.items
          .filter((item) => item.provenance.source === 'memory')
          .map((item) => item.provenance.ref),
        excluded: [...memory.excluded].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      },
      retrievalOmitted: collection.omitted,
      recipient: { exitCode, completed: applied && passed },
      check: passed ? 'passed' : 'failed',
      inspectionEntries: inspection.entries.length,
    };
  } finally {
    store.close();
  }
}

/** Every violated G04 expectation, as readable problems; empty when the fixture passed. */
export function handoffFailures(report: HandoffFixtureReport): string[] {
  const problems: string[] = [];
  if (report.classification !== 'offline' || report.liveProvidersTested.length)
    problems.push('fixture is not offline');
  if (!report.packetVerified) problems.push('packet seal did not verify');
  if (report.requiredFacts.present !== report.requiredFacts.expected)
    problems.push('required facts missing from packet');
  if (!report.sentinelsAbsent)
    problems.push('excluded sentinel reached packet');
  const excluded = new Map(
    report.memory.excluded.map((entry) => [entry.id, entry.reason]),
  );
  if (excluded.get('old-layout') !== 'stale')
    problems.push('stale memory was not excluded');
  if (excluded.get('foreign-note') !== 'cross_project')
    problems.push('cross-project memory was not excluded');
  if (excluded.get('draft-idea') !== 'unaccepted')
    problems.push('unaccepted memory was not excluded');
  if (!report.recipient.completed || report.check !== 'passed')
    problems.push('recipient did not complete');
  return problems;
}
