import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { McpManager } from '../../packages/mcp-runtime/dist/index.js';

const fixtureSource = String.raw`
const { writeFile } = require('node:fs/promises');
const { resolve, relative } = require('node:path');
const readline = require('node:readline');

const workspaceRoot = resolve(process.argv[2]);
const input = readline.createInterface({ input: process.stdin });

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

input.on('line', async (line) => {
  const request = JSON.parse(line);
  if (!Object.prototype.hasOwnProperty.call(request, 'id')) return;

  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'e-agent-smoke-fixture', version: '1.0.0' }
    });
    return;
  }

  if (request.method === 'tools/list') {
    respond(request.id, {
      tools: [{
        name: 'write_demo_file',
        description: 'Create a bounded smoke-test file.',
        inputSchema: {
          type: 'object',
          properties: {
            fileName: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['fileName', 'content'],
          additionalProperties: false
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false
        }
      }]
    });
    return;
  }

  if (request.method === 'tools/call') {
    const args = request.params?.arguments ?? {};
    if (request.params?.name !== 'write_demo_file' || args.fileName !== 'mcp-smoke.txt') {
      respond(request.id, {
        content: [{ type: 'text', text: 'Rejected by the smoke fixture.' }],
        isError: true
      });
      return;
    }

    const target = resolve(workspaceRoot, args.fileName);
    const relativeTarget = relative(workspaceRoot, target);
    if (relativeTarget.startsWith('..') || resolve(target) === workspaceRoot) {
      respond(request.id, {
        content: [{ type: 'text', text: 'Path escaped the smoke workspace.' }],
        isError: true
      });
      return;
    }

    await writeFile(target, String(args.content), { encoding: 'utf8', flag: 'wx' });
    respond(request.id, {
      content: [{
        type: 'text',
        text: JSON.stringify({ fileName: args.fileName, bytes: Buffer.byteLength(String(args.content)) })
      }],
      isError: false
    });
    return;
  }

  if (request.method === 'ping') {
    respond(request.id, {});
  }
});
`;

const expectedContent = 'E Agent MCP tool call verified.';
const temporaryRoot = await mkdtemp(join(tmpdir(), 'e-agent-mcp-smoke-'));
const manager = new McpManager({
  servers: [
    {
      id: 'smoke',
      displayName: 'MCP Smoke Fixture',
      enabled: true,
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [join(temporaryRoot, 'server.cjs'), temporaryRoot],
        cwd: temporaryRoot,
        inheritEnv: [],
        shutdownGraceMs: 100,
      },
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      maxConcurrentCalls: 1,
    },
  ],
});

let exitCode = 0;
try {
  await writeFile(join(temporaryRoot, 'server.cjs'), fixtureSource, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await manager.initialize();
  const tools = await manager.listTools();
  const tool = tools.find((candidate) => candidate.originalName === 'write_demo_file');
  if (tool === undefined) throw new Error('MCP smoke test did not discover write_demo_file.');
  if (tool.annotations?.destructiveHint !== true) {
    throw new Error('MCP smoke test lost the tool approval annotation.');
  }

  const result = await manager.callTool(tool.name, {
    fileName: 'mcp-smoke.txt',
    content: expectedContent,
  });
  if (result.isError) throw new Error('MCP smoke tool returned isError=true.');

  const createdContent = await readFile(join(temporaryRoot, 'mcp-smoke.txt'), 'utf8');
  if (createdContent !== expectedContent) {
    throw new Error('MCP smoke tool created unexpected file content.');
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      transport: 'stdio',
      discoveredTools: tools.length,
      exposedTool: tool.name,
      fileCreated: true,
      bytes: Buffer.byteLength(createdContent),
    })}\n`,
  );
} catch (error) {
  exitCode = 1;
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown MCP smoke failure.',
    })}\n`,
  );
} finally {
  await manager.shutdown();
  const safeTemporaryRoot =
    basename(temporaryRoot).startsWith('e-agent-mcp-smoke-') &&
    resolve(temporaryRoot).startsWith(resolve(tmpdir()));
  if (!safeTemporaryRoot) throw new Error('Refusing to clean an unexpected smoke-test directory.');
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.exitCode = exitCode;
