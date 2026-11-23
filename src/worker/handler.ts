import { QueryEngine } from '../core/engine';
import type { FromWorker, ToWorker } from './protocol';

type Post = (message: FromWorker, transfer: Transferable[]) => void;

/** Worker logic as a plain function, so tests can drive it without a real Worker. */
export function createWorkerHandler(post: Post) {
  let engine: QueryEngine | null = null;
  let version = -1;

  return (message: ToWorker) => {
    if (message.type === 'load') {
      engine = new QueryEngine(message.table);
      version = message.version;
      return;
    }
    if (!engine || message.version !== version) return; // a newer table replaced this one
    const started = performance.now();
    try {
      const indices = engine.run(message.query);
      post({ type: 'result', id: message.id, version, indices, ms: performance.now() - started }, [indices.buffer]);
    } catch (err) {
      post({ type: 'error', id: message.id, message: err instanceof Error ? err.message : String(err) }, []);
    }
  };
}
