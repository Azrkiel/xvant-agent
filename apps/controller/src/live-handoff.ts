import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { createWorktree } from '../../../packages/storage/src/git-workspace.ts';
import {
  collectRepository,
  repositoryContextItems,
  searchRepository,
} from '../../../packages/context/src/retrieval.ts';
import {
  createHandoff,
  handoffPacket,
} from '../../../packages/context/src/handoff.ts';
import { renderPacketPrompt } from '../../../packages/context/src/render.ts';
import { LIVE_ROUTES } from '../../../packages/contracts/src/live.ts';
import type { ProviderKind } from '../../../packages/contracts/src/providers.ts';
import { NativeReviewController } from './native-review.ts';
import { LiveCodexController, type LiveEvent } from './codex-live.ts';
import { LiveClaudeController } from './claude-live.ts';
import { LiveOpenCodeController } from './opencode-live.ts';
import type { RosterRuntime } from './live-roster.ts';

export interface LiveHandoffReport {
  classification: 'live';
  scope: 'live-handoff';
  from: {
    alias: string;
    runtimeKind: ProviderKind;
    state: string;
    sessionId: string;
  };
  to: {
    alias: string;
    runtimeKind: ProviderKind;
    state: string;
    sessionId: string;
  };
  handoffHash: string;
  packetHash: string;
  promptChars: number;
  requiredFacts: { expected: number; present: number };
  sentinelsAbsent: { prompt: boolean; patch: boolean };
  recipientChangedFiles: string[];
  problems: string[];
  activeCount: number;
}
const SOURCE = `export const MAX_RETRIES = 0;

// Calls \`call\` until it resolves. There is no limit yet.
export async function fetchWithRetry(call) {
  for (;;) {
    try {
      return await call();
    } catch (error) {
      void error;
    }
  }
}
`;

/**
 * Live G04: a real sender runtime does the first part of a task, the host
 * seals a handoff whose continuation value exists nowhere else, and a real
 * recipient on another runtime continues from the rendered packet alone, in
 * a worktree based on the sender's accepted patch. Secret sentinels in the
 * repository must reach neither the prompt nor the result.
 */
