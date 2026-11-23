import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createDataGrid, type DataGrid } from '../src';
import type { Column } from '../src/core/types';
import type { WorkerLike } from '../src/core/queryClient';

type R = { id: number; name: string; city: string; score: number };
const CITIES = ['London', 'Tokyo', 'Pune', 'Lagos'];
const makeRows = (n: number): R[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Person ${i + 1}`, city: CITIES[i % 4], score: (i * 37) % 100 }));
const columns: Column<R>[] = [
  { field: 'id', title: 'ID', type: 'number', width: 80 },
  { field: 'name', title: 'Name' },
  { field: 'city', title: 'City' },
  { field: 'score', title: 'Score', type: 'number' },
];
const ROW = 36;
const VISIBLE = 10;

// jsdom has no layout: give the scroller a size and a working scroll position.
beforeAll(() => {
  const proto = HTMLElement.prototype as HTMLElement & { _top?: number; _left?: number };
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return this.classList.contains('vdg-scroller') ? ROW * (VISIBLE + 1) : 0; } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, 'scrollTop', { configurable: true, get() { return this._top ?? 0; }, set(v: number) { this._top = v; } });
  Object.defineProperty(proto, 'scrollLeft', { configurable: true, get() { return this._left ?? 0; }, set(v: number) { this._left = v; } });
});

let host: HTMLElement;
let grid: DataGrid<R>;
const $ = (s: string) => host.querySelector<HTMLElement>(s)!;
const $$ = (s: string) => [...host.querySelectorAll<HTMLElement>(s)];
const scroller = () => $('[role="grid"]');
const bodyRows = () => $$('.vdg-layer [role="row"]');
const cellText = (row: HTMLElement, col: number) => row.querySelectorAll('[role="gridcell"]')[col].textContent;
const key = (k: string, init: KeyboardEventInit = {}) => scroller().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const active = () => document.getElementById(scroller().getAttribute('aria-activedescendant')!)!;
const frame = () => new Promise((r) => setTimeout(r, 20));
const header = (title: string) => $$('[role="columnheader"]').find((h) => h.textContent === title)!;

async function mount(rows = makeRows(1000), extra = {}) {
  grid = createDataGrid(host, { columns, rows, ariaLabel: 'People', selectable: true, rowHeight: ROW, rowLabel: (r) => r.name, ...extra });
  await grid.ready;
  return grid;
}

beforeEach(() => { host = document.createElement('div'); document.body.append(host); });
afterEach(() => { grid?.destroy(); host.remove(); });

describe('rendering', () => {
  it('exposes the full size to assistive tech but only puts visible rows in the DOM', async () => {
    await mount(makeRows(10_000));
    expect(scroller().getAttribute('aria-rowcount')).toBe('10001');
    expect(scroller().getAttribute('aria-colcount')).toBe('5');
    expect(bodyRows().length).toBeLessThanOrEqual(VISIBLE + 1 + 6 * 2);
    expect(bodyRows()[0].getAttribute('aria-rowindex')).toBe('2');
    expect(cellText(bodyRows()[0], 2)).toBe('Person 1');
    expect(grid.getStats()).toMatchObject({ total: 10_000, matching: 10_000, where: 'main' });
  });

  it('recycles rows while scrolling', async () => {
    await mount(makeRows(10_000));
    const firstEl = bodyRows()[0];
    scroller().scrollTop = ROW * 5000;
    scroller().dispatchEvent(new Event('scroll'));
    await frame();
    expect(bodyRows()[0]).toBe(firstEl); // same element, new content
    expect(bodyRows()[0].getAttribute('aria-rowindex')).toBe(String(5000 - 6 + 2));
    expect(cellText(bodyRows()[0], 2)).toBe(`Person ${5000 - 6 + 1}`);
  });

  it('renders data as text, never as HTML', async () => {
    await mount([{ id: 1, name: '<img src=x onerror="window.pwned=1">', city: '<b>x</b>', score: 1 }]);
    expect(host.querySelector('.vdg-layer img, .vdg-layer b')).toBeNull();
    expect(cellText(bodyRows()[0], 2)).toBe('<img src=x onerror="window.pwned=1">');
  });
});

describe('sorting and search', () => {
  it('cycles a header through ascending, descending and unsorted, and announces it', async () => {
    await mount();
    header('Score').click();
    await grid.ready;
    await frame();
    expect(header('Score').getAttribute('aria-sort')).toBe('ascending');
    expect(cellText(bodyRows()[0], 4)).toBe('0');
    expect($('.vdg-live').textContent).toBe('Sorted by Score, ascending. 1,000 rows.');

    header('Score').click();
    await frame();
    expect(header('Score').getAttribute('aria-sort')).toBe('descending');
    expect(cellText(bodyRows()[0], 4)).toBe('99');

    header('Score').click();
    await frame();
    expect(header('Score').getAttribute('aria-sort')).toBe('none');
    expect(cellText(bodyRows()[0], 1)).toBe('1');
  });

  it('searches, updates the row count, and shows an empty state', async () => {
    await mount();
    await grid.setSearch('tokyo');
    expect(scroller().getAttribute('aria-rowcount')).toBe('251');
    expect(bodyRows().every((r) => cellText(r, 3) === 'Tokyo')).toBe(true);
    await grid.setSearch('nowhere');
    expect($('.vdg-empty').hidden).toBe(false);
    expect($('.vdg-empty').textContent).toBe('No rows match your search.');
  });
});

describe('keyboard (WAI-ARIA grid pattern)', () => {
  it('starts on the first data cell and moves with arrows, Home and End', async () => {
    await mount();
    scroller().focus();
    expect(active().textContent).toBe('1');
    key('ArrowRight');
    key('ArrowDown');
    expect(active().textContent).toBe('Person 2');
    expect(active().getAttribute('aria-colindex')).toBe('3');
    expect(active().parentElement!.getAttribute('aria-rowindex')).toBe('3');
    key('End');
    expect(active().textContent).toBe('37');
    key('Home');
    expect(active().classList.contains('vdg-check')).toBe(true);
    key('ArrowRight');
    key('ArrowRight');
    key('ArrowRight');
    key('ArrowRight');
    key('ArrowRight'); // clamped at the last column
    expect(active().textContent).toBe('37');
  });

  it('Ctrl+End jumps to the last cell and scrolls it into view; PageUp moves a page', async () => {
    await mount();
    scroller().focus();
    key('End', { ctrlKey: true });
    expect(scroller().scrollTop).toBe(1000 * ROW - VISIBLE * ROW);
    expect(active().parentElement!.getAttribute('aria-rowindex')).toBe('1001');
    key('PageUp');
    expect(active().parentElement!.getAttribute('aria-rowindex')).toBe(String(1001 - (VISIBLE - 1)));
  });

  it('reaches the header with ArrowUp and sorts with Enter', async () => {
    await mount();
    scroller().focus();
    key('ArrowUp');
    expect(active().getAttribute('role')).toBe('columnheader');
    key('ArrowRight');
    key('Enter');
    await frame();
    expect(header('Name').getAttribute('aria-sort')).toBe('ascending');
    expect(active().textContent).toBe('Name'); // focus stays on the header
  });
});

describe('selection', () => {
  it('toggles with Space, extends with Shift+Space, and survives sorting', async () => {
    const changes: number[] = [];
    await mount(makeRows(1000), { onSelectionChange: (n: number) => changes.push(n) });
    scroller().focus();
    key(' ');
    expect(bodyRows()[0].getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    key('ArrowDown');
    key(' ', { shiftKey: true });
    expect(grid.getSelectedRows().map((r) => r.id)).toEqual([1, 2, 3]);
    expect($('.vdg-live').textContent).toContain('3 rows selected');
    expect(changes.at(-1)).toBe(3);

    await grid.setSort({ field: 'id', direction: 'desc' });
    expect(bodyRows().filter((r) => r.getAttribute('aria-selected') === 'true')).toHaveLength(0); // now at the bottom
    expect(grid.getSelectedRows().map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('select-all only selects rows that match the search, and shows a mixed state', async () => {
    await mount();
    await grid.setSearch('lagos');
    scroller().focus();
    key('a', { ctrlKey: true });
    expect(grid.getSelectedRows()).toHaveLength(250);
    expect(grid.getSelectedRows().every((r) => r.city === 'Lagos')).toBe(true);
    await grid.setSearch('');
    const all = host.querySelector<HTMLInputElement>('[aria-label="Select all rows"]')!;
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
  });

  it('selects by clicking checkboxes, with Shift+click ranges', async () => {
    await mount();
    bodyRows()[1].querySelector<HTMLInputElement>('.vdg-checkbox')!.click();
    bodyRows()[4].querySelector<HTMLInputElement>('.vdg-checkbox')!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(grid.getSelectedRows().map((r) => r.id)).toEqual([2, 3, 4, 5]);
    expect(bodyRows()[1].querySelector('input')!.getAttribute('aria-label')).toBe('Select Person 2');
  });
});

describe('export', () => {
  it('exports the current view, or only the selection, as CSV with formula guards', async () => {
    const rows: R[] = [
      { id: 1, name: '=HYPERLINK("http://evil")', city: 'Pune, IN', score: 5 },
      { id: 2, name: 'Ana', city: 'Lagos', score: -3 },
    ];
    await mount(rows);
    await grid.setSort({ field: 'score', direction: 'asc' });
    expect(grid.exportCsv()).toBe('ID,Name,City,Score\r\n2,Ana,Lagos,-3\r\n1,"\'=HYPERLINK(""http://evil"")","Pune, IN",5');
    scroller().focus();
    key(' ');
    expect(grid.exportCsv({ selectedOnly: true })).toBe('ID,Name,City,Score\r\n2,Ana,Lagos,-3');
  });
});

describe('workers', () => {
  it('falls back to the main thread if the worker crashes', async () => {
    const crashing: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        if (message.type === 'query') setTimeout(() => this.onerror?.({ message: 'out of memory' } as ErrorEvent));
      },
      terminate() {},
    };
    await mount(makeRows(50), { worker: 'always', createWorker: () => crashing });
    expect(grid.getStats().where).toBe('main');
    expect(bodyRows().length).toBeGreaterThan(0);
  });
});

describe('layout safety', () => {
  it('caps rendering and warns when the container has no fixed height', async () => {
    const proto = HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'clientHeight')!;
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return this.classList.contains('vdg-scroller') ? 10_000 * ROW : 0; } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mount(makeRows(10_000));
      expect(bodyRows().length).toBeLessThan(Math.ceil((innerHeight * 2) / ROW) + 20);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(proto, 'clientHeight', original);
      warn.mockRestore();
    }
  });
});

describe('loading big tables', () => {
  it('encodes large tables in slices and lets newer data cancel an older load', async () => {
    grid = createDataGrid(host, { columns, rows: makeRows(60_000), ariaLabel: 'People', worker: 'never', rowHeight: ROW });
    const latest = grid.setRows(makeRows(30)); // arrives while the first load is still encoding
    await latest;
    expect(grid.viewCount).toBe(30);
    expect(scroller().getAttribute('aria-rowcount')).toBe('31');

    await grid.setRows(makeRows(25_000));
    expect(grid.viewCount).toBe(25_000);
    expect(grid.getStats().encodeMs).toBeGreaterThan(0);
  });
});
