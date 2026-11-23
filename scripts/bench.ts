/**
 * Query-engine benchmark on the demo's generated employee data.
 *   npm run bench             # 1,000,000 rows
 *   npm run bench -- 100000   # another size
 * Each number is the median of several runs, in ms. "Cold" runs use a fresh engine, so
 * they include ranking the column; the browser demo shows live numbers too.
 */
import os from 'node:os';
import { makeEmployees, type Employee } from '../demo/data';
import { encodeTable } from '../src/core/encode';
import { QueryEngine } from '../src/core/engine';
import type { Column, Query } from '../src/core/types';

const size = Number(process.argv[2] ?? 1_000_000);
const columns: Column<Employee>[] = [
  { field: 'id', title: 'ID', type: 'number' },
  { field: 'name', title: 'Name' },
  { field: 'role', title: 'Role' },
  { field: 'team', title: 'Team' },
  { field: 'office', title: 'Office' },
  { field: 'started', title: 'Started', type: 'date' },
  { field: 'salary', title: 'Salary', type: 'number' },
  { field: 'rating', title: 'Rating', type: 'number' },
];
const results: [string, number][] = [];

function median(label: string, runs: number, fn: () => void, setup: () => void = () => {}) {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    setup();
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  results.push([label, samples[Math.floor(samples.length / 2)]]);
}

const rows = makeEmployees(size);
const table = encodeTable(rows, columns);
let engine = new QueryEngine(table);
const fresh = () => { engine = new QueryEngine(table); };
const run = (query: Query) => () => { engine.run(query); };
const sort = (field: string, direction: 'asc' | 'desc' = 'asc'): Query => ({ search: '', sort: { field, direction } });

// warm up the JIT so the first measured case isn't penalised
new QueryEngine(table).run(sort('salary'));

median('encode (main thread, per data load; time-sliced in the browser)', 3, () => { encodeTable(rows, columns); });
median('cold sort: number column (salary)', 5, run(sort('salary')), fresh);
median('cold sort: text column (name)', 5, run(sort('name')), fresh);
median('cold sort: unique per row (id)', 5, run(sort('id')), fresh);
engine.run(sort('name'));
median('re-sort the same column (cached order)', 9, run(sort('name')));
median('reverse the direction (ranks cached)', 5, run(sort('name', 'desc')), () => { fresh(); engine.run(sort('name')); });
median('search "lon", 1 term', 9, run({ search: 'lon', sort: null }));
median('search "priya pune", 2 terms, sorted view', 9, run({ search: 'priya pune', sort: { field: 'name', direction: 'asc' } }));
median('search with no match', 9, run({ search: 'zzzz', sort: null }));
median('naive: indices.sort with localeCompare (for comparison)', 1, () => {
  const order = Array.from({ length: rows.length }, (_, i) => i);
  order.sort((a, b) => rows[a].name.localeCompare(rows[b].name) || a - b);
});

const name = (c: Column<Employee>) => c.field;
const distinct = columns.filter((c) => (c.type ?? 'text') === 'text').map((c) => `${name(c)} ${new Set(rows.map((r) => r[c.field])).size.toLocaleString('en-US')}`);
console.log(`\nVanilla Data Grid engine · ${size.toLocaleString('en-US')} rows · Node ${process.version} · ${os.cpus().length} cores (${os.cpus()[0]?.model || os.arch()})`);
console.log(`distinct text values: ${distinct.join(', ')}\n`);
const width = Math.max(...results.map(([label]) => label.length));
for (const [label, ms] of results) console.log(`${label.padEnd(width)}  ${(ms < 10 ? ms.toFixed(1) : Math.round(ms).toString()).padStart(6)} ms`);
