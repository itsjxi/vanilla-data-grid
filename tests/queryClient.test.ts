import { describe, it, expect } from 'vitest';
import { QueryClient, type WorkerLike } from '../src/core/queryClient';
import { encodeTable } from '../src/core/encode';
import { createWorkerHandler } from '../src/worker/handler';
import type { FromWorker, ToWorker } from '../src/worker/protocol';

const rows = ['London', 'Tokyo', 'Paris', 'Lagos', 'Lima'].map((city, id) => ({ id, city }));
const table = () => encodeTable(rows, [{ field: 'city', title: 'City' }]);

/** A Worker stand-in that holds answers until the test releases them. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  received: ToWorker[] = [];
  outbox: FromWorker[] = [];
  terminated = false;
  private handle = createWorkerHandler((message) => this.outbox.push(message));
  postMessage(message: ToWorker) {
    this.received.push(message);
    this.handle(message);
  }
  deliver() {
    const message = this.outbox.shift();
    if (message) this.onmessage?.({ data: message } as MessageEvent<FromWorker>);
  }
  terminate() { this.terminated = true; }
}

const setup = () => {
  const worker = new FakeWorker();
  const client = new QueryClient({ mode: 'always', createWorker: () => worker });
  client.load(table());
  return { worker, client };
};
const queries = (w: FakeWorker) => w.received.filter((m) => m.type === 'query').length;

describe('QueryClient', () => {
  it('runs on the main thread for small tables in auto mode', async () => {
    const client = new QueryClient({ mode: 'auto', workerThreshold: 100, createWorker: () => new FakeWorker() });
    client.load(table());
    expect(client.where).toBe('main');
    const result = await client.run({ search: 'l', sort: null });
    expect(result?.where).toBe('main');
    expect([...result!.indices]).toEqual([0, 3, 4]);
  });

  it('keeps one query in flight and only the newest queued; superseded callers get null', async () => {
    const { worker, client } = setup();
    expect(client.where).toBe('worker');
    const a = client.run({ search: 'l', sort: null });
    const b = client.run({ search: 'la', sort: null });
    const c = client.run({ search: 'lag', sort: null });
    expect(queries(worker)).toBe(1); // b and c wait
    await expect(b).resolves.toBeNull(); // replaced by c before it was sent

    worker.deliver(); // a's answer arrives, but c is waiting, so a is stale
    await expect(a).resolves.toBeNull();
    expect(queries(worker)).toBe(2); // c sent now

    worker.deliver();
    const result = await c;
    expect(result?.where).toBe('worker');
    expect([...result!.indices]).toEqual([3]);
  });

  it('drops answers for a table that has since been replaced', async () => {
    const { worker, client } = setup();
    const old = client.run({ search: 'l', sort: null });
    client.load(table());
    await expect(old).resolves.toBeNull();
    worker.deliver(); // late answer for the old version is ignored
    const fresh = client.run({ search: 'tokyo', sort: null });
    worker.deliver();
    expect([...(await fresh)!.indices]).toEqual([1]);
  });

  it('rejects pending queries and stops the worker when it crashes', async () => {
    const { worker, client } = setup();
    const pending = client.run({ search: 'l', sort: null });
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(pending).rejects.toThrow('Query worker failed: boom');
    expect(worker.terminated).toBe(true);
  });
});
