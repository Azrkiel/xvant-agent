import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Store } from './store.ts';

it('atomically records progress and intent, fences claims, and deduplicates exact results', () => {
  const root = mkdtempSync(join(tmpdir(), 'xvant-workflows-'));
  const path = join(root, 'state.sqlite');
  let kill = false;
  let writer = new Store(path, {
    owner: 'first',
    fault: (point) => {
      if (kill && point === 'workflow.intent.before_commit:node')
        throw new Error('rollback');
    },
  });
  try {
    writer.graphs.create('root', 'project', { phase: 'running' }, {});
    const prepare = () =>
      writer.workflows.atomic(() => {
        writer.graphs.update(
          'root',
          1,
          { phase: 'working' },
          'node.dispatched',
          {},
        );
        writer.workflows.write('root', { cursor: 'node' });
        return writer.workflows.prepare('root', 'node', 'turn', {
          taskId: 'task',
        });
      });
    kill = true;
    expect(prepare).toThrow('rollback');
    expect(writer.workflows.read('root')).toBeNull();
    expect(writer.workflows.actions('root')).toEqual([]);
    expect(writer.graphs.get('root').rowVersion).toBe(1);
    kill = false;
    const pending = prepare();
    expect(pending.status).toBe('prepared');
    writer.close();
    writer = new Store(path, { owner: 'second' });
    const claimed = writer.workflows.claim('root', 'node');
    expect(claimed.generation).toBeGreaterThan(pending.generation);
    expect(() => writer.workflows.claim('root', 'node')).toThrow(
      'UNRESOLVED_WORKFLOW_ACTION',
    );
    expect(() =>
      writer.workflows.complete('root', 'node', pending.generation, {
        result: 'obsolete',
      }),
    ).toThrow('STALE_FENCE');
    writer.workflows.complete('root', 'node', claimed.generation, {
      result: 'exact',
    });
    writer.workflows.complete('root', 'node', claimed.generation, {
      result: 'exact',
    });
    expect(() =>
      writer.workflows.complete('root', 'node', claimed.generation, {
        result: 'changed',
      }),
    ).toThrow('CONFLICT');
    expect(writer.workflows.action('root', 'node')).toMatchObject({
      status: 'completed',
      result: { result: 'exact' },
    });
    writer.close();
    writer = new Store(path, { owner: 'third' });
    expect(writer.workflows.read('root')).toEqual({ cursor: 'node' });
    expect(writer.graphs.get('root').rowVersion).toBe(2);
    expect(() =>
      writer.workflows.complete('root', 'node', claimed.generation, {
        result: 'exact',
      }),
    ).toThrow('STALE_FENCE');
  } finally {
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
