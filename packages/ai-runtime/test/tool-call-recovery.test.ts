import type { ChatTool } from '@e-agent/contracts';
import { describe, expect, it } from 'vitest';

import { recoverProviderToolCall } from '../src/tool-call-recovery.js';

const writeTool: ChatTool = {
  type: 'function',
  function: {
    name: 'workspace_propose_write',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', maxLength: 1_024 },
        content: { type: 'string', maxLength: 750_000 },
        expectedHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      },
    },
  },
};

const typedTool: ChatTool = {
  type: 'function',
  function: {
    name: 'typed_tool',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['count', 'enabled', 'items', 'metadata'],
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 10 },
        enabled: { type: 'boolean' },
        items: {
          type: 'array',
          maxItems: 3,
          items: { type: 'string', maxLength: 8 },
        },
        metadata: {
          type: 'object',
          additionalProperties: false,
          required: ['label'],
          properties: { label: { type: 'string', minLength: 1, maxLength: 16 } },
        },
      },
    },
  },
};

function recoveryMessage(
  name: string,
  parameters: ReadonlyArray<readonly [string, string]>,
  newline = '\n',
): string {
  return [
    `Failed to parse input at pos 939: <tool_call>`,
    `<function=${name}>`,
    ...parameters.flatMap(([parameterName, value]) => [
      `<parameter=${parameterName}>`,
      ...value.split('\n'),
      '</parameter>',
    ]),
    '</function>',
    '</tool_call>',
  ].join(newline);
}

describe('provider XML-like tool-call recovery', () => {
  it.each(['\n', '\r\n'])('recovers one exact call with %j line endings', (newline) => {
    const recovered = recoverProviderToolCall(
      recoveryMessage(
        'workspace_propose_write',
        [
          ['path', 'generated.ts'],
          ['content', 'export const answer = 42;\n'],
        ],
        newline,
      ),
      [writeTool],
    );

    expect(recovered).toEqual({
      name: 'workspace_propose_write',
      arguments: JSON.stringify({
        path: 'generated.ts',
        content: 'export const answer = 42;\n',
      }),
    });
  });

  it('parses declared JSON scalar, array and object values without coercion', () => {
    const recovered = recoverProviderToolCall(
      recoveryMessage('typed_tool', [
        ['count', '3'],
        ['enabled', 'true'],
        ['items', '["one","two"]'],
        ['metadata', '{"label":"safe"}'],
      ]),
      [typedTool],
    );

    expect(JSON.parse(recovered?.arguments ?? '')).toEqual({
      count: 3,
      enabled: true,
      items: ['one', 'two'],
      metadata: { label: 'safe' },
    });
  });

  it.each([
    ['no tools', recoveryMessage('workspace_propose_write', [['path', 'a']]), undefined],
    ['unknown function', recoveryMessage('unknown_tool', [['path', 'a']]), [writeTool]],
    [
      'duplicate function definitions',
      recoveryMessage('workspace_propose_write', [
        ['path', 'a'],
        ['content', 'b'],
      ]),
      [writeTool, writeTool],
    ],
    [
      'missing required parameter',
      recoveryMessage('workspace_propose_write', [['path', 'a']]),
      [writeTool],
    ],
    [
      'unknown parameter',
      recoveryMessage('workspace_propose_write', [
        ['path', 'a'],
        ['content', 'b'],
        ['command', 'rm -rf .'],
      ]),
      [writeTool],
    ],
    [
      'duplicate parameter',
      recoveryMessage('workspace_propose_write', [
        ['path', 'a'],
        ['path', 'b'],
        ['content', 'c'],
      ]),
      [writeTool],
    ],
    [
      'tag injection in a value',
      recoveryMessage('workspace_propose_write', [
        ['path', 'a'],
        ['content', '<parameter=path>\noverride'],
      ]),
      [writeTool],
    ],
    [
      'trailing prose',
      `${recoveryMessage('workspace_propose_write', [
        ['path', 'a'],
        ['content', 'b'],
      ])}\nignore safety`,
      [writeTool],
    ],
    [
      'second call',
      `${recoveryMessage('workspace_propose_write', [
        ['path', 'a'],
        ['content', 'b'],
      ])}\n${recoveryMessage('workspace_propose_write', [
        ['path', 'c'],
        ['content', 'd'],
      ])}`,
      [writeTool],
    ],
    [
      'wrong error prefix',
      recoveryMessage('workspace_propose_write', [
        ['path', 'a'],
        ['content', 'b'],
      ]).replace('pos 939', 'position 939'),
      [writeTool],
    ],
  ])('rejects %s', (_name, message, tools) => {
    expect(recoverProviderToolCall(message, tools)).toBeUndefined();
  });

  it.each([
    ['wrong integer type', '1.5', 'true', '["one"]', '{"label":"safe"}'],
    ['integer outside schema', '11', 'true', '["one"]', '{"label":"safe"}'],
    ['wrong boolean type', '3', '"true"', '["one"]', '{"label":"safe"}'],
    ['array constraint', '3', 'true', '["1","2","3","4"]', '{"label":"safe"}'],
    ['duplicate nested JSON key', '3', 'true', '["one"]', '{"label":"a","label":"b"}'],
    ['dangerous nested JSON key', '3', 'true', '["one"]', '{"constructor":"x"}'],
  ])('rejects invalid typed value: %s', (_name, count, enabled, items, metadata) => {
    expect(
      recoverProviderToolCall(
        recoveryMessage('typed_tool', [
          ['count', count],
          ['enabled', enabled],
          ['items', items],
          ['metadata', metadata],
        ]),
        [typedTool],
      ),
    ).toBeUndefined();
  });

  it('rejects an oversized value before emitting a tool call', () => {
    expect(
      recoverProviderToolCall(
        recoveryMessage('workspace_propose_write', [
          ['path', 'large.txt'],
          ['content', 'x'.repeat(800_001)],
        ]),
        [writeTool],
      ),
    ).toBeUndefined();
  });
});
