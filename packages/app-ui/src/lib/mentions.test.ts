import { describe, expect, it } from 'vitest';

import { parseMentions } from './mentions';

describe('parseMentions', () => {
  it('解析带空格和普通路径的上下文提及', () => {
    expect(
      parseMentions('检查 @file:src/main.ts 和 @folder:"packages/app ui" @web:https://example.com'),
    ).toEqual([
      { raw: '@file:src/main.ts', type: 'file', value: 'src/main.ts' },
      { raw: '@folder:"packages/app ui"', type: 'folder', value: 'packages/app ui' },
      { raw: '@web:https://example.com', type: 'web', value: 'https://example.com' },
    ]);
  });

  it('忽略不完整提及', () => {
    expect(parseMentions('@file: @folder:')).toEqual([]);
  });
});
