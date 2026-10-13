/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders are refused even with that flag. The flag forces the
 * listener onto 127.0.0.1. /mcp rejects a missing or invalid X-Gateway-S2S
 * header. AUTH_MODE=gateway rejects requests that omit X-Clio-Access-Token
 * and must not fall back to CLIO_* in process.env.
 */

import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHttpServer } from '../http.js';

const S2S_SECRET = 's2s-do-not-log-7f3a';
const ENV_ACCESS_TOKEN = 'env-access-token-must-not-be-used';
const PLACEHOLDER = 'replace-with-a-real-secret';

const ENV_KEYS = [
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'AUTH_MODE',
  'CLIO_ACCESS_TOKEN',
  'CLIO_REFRESH_TOKEN',
  'CLIO_CLIENT_ID',
  'CLIO_CLIENT_SECRET',
  'CLIO_REGION',
  'LOG_LEVEL',
  'MCP_TRANSPORT',
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
  return {
    text: () => lines.join('\n'),
    restore: () => spy.mockRestore(),
  };
}

function refuseExit(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

async function listen(): Promise<{ port: number; address: string; close: () => Promise<void> }> {
  const server = await startHttpServer();
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === 'string') {
    throw new Error('HTTP server did not bind a TCP port');
  }
  return {
    port: bound.port,
    address: bound.address,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

const statusCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'clio_status', arguments: {} },
});

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.LOG_LEVEL = 'info';
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.CLIO_ACCESS_TOKEN;
  delete process.env.CLIO_REFRESH_TOKEN;
  delete process.env.CLIO_CLIENT_ID;
  delete process.env.CLIO_CLIENT_SECRET;
  delete process.env.CLIO_REGION;
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('HTTP startup', () => {
  it.each(['', '   '])('refuses to start when CONDUIT_S2S_SECRET is %j', async (secret) => {
    process.env.CONDUIT_S2S_SECRET = secret;
    const logs = captureStderr();
    refuseExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      const text = logs.text();
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('CONDUIT_S2S_SECRET is empty');
      expect(text).not.toContain(S2S_SECRET);
      expect(text).not.toContain(PLACEHOLDER);
    } finally {
      logs.restore();
    }
  });

  it('refuses to start when CONDUIT_S2S_SECRET is unset', async () => {
    const logs = captureStderr();
    refuseExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('CONDUIT_S2S_SECRET is empty');
    } finally {
      logs.restore();
    }
  });

  it('still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    const logs = captureStderr();
    refuseExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('Refusing to start HTTP transport');
    } finally {
      logs.restore();
    }
  });

  it('refuses a known placeholder secret and does not log it', async () => {
    process.env.CONDUIT_S2S_SECRET = PLACEHOLDER;
    const logs = captureStderr();
    refuseExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      const text = logs.text();
      expect(text).toContain('known placeholder');
      expect(text).toContain('openssl rand -hex 32');
      expect(text).not.toContain(PLACEHOLDER);
    } finally {
      logs.restore();
    }
  });

  it('refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1', async () => {
    process.env.CONDUIT_S2S_SECRET = '  Your-S2S-Secret  ';
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_HTTP_PORT = '47114';
    const logs = captureStderr();
    refuseExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      const text = logs.text();
      expect(text).toContain('known placeholder');
      expect(text).not.toContain('Your-S2S-Secret');
      expect(text).not.toContain('SECURITY WARNING');
      await expect(fetch('http://127.0.0.1:47114/health')).rejects.toThrow();
    } finally {
      logs.restore();
    }
  });

  it('allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    const exitSpy = vi.spyOn(process, 'exit');

    try {
      const server = await listen();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(server.address).toBe('127.0.0.1');
      const text = logs.text();
      expect(text).toContain('SECURITY WARNING');
      expect(text).toContain('CONDUIT_S2S_SECRET');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV');
      expect(text).toContain('127.0.0.1');
      expect(text).not.toContain('not a loopback address');
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it.each(['0.0.0.0', '10.1.2.3'])(
    'forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is %s',
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      const exitSpy = vi.spyOn(process, 'exit');

      try {
        const server = await listen();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(server.address).toBe('127.0.0.1');
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain('Binding 127.0.0.1 only');
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        logs.restore();
      }
    },
  );

  it('honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const logs = captureStderr();

    try {
      const server = await listen();
      expect(server.address).toBe('0.0.0.0');
      expect(logs.text()).not.toContain('not a loopback address');
      expect(logs.text()).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it('binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is configured', async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe('127.0.0.1');
  });
});

