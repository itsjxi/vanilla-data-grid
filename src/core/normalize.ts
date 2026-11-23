const DIACRITICS = /[̀-ͯ]/g;

/** Lower-case and strip accents so "Zoë" matches "zoe". Used for both data and queries. */
export function normalizeText(value: string): string {
  return value.normalize('NFD').replace(DIACRITICS, '').toLowerCase();
}

/** Split a search box value into normalized terms. Every term must match (AND). */
export function searchTerms(search: string): string[] {
  return normalizeText(search).split(/\s+/).filter(Boolean);
}

/** "$1,200" -> 1200, "" -> NaN. Numbers pass through. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return NaN;
  const cleaned = String(value).replace(/[$€£₹,\s]/g, '');
  return cleaned === '' ? NaN : Number(cleaned);
}

export function toTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (value === null || value === undefined || value === '') return NaN;
  return Date.parse(String(value));
}
