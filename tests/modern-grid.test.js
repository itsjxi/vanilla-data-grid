// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModernGrid, compareValues, escapeHtml } from '../modern-grid.js';

const columns = [
  { field: 'id', title: 'ID' },
  { field: 'name', title: 'Name' },
  { field: 'office', title: 'Office' },
  { field: 'salary', title: 'Salary' },
];

const rows = () => [
  { id: 'EMP001', name: 'Tiger Nixon', office: 'Edinburgh', salary: '$320,800' },
  { id: 'EMP002', name: 'Garrett Winters', office: 'Tokyo', salary: '$170,750' },
  { id: 'EMP003', name: 'Ashton Cox', office: 'San Francisco', salary: '$86,000' },
  { id: 'EMP004', name: 'Cedric Kelly', office: 'Edinburgh', salary: '$433,060' },
];

let container;
const makeGrid = (config = {}) => new ModernGrid(container, { columns, data: rows(), pageSize: 10, ...config });
const visibleNames = () =>
  [...container.querySelectorAll('tbody tr td[data-field="name"]')].map(td => td.textContent.trim());
const type = (grid, text) => {
  // Simulate typing one character at a time into the (re-rendered) search box
  for (let i = 1; i <= text.length; i++) {
    const input = container.querySelector('#search-input');
    input.value = text.slice(0, i);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
};
const check = (rowName, checked = true) => {
  const td = [...container.querySelectorAll('td[data-field="name"]')].find(t => t.textContent.trim() === rowName);
  const box = td.closest('tr').querySelector('.row-select');
  box.checked = checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = '<div id="grid"></div>';
  container = document.getElementById('grid');
  vi.restoreAllMocks();
});

describe('compareValues', () => {
  it('sorts currency and numbers numerically', () => {
    const data = [{ v: '$1,200' }, { v: '$90' }, { v: '$10,000' }];
    expect(data.sort(compareValues('v')).map(r => r.v)).toEqual(['$90', '$1,200', '$10,000']);
  });

  it('sorts text case-insensitively with natural number ordering', () => {
    const data = [{ v: 'item 10' }, { v: 'Item 2' }, { v: 'apple' }];
    expect(data.sort(compareValues('v')).map(r => r.v)).toEqual(['apple', 'Item 2', 'item 10']);
  });

  it('supports descending order and missing values', () => {
    const data = [{ v: 1 }, {}, { v: 3 }];
    expect(data.sort(compareValues('v', 'desc')).map(r => r.v)).toEqual([3, 1, undefined]);
  });
});

describe('search', () => {
  it('keeps the typed text and focus while typing several characters', () => {
    const grid = makeGrid();
    type(grid, 'edin');
    const input = container.querySelector('#search-input');
    expect(input.value).toBe('edin');
    expect(document.activeElement).toBe(input);
    expect(visibleNames()).toEqual(['Tiger Nixon', 'Cedric Kelly']);
  });

  it('keeps the active sort when filtering', () => {
    const grid = makeGrid();
    grid.handleSort('salary');
    grid.handleSort('salary'); // descending: data order is the opposite of this
    type(grid, 'edinburgh');
    expect(visibleNames()).toEqual(['Cedric Kelly', 'Tiger Nixon']); // $433,060 > $320,800
  });
});

describe('selection', () => {
  it('select-all only selects rows matching the current search', () => {
    const grid = makeGrid();
    type(grid, 'tokyo');
    grid.selectAll(true);
    expect(grid.getSelectedRows().map(r => r.name)).toEqual(['Garrett Winters']);
  });

  it('deleting selected rows never removes rows hidden by the search', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const grid = makeGrid();
    type(grid, 'tokyo');
    grid.selectAll(true);
    grid.deleteSelected();
    expect(grid.getData().map(r => r.name)).toEqual(['Tiger Nixon', 'Ashton Cox', 'Cedric Kelly']);
  });

  it('keeps other selections pointing at the right rows after a single-row delete', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const grid = makeGrid();
    check('Cedric Kelly');
    const firstRow = container.querySelector('tbody tr');
    grid.deleteRow(firstRow); // deletes Tiger Nixon, shifting everyone's index
    expect(grid.getSelectedRows().map(r => r.name)).toEqual(['Cedric Kelly']);
  });

  it('treats identical rows as separate rows', () => {
    const dupe = { id: 'X', name: 'Same', office: 'A', salary: '$1' };
    const grid = new ModernGrid(container, { columns, data: [dupe, { ...dupe }] });
    const boxes = container.querySelectorAll('.row-select');
    boxes[1].checked = true;
    boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
    expect(grid.getSelectedRows()).toHaveLength(1);
    expect(grid.getSelectedRows()[0]).toBe(grid.getData()[1]);
  });
});

describe('pagination', () => {
  it('pages through filtered rows and clamps the page after deletes', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const grid = makeGrid({ pageSize: 2 });
    grid.goToPage(2);
    expect(visibleNames()).toEqual(['Ashton Cox', 'Cedric Kelly']);
    grid.selectAll(true);
    grid.deleteSelected();
    expect(grid.currentPage).toBe(1);
  });
});

describe('rendering and export', () => {
  it('escapes cell values instead of injecting HTML', () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    makeGrid({ data: [{ id: '1', name: evil, office: '', salary: '' }] });
    expect(container.querySelector('tbody img')).toBeNull();
    expect(visibleNames()[0]).toBe(evil);
    expect(escapeHtml('"a" & <b>')).toBe('&quot;a&quot; &amp; &lt;b&gt;');
  });

  it('exports the visible rows (or the selection) as quoted CSV', () => {
    const grid = makeGrid();
    const download = vi.spyOn(grid, 'downloadFile').mockImplementation(() => {});
    type(grid, 'cox');
    grid.exportData('csv');
    const [csv, filename, mime] = download.mock.calls[0];
    expect(csv).toBe('ID,Name,Office,Salary\n"EMP003","Ashton Cox","San Francisco","$86,000"');
    expect(filename).toMatch(/\.csv$/);
    expect(mime).toBe('text/csv');
  });

  it('adds a new row at the top, clearing any search so it is visible', () => {
    vi.useFakeTimers();
    const grid = makeGrid();
    type(grid, 'tokyo');
    grid.addRow();
    expect(grid.getData()[0].id).toBe('EMP005');
    expect(container.querySelector('#search-input').value).toBe('');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    vi.useRealTimers();
  });
});
