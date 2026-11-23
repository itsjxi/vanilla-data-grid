import type { Query, SortState } from './types';
import { SEP, type EncodedTable, type NumberColumn, type TextColumn } from './encode';
import { normalizeText, searchTerms } from './normalize';

/**
 * Sort keys are packed as `rank * INDEX_SPACE + rowIndex` into a Float64Array, so the
 * engine can use the native numeric sort (no comparator callback) and still get a
 * stable, deterministic order. 2^21 rows keeps every key below 2^42, well inside the
 * 2^53 range where doubles are exact integers.
 */
export const INDEX_SPACE = 2 ** 21;
export const MAX_TERMS = 32;
const ORDER_CACHE_SIZE = 4;

interface Ranking {
  /** Dense rank per row: equal values share a rank. */
  rank: Uint32Array;
  /** Rank given to empty values; also the number of distinct present values. */
  missing: number;
}

function rankNumbers(values: Float64Array): Ranking {
  const present = values.filter((v) => !Number.isNaN(v)).sort(); // typed-array sort is numeric
  const unique: number[] = [];
  for (let i = 0; i < present.length; i++) if (i === 0 || present[i] !== present[i - 1]) unique.push(present[i]);
  const rank = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) { rank[i] = unique.length; continue; }
    let lo = 0;
    let hi = unique.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (unique[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    rank[i] = lo;
  }
  return { rank, missing: unique.length };
}

/**
 * Rank a dictionary-encoded text column: sort the distinct values once with Intl.Collator,
 * then each row's rank is a lookup by its id. A million rows with a few thousand distinct
 * names costs a few thousand collator comparisons' worth of sorting, not a million.
 */
function rankText(dictionary: string[], ids: Uint32Array, collator: Intl.Collator): Ranking {
  const order = dictionary.map((_, i) => i).filter((i) => dictionary[i] !== '');
  order.sort((a, b) => collator.compare(dictionary[a], dictionary[b]));

  const rankOfId = new Uint32Array(dictionary.length);
  let rankValue = 0;
  for (let i = 0; i < order.length; i++) {
    if (i > 0 && collator.compare(dictionary[order[i - 1]], dictionary[order[i]]) !== 0) rankValue++;
    rankOfId[order[i]] = rankValue;
  }
  const missing = order.length ? rankValue + 1 : 0;
  const emptyId = dictionary.indexOf('');
  if (emptyId !== -1) rankOfId[emptyId] = missing;

  const rank = new Uint32Array(ids.length);
  for (let i = 0; i < ids.length; i++) rank[i] = rankOfId[ids[i]];
  return { rank, missing };
}

/**
 * Pure sort + search over an EncodedTable. Runs inside the Web Worker, and on the main
 * thread for small tables or when workers are unavailable. Returns row indices in view order.
 */
export class QueryEngine {
  private readonly rankings = new Map<string, Ranking>();
  private readonly dictionaries = new Map<string, string[]>();
  private readonly normalized = new Map<string, string[]>();
  private readonly orders = new Map<string, Uint32Array>();
  private identityOrder: Uint32Array | null = null;
  private readonly collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  constructor(private readonly table: EncodedTable) {}

  get size(): number {
    return this.table.size;
  }

  /** Always returns a fresh array: the caller may transfer it away. */
  run(query: Query): Uint32Array {
    const base = query.sort ? this.sorted(query.sort) : this.identity();
    const terms = searchTerms(query.search).slice(0, MAX_TERMS);
    if (terms.length === 0) return base.slice();

    const hits = this.match(terms);
    const need = terms.length;
    let count = 0;
    for (let i = 0; i < base.length; i++) if (hits[base[i]] === need) count++;
    const out = new Uint32Array(count);
    for (let i = 0, j = 0; i < base.length; i++) if (hits[base[i]] === need) out[j++] = base[i];
    return out;
  }

