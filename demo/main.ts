import '../src/grid/grid.css';
import './demo.css';
import { createDataGrid, type Column, type DataGrid, type GridStats } from '../src';
import { makeEmployeesAsync, type Employee } from './data';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const columns: Column<Employee>[] = [
  { field: 'id', title: 'ID', type: 'number', width: 96, format: (v) => String(v) },
  { field: 'name', title: 'Name', width: 200 },
  { field: 'role', title: 'Role', width: 220 },
  { field: 'team', title: 'Team', width: 130 },
  { field: 'office', title: 'Office', width: 140 },
  { field: 'started', title: 'Started', type: 'date', width: 120 },
  { field: 'salary', title: 'Salary', type: 'number', width: 120, format: (v) => money.format(v as number) },
  { field: 'rating', title: 'Rating', type: 'number', width: 96, format: (v) => (v as number).toFixed(1) },
];

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const statsEl = $('#stats');
const exportButton = $<HTMLButtonElement>('#export');
const search = $<HTMLInputElement>('#search');
let grid: DataGrid<Employee>;
let generatedMs = 0;
let selectedCount = 0;

const fmt = (n: number) => n.toLocaleString('en-US');
const ms = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toString());

function showStats(s: GridStats) {
  const parts = [
    `${fmt(s.matching)} of ${fmt(s.total)} rows`,
    `query ${ms(s.queryMs)} ms on the ${s.where === 'worker' ? 'worker' : 'main thread'}`,
    `${s.domRows} rows in the DOM`,
    `frame ${ms(s.renderMs)} ms`,
  ];
  if (generatedMs) parts.push(`indexed in ${ms(s.encodeMs)} ms`);
  if (selectedCount) parts.push(`${fmt(selectedCount)} selected`);
  statsEl.textContent = parts.join(' · ');
}

let loading = 0;
async function load(size: number) {
  const ticket = ++loading;
  statsEl.textContent = `Generating ${fmt(size)} rows…`;
  {
    const started = performance.now();
    const rows = await makeEmployeesAsync(size);
    if (ticket !== loading) return; // a newer size was picked meanwhile
    generatedMs = performance.now() - started;
    selectedCount = 0;
    if (!grid) {
      grid = createDataGrid($('#grid'), {
        columns,
        rows,
        ariaLabel: 'Employees',
        selectable: true,
        rowLabel: (r) => r.name,
        onStats: showStats,
        onSelectionChange: (count) => {
          selectedCount = count;
          exportButton.textContent = count ? `Export ${fmt(count)} selected` : 'Export CSV';
          showStats(grid.getStats());
        },
      });
      exportButton.disabled = false;
    } else {
      void grid.setRows(rows);
    }
    void grid.setSearch(search.value);
  }
}

let searchTimer = 0;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  // A short debounce; the worker client already drops superseded queries.
  searchTimer = window.setTimeout(() => void grid?.setSearch(search.value), 60);
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); grid?.focus(); }
});

document.querySelectorAll<HTMLInputElement>('input[name="size"]').forEach((radio) =>
  radio.addEventListener('change', () => void load(Number(radio.value))));

exportButton.addEventListener('click', () => {
  const csv = grid.exportCsv({ selectedOnly: selectedCount > 0 });
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'employees.csv' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const themeButton = $<HTMLButtonElement>('[data-theme-toggle]');
const applyTheme = (theme: string) => {
  document.documentElement.dataset.theme = theme;
  themeButton.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  try { localStorage.setItem('vdg-theme', theme); } catch { /* private mode */ }
};
let saved: string | null = null;
try { saved = localStorage.getItem('vdg-theme'); } catch { /* ignore */ }
applyTheme(saved ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
themeButton.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

void load(100_000);
