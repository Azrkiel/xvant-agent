import { describe, expect, it, vi } from 'vitest';
import { JsonLineDecoder, RpcChannel } from './transport.ts';

describe('bounded JSON line transport', () => {
  it('decodes fragmented UTF-8 and multiple frames without losing characters', () => {
    const decoder = new JsonLineDecoder(100);
    const bytes = Buffer.from('{"text":"雪"}\r\n{"id":2}\n');
    const out: unknown[] = [];
    for (const byte of bytes) out.push(...decoder.push(Buffer.from([byte])));
    expect(out).toEqual([{ text: '雪' }, { id: 2 }]);
    decoder.end();
  });
  it.each([
    Buffer.from('{bad}\n'),
    Buffer.from([0xff, 10]),
    Buffer.from('[]\n'),
    Buffer.from('null\n'),
  ])('rejects malformed frames and remains poisoned', (bytes) => {
    const decoder = new JsonLineDecoder(100);
    expect(() => decoder.push(bytes)).toThrow('INVALID_EVENT');
    expect(() => decoder.push(Buffer.from('{}\n'))).toThrow();
  });
  it('counts bytes rather than characters and rejects truncated EOF', () => {
    const decoder = new JsonLineDecoder(4);
    expect(() => decoder.push(Buffer.from('雪雪'))).toThrow('LIMIT_EXCEEDED');
    const truncated = new JsonLineDecoder(100);
    truncated.push(Buffer.from('{"id":1}'));
    expect(() => truncated.end()).toThrow('OPERATION_UNKNOWN');
  });
  it('bounds chunks and rejects zero or excessive limits', () => {
    expect(() => new JsonLineDecoder(0)).toThrow('INVALID_INPUT');
    expect(() => new JsonLineDecoder(2 ** 30)).toThrow('INVALID_INPUT');
    expect(() => new JsonLineDecoder(100).push(Buffer.alloc(1048577))).toThrow(
      'LIMIT_EXCEEDED',
    );
  });
});

