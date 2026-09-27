import { Controller } from './controller.ts';
import { SimulatedAdapter } from '../../../packages/adapters/src/simulated/index.ts';
import { scenarioSchema } from '../../../packages/contracts/src/index.ts';
const scenario = scenarioSchema.parse(process.argv[2] ?? 'success');
const controller = new Controller(new SimulatedAdapter(), {
  fixture_integrity: async (task) =>
    Boolean(task.treeHash && task.artifactSetHash),
  fixture_review: async (task) => task.acceptanceCriteria.length > 0,
});
controller.registerWorker({
  id: 'worker_a',
  alias: 'simulated_coder',
  hostId: 'local',
  runtimeKind: 'simulated',
  nativeSessionId: 'session_a',
});
controller.create({
  id: 'demo_task',
  projectId: 'demo_project',
  objective: 'Exercise the XVANT offline lifecycle',
  requiredCheckIds: ['fixture_integrity', 'fixture_review'],
  acceptanceCriteria: ['Valid simulated artifact hashes'],
});
controller.queue('demo_task');
const task = await controller.run(
  'demo_task',
  'worker_a',
  'demo_attempt',
  scenario,
);
console.log(
  JSON.stringify(
    {
      runtimeKind: 'simulated',
      simulated: true,
      notice: 'Fixture checks only; no provider or real code execution.',
      scenario,
      task,
      attempt: controller.getAttempt('demo_attempt'),
    },
    null,
    2,
  ),
);
