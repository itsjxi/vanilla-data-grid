import { QueryEngine } from './engine';
import { transferables, type EncodedTable } from './encode';
import type { Query } from './types';
import type { FromWorker, ToWorker } from '../worker/protocol';

export type WorkerMode = 'auto' | 'always' | 'never';

export interface QueryResult {
  indices: Uint32Array;
  /** Time spent sorting and filtering, in ms (excludes messaging). */
  ms: number;
  where: 'worker' | 'main';
}

export interface WorkerLike {
  postMessage(message: ToWorker, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

export interface QueryClientOptions {
  mode?: WorkerMode;
  /** In 'auto' mode, tables smaller than this are queried on the main thread. */
  workerThreshold?: number;
  createWorker?: () => WorkerLike;
}

interface Pending {
  query: Query;
  resolve: (result: QueryResult | null) => void;
  reject: (error: Error) => void;
}

const defaultCreateWorker = (): WorkerLike =>
  new Worker(new URL('../worker/query.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;

/**
 * Runs queries against the current table, on a Web Worker for large tables.
 *
 * Latest wins: at most one query is in flight. While it runs, newer queries replace each
 * other in a one-slot queue, and every superseded caller gets `null`. So typing "london"
 * quickly into a million-row grid runs at most two queries, not six, and a slow early
 * answer can never overwrite a newer one.
 */
export class QueryClient {
  private worker: WorkerLike | null = null;
  private engine: QueryEngine | null = null;
  private version = 0;
  private nextId = 1;
  private inFlight: (Pending & { id: number }) | null = null;
  private queued: Pending | null = null;
  private readonly mode: WorkerMode;
  private readonly workerThreshold: number;
  private readonly createWorker: () => WorkerLike;
  private readonly canUseWorker: boolean;

  constructor(options: QueryClientOptions = {}) {
    this.mode = options.mode ?? 'auto';
    this.workerThreshold = options.workerThreshold ?? 20_000;
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    this.canUseWorker = Boolean(options.createWorker) || typeof Worker !== 'undefined';
  }

  get where(): 'worker' | 'main' {
    return this.worker ? 'worker' : 'main';
  }

  /** Replace the table. Moves (transfers) its typed arrays to the worker when one is used. */
  load(table: EncodedTable, { forceMain = false } = {}): void {
    this.version++;
    this.supersedeAll();
    const useWorker = !forceMain && this.mode !== 'never' && this.canUseWorker
      && (this.mode === 'always' || table.size >= this.workerThreshold);

    if (useWorker) {
      this.engine = null;
      if (!this.worker) this.startWorker();
      this.worker!.postMessage({ type: 'load', version: this.version, table }, transferables(table));
    } else {
      this.stopWorker();
      this.engine = new QueryEngine(table);
    }
  }

  run(query: Query): Promise<QueryResult | null> {
    return new Promise((resolve, reject) => {
      if (this.engine) {
        // Main thread: synchronous, so it is always the latest.
        const started = performance.now();
        const indices = this.engine.run(query);
        resolve({ indices, ms: performance.now() - started, where: 'main' });
        return;
      }
      if (!this.worker) {
        reject(new Error('QueryClient: no table loaded'));
        return;
      }
      this.queued?.resolve(null);
      this.queued = { query, resolve, reject };
      if (!this.inFlight) this.flush();
    });
  }

  destroy(): void {
    this.supersedeAll();
    this.stopWorker();
    this.engine = null;
  }

  private flush(): void {
    if (!this.queued || !this.worker) return;
    const next = { ...this.queued, id: this.nextId++ };
    this.queued = null;
    this.inFlight = next;
    this.worker.postMessage({ type: 'query', id: next.id, version: this.version, query: next.query }, []);
  }

  private onMessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    const current = this.inFlight;
    if (!current || message.id !== current.id) return; // answer to a superseded query
    this.inFlight = null;

    if (message.type === 'error') current.reject(new Error(message.message));
    else if (message.version !== this.version || this.queued) current.resolve(null); // stale
    else current.resolve({ indices: message.indices, ms: message.ms, where: 'worker' });
    this.flush();
  };

  private onError = (event: ErrorEvent) => {
    const error = new Error(`Query worker failed: ${event.message || 'unknown error'}`);
    this.inFlight?.reject(error);
    this.queued?.reject(error);
    this.inFlight = null;
    this.queued = null;
    this.stopWorker();
  };

  private startWorker(): void {
    this.worker = this.createWorker();
    this.worker.onmessage = this.onMessage;
    this.worker.onerror = this.onError;
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private supersedeAll(): void {
    this.inFlight?.resolve(null);
    this.queued?.resolve(null);
    this.inFlight = null;
    this.queued = null;
  }
}