export async function runLiveHandoff(
  root: string,
  options: {
    runtimes: Partial<Record<ProviderKind, RosterRuntime>>;
    from?: ProviderKind;
    to?: ProviderKind;
    timeoutMs?: number;
    onEvent?: (alias: string, event: LiveEvent) => void;
  },
): Promise<LiveHandoffReport> {
  const from = options.from ?? 'codex';
  const to = options.to ?? 'claude';
  if (from === to) throw new Error('INVALID_INPUT');
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const secrets = {
    env: 'API_TOKEN=' + 'envsentinel'.repeat(3),
    aws: 'AKIA' + 'Q7'.repeat(8),
  };
  const token = randomInt(3, 10);
  const repo = join(root, 'repo');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=xvant',
        '-c',
        'user.email=xvant@local.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8', windowsHide: true },
    ).trim();
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  write('src/fetch.mjs', SOURCE);
  write('README.md', 'Fetch helper. Run node check.mjs to verify.\n');
  write('.env', secrets.env + '\n');
  write('config/deploy.mjs', 'export const key = "' + secrets.aws + '";\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  const objects = new ArtifactStore(join(root, 'objects'));
  let store = new Store(join(root, 'state.sqlite'), { owner: 'live-handoff' });
  const problems: string[] = [];
  const controllers: { stop(): void; activeCount: number }[] = [];
  const checkScript = (expected: 'part1' | 'final') => ({
    executable: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      expected === 'part1'
        ? "const m=await import('./src/fetch.mjs');if(JSON.stringify(m.RETRY_ON)!=='[429,503]'||m.MAX_RETRIES!==0)process.exit(1)"
        : `const m=await import('./src/fetch.mjs');if(JSON.stringify(m.RETRY_ON)!=='[429,503]'||m.MAX_RETRIES!==${token})process.exit(1);let n=0;const e=new Error('down');let thrown;try{await m.fetchWithRetry(async()=>{n++;if(n>50)return 'runaway';throw e})}catch(x){thrown=x}if(thrown!==e||n!==${token})process.exit(2)`,
    ],
  });
  const runTurn = async (
    runtime: ProviderKind,
    alias: string,
    taskId: string,
    objective: string,
    workspace: { path: string; baseCommit: string },
    check: ReturnType<typeof checkScript>,
  ) => {
    store.create('create-' + taskId, {
      id: taskId,
      projectId: 'handoff',
      objective,
      requiredCheckIds: ['check'],
      acceptanceCriteria: ['The check passes'],
    });
    store.queue('queue-' + taskId, taskId, 0);
    const spec = options.runtimes[runtime];
    if (!spec) throw new Error('RUNTIME_UNAVAILABLE: ' + runtime);
    const common = {
      executable: spec.executable,
      prefixArgs: spec.prefixArgs ?? [],
      timeoutMs,
      gitBases: { [alias]: workspace.baseCommit },
      onEvent: (event: LiveEvent) => options.onEvent?.(alias, event),
    };
    const workspaces = { [alias]: workspace.path };
    const checks = { check };
    const route = LIVE_ROUTES[runtime];
    const input = {
      connectionId: taskId,
      taskId,
      attemptId: taskId + '-a1',
      workspaceId: alias,
      expectedVersion: store.getTask(taskId).rowVersion,
      classification: 'live' as const,
      liveApproval: {
        actorId: 'operator',
        model:
          runtime === 'opencode'
            ? 'opencode/big-pickle'
            : (spec.model ?? 'default'),
        transport: route.transport,
        userApprovedTrustedLocal: true as const,
        profile: 'workspace-write' as const,
        acknowledgedNativeBypass: true as const,
      },
      worker: {
        id: alias,
        alias,
        runtimeKind: runtime,
        hostId: 'local',
        endpointId: route.transport,
        nativeSessionId:
          runtime === 'claude' ? randomUUID() : 'pending:' + taskId,
        runtimeVersion: route.runtimeVersion,
        adapterVersion: route.adapterVersion,
        mode: 'managed' as const,
        quotaGroupId: runtime + '-subscription',
      },
    };
    let result;
    if (runtime === 'opencode') {
      const c = new LiveOpenCodeController(
        store,
        objects,
        workspaces,
        checks,
        common,
      );
      controllers.push(c);
      result = await c.runLive(input);
    } else if (runtime === 'codex') {
      const c = new LiveCodexController(
        store,
        objects,
        workspaces,
        checks,
        common,
      );
      controllers.push(c);
      result = await c.run(input, 'create');
    } else {
      const c = new LiveClaudeController(
        store,
        objects,
        workspaces,
        checks,
        common,
      );
      controllers.push(c);
      result = await c.run(input, 'create');
    }
    // Explicit acceptance after a controller restart, as in the roster.
    for (const c of controllers) c.stop();
    store.close();
    store = new Store(join(root, 'state.sqlite'), { owner: 'live-handoff' });
    const prepared = store
      .events(0)
      .find(
        (e) =>
          e.kind === 'native.ready_for_acceptance' &&
          (e.payload as { connectionId: string }).connectionId === taskId,
      )?.payload as { rowVersion: number; evidenceHash: string } | undefined;
    let state = store.getTask(taskId).state as string;
    if (prepared)
      state = new NativeReviewController(store, objects).accept(
        'accept-' + taskId,
        {
          connectionId: taskId,
          expectedVersion: prepared.rowVersion,
          reviewedEvidenceHash: prepared.evidenceHash,
          actorId: 'handoff-reviewer',
          classification: 'live',
        },
      ).state;
    const saved = store.providers.get(taskId);
    let patch = '';
    let files: string[] = [];
    if (saved.verification && saved.verification.status !== 'unknown') {
      const manifest = JSON.parse(
        objects.get(saved.verification.evidence.treeHash).toString(),
      ) as { patch: string; files: { path: string }[] };
      patch = objects.get(manifest.patch).toString('utf8');
      files = manifest.files.map((f) => f.path);
    }
    return {
      state,
      sessionId: saved.worker.nativeSessionId,
      patch,
      files,
      finalText: result.finalText,
    };
  };
  try {
    // The root task the handoff belongs to; its current attempt is the host's.
    store.create('create-root', {
      id: 'retry',
      projectId: 'handoff',
      objective: 'Enforce a retry limit in fetchWithRetry (src/fetch.mjs)',
      requiredCheckIds: ['check'],
      acceptanceCriteria: [
        'MAX_RETRIES equals the value agreed in the handoff',
        'fetchWithRetry calls at most MAX_RETRIES times, then rethrows the last error',
        'RETRY_ON stays [429, 503]',
      ],
    });
    store.queue('queue-root', 'retry', 0);
    store.dispatch('dispatch-root', {
      taskId: 'retry',
      workerId: 'coordinator',
      attemptId: 'attempt-1',
      workspaceId: 'root',
      sessionId: 'root-session',
      scenario: 'success',
      expectedVersion: store.getTask('retry').rowVersion,
    });
    const fromAlias = from + '-1',
      toAlias = to + '-1';
    const senderTree = createWorktree(
      repo,
      'main',
      join(root, 'wt', fromAlias),
      'xvant/' + fromAlias,
    );
    const sender = await runTurn(
      from,
      fromAlias,
      'retry-part1',
      'In src/fetch.mjs, add the line `export const RETRY_ON = [429, 503];` directly below the MAX_RETRIES line. Do not change anything else, and do not commit.',
      senderTree,
      checkScript('part1'),
    );
    if (sender.state !== 'accepted') throw new Error('SENDER_NOT_ACCEPTED');
    // The accepted patch becomes the recipient's base revision.
    git(senderTree.path, 'add', '-A');
    git(
      senderTree.path,
      'commit',
      '-q',
      '-m',
      'handoff: ' + fromAlias + ' part 1',
    );
    const handoffBase = git(senderTree.path, 'rev-parse', 'HEAD');
    const patchHash = objects.put(Buffer.from(sender.patch));
    const handoff = createHandoff(
      store.getTask('retry'),
      {
        id: 'handoff-1',
        attemptId: 'attempt-1',
        fromWorkerId: fromAlias,
        toWorkerId: toAlias,
        baseRevision: handoffBase,
        summary: 'Added RETRY_ON. The retry loop still has no limit.',
        completed: ['Added export const RETRY_ON = [429, 503]'],
        remaining: [
          'Set MAX_RETRIES to ' + token,
          'Make fetchWithRetry call `call` at most MAX_RETRIES times, then throw the last error',
        ],
        openQuestions: [
          'Should RETRY_ON filter which errors are retried? Not in this task: leave it unused.',
        ],
        failedAttempts: [],
        artifacts: [
          {
            hash: patchHash,
            mediaType: 'text/x-diff',
            description: 'Accepted patch from ' + fromAlias,
          },
        ],
      },
      Date.now(),
    );
    const recipientTree = createWorktree(
      repo,
      handoffBase,
      join(root, 'wt', toAlias),
      'xvant/' + toAlias,
    );
    const collection = collectRepository(recipientTree.path);
    const task = store.getTask('retry');
    const packet = handoffPacket(handoff, {
      recipient: { workerId: toAlias, role: 'worker' },
      ownership: { writablePaths: ['src/fetch.mjs'] },
      policy: { permissionProfile: 'trusted-local', allowedTools: [] },
      skills: [],
      budget: { maxTokens: 2400 },
      items: repositoryContextItems({
        projectId: 'handoff',
        revision: handoffBase,
        files: collection.files,
        results: searchRepository(collection.files, task.objective),
      }),
    });
    const prompt = renderPacketPrompt(packet);
    const facts = [
      ...task.acceptanceCriteria,
      ...handoff.remaining,
      handoff.summary,
      ...handoff.openQuestions,
      patchHash,
    ];
    const recipient = await runTurn(
      to,
      toAlias,
      'retry-part2',
      prompt,
      recipientTree,
      checkScript('final'),
    );
    const leaked = (text: string) =>
      Object.values(secrets).some((s) => text.includes(s));
    const report: LiveHandoffReport = {
      classification: 'live',
      scope: 'live-handoff',
      from: {
        alias: fromAlias,
        runtimeKind: from,
        state: sender.state,
        sessionId: sender.sessionId,
      },
      to: {
        alias: toAlias,
        runtimeKind: to,
        state: recipient.state,
        sessionId: recipient.sessionId,
      },
      handoffHash: handoff.handoffHash,
      packetHash: packet.packetHash,
      promptChars: prompt.length,
      requiredFacts: {
        expected: facts.length,
        present: facts.filter((f) => prompt.includes(f)).length,
      },
      sentinelsAbsent: {
        prompt: !leaked(prompt),
        patch: !leaked(recipient.patch),
      },
      recipientChangedFiles: recipient.files,
      problems,
      activeCount: 0,
    };
    if (report.requiredFacts.present !== report.requiredFacts.expected)
      problems.push('required facts missing from the prompt');
    if (!report.sentinelsAbsent.prompt)
      problems.push('secret sentinel reached the prompt');
    if (!report.sentinelsAbsent.patch)
      problems.push('secret sentinel reached the result');
    if (recipient.state !== 'accepted')
      problems.push('recipient did not pass and get accepted');
    if (JSON.stringify(recipient.files) !== JSON.stringify(['src/fetch.mjs']))
      problems.push('recipient changed ' + JSON.stringify(recipient.files));
    return report;
  } finally {
    for (const c of controllers) c.stop();
    store.close();
  }
}
