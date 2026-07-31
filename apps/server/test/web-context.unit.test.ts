import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const networkMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: networkMocks.lookup,
}));

vi.mock('node:https', () => ({
  request: networkMocks.request,
}));

import { formatWebContext, resolveWebContextMentions } from '../src/web-context.js';

interface ResponsePlan {
  statusCode?: number;
  location?: string;
  contentType?: string;
  contentEncoding?: string;
  chunks?: Array<Buffer | string>;
  requestError?: Error;
  responseError?: Error;
  timeout?: boolean;
}

class MockResponse extends EventEmitter {
  public readonly headers: Record<string, string | undefined>;
  public readonly statusCode: number | undefined;
  public destroyed = false;
  public readonly resume = vi.fn();

  public constructor(plan: ResponsePlan) {
    super();
    this.statusCode = plan.statusCode;
    this.headers = {
      location: plan.location,
      'content-type': plan.contentType,
      'content-encoding': plan.contentEncoding,
    };
  }

  public destroy(error?: Error): this {
    this.destroyed = true;
    if (error !== undefined) queueMicrotask(() => this.emit('error', error));
    return this;
  }
}

class MockRequest extends EventEmitter {
  public timeoutHandler: (() => void) | undefined;
  public readonly timeoutDurations: number[] = [];
  private readonly finishRequest: () => void;

  public constructor(finishRequest: () => void) {
    super();
    this.finishRequest = finishRequest;
  }

  public setTimeout(duration: number, handler: () => void): this {
    this.timeoutDurations.push(duration);
    this.timeoutHandler = handler;
    return this;
  }

  public end(): this {
    this.finishRequest();
    return this;
  }

  public destroy(error?: Error): this {
    if (error !== undefined) queueMicrotask(() => this.emit('error', error));
    return this;
  }
}

const requestOptions: Array<Record<string, unknown>> = [];
const outboundRequests: MockRequest[] = [];

function enqueueResponse(plan: ResponsePlan): void {
  networkMocks.request.mockImplementationOnce(
    (options: Record<string, unknown>, callback: (response: MockResponse) => void) => {
      requestOptions.push(options);
      const outbound = new MockRequest(() => {
        if (plan.requestError !== undefined) {
          queueMicrotask(() => outbound.emit('error', plan.requestError));
          return;
        }
        if (plan.timeout === true) {
          queueMicrotask(() => outbound.timeoutHandler?.());
          return;
        }
        const response = new MockResponse(plan);
        queueMicrotask(() => {
          callback(response);
          queueMicrotask(() => {
            if (plan.responseError !== undefined) {
              response.emit('error', plan.responseError);
              return;
            }
            for (const chunk of plan.chunks ?? []) {
              if (response.destroyed) break;
              response.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            if (!response.destroyed) response.emit('end');
          });
        });
      });
      outboundRequests.push(outbound);
      return outbound;
    },
  );
}

function expectBadRequest(promise: Promise<unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: 'DomainError',
    code: 'BAD_REQUEST',
    statusCode: 400,
  });
}

