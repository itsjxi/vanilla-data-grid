import type { EncodedTable } from '../core/encode';
import type { Query } from '../core/types';

export type ToWorker =
  | { type: 'load'; version: number; table: EncodedTable }
  | { type: 'query'; id: number; version: number; query: Query };

export type FromWorker =
  | { type: 'result'; id: number; version: number; indices: Uint32Array; ms: number }
  | { type: 'error'; id: number; message: string };
