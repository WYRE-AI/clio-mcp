import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { credentialsFromHeaders, getCredentials, runWithCredentials } from './utils/client.js';
import { runWithServerRef } from './utils/server-ref.js';
import { logger } from './utils/logger.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';

/**
 * Public example values. A copied placeholder must not verify as a real
 * X-Gateway-S2S secret, including when MCP_ALLOW_INSECURE_DEV=1 is set.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-real-secret',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
]);

const MISSING_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. ' +
  'An empty secret would accept unauthenticated /mcp requests (CWE-306). ' +
  'Set CONDUIT_S2S_SECRET to the gateway-provisioned service-to-service secret (openssl rand -hex 32), ' +
  'or set MCP_ALLOW_INSECURE_DEV=1 for local development only.';

const PLACEHOLDER_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.';

const INSECURE_DEV_WARNING =
  'SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. ' +
  'HTTP /mcp is not enforcing X-Gateway-S2S and listens on 127.0.0.1 only. ' +
  'Do not use this outside local development.';

const LOOPBACK_HOST = '127.0.0.1';

const S2S_UNAUTHORIZED = {
  error: 'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
};

const GATEWAY_CREDENTIALS_UNAUTHORIZED = {
  error: 'Unauthorized: missing required gateway credential header X-Clio-Access-Token',
};

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, '$1');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed: the process exits unless MCP_ALLOW_INSECURE_DEV=1,
 * which forces the listener onto 127.0.0.1. A known placeholder always
 * refuses to start. The secret value is never written to logs.
 */
function resolveHttpS2sSecret(): string {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? '').trim();
  if (KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    logger.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (raw) return raw;

  if (process.env.MCP_ALLOW_INSECURE_DEV === '1') {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
    return '';
  }

  logger.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * No secret (the insecure-dev bypass) always binds 127.0.0.1, even when
 * MCP_HTTP_HOST is a wider address such as the image default 0.0.0.0.
 * A configured secret honors MCP_HTTP_HOST, defaulting to 127.0.0.1 when unset.
 */
function resolveBindHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? '').trim();
  if (s2sSecret) return configured || LOOPBACK_HOST;

  if (configured && !isLoopbackHost(configured)) {
    logger.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        'MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. ' +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

/**
 * HTTP streaming transport (skill 2.2 / 2.3). Every request gets a brand new
 * Server + StreamableHTTPServerTransport pair -- the gateway sends separate
 * HTTP requests for initialize / tools/list / tools/call, and a shared
 * server would reject the second `initialize` with HTTP 500.
 *
 * SECURITY-CRITICAL invariant: `sessionIdGenerator: undefined` +
 * `enableJsonResponse: true` keeps this transport stateless. Per-request
 * tenant credentials are carried in the AsyncLocalStorage context opened by
 * `runWithCredentials()` below, scoped to exactly this request's handling.
 * Switching to a stateful/SSE transport would let a long-lived connection
 * serve later messages under a stale/foreign credential context.
 *
 * HTTP refuses to start unless CONDUIT_S2S_SECRET is a real secret.
 * MCP_ALLOW_INSECURE_DEV=1 is a local-only escape hatch: it logs a warning,
 * skips X-Gateway-S2S, and binds 127.0.0.1 only. /health and /healthz stay
 * unauthenticated and do not read credentials. stdio does not use S2S auth.
 */
export async function startHttpServer(): Promise<HttpServer> {
  const s2sSecret = resolveHttpS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT ?? '8080', 10);
  const host = resolveBindHost(s2sSecret);
  const isGatewayMode = process.env.AUTH_MODE === 'gateway';

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Shallow, unauthenticated liveness probe. Always 200 while the process
    // is up -- in gateway mode credentials arrive per-request via headers, so
    // a credential-gated status would wrongly fail the container's liveness
    // probe. This handler must not read vendor credentials.
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'http', timestamp: new Date().toISOString() }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1; startup
    // refuses otherwise. A configured secret is always enforced, before any
    // credential extraction.
    if (s2sSecret && !verifyS2sHeader(singleHeader(req.headers[S2S_HEADER]), s2sSecret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(S2S_UNAUTHORIZED));
      return;
    }

    const handle = async () => {
      const server = createServer();

      // Bind this request's server into the per-request async context (not
      // a module-level global) so elicitation helpers resolve *this*
      // server/transport even after await gaps, and never a concurrent
      // request's — see utils/server-ref.ts. The whole connect/handleRequest/
      // catch chain must stay inside this callback so the bound context
      // survives every await gap between here and any later getServerRef()
      // call.
      await runWithServerRef(server, async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          transport.close();
          server.close();
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } catch (err) {
          logger.error('MCP transport error', { error: (err as Error).message });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
          }
        }
      });
    };

    if (isGatewayMode) {
      // Credentials must arrive on every request via X-Clio-Access-Token.
      // Reject explicitly if missing rather than falling through — falling
      // through would resolve CLIO_* from the process environment, which is
      // not request-scoped (CWE-306).
      const creds = credentialsFromHeaders(req.headers as Record<string, string | string[] | undefined>);
      if (!creds) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(GATEWAY_CREDENTIALS_UNAUTHORIZED));
        return;
      }
      await runWithCredentials(creds, handle);
      return;
    }

    await handle();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      logger.info(`Clio MCP server listening on ${host}:${port}`, {
        authMode: isGatewayMode ? 'gateway' : 'env',
        hasEnvCredentials: Boolean(getCredentials()),
      });
      resolve();
    });
  });

  return httpServer;
}