  /**
   * hits[row] = how many terms (in order) the row has matched; a row matches when it reaches
   * terms.length. Each term is tested once per distinct value, then rows are checked with an
   * array lookup by id.
   */
  match(terms: string[]): Uint8Array {
    const size = this.table.size;
    const hits = new Uint8Array(size);
    const columns = this.table.columns.filter((c): c is TextColumn => c.kind === 'text' && c.searchable);

    for (let t = 0; t < terms.length; t++) {
      const term = terms[t];
      const active: { ids: Uint32Array; mask: Uint8Array }[] = [];
      for (const column of columns) {
        const values = this.normalizedDictionary(column);
        const mask = new Uint8Array(values.length);
        let any = false;
        for (let d = 0; d < values.length; d++) {
          if (values[d].includes(term)) { mask[d] = 1; any = true; }
        }
        if (any) active.push({ ids: column.ids, mask });
      }
      if (active.length === 0) return hits; // no value anywhere contains this term

      for (let i = 0; i < size; i++) {
        if (hits[i] !== t) continue;
        for (let a = 0; a < active.length; a++) {
          if (active[a].mask[active[a].ids[i]]) { hits[i] = t + 1; break; }
        }
      }
    }
    return hits;
  }

  private dictionary(column: TextColumn): string[] {
    let values = this.dictionaries.get(column.field);
    if (!values) {
      values = column.dictionary.split(SEP);
      this.dictionaries.set(column.field, values);
    }
    return values;
  }

  private normalizedDictionary(column: TextColumn): string[] {
    let values = this.normalized.get(column.field);
    if (!values) {
      values = this.dictionary(column).map(normalizeText);
      this.normalized.set(column.field, values);
    }
    return values;
  }

  private identity(): Uint32Array {
    if (!this.identityOrder) {
      this.identityOrder = new Uint32Array(this.table.size);
      for (let i = 0; i < this.table.size; i++) this.identityOrder[i] = i;
    }
    return this.identityOrder;
  }

  private ranking(column: NumberColumn | TextColumn): Ranking {
    let ranking = this.rankings.get(column.field);
    if (!ranking) {
      ranking = column.kind === 'number'
        ? rankNumbers(column.values)
        : rankText(this.dictionary(column), column.ids, this.collator);
      this.rankings.set(column.field, ranking);
    }
    return ranking;
  }

  /** Full-table order for a sort, cached (small LRU) so typing in search never re-sorts. */
  sorted(sort: SortState): Uint32Array {
    const key = `${sort.field}:${sort.direction}`;
    const cached = this.orders.get(key);
    if (cached) {
      this.orders.delete(key);
      this.orders.set(key, cached);
      return cached;
    }
    const column = this.table.columns.find((c) => c.field === sort.field && c.sortable);
    if (!column) return this.identity();

    const order = this.computeOrder(this.ranking(column), sort.direction);
    this.orders.set(key, order);
    if (this.orders.size > ORDER_CACHE_SIZE) this.orders.delete(this.orders.keys().next().value!);
    return order;
  }

  private computeOrder({ rank, missing }: Ranking, direction: SortState['direction']): Uint32Array {
    const size = this.table.size;
    // Empty values sort last in both directions; ties keep their original order.
    const keyOf = (r: number) => (r === missing ? missing : direction === 'asc' ? r : missing - 1 - r);
    const order = new Uint32Array(size);

    if (size <= INDEX_SPACE) {
      const keys = new Float64Array(size);
      for (let i = 0; i < size; i++) keys[i] = keyOf(rank[i]) * INDEX_SPACE + i;
      keys.sort();
      for (let i = 0; i < size; i++) order[i] = keys[i] % INDEX_SPACE;
      return order;
    }

    // Beyond 2^21 rows the packed key could lose precision: fall back to a comparator.
    for (let i = 0; i < size; i++) order[i] = i;
    return order.sort((a, b) => keyOf(rank[a]) - keyOf(rank[b]) || a - b);
  }
}
