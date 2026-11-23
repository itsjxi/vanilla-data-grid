/** A row is any plain object. The grid never mutates it. */
export type Row = Record<string, unknown>;

/**
 * How a column is compared and searched.
 * - `text`: locale-aware, case-insensitive, numeric-aware ("Item 2" < "item 10")
 * - `number`: numeric; also understands strings such as "$1,200"
 * - `date`: anything `Date.parse` accepts, or a Date / epoch number
 */
export type ColumnType = 'text' | 'number' | 'date';

export interface Column<T extends Row = Row> {
  field: keyof T & string;
  title: string;
  type?: ColumnType;
  /** Width in px. Columns without a width share the remaining space. */
  width?: number;
  /** Turns the raw value into display text. Defaults to `String(value)`. */
  format?: (value: T[keyof T], row: T) => string;
  sortable?: boolean;
  /** Text columns are searchable by default; number and date columns are not. */
  searchable?: boolean;
}

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  field: string;
  direction: SortDirection;
}

export interface Query {
  search: string;
  sort: SortState | null;
}