describe('RPC request lifecycle', () => {
  it('sends notifications and denial responses without fabricating request acknowledgements', async () => {
    const frames: unknown[] = [];
    const channel = new RpcChannel({
      beforeWrite: async () => {},
      write: async (frame) => {
        frames.push(JSON.parse(frame));
      },
    });
    await channel.notify('initialized', {});
    await channel.respond('server-1', { decision: 'decline' });
    expect(frames).toEqual([
      { method: 'initialized', params: {} },
      { id: 'server-1', result: { decision: 'decline' } },
    ]);
    channel.close();
  });
  it('persists intent before write and correlates out-of-order replies', async () => {
    const order: string[] = [];
    const frames: Record<string, unknown>[] = [];
    const channel = new RpcChannel({
      beforeWrite: async (intent) => {
        order.push('persist:' + intent.id);
      },
      write: async (frame) => {
        const value = JSON.parse(frame);
        frames.push(value);
        order.push('write:' + value.id);
      },
    });
    const a = channel.request('read/a', {});
    const b = channel.request('read/b', {});
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    channel.receive(
      Buffer.from(
        JSON.stringify({ id: frames[1]!.id, result: 'b' }) +
          '\n' +
          JSON.stringify({ id: frames[0]!.id, result: 'a' }) +
          '\n',
      ),
    );
    expect(await a).toBe('a');
    expect(await b).toBe('b');
    for (const f of frames)
      expect(order.indexOf('persist:' + f.id)).toBeLessThan(
        order.indexOf('write:' + f.id),
      );
    channel.close();
  });
  it('does not write when persisting intent fails', async () => {
    const write = vi.fn();
    const channel = new RpcChannel({
      beforeWrite: async () => {
        throw new Error('secret path');
      },
      write,
    });
    await expect(channel.request('turn/start', {})).rejects.toThrow(
      'STORAGE_UNAVAILABLE',
    );
    expect(write).not.toHaveBeenCalled();
    expect(channel.uncertainIds).toEqual([]);
    channel.close();
  });
  it('write failures poison the connection and never retry', async () => {
    const write = vi.fn(async () => {
      throw new Error('secret');
    });
    const channel = new RpcChannel({ beforeWrite: async () => {}, write });
    await expect(channel.request('turn/start', {})).rejects.toThrow(
      'OPERATION_UNKNOWN',
    );
    expect(channel.uncertainIds).toHaveLength(1);
    await expect(channel.request('turn/start', {})).rejects.toThrow(
      'CONNECTION_CLOSED',
    );
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('disconnects reject pending operations and retain uncertain IDs', async () => {
    const write = vi.fn(async () => {});
    const channel = new RpcChannel({ beforeWrite: async () => {}, write });
    const p = channel.request('turn/start', {});
    const rejected = expect(p).rejects.toThrow('OPERATION_UNKNOWN');
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    channel.close();
    await rejected;
    expect(channel.uncertainIds).toHaveLength(1);
  });
  it('timeouts prevent a late persistence callback from sending', async () => {
    vi.useFakeTimers();
    try {
      let persist!: () => void;
      const write = vi.fn(async () => {});
      const channel = new RpcChannel({
        timeoutMs: 50,
        beforeWrite: () =>
          new Promise<void>((resolve) => {
            persist = resolve;
          }),
        write,
      });
      const p = channel.request('turn/start', {});
      const rejected = expect(p).rejects.toThrow('OPERATION_UNKNOWN');
      await vi.advanceTimersByTimeAsync(51);
      await rejected;
      persist();
      await Promise.resolve();
      expect(write).not.toHaveBeenCalled();
      expect(channel.uncertainIds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('bounds pending requests and outbound frames before persistence', async () => {
    const beforeWrite = vi.fn(async () => {});
    const channel = new RpcChannel({
      beforeWrite,
      write: async () => {},
      maxPending: 1,
      maxFrameBytes: 256,
    });
    await expect(
      channel.request('turn/start', { text: 'x'.repeat(300) }),
    ).rejects.toThrow('LIMIT_EXCEEDED');
    expect(beforeWrite).not.toHaveBeenCalled();
    const p = channel.request('turn/start', {});
    const rejected = expect(p).rejects.toThrow('OPERATION_UNKNOWN');
    await expect(channel.request('turn/start', {})).rejects.toThrow(
      'WORKER_BUSY',
    );
    channel.close();
    await rejected;
  });
  it('routes notifications and server requests without treating them as acknowledgements', async () => {
    const inbound = vi.fn();
    const channel = new RpcChannel({
      beforeWrite: async () => {},
      write: async () => {},
      onMessage: inbound,
    });
    channel.receive(
      Buffer.from(
        '{"method":"turn/started","params":{}}\n{"id":1,"method":"approval","params":{}}\n',
      ),
    );
    expect(inbound).toHaveBeenCalledTimes(2);
    channel.close();
  });
  it('rejects unknown response IDs, ambiguous envelopes, and notification handler failures', async () => {
    for (const input of [
      { id: 999, result: {} },
      { id: 1, result: {}, error: { code: 1, message: 'secret' } },
      { method: 'notification' },
    ]) {
      const channel = new RpcChannel({
        beforeWrite: async () => {},
        write: async () => {},
        onMessage: () => {
          throw new Error('secret');
        },
      });
      expect(() =>
        channel.receive(Buffer.from(JSON.stringify(input) + '\n')),
      ).toThrow('INVALID_EVENT');
      await expect(channel.request('turn/start', {})).rejects.toThrow(
        'CONNECTION_CLOSED',
      );
    }
  });
  it('returns redacted RPC errors without leaking message or data', async () => {
    let id: number | undefined;
    const channel = new RpcChannel({
      beforeWrite: async () => {},
      write: async (frame) => {
        id = JSON.parse(frame).id;
      },
    });
    const p = channel.request('turn/start', {});
    const rejected = expect(p).rejects.toThrow('RPC_ERROR:-32601');
    await vi.waitFor(() => expect(id).toBeDefined());
    channel.receive(
      Buffer.from(
        JSON.stringify({
          id,
          error: { code: -32601, message: 'secret', data: 'token' },
        }) + '\n',
      ),
    );
    await rejected;
    expect(channel.uncertainIds).toEqual([]);
    channel.close();
  });
});
