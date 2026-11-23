import { describe, it, expect } from 'vitest';
import { encodeTable } from '../src/core/encode';
import { QueryEngine } from '../src/core/engine';
import type { Column } from '../src/core/types';

type Person = { id: number; name: string; office: string; salary: string; start: string };
const rows: Person[] = [
  { id: 1, name: 'Zoë Adams', office: 'London', salary: '$90,000', start: '2012-03-01' },
  { id: 2, name: 'adam Brown', office: 'Tokyo', salary: '$1,200,000', start: '2010-01-15' },
  { id: 3, name: 'Item 10', office: 'london', salary: '', start: '' },
  { id: 4, name: 'Item 2', office: 'New York', salary: '$320,800', start: '2011-07-25' },
  { id: 5, name: 'Chen Li', office: 'Tokyo', salary: '$90,000', start: '2010-01-15' },
];
const columns: Column<Person>[] = [
  { field: 'id', title: 'ID', type: 'number' },
  { field: 'name', title: 'Name' },
  { field: 'office', title: 'Office' },
  { field: 'salary', title: 'Salary', type: 'number' },
  { field: 'start', title: 'Start', type: 'date' },
];
const engine = () => new QueryEngine(encodeTable(rows, columns));
const ids = (order: Uint32Array) => [...order].map((i) => rows[i].id);

describe('QueryEngine sort', () => {
  it('sorts currency strings numerically, keeps ties stable, puts empties last both ways', () => {
    const e = engine();
    expect(ids(e.run({ search: '', sort: { field: 'salary', direction: 'asc' } }))).toEqual([1, 5, 4, 2, 3]);
    expect(ids(e.run({ search: '', sort: { field: 'salary', direction: 'desc' } }))).toEqual([2, 4, 1, 5, 3]);
  });

  it('sorts text case-insensitively and numeric-aware', () => {
    expect(ids(engine().run({ search: '', sort: { field: 'name', direction: 'asc' } }))).toEqual([2, 5, 4, 3, 1]);
  });

  it('treats values the collator considers equal as ties (keeps original order)', () => {
    expect(ids(engine().run({ search: '', sort: { field: 'office', direction: 'asc' } }))).toEqual([1, 3, 4, 2, 5]);
  });

  it('sorts dates and leaves unknown fields in original order', () => {
    const e = engine();
    expect(ids(e.run({ search: '', sort: { field: 'start', direction: 'asc' } }))).toEqual([2, 5, 4, 1, 3]);
    expect(ids(e.run({ search: '', sort: { field: 'nope', direction: 'asc' } }))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('QueryEngine search', () => {
  it('matches accent- and case-insensitively, AND across terms, in sort order', () => {
    const e = engine();
    expect(ids(e.run({ search: 'zoe', sort: null }))).toEqual([1]);
    expect(ids(e.run({ search: 'TOKYO', sort: { field: 'name', direction: 'desc' } }))).toEqual([5, 2]);
    expect(ids(e.run({ search: 'item london', sort: null }))).toEqual([3]);
    expect(ids(e.run({ search: 'item tokyo', sort: null }))).toEqual([]);
  });

  it('searches number columns only when asked to', () => {
    const e = new QueryEngine(encodeTable(rows, [...columns.slice(0, 3), { field: 'salary', title: 'Salary', type: 'number', searchable: true }]));
    expect(ids(e.run({ search: '320', sort: null }))).toEqual([4]);
    expect(ids(e.run({ search: '', sort: { field: 'salary', direction: 'desc' } }))).toEqual([2, 4, 1, 5, 3]);
  });

  it('does not match across cell or row boundaries, and skips number columns', () => {
    const e = engine();
    expect(ids(e.run({ search: 'adamslondon', sort: null }))).toEqual([]);
    expect(ids(e.run({ search: 'londonadam', sort: null }))).toEqual([]);
    expect(ids(e.run({ search: '320', sort: null }))).toEqual([]);
  });

  it('returns a fresh array every time (safe to transfer)', () => {
    const e = engine();
    const a = e.run({ search: '', sort: { field: 'id', direction: 'asc' } });
    const b = e.run({ search: '', sort: { field: 'id', direction: 'asc' } });
    expect(a).not.toBe(b);
    expect([...a]).toEqual([...b]);
  });

  it('handles an empty table', () => {
    const e = new QueryEngine(encodeTable([], columns));
    expect(e.run({ search: 'x', sort: { field: 'name', direction: 'asc' } })).toHaveLength(0);
  });
});

describe('large tables', () => {
  it('sorts 200k rows correctly', () => {
    const big = Array.from({ length: 200_000 }, (_, i) => ({ id: i, n: (i * 7919) % 1000 }));
    const e = new QueryEngine(encodeTable(big, [{ field: 'n', title: 'n', type: 'number' }]));
    const order = e.run({ search: '', sort: { field: 'n', direction: 'asc' } });
    let sorted = true;
    for (let i = 1; i < order.length && sorted; i++) {
      const a = big[order[i - 1]];
      const b = big[order[i]];
      sorted = a.n < b.n || (a.n === b.n && a.id < b.id);
    }
    expect(sorted).toBe(true);
  });
});
