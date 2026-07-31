import { describe, expect, it, vi } from 'vitest';

import { McpClient, StdioMcpTransport, parseMcpServerConfig } from '../src/index.js';

const serverScript = String.raw`
const readline = require('node:readline');
process.stderr.write('Authorization: Bearer sk-test-child-secret-123456789\n');
process.stderr.write(String(process.env.MCP_FIXTURE_SECRET) + '\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (!Object.prototype.hasOwnProperty.call(request, 'id')) return;
  let result = {};
  if (request.method === 'initialize') {
    result = {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'stdio-fixture', version: '1.0.0' }
    };
  } else if (request.method === 'tools/list') {
    result = {
      tools: [{
        name: 'echo',
        description: 'Echo input',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value']
        }
      }]
    };
  } else if (request.method === 'tools/call') {
    result = {
      content: [{ type: 'text', text: String(request.params.arguments.value) }],
      isError: false
    };
  } else if (request.method === 'ping') {
    result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`;

describe('StdioMcpTransport integration', () => {
  it('与真实子进程完成握手、发现、调用和清理', async () => {
    const parsed = parseMcpServerConfig({
      id: 'stdio.fixture',
      displayName: 'Stdio Fixture',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['-e', serverScript],
        env: { MCP_FIXTURE_SECRET: 'arbitrary-value-that-does-not-look-like-a-key' },
        shutdownGraceMs: 50,
      },
    });
    if (parsed.transport.type !== 'stdio') throw new Error('unexpected config');
    const logger = vi.fn();
    const transport = new StdioMcpTransport({
      serverId: parsed.id,
      config: parsed.transport,
      requestTimeoutMs: 2_000,
      logger,
    });
    const client = new McpClient({
      serverId: parsed.id,
      displayName: parsed.displayName,
      transport,
      requestTimeoutMs: 2_000,
    });

    await client.connect();
    await expect(client.listTools()).resolves.toEqual([expect.objectContaining({ name: 'echo' })]);
    await expect(client.callTool('echo', { value: 'hello MCP' })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'hello MCP' }],
      isError: false,
    });
    await client.close();
    expect(transport.connected).toBe(false);
    expect(JSON.stringify(logger.mock.calls)).not.toContain('sk-test-child-secret-123456789');
    expect(JSON.stringify(logger.mock.calls)).not.toContain(
      'arbitrary-value-that-does-not-look-like-a-key',
    );
    expect(JSON.stringify(logger.mock.calls)).toContain('[third-party stderr suppressed]');
  });

  it('超时会清理 pending 请求并允许后续关闭', async () => {
    const parsed = parseMcpServerConfig({
      id: 'stdio.timeout',
      displayName: 'Timeout',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
        shutdownGraceMs: 20,
      },
    });
    if (parsed.transport.type !== 'stdio') throw new Error('unexpected config');
    const transport = new StdioMcpTransport({
      serverId: parsed.id,
      config: parsed.transport,
      requestTimeoutMs: 20,
    });
    await transport.connect();
    await expect(
      transport.request({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await transport.close();
  });

  it('支持调用方取消，并拒绝重复 ID、超大请求和无效 stdout', async () => {
    const parsed = parseMcpServerConfig({
      id: 'stdio.cancel',
      displayName: 'Cancel',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
        shutdownGraceMs: 20,
      },
    });
    if (parsed.transport.type !== 'stdio') throw new Error('unexpected config');
    const transport = new StdioMcpTransport({
      serverId: parsed.id,
      config: parsed.transport,
      requestTimeoutMs: 2_000,
      maxMessageBytes: 128,
    });
    await transport.connect();
    const controller = new AbortController();
    const first = transport.request(
      { jsonrpc: '2.0', id: 7, method: 'ping' },
      { signal: controller.signal },
    );
    await expect(
      transport.request({ jsonrpc: '2.0', id: 7, method: 'ping' }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    await expect(
      transport.notify({
        jsonrpc: '2.0',
        method: 'notification/large',
        params: { value: 'x'.repeat(500) },
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await transport.close();

    const invalidConfig = parseMcpServerConfig({
      id: 'stdio.invalid',
      displayName: 'Invalid',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [
          '-e',
          "require('node:readline').createInterface({input:process.stdin}).on('line',()=>process.stdout.write('not-json\\n'))",
        ],
        shutdownGraceMs: 20,
      },
    });
    if (invalidConfig.transport.type !== 'stdio') throw new Error('unexpected config');
    const invalid = new StdioMcpTransport({
      serverId: invalidConfig.id,
      config: invalidConfig.transport,
      requestTimeoutMs: 3_000,
    });
    await invalid.connect();
    await expect(invalid.request({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toMatchObject({
      code: 'PROTOCOL_INVALID',
    });
    await invalid.close();
  });

  it('将子进程启动失败转换为安全连接错误', async () => {
    const parsed = parseMcpServerConfig({
      id: 'stdio.missing',
      displayName: 'Missing',
      transport: {
        type: 'stdio',
        command: `definitely-missing-mcp-command-${Date.now()}`,
      },
    });
    if (parsed.transport.type !== 'stdio') throw new Error('unexpected config');
    const transport = new StdioMcpTransport({
      serverId: parsed.id,
      config: parsed.transport,
    });
    await expect(transport.connect()).rejects.toMatchObject({
      code: 'CONNECT_FAILED',
      retryable: true,
    });
    await expect(
      transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
  });

  it('rejects an already-aborted request before writing it to the child', async () => {
    const parsed = parseMcpServerConfig({
      id: 'stdio.pre-aborted',
      displayName: 'Pre-aborted',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
        shutdownGraceMs: 20,
      },
    });
    if (parsed.transport.type !== 'stdio') throw new Error('unexpected config');
    const transport = new StdioMcpTransport({
      serverId: parsed.id,
      config: parsed.transport,
      requestTimeoutMs: 2_000,
    });
    await transport.connect();
    const child = (
      transport as unknown as {
        child: { stdin: { write: (...arguments_: unknown[]) => boolean } };
      }
    ).child;
    const originalWrite = child.stdin.write;
    const stalledWrite = vi.fn(() => true);
    child.stdin.write = stalledWrite;
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));

    try {
      await expect(
        transport.request(
          { jsonrpc: '2.0', id: 'pre-aborted', method: 'ping' },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
      expect(stalledWrite).not.toHaveBeenCalled();
    } finally {
      child.stdin.write = originalWrite;
      await transport.close();
    }
  });

  it('applies cancellation and timeout options while writing notifications', async () => {
    const parsed = parseMcpServerConfig({
      id: 'stdio.notify-timeout',
      displayName: 'Notification timeout',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
        shutdownGraceMs: 20,
      },
    });
    if (parsed.transport.type !== 'stdio') throw new Error('unexpected config');
    const transport = new StdioMcpTransport({
      serverId: parsed.id,
      config: parsed.transport,
      requestTimeoutMs: 2_000,
    });
    await transport.connect();
    const child = (
      transport as unknown as {
        child: { stdin: { write: (...arguments_: unknown[]) => boolean } };
      }
    ).child;
    const originalWrite = child.stdin.write;
    const stalledWrite = vi.fn(() => true);
    child.stdin.write = stalledWrite;

    try {
      const controller = new AbortController();
      controller.abort(new DOMException('cancelled', 'AbortError'));
      await expect(
        transport.notify(
          { jsonrpc: '2.0', method: 'notifications/pre-aborted' },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
      expect(stalledWrite).not.toHaveBeenCalled();

      await expect(
        transport.notify({ jsonrpc: '2.0', method: 'notifications/stalled' }, { timeoutMs: 20 }),
      ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', retryable: true });
      expect(stalledWrite).toHaveBeenCalledTimes(1);
    } finally {
      child.stdin.write = originalWrite;
      await transport.close();
    }
  });

  it('waits for a stubborn process tree to exit during close', async () => {
    const treeServerScript = String.raw`
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore'
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (!Object.prototype.hasOwnProperty.call(request, 'id')) return;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: { grandchildPid: grandchild.pid }
  }) + '\n');
});
setInterval(() => {}, 1000);
`;
    const parsed = parseMcpServerConfig({
      id: 'stdio.process-tree',
      displayName: 'Process tree',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['-e', treeServerScript],
        shutdownGraceMs: 20,
      },
    });
    if (parsed.transport.type !== 'stdio') throw new Error('unexpected config');
    const transport = new StdioMcpTransport({
      serverId: parsed.id,
      config: parsed.transport,
      requestTimeoutMs: 2_000,
    });
    let grandchildPid: number | undefined;

    try {
      await transport.connect();
      const response = await transport.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
      });
      grandchildPid = (response.result as { grandchildPid: number }).grandchildPid;
      expect(isProcessAlive(grandchildPid)).toBe(true);

      await transport.close();

      expect(isProcessAlive(grandchildPid)).toBe(false);
    } finally {
      await transport.close();
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // The process may exit between the liveness check and cleanup.
        }
      }
    }
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
