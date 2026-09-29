import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/storage/src/store.ts';
import { ArtifactStore } from '../packages/storage/src/artifacts.ts';
import { OfflineNativeController } from '../apps/controller/src/native-offline.ts';
import { versions } from '../packages/adapters/src/providers/native-profiles.ts';

const kind = process.argv[2];
const scenario = process.argv[3] ?? 'permission';
const mode = process.argv[4] ?? 'resume';
if (mode !== 'resume' && mode !== 'create') throw new Error('INVALID_INPUT');
if (kind !== 'claude' && kind !== 'opencode') throw new Error('INVALID_INPUT');
if (scenario !== 'permission' && scenario !== 'interrupt')
  throw new Error('INVALID_INPUT');
const root = mkdtempSync(join(tmpdir(), 'xvant-native-controller-demo-'));
let store, controller;
try {
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'result.txt'), 'offline fixture');
  store = new Store(join(root, 'state.sqlite'), { owner: 'fixture' });
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Read fixture',
    requiredCheckIds: ['check'],
    acceptanceCriteria: ['Pass'],
  });
  store.queue('queue', 'task', 0);
  controller = new OfflineNativeController(
    store,
    new ArtifactStore(join(root, 'objects')),
    { workspace },
    {
      check: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
    },
  );
  const pending = controller.run(
    {
      connectionId: 'connection',
      taskId: 'task',
      attemptId: 'attempt',
      workspaceId: 'workspace',
      expectedVersion: 1,
      classification: 'offline',
      worker: {
        id: 'worker',
        alias: 'worker',
        runtimeKind: kind,
        hostId: 'host',
        endpointId: 'fixture',
        nativeSessionId:
          kind === 'claude' && mode === 'create'
            ? '6306ed11-5ca4-4c61-a177-5b64eddf5d5b'
            : 'session-1',
        runtimeVersion: versions[kind],
        adapterVersion: 'v1',
        mode: 'managed',
        quotaGroupId: 'account',
      },
    },
    scenario,
    mode,
  );
  // A host operator polls admission until the running turn can be interrupted.
  let admission;
  for (let tries = 0; scenario === 'interrupt' && !admission; tries++) {
    try {
      admission = controller.interrupt('connection', 'operator').status;
    } catch (error) {
      if (error.message !== 'NOT_INTERRUPTIBLE' || tries >= 1000) throw error;
      await new Promise((done) => setTimeout(done, 5));
    }
  }
  const task = await pending;
  const connection = store.providers.get('connection');
  console.log(
    JSON.stringify({
      classification: 'offline',
      liveProvidersTested: [],
      kind,
      state: task.state,
      verification: connection.verification?.status,
      outcome: connection.outcome,
      interruptAdmission: admission ?? null,
      interruptActor: connection.interrupt?.actorId ?? null,
      sessionBound: connection.sessionBound === true,
      nativeSessionId: connection.worker.nativeSessionId,
      journalEntries: store.providers.entries('connection').length,
      activeCount: controller.activeCount,
      accepted: store
        .events(0)
        .some((event) => event.kind === 'native.accepted'),
    }),
  );
  if (
    scenario === 'permission'
      ? task.state !== 'ready_for_acceptance'
      : task.state !== 'needs_attention' || connection.outcome !== 'cancelled'
  )
    process.exitCode = 1;
} finally {
  controller?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true });
}
