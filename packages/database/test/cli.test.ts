import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArguments = [...process.argv];
const originalDatabaseUrl = process.env['E_AGENT_DATABASE_URL'];
const originalExitCode = process.exitCode;
const CLI_TEST_TIMEOUT_MS = 15_000;

afterEach(() => {
  process.argv = [...originalArguments];
  if (originalDatabaseUrl === undefined) {
    delete process.env['E_AGENT_DATABASE_URL'];
  } else {
    process.env['E_AGENT_DATABASE_URL'] = originalDatabaseUrl;
  }
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('database CLI', () => {
  it.each([
    ['migrate', 'stdout', undefined],
    ['seed', 'stdout', undefined],
    ['unknown', 'stderr', 1],
  ] as const)(
    'handles the %s command',
    async (command, stream, expectedExitCode) => {
      process.env['E_AGENT_DATABASE_URL'] = ':memory:';
      process.argv = [process.argv[0] ?? 'node', 'cli.ts', command];
      process.exitCode = undefined;
      const output = vi.spyOn(process[stream], 'write').mockImplementation(() => true);
      vi.resetModules();

      await import('../src/cli.js');

      expect(output).toHaveBeenCalled();
      expect(process.exitCode).toBe(expectedExitCode);
    },
    CLI_TEST_TIMEOUT_MS,
  );
});
