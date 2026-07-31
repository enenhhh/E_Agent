import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, '../..');
const documents = [
  'README.md',
  'SECURITY.md',
  'docs/architecture.md',
  'docs/delivery-status.md',
  'docs/deployment.md',
  'docs/operations.md',
  'docs/performance.md',
  'docs/plugins.md',
  'docs/security.md',
  'docs/skills.md',
  'docs/testing.md',
];

function localLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)]
    .map((match) => match[1] ?? '')
    .filter(
      (target) =>
        target.length > 0 && !target.startsWith('#') && !/^(?:https?:|mailto:)/u.test(target),
    )
    .map((target) => decodeURIComponent(target.split('#', 1)[0] ?? ''));
}

describe('documentation contract', () => {
  it('keeps every local Markdown link resolvable inside the repository', async () => {
    const missing: string[] = [];

    for (const document of documents) {
      const documentPath = path.join(workspaceRoot, document);
      const markdown = await readFile(documentPath, 'utf8');
      for (const target of localLinkTargets(markdown)) {
        const resolvedTarget = path.resolve(path.dirname(documentPath), target);
        const relation = path.relative(workspaceRoot, resolvedTarget);
        if (
          relation === '..' ||
          relation.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relation)
        ) {
          missing.push(`${document} -> ${target} (outside workspace)`);
          continue;
        }
        try {
          await access(resolvedTarget);
        } catch {
          missing.push(`${document} -> ${target}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('does not use unsafe file URLs in user-facing documentation', async () => {
    for (const document of documents) {
      const markdown = await readFile(path.join(workspaceRoot, document), 'utf8');
      expect(markdown, document).not.toMatch(/\bfile:\/\//iu);
    }
  });
});
