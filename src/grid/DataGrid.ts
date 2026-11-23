import type { Column, Query, Row, SortState } from '../core/types';
import { encodeTable, encodeTableAsync } from '../core/encode';
import { QueryClient, type QueryResult, type WorkerLike, type WorkerMode } from '../core/queryClient';
import { computeWindow, scrollTopForRow, type RowWindow } from '../core/virtualizer';
import { toCsv } from '../core/csv';

export interface GridStats {
  /** Rows in the table. */
  total: number;
  /** Rows after search. */
  matching: number;
  /** Sort + search time, ms. */
  queryMs: number;
  where: 'worker' | 'main';
  /** Last frame's DOM update, ms. */
  renderMs: number;
  /** Row elements currently in the DOM. */
  domRows: number;
  /** Time to prepare the last data set for querying, ms (time-sliced for big tables). */
  encodeMs: number;
}

export interface DataGridOptions<T extends Row> {
  columns: Column<T>[];
  rows: T[];
  /** Accessible name for the grid. */
  ariaLabel: string;
  rowHeight?: number;
  overscan?: number;
  selectable?: boolean;
  /** Words used for a row in announcements and checkbox labels. Defaults to the first column. */
  rowLabel?: (row: T) => string;
  emptyMessage?: string;
  worker?: WorkerMode;
  workerThreshold?: number;
  /** For tests and custom bundling. */
  createWorker?: () => WorkerLike;
  onStats?: (stats: GridStats) => void;
  onSelectionChange?: (count: number) => void;
}

interface Slot {
  el: HTMLElement;
  cells: HTMLElement[];
  text: string[];
  checkbox: HTMLInputElement | null;
  view: number;
}

interface Active {
  /** -1 = header row. */
  row: number;
  col: number;
}

const raf: (cb: () => void) => number = globalThis.requestAnimationFrame?.bind(globalThis) ?? ((cb) => setTimeout(cb, 16) as unknown as number);
const caf: (id: number) => void = globalThis.cancelAnimationFrame?.bind(globalThis) ?? ((id) => clearTimeout(id));

let gridCount = 0;
const SLICE_THRESHOLD = 20_000;
const SORT_WORDS = { asc: 'ascending', desc: 'descending' } as const;
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