describe('Web context mention resolution', () => {
  beforeEach(() => {
    networkMocks.lookup.mockReset();
    networkMocks.request.mockReset();
    requestOptions.length = 0;
    outboundRequests.length = 0;
    networkMocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  it('fetches public text through the pinned DNS address and trims it', async () => {
    enqueueResponse({
      statusCode: 200,
      contentType: 'text/plain; charset=utf-8',
      chunks: ['  hello ', 'world  \n'],
    });

    const result = await resolveWebContextMentions(['@web:https://example.com/articles/read?id=7']);

    expect(result).toEqual({
      documents: [
        {
          url: 'https://example.com/articles/read?id=7',
          content: 'hello world',
        },
      ],
    });
    expect(networkMocks.lookup).toHaveBeenCalledWith('example.com', {
      all: true,
      verbatim: true,
    });
    expect(requestOptions[0]).toMatchObject({
      protocol: 'https:',
      host: '93.184.216.34',
      family: 4,
      port: 443,
      path: '/articles/read?id=7',
      method: 'GET',
      servername: 'example.com',
      headers: {
        Host: 'example.com',
        Accept: expect.stringContaining('text/html'),
        'User-Agent': 'E-Agent/0.1 WebContext',
      },
    });
    expect(outboundRequests[0]?.timeoutDurations).toEqual([10_000]);
  });

  it('sanitizes HTML into inert readable text and decodes supported entities', async () => {
    enqueueResponse({
      statusCode: 200,
      contentType: 'text/html; charset=UTF-8',
      chunks: [
        '<style>.secret{display:none}</style><script>steal()</script>',
        '<noscript>fallback</noscript><svg><path /></svg>',
        '<main> Hello&nbsp; &amp; &lt;ok&gt; &quot;q&quot; &#39;s&#39; </main>',
      ],
    });

    const result = await resolveWebContextMentions(['@web:"https://example.com/page"']);

    expect(result.documents[0]?.content).toBe(`Hello & <ok> "q" 's'`);
    expect(result.documents[0]?.content).not.toContain('steal');
    expect(result.documents[0]?.content).not.toContain('secret');
  });

  it.each([
    ['application/json; charset=utf-8', ' {"ok":true} ', '{"ok":true}'],
    ['application/xml', ' <root>value</root> ', '<root>value</root>'],
    ['text/csv', ' a,b\n1,2 ', 'a,b\n1,2'],
  ])('accepts supported %s responses', async (contentType, source, expected) => {
    enqueueResponse({ statusCode: 200, contentType, chunks: [source] });

    const result = await resolveWebContextMentions(['@web:https://example.com/data']);

    expect(result.documents[0]?.content).toBe(expected);
  });

  it('treats XHTML as HTML and accepts an explicit identity encoding', async () => {
    enqueueResponse({
      statusCode: 200,
      contentType: 'application/xhtml+xml',
      contentEncoding: 'identity',
      chunks: ['<article>XHTML&nbsp;<strong>content</strong></article>'],
    });

    const result = await resolveWebContextMentions(['@web:https://example.com/xhtml']);

    expect(result.documents[0]?.content).toBe('XHTML content');
  });

  it('supports public IPv6 and omits TLS servername for an IP-literal URL', async () => {
    networkMocks.lookup.mockResolvedValue([{ address: '2606:4700:4700:0:0:0:0:1111', family: 6 }]);
    enqueueResponse({ statusCode: 200, contentType: 'text/plain', chunks: ['ipv6'] });

    const result = await resolveWebContextMentions([
      '@web:https://[2606:4700:4700::1111]/resource',
    ]);

    expect(result.documents[0]?.content).toBe('ipv6');
    expect(requestOptions[0]).toMatchObject({
      host: '2606:4700:4700:0:0:0:0:1111',
      family: 6,
      path: '/resource',
    });
    expect(requestOptions[0]).not.toHaveProperty('servername');
  });

  it('accepts a public IPv4-mapped IPv6 DNS answer', async () => {
    networkMocks.lookup.mockResolvedValue([{ address: '::ffff:93.184.216.34', family: 6 }]);
    enqueueResponse({ statusCode: 200, contentType: 'text/plain', chunks: ['mapped'] });

    const result = await resolveWebContextMentions(['@web:https://example.com/']);

    expect(result.documents[0]?.content).toBe('mapped');
  });

  it.each([
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1%eth0',
    'ff02::1',
    '2001:db8::1',
    'not-an-ip',
  ])('rejects non-public DNS answer %s', async (address) => {
    networkMocks.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);

    await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/']));
    expect(networkMocks.request).not.toHaveBeenCalled();
  });

  it('rejects DNS rebinding candidates when any answer is private', async () => {
    networkMocks.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.2', family: 4 },
    ]);

    await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/']));
    expect(networkMocks.request).not.toHaveBeenCalled();
  });

  it('rejects a DNS result with an unsupported address family', async () => {
    networkMocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 0 }]);

    await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/']));
  });

  it('maps DNS lookup failures to a safe bad-request error', async () => {
    networkMocks.lookup.mockRejectedValue(new Error('resolver details must remain internal'));

    await expectBadRequest(resolveWebContextMentions(['@web:https://missing.example/']));
    expect(networkMocks.request).not.toHaveBeenCalled();
  });

  it.each([
    '@web:http://example.com/',
    '@web:https://user:password@example.com/',
    '@web:https://example.com:8443/',
    '@web:https://localhost/',
    '@web:https://sub.localhost/',
    '@web:https://printer.local/',
    '@web:https://service.internal/',
    '@web:https://intranet/',
  ])('rejects unsafe target syntax %s before making an HTTPS request', async (mention) => {
    await expectBadRequest(resolveWebContextMentions([mention]));
    expect(networkMocks.request).not.toHaveBeenCalled();
  });

  it('follows a relative redirect and returns the final source URL', async () => {
    enqueueResponse({ statusCode: 302, location: '/final?from=redirect' });
    enqueueResponse({ statusCode: 200, contentType: 'text/plain', chunks: ['done'] });

    const result = await resolveWebContextMentions(['@web:https://example.com/start']);

    expect(result.documents).toEqual([
      {
        url: 'https://example.com/final?from=redirect',
        content: 'done',
      },
    ]);
    expect(requestOptions.map((options) => options.path)).toEqual([
      '/start',
      '/final?from=redirect',
    ]);
  });

  it('revalidates DNS and request metadata across an absolute cross-host redirect', async () => {
    enqueueResponse({ statusCode: 307, location: 'https://cdn.example.net/asset' });
    enqueueResponse({ statusCode: 200, contentType: 'text/plain', chunks: [] });

    const result = await resolveWebContextMentions(['@web:https://example.com/start']);

    expect(networkMocks.lookup).toHaveBeenNthCalledWith(2, 'cdn.example.net', {
      all: true,
      verbatim: true,
    });
    expect(requestOptions[1]).toMatchObject({
      path: '/asset',
      servername: 'cdn.example.net',
      headers: expect.objectContaining({ Host: 'cdn.example.net' }),
    });
    expect(result.documents).toEqual([{ url: 'https://cdn.example.net/asset', content: '' }]);
  });

  it('rejects a redirect chain beyond the configured limit', async () => {
    for (let index = 0; index < 4; index += 1) {
      enqueueResponse({ statusCode: 301, location: `/redirect-${index + 1}` });
    }

    await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/start']));
    expect(networkMocks.request).toHaveBeenCalledTimes(4);
  });

  it('rejects malformed and unsafe redirect locations', async () => {
    enqueueResponse({ statusCode: 302, location: 'https://[invalid' });
    await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/start']));

    enqueueResponse({ statusCode: 302, location: 'http://example.com/insecure' });
    await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/again']));
  });

  it('treats a redirect status without a location as an unsuccessful response', async () => {
    enqueueResponse({ statusCode: 302 });

    await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/no-location']));
  });

  it.each([undefined, 199, 404, 500])('rejects unsuccessful HTTP status %s', async (statusCode) => {
    enqueueResponse({ statusCode, contentType: 'text/plain', chunks: ['ignored'] });

    await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/']));
  });

  it.each([
    ['application/octet-stream', undefined],
    ['image/svg+xml', undefined],
    ['text/plain', 'gzip'],
    ['application/json', 'br'],
  ])(
    'rejects unsupported response metadata content-type=%s encoding=%s',
    async (contentType, contentEncoding) => {
      enqueueResponse({
        statusCode: 200,
        contentType,
        contentEncoding,
        chunks: ['ignored'],
      });

      await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/']));
    },
  );

  it('rejects request errors, response errors, and timeouts', async () => {
    enqueueResponse({ requestError: new Error('connection refused') });
    await expect(resolveWebContextMentions(['@web:https://example.com/request'])).rejects.toThrow(
      'connection refused',
    );

    enqueueResponse({
      statusCode: 200,
      contentType: 'text/plain',
      responseError: new Error('response reset'),
    });
    await expect(resolveWebContextMentions(['@web:https://example.com/response'])).rejects.toThrow(
      'response reset',
    );

    enqueueResponse({ timeout: true });
    await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/timeout']));
  });

  it('rejects a response larger than 512 KiB', async () => {
    enqueueResponse({
      statusCode: 200,
      contentType: 'text/plain',
      chunks: [Buffer.alloc(512 * 1024 + 1, 'x')],
    });

    await expectBadRequest(resolveWebContextMentions(['@web:https://example.com/large']));
  });

  it('limits the number and aggregate size of fetched documents', async () => {
    for (let index = 0; index < 4; index += 1) {
      enqueueResponse({ statusCode: 200, contentType: 'text/plain', chunks: [`doc-${index}`] });
    }
    await expectBadRequest(
      resolveWebContextMentions([
        '@web:https://one.example/',
        '@web:https://two.example/',
        '@web:https://three.example/',
        '@web:https://four.example/',
        '@web:https://five.example/',
      ]),
    );
    expect(networkMocks.request).toHaveBeenCalledTimes(4);

    enqueueResponse({
      statusCode: 200,
      contentType: 'text/plain',
      chunks: [Buffer.alloc(500_001, 'a')],
    });
    enqueueResponse({
      statusCode: 200,
      contentType: 'text/plain',
      chunks: [Buffer.alloc(500_001, 'b')],
    });
    await expectBadRequest(
      resolveWebContextMentions([
        '@web:https://large-one.example/',
        '@web:https://large-two.example/',
      ]),
    );
  });

  it('parses skill references and enforces a single distinct skill', async () => {
    await expect(resolveWebContextMentions([])).resolves.toEqual({ documents: [] });
    await expect(
      resolveWebContextMentions(['@skill:"@code-review"', '@skill:@code-review']),
    ).resolves.toEqual({
      documents: [],
      skillReference: '@code-review',
    });
    await expectBadRequest(resolveWebContextMentions(['@skill:@code-review', '@skill:@test-gen']));
  });

  it('rejects desktop-only, malformed mention, and invalid URL inputs', async () => {
    for (const mention of ['@file:src/index.ts', '@folder:"src/components"']) {
      await expect(resolveWebContextMentions([mention])).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        details: {
          supportedSurface: 'desktop',
          mention,
        },
      });
    }
    await expectBadRequest(resolveWebContextMentions(['@unknown:value']));
    await expectBadRequest(resolveWebContextMentions(['@web:"unterminated']));
    await expectBadRequest(resolveWebContextMentions(['@web:not-a-valid-url']));
  });
});

describe('Web context prompt formatting', () => {
  it('returns no prompt section when there are no documents', () => {
    expect(formatWebContext([])).toBe('');
  });

  it('wraps every document and escapes quotes in source attributes', () => {
    const formatted = formatWebContext([
      { url: 'https://example.com/?title="quoted"', content: 'first body' },
      { url: 'https://second.example/path', content: 'second body' },
    ]);

    expect(formatted).toContain(
      '<web-context source="https://example.com/?title=&quot;quoted&quot;">\nfirst body\n</web-context>',
    );
    expect(formatted).toContain(
      '<web-context source="https://second.example/path">\nsecond body\n</web-context>',
    );
    expect(formatted.indexOf('first body')).toBeLessThan(formatted.indexOf('second body'));
  });
});