describe('HTTP /mcp authentication', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.CLIO_ACCESS_TOKEN = ENV_ACCESS_TOKEN;
    process.env.CLIO_REGION = 'ca';
  });

  it('returns 401 when the S2S header is missing or invalid and does not log the secret', async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const missing = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({ 'x-clio-access-token': 'header-token' }),
        body: statusCall,
      });
      const invalid = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-clio-access-token': 'header-token',
          'x-gateway-s2s': mintS2sHeader('wrong-secret'),
        }),
        body: statusCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      const missingBody = await missing.text();
      const invalidBody = await invalid.text();
      expect(missingBody).toContain('X-Gateway-S2S');
      expect(invalidBody).toContain('X-Gateway-S2S');
      expect(missingBody).not.toContain(S2S_SECRET);
      expect(invalidBody).not.toContain(S2S_SECRET);
      expect(missingBody).not.toContain(ENV_ACCESS_TOKEN);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_ACCESS_TOKEN);
    } finally {
      logs.restore();
    }
  });

  it('returns 401 in gateway mode without credential headers and does not use env credentials', async () => {
    const server = await listen();
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toContain('Unauthorized');
    expect(body).toContain('X-Clio-Access-Token');
    expect(body).not.toContain(ENV_ACCESS_TOKEN);
    expect(body).not.toContain(S2S_SECRET);
    expect(body).not.toContain('ca');

    const partial = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders({
        'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
        'x-clio-refresh-token': 'refresh-only',
      }),
      body: statusCall,
    });
    expect(partial.status).toBe(401);
    expect(await partial.text()).not.toContain(ENV_ACCESS_TOKEN);
  });

  it('accepts a valid S2S header plus credential headers and uses those credentials', async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-clio-access-token': 'header-access-token',
          'x-clio-region': 'eu',
        }),
        body: statusCall,
      });
      const raw = await response.text();

      expect(response.status).toBe(200);
      expect(raw).not.toContain(S2S_SECRET);
      expect(raw).not.toContain(ENV_ACCESS_TOKEN);
      const payload = JSON.parse(raw) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = payload.result?.content?.[0]?.text ?? '';
      const status = JSON.parse(text) as { connected?: boolean; region?: string };
      expect(status.connected).toBe(true);
      expect(status.region).toBe('eu');
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_ACCESS_TOKEN);
    } finally {
      logs.restore();
    }
  });

  it('serves /health and /healthz without authentication and without reading credentials', async () => {
    const server = await listen();
    for (const path of ['/health', '/healthz']) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { status?: string; credentials?: unknown };
      expect(body.status).toBe('ok');
      expect(body.credentials).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(S2S_SECRET);
      expect(JSON.stringify(body)).not.toContain(ENV_ACCESS_TOKEN);
    }
  });

  it('uses env credentials in AUTH_MODE=env after a valid S2S header', async () => {
    process.env.AUTH_MODE = 'env';
    const server = await listen();
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });
    const raw = await response.text();
    expect(response.status).toBe(200);
    const payload = JSON.parse(raw) as { result?: { content?: Array<{ text?: string }> } };
    const status = JSON.parse(payload.result?.content?.[0]?.text ?? '') as { connected?: boolean; region?: string };
    expect(status.connected).toBe(true);
    expect(status.region).toBe('ca');
    expect(raw).not.toContain(ENV_ACCESS_TOKEN);
    expect(raw).not.toContain(S2S_SECRET);
  });
});
