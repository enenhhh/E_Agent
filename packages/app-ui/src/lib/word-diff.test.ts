import { describe, expect, it } from 'vitest';

import { diffAgainstBaseline } from './word-diff';

describe('diffAgainstBaseline', () => {
  it('只标记候选文本中的新增或替换词', () => {
    const result = diffAgainstBaseline('use fetch with retry', 'use native fetch with backoff');
    expect(
      result.filter((segment) => segment.changed).map((segment) => segment.text.trim()),
    ).toEqual(['native', 'backoff']);
  });

  it('相同文本不产生差异', () => {
    expect(diffAgainstBaseline('same text', 'same text').every((segment) => !segment.changed)).toBe(
      true,
    );
  });
});
