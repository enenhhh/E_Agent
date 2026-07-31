import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveHook } from '../src/restricted-loader.js';

const pluginParent = pathToFileURL(resolve('fixtures', 'plugin', 'index.js')).href;

describe('restricted loader', () => {
  it('拒绝插件直接导入 Node 内置模块', () => {
    expect(() =>
      resolveHook('node:fs', { parentURL: pluginParent }, () => ({
        url: 'node:fs',
      })),
    ).toThrow(/不允许直接导入/);
  });

  it('拒绝插件加载根目录之外的文件', () => {
    expect(() =>
      resolveHook('../../outside.js', { parentURL: pluginParent }, () => ({
        url: pathToFileURL(resolve('..', 'outside.js')).href,
      })),
    ).toThrow(/逃逸/);
  });

  it('不干预宿主自身的模块解析', () => {
    expect(
      resolveHook('node:fs', { parentURL: pathToFileURL(resolve('..', 'host.js')).href }, () => ({
        url: 'node:fs',
      })),
    ).toEqual({ url: 'node:fs' });
  });

  it('允许插件目录内的相对文件和插件根入口', () => {
    const nested = pathToFileURL(resolve('fixtures', 'plugin', 'nested.js')).href;
    expect(
      resolveHook('./nested.js', { parentURL: pluginParent }, () => ({
        url: nested,
        format: 'module',
      })),
    ).toEqual({ url: nested, format: 'module' });
    expect(
      resolveHook('./index.js', { parentURL: pluginParent }, () => ({
        url: pluginParent,
      })),
    ).toEqual({ url: pluginParent });
  });

  it('拒绝外部包和非文件协议', () => {
    expect(() =>
      resolveHook('external-package', { parentURL: pluginParent }, () => ({
        url: 'file:///unused.js',
      })),
    ).toThrow(/不允许直接导入/);
    expect(() =>
      resolveHook('./remote.js', { parentURL: pluginParent }, () => ({
        url: 'https://example.test/remote.js',
      })),
    ).toThrow(/不允许加载协议/);
  });

  it('缺少父 URL 时保持宿主解析行为', () => {
    expect(
      resolveHook('./host.js', {}, () => ({
        url: 'file:///host.js',
        shortCircuit: true,
      })),
    ).toEqual({ url: 'file:///host.js', shortCircuit: true });
  });
});
