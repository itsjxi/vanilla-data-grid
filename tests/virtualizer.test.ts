import { describe, it, expect } from 'vitest';
import { computeWindow, scrollTopForRow, scrollMetrics } from '../src/core/virtualizer';

const base = { viewportHeight: 360, rowHeight: 36, rowCount: 1000, overscan: 2 };

describe('computeWindow', () => {
  it('renders only the visible rows plus overscan', () => {
    const w = computeWindow({ ...base, scrollTop: 0 });
    expect(w).toMatchObject({ start: 0, end: 13, offsetY: 0, scrollHeight: 36_000, ratio: 1 });
    const mid = computeWindow({ ...base, scrollTop: 3600 + 18 });
    expect(mid.start).toBe(98);
    expect(mid.end).toBe(113);
    expect(mid.offsetY).toBe(98 * 36);
  });

  it('clamps at the end and handles tiny or empty tables', () => {
    expect(computeWindow({ ...base, scrollTop: 1e9 }).end).toBe(1000);
    expect(computeWindow({ ...base, rowCount: 3, scrollTop: 0 })).toMatchObject({ start: 0, end: 3 });
    expect(computeWindow({ ...base, rowCount: 0, scrollTop: 0 })).toMatchObject({ start: 0, end: 0 });
  });

  it('compresses very tall content and still lands on the last row', () => {
    const big = { ...base, rowCount: 1_000_000, maxScrollHeight: 1_000_000 };
    expect(scrollMetrics(big.rowCount, 36, 360, big.maxScrollHeight).scrollHeight).toBe(1_000_000);
    const end = computeWindow({ ...big, scrollTop: 1_000_000 - 360 });
    expect(end.end).toBe(1_000_000);
    // the last row's bottom lines up with the viewport bottom
    const lastTop = end.offsetY + (999_999 - end.start) * 36;
    expect(lastTop + 36 - (1_000_000 - 360)).toBeCloseTo(360, 5);
  });
});

describe('scrollTopForRow', () => {
  it('scrolls the minimum needed, and not at all when visible', () => {
    expect(scrollTopForRow(5, { ...base, scrollTop: 0 })).toBe(0);
    expect(scrollTopForRow(20, { ...base, scrollTop: 0 })).toBe(21 * 36 - 360);
    expect(scrollTopForRow(2, { ...base, scrollTop: 360 })).toBe(72);
  });

  it('accounts for compression', () => {
    const big = { ...base, rowCount: 1_000_000, maxScrollHeight: 1_000_000, scrollTop: 0 };
    const top = scrollTopForRow(500_000, big);
    const w = computeWindow({ ...big, scrollTop: top });
    expect(w.start).toBeLessThanOrEqual(500_000);
    expect(w.end).toBeGreaterThan(500_000);
  });
});
