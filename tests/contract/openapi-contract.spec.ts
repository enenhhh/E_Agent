import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface OpenApiOperation {
  operationId?: string;
  responses?: Record<string, unknown>;
  security?: unknown[];
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation | unknown>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(testDirectory, '../../infra/openapi/e-agent.v1.json');
const httpMethods = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace']);

async function readContract(): Promise<OpenApiDocument> {
  return JSON.parse(await readFile(contractPath, 'utf8')) as OpenApiDocument;
}

describe('OpenAPI public contract', () => {
  it('is a versioned OpenAPI 3.1 document', async () => {
    const contract = await readContract();

    expect(contract.openapi).toMatch(/^3\.1\./u);
    expect(contract.info).toEqual(
      expect.objectContaining({
        title: 'E Agent API',
        version: expect.stringMatching(/^1\./u),
      }),
    );
    expect(contract.components.securitySchemes).toHaveProperty('bearerAuth');
    expect(contract.components.schemas).toHaveProperty('Problem');
  });

  it('assigns every operation a unique operationId and an explicit response', async () => {
    const contract = await readContract();
    const operationIds = new Set<string>();

    for (const [route, pathItem] of Object.entries(contract.paths)) {
      expect(route, 'route must be rooted and must not end with slash').toMatch(
        /^\/(?:$|.*[^/])$/u,
      );
      for (const [method, candidate] of Object.entries(pathItem)) {
        if (!httpMethods.has(method)) {
          continue;
        }
        const operation = candidate as OpenApiOperation;
        expect(operation.operationId, `${method.toUpperCase()} ${route}`).toBeTypeOf('string');
        expect(operation.responses, `${method.toUpperCase()} ${route}`).toBeTruthy();
        expect(operationIds.has(operation.operationId!), operation.operationId).toBe(false);
        operationIds.add(operation.operationId!);
      }
    }

    expect(operationIds.size).toBeGreaterThanOrEqual(20);
  });

  it('documents all externally supported route families', async () => {
    const contract = await readContract();
    const routes = Object.keys(contract.paths);

    for (const prefix of [
      '/api/v1/auth',
      '/api/v1/chat',
      '/api/v1/conversations',
      '/api/v1/keys',
      '/api/v1/models',
      '/api/v1/providers',
      '/api/v1/settings',
      '/api/v1/usage',
      '/health',
    ]) {
      expect(
        routes.some((route) => route.startsWith(prefix)),
        `missing ${prefix}`,
      ).toBe(true);
    }
  });

  it('declares the chat endpoint as an SSE stream', async () => {
    const contract = await readContract();
    const chatOperation = contract.paths['/api/v1/chat/completions']?.post as
      | OpenApiOperation
      | undefined;
    const successResponse = chatOperation?.responses?.['200'] as
      | {
          content?: Record<string, { schema?: Record<string, unknown> }>;
        }
      | undefined;

    expect(successResponse?.content).toHaveProperty('text/event-stream');
    expect(successResponse?.content?.['text/event-stream']?.schema).toEqual(
      expect.objectContaining({ type: 'string' }),
    );
  });

  it('documents authenticated logout for the session lifecycle', async () => {
    const contract = await readContract();
    const operation = contract.paths['/api/v1/auth/logout']?.post as OpenApiOperation | undefined;

    expect(operation?.operationId).toBe('logoutUser');
    expect(operation?.security).toContainEqual({ bearerAuth: [] });
    expect(operation?.responses).toHaveProperty('204');
  });

  it('protects non-authentication API operations with bearer auth', async () => {
    const contract = await readContract();

    for (const [route, pathItem] of Object.entries(contract.paths)) {
      if (
        route.startsWith('/health') ||
        route === '/api/v1/auth/status' ||
        route === '/api/v1/auth/register' ||
        route === '/api/v1/auth/login'
      ) {
        continue;
      }
      for (const [method, candidate] of Object.entries(pathItem)) {
        if (!httpMethods.has(method)) {
          continue;
        }
        const operation = candidate as OpenApiOperation;
        expect(
          operation.security,
          `${method.toUpperCase()} ${route} must be authenticated`,
        ).toContainEqual({ bearerAuth: [] });
      }
    }
  });
});
