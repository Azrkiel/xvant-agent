import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/index.ts';
import { revisionSchema } from '../../../packages/contracts/src/context.ts';
import {
  decisionDetailsSchema,
  memoryProposalSchema,
} from '../../../packages/contracts/src/memory.ts';
import {
  exportMemoryBundle,
  importMemoryBundle,
} from '../../../packages/context/src/transfer.ts';
import { containsSecret } from '../../../packages/context/src/secrets.ts';
import {
  assessMemory,
  memoryContextItems,
  type FileHash,
} from '../../../packages/memory/src/relevance.ts';
import type { Store } from '../../../packages/storage/src/store.ts';
import { HttpError } from './http/app-server.ts';

const version = z.number().int().positive();
const item = { id: idSchema, expectedVersion: z.number().int().nonnegative() };
const command = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('propose'),
    commandId: idSchema,
    id: idSchema,
    expectedBacklog: version,
    revision: revisionSchema,
    content: memoryProposalSchema.shape.content,
    details: decisionDetailsSchema,
    anchors: memoryProposalSchema.shape.anchors,
    supersedes: idSchema.optional(),
  }),
  z.strictObject({
    action: z.enum(['accept', 'reject', 'forget']),
    commandId: idSchema,
    ...item,
  }),
  z.strictObject({
    action: z.literal('import'),
    commandId: idSchema,
    bundle: z.unknown(),
  }),
]);

const namespace = 'project-decisions';
const maxRecords = 32;

export class ProjectKnowledge {
  readonly #store: Store;
  constructor(store: Store) {
    this.#store = store;
  }

  #current(projectId: string) {
    const view = this.#store.contracts.getBacklog(projectId);
    return view.status === 'current' && view.backlog ? view.backlog : null;
  }

  #records(projectId: string, all = false) {
    return this.#store.memory.search(projectId, {
      namespaces: [namespace],
      ...(all
        ? { statuses: ['accepted', 'proposed', 'rejected', 'superseded'] }
        : {}),
      limit: maxRecords,
    });
  }

  view(projectId: string) {
    return {
      backlog: this.#store.contracts.getBacklog(projectId),
      records: this.#records(projectId, true),
    };
  }

  export(projectId: string, now = Date.now()) {
    const current = this.#current(projectId);
    const records = current
      ? this.#store.memory.projectDecisions({
          projectId,
          projectVersion: current.projectVersion,
          policyVersion: current.policyVersion,
          backlogRevision: current.revision,
        })
      : [];
    return exportMemoryBundle(records, { projectId, now });
  }

  apply(projectId: string, raw: unknown) {
    const input = command.parse(raw);
    return this.#store.projectKnowledgeCommand(
      projectId,
      input.commandId,
      input,
      () => {
        const { project } = this.#store.contracts.getProject(projectId);
        const actorId = project.ownerIntent.actorId;
        if (input.action === 'import') {
          const { proposals, skipped } = importMemoryBundle(input.bundle, {
            projectId,
            actorId,
          });
          if (proposals.length > maxRecords)
            throw new HttpError(400, 'LIMIT_EXCEEDED');
          const records = proposals
            .filter(
              (proposal) =>
                proposal.namespace === namespace &&
                proposal.kind === 'decision',
            )
            .map((proposal) => this.#store.memory.propose(proposal));
          return { records, skipped };
        }
        const current = this.#current(projectId);
        if (input.action === 'propose') {
          if (!current || current.revision !== input.expectedBacklog)
            throw new HttpError(409, 'CONFLICT');
          const requirements = new Set(
            project.requirements.map(({ id }) => id),
          );
          if (
            input.details.requirementIds.some((id) => !requirements.has(id)) ||
            containsSecret(JSON.stringify(input))
          )
            throw new HttpError(400, 'INVALID_INPUT');
          return this.#store.memory.propose({
            id: input.id,
            projectId,
            namespace,
            kind: 'decision',
            content: input.content,
            confidence: 'reported',
            anchors: input.anchors,
            supersedes: input.supersedes,
            decision: {
              ...input.details,
              projectVersion: current.projectVersion,
              policyVersion: current.policyVersion,
              backlogRevision: current.revision,
            },
            provenance: { source: 'user', actorId, revision: input.revision },
          });
        }
        const record = this.#store.memory.get(projectId, input.id);
        if (record.namespace !== namespace)
          throw new HttpError(404, 'NOT_FOUND');
        if (input.action === 'forget')
          return this.#store.memory.forget(
            projectId,
            input.id,
            input.expectedVersion,
          );
        if (
          input.action === 'accept' &&
          (!current || current.revision !== record.decision?.backlogRevision)
        )
          throw new HttpError(409, 'CONFLICT');
        return this.#store.memory.decide(projectId, input.id, {
          decision: input.action,
          actorId,
          expectedVersion: input.expectedVersion,
        });
      },
    );
  }

  /** Caller supplies trusted file hashes for the task's pinned checkout. */
  forTask(
    taskId: string,
    files: readonly FileHash[],
    milestoneRequirements?: readonly string[],
  ) {
    const {
      record: { task },
      decision,
    } = this.#store.contracts.getTask(taskId);
    const current = this.#current(task.projectId);
    if (!current || decision.blockers.includes('authorization_stale'))
      return [];
    const records = this.#store.memory.projectDecisions({
      projectId: task.projectId,
      projectVersion: task.projectVersion,
      policyVersion: task.policyVersion,
      backlogRevision: current.revision,
      revision: task.baseRevision,
      requirementIds: milestoneRequirements
        ? task.requirementIds.filter((id) => milestoneRequirements.includes(id))
        : task.requirementIds,
    });
    const { items } = memoryContextItems(
      assessMemory(records, files),
      task.projectId,
    );
    let remaining = 32 * 1024 - 2;
    return items.filter((item) => {
      const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (bytes > remaining) return false;
      remaining -= bytes;
      return true;
    });
  }

  /** Manager turns get only knowledge bound to the exact pinned base and milestone. */
  forManagerTurn(rootId: string, slot: string, revision: string) {
    const node = /^node:([^:]+):[0-9]+$/.exec(slot);
    if (!node) return [];
    const run = this.#store.contracts.managerRun(rootId);
    if (!run) return [];
    const current = this.#current(run.projectId);
    if (!current || current.revision !== run.revision) return [];
    const milestone = current.milestones.find(({ id }) => id === node[1]);
    const {
      record: { task },
    } = this.#store.contracts.getTask(run.taskId);
    if (!milestone || task.baseRevision !== revision) return [];
    // No file evidence is collected by this scheduler hook. Anchored records
    // are only eligible through a host caller that supplies those file hashes.
    return this.forTask(task.id, [], milestone.requirementIds);
  }
}
