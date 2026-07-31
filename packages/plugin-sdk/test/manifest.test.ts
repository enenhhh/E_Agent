import { describe, expect, it } from 'vitest';

import { parsePluginManifest } from '../src/manifest.js';

const validManifest = {
  schemaVersion: 1,
  id: 'com.eagent.example',
  name: 'Example',
  version: '1.0.0',
  description: '测试插件',
  publisher: 'E Agent',
  entry: 'dist/index.js',
  engines: { eAgent: '>=0.1.0', node: '>=22' },
  types: ['tool'],
  permissions: {},
  contributes: {
    commands: [{ id: 'example.run', title: '运行' }],
  },
} as const;

describe('parsePluginManifest', () => {
  it('接受完整且合法的清单', () => {
    expect(parsePluginManifest(validManifest).id).toBe('com.eagent.example');
  });

  it('拒绝可以逃逸插件目录的入口', () => {
    expect(() => parsePluginManifest({ ...validManifest, entry: '../index.js' })).toThrow(/逃逸/);
  });

  it('拒绝未声明的清单字段', () => {
    expect(() => parsePluginManifest({ ...validManifest, unexpected: true })).toThrow();
  });

  it('拒绝不受约束的网络通配符', () => {
    expect(() =>
      parsePluginManifest({
        ...validManifest,
        permissions: { network: { hosts: ['*'] } },
      }),
    ).toThrow();
  });
});
