import type { Column, Row } from './types';
import { toNumber, toTime } from './normalize';

/** Separates values in a joined dictionary string. Stripped from data so a value can never forge a boundary. */
export const SEP = '\u0000';
const SEP_TEST = /\u0000/;
const SEP_ALL = /\u0000/g;

/**
 * Text is dictionary-encoded, the way columnar formats (Arrow, Parquet) do it: each
 * distinct value is stored once, and each row stores a small integer id. Real columns
 * repeat a lot (12 offices, 14 roles, a few thousand names across a million rows), so:
 * - the worker receives typed arrays it can take over for free (transfer, not copy),
 * - search tests each distinct value once instead of once per row,
 * - sorting ranks the distinct values, not a million strings.
 */
export interface TextColumn {
  field: string;
  kind: 'text';
  /** Distinct values joined with SEP (one big string clones far faster than many small ones). */
  dictionary: string;
  /** Dictionary id per row. */
  ids: Uint32Array;
  searchable: boolean;
  sortable: boolean;
}

export interface NumberColumn {
  field: string;
  kind: 'number';
  /** NaN = empty. Dates are epoch milliseconds. */
  values: Float64Array;
  sortable: true;
  searchable: false;
}

export type EncodedColumn = TextColumn | NumberColumn;

export interface EncodedTable {
  size: number;
  columns: EncodedColumn[];
}

const clean = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : String(value);
  return SEP_TEST.test(text) ? text.replace(SEP_ALL, ' ') : text;
};

export function isSearchable(column: Column): boolean {
  return column.searchable ?? (column.type ?? 'text') === 'text';
}

type Builder =
  | { kind: 'text'; field: string; searchable: boolean; sortable: boolean; lookup: Map<string, number>; dictionary: string[]; ids: Uint32Array }
  | { kind: 'number'; field: string; values: Float64Array; convert: (v: unknown) => number };

function createEncoder<T extends Row>(rows: readonly T[], columns: readonly Column<T>[]) {
  const size = rows.length;
  const builders: Builder[] = [];
  for (const column of columns) {
    const type = column.type ?? 'text';
    const sortable = column.sortable !== false;
    const searchable = isSearchable(column as Column);
    if (type === 'text') {
      if (sortable || searchable) builders.push({ kind: 'text', field: column.field, searchable, sortable, lookup: new Map(), dictionary: [], ids: new Uint32Array(size) });
      continue;
    }
    if (sortable) builders.push({ kind: 'number', field: column.field, values: new Float64Array(size), convert: type === 'date' ? toTime : toNumber });
    // A searchable number/date column is also dictionary-encoded as text, for search only.
    if (searchable) builders.push({ kind: 'text', field: column.field, searchable: true, sortable: false, lookup: new Map(), dictionary: [], ids: new Uint32Array(size) });
  }

  return {
    step(from: number, to: number) {
      for (const b of builders) {
        const field = b.field;
        if (b.kind === 'number') {
          for (let i = from; i < to; i++) b.values[i] = b.convert(rows[i][field]);
          continue;
        }
        const { lookup, dictionary, ids } = b;
        for (let i = from; i < to; i++) {
          const value = clean(rows[i][field]);
          let id = lookup.get(value);
          if (id === undefined) {
            id = dictionary.length;
            lookup.set(value, id);
            dictionary.push(value);
          }
          ids[i] = id;
        }
      }
    },
    finish(): EncodedTable {
      return {
        size,
        columns: builders.map((b): EncodedColumn => (b.kind === 'number'
          ? { field: b.field, kind: 'number', values: b.values, sortable: true, searchable: false }
          : { field: b.field, kind: 'text', dictionary: b.dictionary.join(SEP), ids: b.ids, searchable: b.searchable, sortable: b.sortable })),
      };
    },
  };
}

export function encodeTable<T extends Row>(rows: readonly T[], columns: readonly Column<T>[]): EncodedTable {
  const encoder = createEncoder(rows, columns);
  encoder.step(0, rows.length);
  return encoder.finish();
}

/** Yield to the browser so it can paint and handle input. MessageChannel avoids setTimeout's 4ms clamp. */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}

export interface EncodeOptions {
  /** Main-thread time to spend per slice before yielding, in ms. */
  sliceMs?: number;
  /** Return true to stop early (e.g. newer data arrived); the promise then resolves to null. */
  cancelled?: () => boolean;
  yieldFn?: () => Promise<void>;
}

/**
 * Time-sliced encodeTable: works in ~sliceMs bursts and yields in between, so preparing a
 * million rows never freezes scrolling or typing.
 */
export async function encodeTableAsync<T extends Row>(
  rows: readonly T[], columns: readonly Column<T>[], { sliceMs = 12, cancelled, yieldFn = yieldToMain }: EncodeOptions = {},
): Promise<EncodedTable | null> {
  const encoder = createEncoder(rows, columns);
  const BATCH = 4096;
  let i = 0;
  while (i < rows.length) {
    const started = performance.now();
    do {
      const next = Math.min(rows.length, i + BATCH);
      encoder.step(i, next);
      i = next;
    } while (i < rows.length && performance.now() - started < sliceMs);
    if (i < rows.length) {
      await yieldFn();
      if (cancelled?.()) return null;
    }
  }
  return encoder.finish();
}

/** Buffers that can be transferred (moved, not copied) to a worker. */
export function transferables(table: EncodedTable): ArrayBuffer[] {
  return table.columns.map((c) => (c.kind === 'number' ? c.values.buffer : c.ids.buffer) as ArrayBuffer);
}
