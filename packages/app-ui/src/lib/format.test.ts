import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clampPercentage,
  downloadBlob,
  formatCompactNumber,
  formatCurrency,
  formatDateTime,
  formatDuration,
} from './format';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('format helpers', () => {
  it('格式化紧凑数字、美元与合法/非法时间', () => {
    expect(formatCompactNumber(1_250)).toMatch(/1[.,]?25?K|1250/i);
    expect(formatCurrency(1.23456)).toBe('$1.2346');
    expect(formatDateTime('not-a-date')).toEqual(expect.any(String));
    expect(formatDateTime('not-a-date')).not.toBe('');
    expect(formatDateTime('2026-07-29T10:30:00.000Z')).toMatch(/\d/);
  });

  it('格式化毫秒与秒并将百分比限制在安全范围', () => {
    expect(formatDuration(999.5)).toBe('1000 ms');
    expect(formatDuration(1_234)).toBe('1.23 s');
    expect(clampPercentage(-1)).toBe(0);
    expect(clampPercentage(32)).toBe(32);
    expect(clampPercentage(101)).toBe(100);
  });

  it('通过临时链接下载 Blob 并及时释放对象 URL', () => {
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    downloadBlob(new Blob(['hello']), 'usage.csv');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    expect(document.querySelector('a[download="usage.csv"]')).not.toBeInTheDocument();
  });
});
