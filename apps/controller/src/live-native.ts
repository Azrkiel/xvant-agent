import { execFileSync } from 'node:child_process';
import { cpSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolReceipt } from '../../../packages/contracts/src/tools.ts';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import type {
  ModelCapabilities,
  ModelProvider,
} from '../../../packages/native-agent/src/model.ts';
import type { LoopEvent } from '../../../packages/native-agent/src/loop.ts';
import { NativeTurnRunner } from './native-turn-runner.ts';

export interface LiveNativeReport {
  classification: 'offline' | 'live';
  scope: 'live-native';
  provider: string;
  model: string;
  capabilities: ModelCapabilities | null;
  state: string | null;
  outcome: string | null;
  failure?: string;
  finalText: string;
  changedFiles: string[];
  modelCalls: number;
  receipts: { tool: string; status: string; code?: string }[];
  activeCount: number;
  problems: string[];
}
const fixtureRepo = fileURLToPath(
  new URL('../../../fixtures/skills/implement-clamp/repo', import.meta.url),
);
const ALIAS = 'native-1';
const TASK = 'native-live-t1';

/**
 * Live G08: one real small change through XVANT's own loop. The model must
 * qualify by answering the probe with a structured tool call, then add
 * `clamp` to the fixture repository using only registry tools. The host
 * runs the registered check and accepts; nothing the model says counts.
 * A stub provider must use the `offline` classification.
 */
export async function runLiveNative(
  root: string,
  options: {
    provider: ModelProvider;
    classification: 'offline' | 'live';
    maxSteps?: number;
    onEvent?: (alias: string, event: LoopEvent) => void;
  },
): Promise<LiveNativeReport> {
  const { provider } = options;
  const report: LiveNativeReport = {
    classification: options.classification,
    scope: 'live-native',
    provider: provider.id,
    model: provider.model,
    capabilities: null,
    state: null,
    outcome: null,
    finalText: '',
    changedFiles: [],
    modelCalls: 0,
    receipts: [],
    activeCount: 0,
    problems: [],
  };
  report.capabilities = await provider.probe();
  if (!report.capabilities.toolCalls) {
    report.problems.push('model did not answer the probe with a tool call');
    return report;
  }
  const repo = join(realpathSync(root), 'repo');
  cpSync(fixtureRepo, repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=xvant',
        '-c',
        'user.email=xvant@local.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8', windowsHide: true },
    ).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const store = new Store(join(root, 'state.sqlite'), { owner: 'live-native' });
  try {
    const runner = new NativeTurnRunner(
      store,
      new ArtifactStore(join(root, 'objects')),
      [
        {
          alias: ALIAS,
          runtimeKind: 'native-local',
          quotaGroupId: 'local-gpu',
          roles: ['worker'],
        },
      ],
      provider,
      {
        classification: options.classification,
        limits: { maxSteps: options.maxSteps ?? 16 },
        checkTimeoutMs: 60_000,
        stateDir: join(root, 'checkpoints'),
        onEvent: (alias, _taskId, event) => {
          if (event.kind === 'model') report.modelCalls += 1;
          options.onEvent?.(alias, event);
        },
      },
    );
    const outcome = await runner.run({
      taskId: TASK,
      projectId: 'live-native',
      alias: ALIAS,
      prompt:
        'Add clamp(value, min, max) to src/math.js so the "tests" check passes.\n' +
        'clamp returns value limited to the range [min, max] and throws RangeError when min > max. ' +
        'Keep sum unchanged, export clamp, and change no other file. ' +
        'Read test/math.test.mjs and src/math.js first, then run the "tests" check to confirm.',
      workspace: { path: repo, baseCommit: git('rev-parse', 'HEAD') },
      checks: {
        tests: { executable: process.execPath, args: ['test/math.test.mjs'] },
      },
      writablePaths: ['src'],
    });
    report.outcome = outcome.status;
    if (outcome.failure) report.failure = outcome.failure;
    report.finalText = outcome.finalText.slice(0, 2000);
    report.changedFiles = outcome.files;
    report.state = store.getTask(TASK).state;
    for (let after = 0; ;) {
      const page = store.events(after, 1000);
      if (!page.length) break;
      for (const event of page)
        if (event.kind === 'tool.receipt') {
          const { tool, status, code } = event.payload as ToolReceipt;
          report.receipts.push({ tool, status, ...(code ? { code } : {}) });
        }
      after = page.at(-1)!.sequence;
    }
    const connection = store.providers.get(TASK);
    if (outcome.status !== 'accepted')
      report.problems.push(
        'turn ended ' +
          outcome.status +
          ': ' +
          (outcome.failure ?? 'no detail'),
      );
    if (report.state !== 'accepted')
      report.problems.push('task state is ' + report.state);
    if (connection.worker.runtimeKind !== 'native-local')
      report.problems.push('work was not recorded as native-local');
    if (connection.classification !== options.classification)
      report.problems.push('classification was not recorded');
    if (report.changedFiles.join() !== 'src/math.js')
      report.problems.push(
        'changed files: ' + (report.changedFiles.join(', ') || 'none'),
      );
    if (
      !report.receipts.some(
        (r) => r.tool === 'file.apply_patch' && r.status === 'succeeded',
      )
    )
      report.problems.push('no file.apply_patch receipt was journaled');
  } finally {
    store.close();
  }
  return report;
}
