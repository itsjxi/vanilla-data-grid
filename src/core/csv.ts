import type { Column, Row } from './types';

const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;
/** Spreadsheet apps execute cells that start with these as formulas (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown, { guardFormulas = true } = {}): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (guardFormulas && typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV of the given rows, in the given order. Raw values, not display text. */
export function toCsv<T extends Row>(rows: readonly T[], columns: readonly Column<T>[], order?: ArrayLike<number>): string {
  const lines = [columns.map((c) => csvCell(c.title)).join(',')];
  const count = order ? order.length : rows.length;
  for (let i = 0; i < count; i++) {
    const row = rows[order ? order[i] : i];
    lines.push(columns.map((c) => csvCell(row[c.field])).join(','));
  }
  return lines.join('\r\n');
}
