import '../src/grid/grid.css';
import './demo.css';
import { createDataGrid, type Column, type DataGrid, type GridStats } from '../src';
import { makeEmployeesAsync, type Employee } from './data';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const columns: Column<Employee>[] = [
  { field: 'id', title: 'ID', type: 'number', width: 88, format: (v) => String(v) },
  { field: 'name', title: 'Name', width: 180 },
  { field: 'role', title: 'Role', width: 200 },
  { field: 'team', title: 'Team', width: 120 },
  { field: 'office', title: 'Office', width: 130 },
  { field: 'started', title: 'Started', type: 'date', width: 128, format: (v) => day.format(new Date(v as string)) },
  { field: 'salary', title: 'Salary', type: 'number', width: 112, format: (v) => money.format(v as number) },
  { field: 'rating', title: 'Rating', type: 'number', width: 100, format: (v) => (v as number).toFixed(1) },
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

const metric = (name: string) => statsEl.querySelector<HTMLElement>(`[data-metric="${name}"]`)!;
const selectedMetric = statsEl.querySelector<HTMLElement>('.metric-selected')!;

function showStats(s: GridStats) {
  metric('rows').innerHTML = s.matching === s.total
    ? fmt(s.total)
    : `${fmt(s.matching)}<small>of ${fmt(s.total)}</small>`;
  metric('query').innerHTML = `${ms(s.queryMs)} ms<small>${s.where === 'worker' ? 'worker' : 'main thread'}</small>`;
  metric('dom').textContent = String(s.domRows);
  metric('frame').textContent = `${ms(s.renderMs)} ms`;
  metric('indexed').textContent = generatedMs ? `${ms(s.encodeMs)} ms` : '–';
  selectedMetric.hidden = selectedCount === 0;
  metric('selected').textContent = fmt(selectedCount);
}

let loading = 0;
async function load(size: number) {
  const ticket = ++loading;
  metric('rows').innerHTML = `${fmt(size)}<small>generating…</small>`;
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
        rowHeight: 48,
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
