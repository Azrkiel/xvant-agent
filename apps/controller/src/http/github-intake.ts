import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import type { EventInbox } from '../../../../packages/storage/src/event-inbox.ts';
import { HttpError } from './app-server.ts';

const repoId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const githubIntakeConfig = z
  .array(
    z.strictObject({
      repositoryId: repoId,
      secret: z.string().min(32).max(256),
    }),
  )
  .min(1)
  .max(100)
  .refine(
    (entries) =>
      new Set(entries.map(({ repositoryId }) => repositoryId)).size ===
        entries.length &&
      new Set(entries.map(({ secret }) => secret)).size === entries.length,
  );
export type GitHubIntakeConfig = z.infer<typeof githubIntakeConfig>;

const issues = z.object({
  action: z.enum(['opened', 'edited', 'closed', 'reopened']),
  repository: z.object({ id: repoId }),
  issue: z.object({
    number: repoId,
    updated_at: z.iso.datetime({ precision: 0 }),
    state: z.enum(['open', 'closed']),
    title: z.string(),
    body: z.string().nullable(),
  }),
});
const digest = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

export function githubIntake(config: GitHubIntakeConfig, inbox: EventInbox) {
  const secrets = new Map(
    githubIntakeConfig
      .parse(config)
      .map(({ repositoryId, secret }) => [repositoryId, secret]),
  );
  return (repositoryId: number, headers: IncomingHttpHeaders, body: Buffer) => {
    const secret = secrets.get(repositoryId);
    const signature = headers['x-hub-signature-256'];
    if (
      !secret ||
      typeof signature !== 'string' ||
      !/^sha256=[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(
        Buffer.from(signature.slice(7), 'hex'),
        createHmac('sha256', secret).update(body).digest(),
      )
    )
      throw new HttpError(401, 'INVALID_GITHUB_SIGNATURE');
    const deliveryId = headers['x-github-delivery'];
    if (
      typeof deliveryId !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(deliveryId)
    )
      throw new HttpError(400, 'INVALID_GITHUB_DELIVERY');
    if (headers['x-github-event'] !== 'issues') return { ignored: true };
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'INVALID_JSON');
    }
    // Only the subscribed issue actions are relevant. GitHub sends other issue
    // changes on the same subscription, such as labels and assignments.
    const action = z.object({ action: z.string() }).safeParse(payload);
    if (
      action.success &&
      !issues.shape.action.safeParse(action.data.action).success
    )
      return { ignored: true };
    const result = issues.safeParse(payload);
    if (!result.success || result.data.repository.id !== repositoryId)
      throw new HttpError(400, 'INVALID_GITHUB_ISSUE');
    const issue = result.data.issue;
    return inbox.receive({
      repositoryId,
      deliveryId: deliveryId.toLowerCase(),
      issueNumber: issue.number,
      revision: Date.parse(issue.updated_at),
      fingerprint: digest(
        JSON.stringify([issue.state, issue.title, issue.body]),
      ),
      bodyHash: digest(body),
    });
  };
}