function defaultFormat(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-US') : '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * A virtualized grid following the WAI-ARIA grid pattern.
 *
 * - Only the rows in view (plus a few "overscan" rows) exist in the DOM; their elements
 *   are reused as you scroll and only cells whose text changed are written.
 * - Focus stays on the grid element; the active cell is announced through
 *   aria-activedescendant. With virtualization the focused cell's element can be recycled
 *   for another row at any time, so moving real focus between cells would be fragile.
 * - Sorting and search run in a Web Worker for large tables; the old rows stay on screen
 *   (aria-busy) until the new order arrives.
 * - Cell text is set with textContent, never innerHTML, so data cannot inject markup.
 */
export class DataGrid<T extends Row> {
  readonly root: HTMLElement;
  readonly ready: Promise<void>;

  private readonly id = `vdg${++gridCount}`;
  private readonly options: Required<Pick<DataGridOptions<T>, 'rowHeight' | 'overscan' | 'selectable' | 'emptyMessage'>> & DataGridOptions<T>;
  private readonly columns: Column<T>[];
  private rows: T[];
  private order: Uint32Array = new Uint32Array(0);
  private query: Query = { search: '', sort: null };
  private readonly client: QueryClient;
  private readonly selected = new Set<number>();
  private anchor: number | null = null;
  private active: Active = { row: 0, col: 0 };
  private window: RowWindow = { start: 0, end: 0, offsetY: 0, scrollHeight: 0, ratio: 1 };
  private slots: Slot[] = [];
  private frame = 0;
  private busyTimer = 0;
  private announceTimer = 0;
  private stats: GridStats = { total: 0, matching: 0, queryMs: 0, where: 'main', renderMs: 0, domRows: 0, encodeMs: 0 };
  private loadVersion = 0;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;
  private warnedHeight = false;
  private resolveReady!: () => void;

  private readonly scroller: HTMLElement;
  private readonly headerRow: HTMLElement;
  private readonly headerCells: HTMLElement[] = [];
  private readonly selectAll: HTMLInputElement | null = null;
  private readonly body: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly live: HTMLElement;
  private readonly progress: HTMLElement;

  constructor(container: HTMLElement, options: DataGridOptions<T>) {
    this.options = { rowHeight: 44, overscan: 6, selectable: false, emptyMessage: 'No rows match your search.', ...options };
    this.columns = options.columns;
    this.rows = options.rows;
    this.client = new QueryClient({ mode: options.worker, workerThreshold: options.workerThreshold, createWorker: options.createWorker });
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    this.active = { row: 0, col: this.options.selectable ? 1 : 0 }; // first data cell, not the checkbox

    const { rowHeight, selectable } = this.options;
    const template = [
      ...(selectable ? ['56px'] : []),
      ...this.columns.map((c) => (c.width ? `minmax(${c.width}px, ${c.width}fr)` : 'minmax(120px, 120fr)')),
    ];
    const minWidth = (selectable ? 56 : 0) + this.columns.reduce((sum, c) => sum + (c.width ?? 120), 0);

    this.root = el('div', 'vdg');
    this.root.style.setProperty('--vdg-row-height', `${rowHeight}px`);
    this.root.style.setProperty('--vdg-columns', template.join(' '));
    this.root.style.setProperty('--vdg-min-width', `${minWidth}px`);

    this.scroller = el('div', 'vdg-scroller', {
      role: 'grid', tabindex: '0', 'aria-label': options.ariaLabel,
      'aria-colcount': String(this.colCount), 'aria-rowcount': '1',
      ...(selectable ? { 'aria-multiselectable': 'true' } : {}),
    });

    const header = el('div', 'vdg-header', { role: 'rowgroup' });
    this.headerRow = el('div', 'vdg-row vdg-header-row', { role: 'row', 'aria-rowindex': '1' });
    let col = 0;
    if (selectable) {
      const cell = this.headerCell(col++, 'vdg-cell vdg-check');
      this.selectAll = el('input', 'vdg-checkbox', { type: 'checkbox', tabindex: '-1', 'aria-label': 'Select all rows' });
      cell.append(this.selectAll);
    }
    for (const column of this.columns) {
      const numeric = column.type === 'number';
      const cell = this.headerCell(col++, `vdg-cell vdg-th${numeric ? ' is-numeric' : ''}${column.sortable === false ? '' : ' is-sortable'}`);
      const label = el('span', 'vdg-th-label');
      label.textContent = column.title;
      const icon = el('span', 'vdg-sort-icon', { 'aria-hidden': 'true' });
      cell.append(label, icon);
      if (column.sortable !== false) cell.setAttribute('aria-sort', 'none');
    }
    header.append(this.headerRow);

    this.body = el('div', 'vdg-body', { role: 'rowgroup' });
    this.layer = el('div', 'vdg-layer');
    this.empty = el('div', 'vdg-empty');
    this.empty.hidden = true;
    this.body.append(this.layer, this.empty);
    this.scroller.append(header, this.body);

    this.progress = el('div', 'vdg-progress', { 'aria-hidden': 'true' });
    this.progress.hidden = true;
    this.live = el('div', 'vdg-live', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.root.append(this.scroller, this.progress, this.live);
    container.append(this.root);

    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.scroller.addEventListener('keydown', this.onKeyDown);
    this.scroller.addEventListener('click', this.onClick);
    this.scroller.addEventListener('focus', this.onFocus);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleRender());
      this.resizeObserver.observe(this.scroller);
    }

    this.load();
  }

  /* ---------------- public API ---------------- */

  get colCount(): number {
    return this.columns.length + (this.options.selectable ? 1 : 0);
  }

  get viewCount(): number {
    return this.order.length;
  }

  getStats(): GridStats {
    return { ...this.stats };
  }

  getSort(): SortState | null {
    return this.query.sort;
  }

  setRows(rows: T[]): Promise<void> {
    this.rows = rows;
    this.selected.clear();
    this.anchor = null;
    this.emitSelection();
    return this.load();
  }

  setSearch(search: string): Promise<void> {
    if (search === this.query.search) return Promise.resolve();
    this.query = { ...this.query, search };
    return this.refresh('search');
  }

  setSort(sort: SortState | null): Promise<void> {
    this.query = { ...this.query, sort };
    this.updateSortHeaders();
    return this.refresh('sort');
  }

  /** Selected rows, in table order. */
  getSelectedRows(): T[] {
    return [...this.selected].sort((a, b) => a - b).map((i) => this.rows[i]);
  }

  clearSelection(): void {
    this.selected.clear();
    this.afterSelectionChange();
  }

  /** CSV of the current view (search + sort applied), or of the selected rows. */
  exportCsv({ selectedOnly = false } = {}): string {
    if (selectedOnly) {
      const order = Uint32Array.from([...this.selected].sort((a, b) => a - b));
      return toCsv(this.rows, this.columns, order);
    }
    return toCsv(this.rows, this.columns, this.order);
  }

  scrollToRow(viewIndex: number): void {
    const index = Math.max(0, Math.min(viewIndex, this.viewCount - 1));
    this.scroller.scrollTop = scrollTopForRow(index, this.windowInput());
    this.render();
  }

  focus(): void {
    this.scroller.focus();
  }

  destroy(): void {
    this.destroyed = true;
    caf(this.frame);
    clearTimeout(this.busyTimer);
    clearTimeout(this.announceTimer);
    this.resizeObserver?.disconnect();
    this.client.destroy();
    this.root.remove();
  }

  /* ---------------- data ---------------- */

  /**
   * Small tables are encoded in one go. Big ones are encoded in ~12ms slices that yield
   * to the browser in between, so a million-row load never freezes the page; a newer
   * setRows() cancels an encode that is still running.
   */
  private async load(): Promise<void> {
    const version = ++this.loadVersion;
    const rows = this.rows;
    const started = performance.now();
    let table;
    if (rows.length < SLICE_THRESHOLD) {
      table = encodeTable(rows, this.columns);
    } else {
      this.setBusy(true);
      table = await encodeTableAsync(rows, this.columns, { cancelled: () => version !== this.loadVersion || this.destroyed });
      // Newer rows arrived while this encode ran (it may finish without ever yielding).
      if (!table || version !== this.loadVersion || this.destroyed) return;
    }
    this.stats.encodeMs = performance.now() - started;
    this.stats.total = rows.length;
    performance.measure?.('vdg:encode', { start: started });
    const posted = performance.now();
    this.client.load(table);
    performance.measure?.('vdg:send-to-worker', { start: posted });
    return this.refresh('load');
  }

  private async refresh(reason: 'load' | 'search' | 'sort'): Promise<void> {
    clearTimeout(this.busyTimer);
    // Only show the progress bar if the answer takes long enough to notice.
    this.busyTimer = setTimeout(() => this.setBusy(true), 150) as unknown as number;
    let result: QueryResult | null;
    try {
      result = await this.client.run(this.query);
    } catch {
      // The worker died: rebuild the table on the main thread and carry on.
      this.client.load(encodeTable(this.rows, this.columns), { forceMain: true });
      result = await this.client.run(this.query);
    }
    if (!result || this.destroyed) return; // superseded by a newer query
    clearTimeout(this.busyTimer);
    this.setBusy(false);

    const applied = performance.now();
    this.order = result.indices;
    this.stats = { ...this.stats, matching: this.order.length, queryMs: result.ms, where: result.where };
    this.scroller.setAttribute('aria-rowcount', String(this.order.length + 1));
    if (this.active.row >= this.order.length) this.active.row = this.order.length - 1;
    if (reason !== 'load' || this.scroller.scrollTop > 0) this.scroller.scrollTop = 0;
    this.invalidateSlots();
    this.render();
    this.updateSelectAll();
    if (reason !== 'load') this.announceView(reason);
    performance.measure?.('vdg:apply-result', { start: applied });
    this.resolveReady();
  }

  private setBusy(busy: boolean): void {
    this.progress.hidden = !busy;
    if (busy) this.scroller.setAttribute('aria-busy', 'true');
    else this.scroller.removeAttribute('aria-busy');
  }

  /* ---------------- rendering ---------------- */

  /**
   * If the container has no fixed height, the scroller grows to fit every row and
   * "visible rows" becomes all of them. Cap it at two screens so a layout mistake costs
   * a warning, not a frozen tab.
   */
  private viewportHeight(): number {
    const height = Math.max(0, this.scroller.clientHeight - this.options.rowHeight);
    const cap = (globalThis.innerHeight || 1000) * 2;
    if (height > cap) {
      if (!this.warnedHeight) {
        this.warnedHeight = true;
        console.warn('vanilla-data-grid: the grid container needs a fixed height (for example height: 600px). Rendering is capped at two screens of rows.');
      }
      return cap;
    }
    return height;
  }

  private windowInput() {
    return {
      scrollTop: this.scroller.scrollTop,
      viewportHeight: this.viewportHeight(),
      rowHeight: this.options.rowHeight,
      rowCount: this.viewCount,
      overscan: this.options.overscan,
    };
  }

  private onScroll = () => this.scheduleRender();

  private scheduleRender(): void {
    if (this.frame) return;
    this.frame = raf(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Force every slot to rewrite its cells (after the data or order changed). */
  private invalidateSlots(): void {
    for (const slot of this.slots) slot.view = -1;
  }

  private render(): void {
    if (this.destroyed) return;
    const started = performance.now();
    const win = computeWindow(this.windowInput());
    this.window = win;
    this.body.style.height = `${Math.max(win.scrollHeight, this.order.length ? 0 : this.options.rowHeight * 3)}px`;
    this.layer.style.transform = `translateY(${win.offsetY}px)`;

    const needed = win.end - win.start;
    while (this.slots.length < needed) this.slots.push(this.createSlot());
    while (this.slots.length > needed) this.slots.pop()!.el.remove();

    for (let k = 0; k < needed; k++) this.fillSlot(this.slots[k], win.start + k);

    this.empty.hidden = this.order.length > 0;
    if (!this.empty.hidden) this.empty.textContent = this.query.search ? this.options.emptyMessage : 'No rows.';
    this.updateActiveDescendant();

    this.stats.renderMs = performance.now() - started;
    this.stats.domRows = needed;
    this.options.onStats?.(this.getStats());
  }

  private createSlot(): Slot {
    const row = el('div', 'vdg-row', { role: 'row' });
    const cells: HTMLElement[] = [];
    let checkbox: HTMLInputElement | null = null;
    if (this.options.selectable) {
      const cell = el('div', 'vdg-cell vdg-check', { role: 'gridcell', 'aria-colindex': '1' });
      checkbox = el('input', 'vdg-checkbox', { type: 'checkbox', tabindex: '-1' });
      cell.append(checkbox);
      row.append(cell);
      cells.push(cell);
    }
    const offset = this.options.selectable ? 1 : 0;
    for (const [c, column] of this.columns.entries()) {
      const cell = el('div', `vdg-cell${column.type === 'number' ? ' is-numeric' : ''}`, { role: 'gridcell', 'aria-colindex': String(c + offset + 1) });
      row.append(cell);
      cells.push(cell);
    }
    this.layer.append(row);
    return { el: row, cells, text: cells.map(() => ''), checkbox, view: -1 };
  }

  private fillSlot(slot: Slot, view: number): void {
    const source = this.order[view];
    const row = this.rows[source];
    const isSelected = this.selected.has(source);
    const offset = this.options.selectable ? 1 : 0;

    if (slot.view !== view) {
      slot.view = view;
      slot.el.setAttribute('aria-rowindex', String(view + 2));
      slot.el.dataset.view = String(view);
      for (let c = 0; c < this.columns.length; c++) {
        const column = this.columns[c];
        const value = row[column.field];
        const text = column.format ? column.format(value as T[keyof T], row) : defaultFormat(value);
        if (slot.text[c + offset] !== text) {
          slot.text[c + offset] = text;
          slot.cells[c + offset].textContent = text;
        }
      }
      for (let c = 0; c < slot.cells.length; c++) slot.cells[c].id = `${this.id}-${view}-${c}`;
      if (slot.checkbox) slot.checkbox.setAttribute('aria-label', `Select ${this.labelOf(row)}`);
    }

    if (this.options.selectable) {
      slot.el.setAttribute('aria-selected', String(isSelected));
      slot.el.classList.toggle('is-selected', isSelected);
      if (slot.checkbox) slot.checkbox.checked = isSelected;
    }
    slot.el.classList.toggle('is-active-row', view === this.active.row);
  }

  private labelOf(row: T): string {
    if (this.options.rowLabel) return this.options.rowLabel(row);
    return defaultFormat(row[this.columns[0].field]);
  }

  private headerCell(col: number, className: string): HTMLElement {
    const cell = el('div', className, { role: 'columnheader', id: `${this.id}-h-${col}`, 'aria-colindex': String(col + 1) });
    this.headerCells.push(cell);
    this.headerRow.append(cell);
    return cell;
  }

  private updateSortHeaders(): void {
    const offset = this.options.selectable ? 1 : 0;
    this.columns.forEach((column, c) => {
      if (column.sortable === false) return;
      const cell = this.headerCells[c + offset];
      const sort = this.query.sort?.field === column.field ? this.query.sort.direction : null;
      cell.setAttribute('aria-sort', sort ? SORT_WORDS[sort] : 'none');
      cell.dataset.sort = sort ?? '';
    });
  }

  /* ---------------- active cell + keyboard ---------------- */

  private cellId({ row, col }: Active): string {
    return row < 0 ? `${this.id}-h-${col}` : `${this.id}-${row}-${col}`;
  }

  private updateActiveDescendant(): void {
    this.scroller.querySelector('.is-active')?.classList.remove('is-active');
    const target = this.root.querySelector<HTMLElement>(`#${this.cellId(this.active)}`);
    if (target) {
      target.classList.add('is-active');
      this.scroller.setAttribute('aria-activedescendant', target.id);
    } else {
      this.scroller.removeAttribute('aria-activedescendant');
    }
  }

  private setActive(next: Active, { scroll = true } = {}): void {
    const row = Math.max(-1, Math.min(next.row, this.viewCount - 1));
    const col = Math.max(0, Math.min(next.col, this.colCount - 1));
    const previousRow = this.active.row;
    this.active = { row, col };
    if (scroll && row >= 0) {
      const top = scrollTopForRow(row, this.windowInput());
      if (top !== this.scroller.scrollTop) this.scroller.scrollTop = top;
    }
    if (previousRow !== row) {
      for (const slot of this.slots) slot.el.classList.toggle('is-active-row', slot.view === row);
    }
    this.render();
    if (scroll) this.scrollColumnIntoView(col);
  }

  private scrollColumnIntoView(col: number): void {
    const cell = this.headerCells[col];
    if (!cell) return;
    const left = cell.offsetLeft;
    const right = left + cell.offsetWidth;
    const { scrollLeft, clientWidth } = this.scroller;
    if (left < scrollLeft) this.scroller.scrollLeft = left;
    else if (right > scrollLeft + clientWidth) this.scroller.scrollLeft = right - clientWidth;
  }

  private onFocus = () => {
    // If the active row scrolled away while the grid was unfocused, pick the first visible row.
    const { start, end } = this.window;
    if (this.active.row >= 0 && (this.active.row < start || this.active.row >= end)) {
      const firstVisible = Math.min(this.viewCount - 1, Math.ceil((this.scroller.scrollTop * this.window.ratio) / this.options.rowHeight));
      this.setActive({ row: firstVisible, col: this.active.col }, { scroll: false });
    } else {
      this.updateActiveDescendant();
    }
  };

  private onKeyDown = (event: KeyboardEvent) => {
    const { row, col } = this.active;
    const page = Math.max(1, Math.floor(this.viewportHeight() / this.options.rowHeight) - 1);
    const ctrl = event.ctrlKey || event.metaKey;
    let handled = true;

    switch (event.key) {
      case 'ArrowDown': this.setActive({ row: row + 1, col }); break;
      case 'ArrowUp': this.setActive({ row: row - 1, col }); break;
      case 'ArrowRight': this.setActive({ row, col: col + 1 }); break;
      case 'ArrowLeft': this.setActive({ row, col: col - 1 }); break;
      case 'PageDown': this.setActive({ row: Math.max(0, row) + page, col }); break;
      case 'PageUp': this.setActive({ row: Math.max(0, row - page), col }); break;
      case 'Home': this.setActive(ctrl ? { row: -1, col: 0 } : { row, col: 0 }); break;
      case 'End': this.setActive(ctrl ? { row: this.viewCount - 1, col: this.colCount - 1 } : { row, col: this.colCount - 1 }); break;
      case 'Enter':
      case ' ':
        if (row < 0) this.activateHeader(col);
        else if (event.key === ' ' && this.options.selectable) this.toggleRow(row, event.shiftKey);
        else handled = false;
        break;
      case 'a':
      case 'A':
        if (ctrl && this.options.selectable) this.selectAllInView(true);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  private onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const cell = target.closest<HTMLElement>('.vdg-cell');
    if (!cell) return;
    const header = cell.getAttribute('role') === 'columnheader';
    const col = header ? this.headerCells.indexOf(cell) : [...cell.parentElement!.children].indexOf(cell);
    const view = header ? -1 : Number(cell.parentElement!.dataset.view);

    this.active = { row: view, col };
    if (header) {
      this.activateHeader(col);
    } else if (target.matches('.vdg-checkbox')) {
      this.toggleRow(view, event.shiftKey);
    }
    this.setActive(this.active, { scroll: false });
    if (document.activeElement !== this.scroller) this.scroller.focus({ preventScroll: true });
  };

  private activateHeader(col: number): void {
    const offset = this.options.selectable ? 1 : 0;
    if (col < offset) {
      this.selectAllInView(!this.allInViewSelected());
      return;
    }
    const column = this.columns[col - offset];
    if (column.sortable === false) return;
    const current = this.query.sort?.field === column.field ? this.query.sort.direction : null;
    const next: SortState | null = current === null ? { field: column.field, direction: 'asc' }
      : current === 'asc' ? { field: column.field, direction: 'desc' } : null;
    void this.setSort(next);
  }

  /* ---------------- selection ---------------- */

  private toggleRow(view: number, range: boolean): void {
    const source = this.order[view];
    if (source === undefined) return;
    const select = !this.selected.has(source);
    if (range && this.anchor !== null) {
      const [from, to] = this.anchor < view ? [this.anchor, view] : [view, this.anchor];
      for (let v = from; v <= to; v++) {
        if (select) this.selected.add(this.order[v]);
        else this.selected.delete(this.order[v]);
      }
    } else if (select) this.selected.add(source);
    else this.selected.delete(source);
    this.anchor = view;
    this.afterSelectionChange();
    this.announce(`${this.labelOf(this.rows[source])} ${select ? 'selected' : 'not selected'}. ${plural(this.selected.size, 'row')} selected.`);
  }

  /** Select-all acts on the rows you can see (after search), never on hidden rows. */
  private selectAllInView(select: boolean): void {
    for (let v = 0; v < this.order.length; v++) {
      if (select) this.selected.add(this.order[v]);
      else this.selected.delete(this.order[v]);
    }
    this.afterSelectionChange();
    this.announce(select ? `${plural(this.order.length, 'row')} selected.` : 'Selection cleared.');
  }

  private allInViewSelected(): boolean {
    if (!this.order.length || this.selected.size < this.order.length) return false;
    for (let v = 0; v < this.order.length; v++) if (!this.selected.has(this.order[v])) return false;
    return true;
  }

  private updateSelectAll(): void {
    if (!this.selectAll) return;
    let inView = 0;
    if (this.selected.size) for (let v = 0; v < this.order.length; v++) if (this.selected.has(this.order[v])) inView++;
    this.selectAll.checked = inView > 0 && inView === this.order.length;
    this.selectAll.indeterminate = inView > 0 && inView < this.order.length;
  }

  private afterSelectionChange(): void {
    this.render();
    this.updateSelectAll();
    this.emitSelection();
  }

  private emitSelection(): void {
    this.options.onSelectionChange?.(this.selected.size);
  }

  /* ---------------- announcements ---------------- */

  private announceView(reason: 'search' | 'sort'): void {
    const count = plural(this.order.length, 'row');
    if (reason === 'sort') {
      const sort = this.query.sort;
      const column = sort && this.columns.find((c) => c.field === sort.field);
      this.announce(sort && column ? `Sorted by ${column.title}, ${SORT_WORDS[sort.direction]}. ${count}.` : `Sort removed. ${count}.`);
    } else {
      this.announce(this.query.search ? `${count} match “${this.query.search}”.` : `Search cleared. ${count}.`, 500);
    }
  }

  /** Polite live region. Search announcements wait until typing pauses. */
  private announce(message: string, delay = 0): void {
    clearTimeout(this.announceTimer);
    const write = () => { this.live.textContent = message; };
    if (delay) this.announceTimer = setTimeout(write, delay) as unknown as number;
    else write();
  }
}

export function createDataGrid<T extends Row>(container: HTMLElement, options: DataGridOptions<T>): DataGrid<T> {
  return new DataGrid(container, options);
}
