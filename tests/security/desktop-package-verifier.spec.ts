import { describe, expect, it } from 'vitest';

import {
  normalizeAsarEntry,
  validateDesktopAsarEntries,
} from '../../scripts/smoke/verify-desktop-package.mjs';

describe('desktop production package verifier', () => {
  it('normalizes Windows and POSIX ASAR paths', () => {
    expect(normalizeAsarEntry('\\node_modules\\undici\\index.js')).toBe(
      'node_modules/undici/index.js',
    );
    expect(normalizeAsarEntry('/dist/main.js')).toBe('dist/main.js');
  });

  it('accepts production runtime entries', () => {
    expect(
      validateDesktopAsarEntries([
        '\\dist\\main.js',
        '\\dist\\renderer\\index.html',
        '\\node_modules\\undici\\index.js',
        '\\package.json',
      ]),
    ).toHaveLength(4);
  });

  it.each([
    ['coverage', '\\node_modules\\pkg\\coverage\\index.html'],
    ['turbo cache', '\\node_modules\\pkg\\.turbo\\turbo-build.log'],
    ['test directory', '\\node_modules\\pkg\\tests\\client.js'],
    ['test file', '\\node_modules\\pkg\\client.test.js'],
    ['source map', '\\dist\\main.js.map'],
    ['build log', '\\node_modules\\pkg\\build.log'],
    ['workspace source', '\\node_modules\\@e-agent\\core\\src\\index.ts'],
    ['environment file', '\\node_modules\\pkg\\.env.production'],
    ['encrypted secret', '\\data\\credentials.enc'],
  ])('rejects %s entries', (_label, entry) => {
    expect(() => validateDesktopAsarEntries(['\\dist\\main.js', entry])).toThrow(
      /禁止的开发或敏感条目/u,
    );
  });
});
