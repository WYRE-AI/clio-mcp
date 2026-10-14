# clio-mcp

MCP (Model Context Protocol) server for [Clio Manage](https://www.clio.com/) -- matters, contacts,
activities, communications, tasks, documents, calendar entries, and bills. Built on
[`@wyre-technology/node-clio`](https://github.com/WYRE-AI/node-clio).

> **Compliance note.** This server proxies access to attorney-client privileged data (matters,
> communications, documents). It does not log or persist any request or response content anywhere --
> the structured stderr logger (`src/utils/logger.ts`) only ever emits level, timestamp, and a small
> context object such as a tool name or an error message, never tool arguments or result bodies. Document
> tools (`clio_documents_list` / `clio_documents_get`) return **metadata only** -- name, filename, size,
> content type, parent folder, associated matter/contact -- and never document content; the underlying SDK
> has no download/upload capability.

## Install

```bash
npm install
npm run build
```

Requires Node.js >= 20. This package depends on `@wyre-technology/node-clio`, published to GitHub
Packages -- see `.npmrc` (registry + token) if installing outside CI.

## Running

Copy [`.env.example`](.env.example) and set the variables below. Never commit a real secret.

```bash
npm run start        # stdio transport, reads CLIO_* env vars
npm run start:http   # HTTP transport; refuses to start until CONDUIT_S2S_SECRET is set
```

Local HTTP without a service-to-service secret is development-only. It logs a warning, does not check
`X-Gateway-S2S`, and binds `127.0.0.1` only (a non-loopback `MCP_HTTP_HOST`, including `0.0.0.0`, is
ignored and the override is logged):

```bash
MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

### Configuration

| Variable | Required | Description |
|---|---|---|
| `CLIO_ACCESS_TOKEN` | For stdio and `AUTH_MODE=env` | OAuth bearer access token. |
| `CLIO_REFRESH_TOKEN` | No | Enables automatic refresh-on-401. |
| `CLIO_CLIENT_ID` | No | Required alongside a refresh token. |
| `CLIO_CLIENT_SECRET` | No | Required alongside a refresh token. |
| `CLIO_REGION` | No | `us` (default), `ca`, `eu`, or `au`. |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http`. |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose default) or `env`. Gateway mode requires `X-Clio-Access-Token` on each `/mcp` request and never falls back to `CLIO_*`. `env` uses those variables only after S2S auth succeeds. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `your-s2s-secret`, `replace-with-a-real-secret`, and the other public example values). Compose will not start when it is unset. The value is never logged. Generate one with `openssl rand -hex 32`. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning and does not enforce `X-Gateway-S2S`. The listener is forced to `127.0.0.1`. A placeholder secret is still refused. |
| `MCP_HTTP_HOST` | No | Bind address when a secret is configured. Defaults to `127.0.0.1` when unset. With no secret, the bind address is `127.0.0.1` even if this is set wider. The container image sets `0.0.0.0`. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### Credentials

Clio is **OAuth-only** -- there is no static API key. This server never performs the OAuth
authorize/token dance itself; something upstream (the WYRE MCP gateway, or your own OAuth client) does
that and hands this server a bearer access token.

**Gateway mode** (`AUTH_MODE=gateway`, `MCP_TRANSPORT=http` -- the Docker image's default): credentials
are read from request headers, per request. A request missing `X-Clio-Access-Token` gets `401` and does
not fall back to `CLIO_*` in the process environment.

| Header | Required | Description |
|---|---|---|
| `X-Gateway-S2S` | Yes, when `CONDUIT_S2S_SECRET` is set | Gateway service-to-service proof. See [HTTP authentication](#http-authentication). |
| `X-Clio-Access-Token` | Yes | OAuth bearer access token. |
| `X-Clio-Refresh-Token` | No | Enables automatic refresh-on-401. |
| `X-Clio-Client-Id` | No | Required if `X-Clio-Refresh-Token` is present -- Clio's refresh flow needs the app's client id. |
| `X-Clio-Client-Secret` | No | Required if `X-Clio-Refresh-Token` is present. |
| `X-Clio-Region` | No | One of `us` \| `ca` \| `eu` \| `au`. Defaults to `us`. |

**stdio mode** (local/CLI use, a single set of credentials for the whole process): set environment
variables instead:

```bash
export CLIO_ACCESS_TOKEN=...
export CLIO_REFRESH_TOKEN=...   # optional
export CLIO_CLIENT_ID=...       # optional, required alongside a refresh token
export CLIO_CLIENT_SECRET=...   # optional, required alongside a refresh token
export CLIO_REGION=us           # optional, defaults to us
```

Clio runs four separate regional deployments (`us`/`ca`/`eu`/`au`) -- a token minted for one region is
not valid against another, and a Clio developer app registration is itself region-specific. Get an
access token via the [Clio OAuth flow](https://docs.developers.clio.com/api-docs/clio-manage/authorization/)
for the region you need; `@wyre-technology/node-clio` exports `buildAuthorizationUrl` /
`exchangeAuthorizationCode` helpers for that.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include
`X-Gateway-S2S`. The check is `verifyS2sHeader` in [`src/s2s-verify.ts`](src/s2s-verify.ts): the header
value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string
`t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be
within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before vendor
credentials are read. The secret is never written to logs or error bodies.

```
t=1710000000,v1=<hmac-sha256(secret, "t=1710000000") as 64 lowercase hex chars>
```

In `AUTH_MODE=gateway`, `/mcp` also requires `X-Clio-Access-Token` (`X-Clio-Refresh-Token`,
`X-Clio-Client-Id`, `X-Clio-Client-Secret`, and `X-Clio-Region` are optional). Those headers are the
only credential source for that request.

`AUTH_MODE=env` still requires a valid `X-Gateway-S2S` header, then uses `CLIO_*` from the process
environment when the request does not carry `X-Clio-Access-Token`.

### Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to
`AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode, Clio
credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build -t clio-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  clio-mcp
```

The checked-in Compose service is gateway mode. It does not set `CLIO_ACCESS_TOKEN` or the other
`CLIO_*` credential variables and does not use `env_file`, so a project `.env` cannot inject static
vendor credentials into the container. Compose still interpolates `CONDUIT_S2S_SECRET` from that file
and refuses to start when it is unset or empty. The published port is `127.0.0.1:8080:8080`.

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) is separate from that gateway service. It still requires the S2S
secret, then uses `CLIO_ACCESS_TOKEN`:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e CLIO_ACCESS_TOKEN=your-access-token \
  -e CLIO_REGION=us \
  -p 127.0.0.1:8080:8080 \
  clio-mcp
```

## Tool navigation

This server uses decision-tree navigation instead of exposing all tools flat. Initially only two tools
are visible:

- **`clio_navigate`** -- switch into one of the eight domains below; the domain's tools (plus
  `clio_back`) then appear in the next `tools/list`.
- **`clio_status`** -- check credential/connection status and see the list of domains.

Once inside a domain, **`clio_back`** returns to the navigation menu.

## Tool reference

Every tool is named `clio_{entity}_{operation}`. Read-only tools (`_list`/`_get`) never mutate Clio data
and are marked `readOnlyHint: true`. Tools that create or update records are marked `readOnlyHint: false`.
No tool in this server is destructive/irreversible -- the underlying SDK has no `delete()` on any
resource, so there is nothing to warn about at that tier.

Every `_list` tool called with no filters at all will ask (via MCP elicitation) for a search term, date
range, or similar before running what would otherwise be an unbounded query across the whole account. If
the client doesn't support elicitation, or the user doesn't answer, the tool proceeds unfiltered anyway --
elicitation is purely additive and never blocks the call.

### matters

| Tool | Description |
|---|---|
| `clio_matters_list` | List matters, filterable by client, status, practice area, responsible attorney, free-text query. |
| `clio_matters_get` | Get a single matter by ID. |
| `clio_matters_create` | Create a matter. Requires `description` and a client -- pass `client_id`, or `client_name` to resolve it by search (asks you to pick if the name is ambiguous). |
| `clio_matters_update` | Update a matter. Only the fields you pass are changed. |

### contacts

| Tool | Description |
|---|---|
| `clio_contacts_list` | List contacts (people and companies), filterable by type, client-only, free-text query. |
| `clio_contacts_get` | Get a single contact by ID. |
| `clio_contacts_create` | Create a contact. Requires `name` and `type` (`Person` or `Company`). |
| `clio_contacts_update` | Update a contact. Only the fields you pass are changed. |

### activities

Time entries and expense entries logged against matters.

| Tool | Description |
|---|---|
| `clio_activities_list` | List activities, filterable by matter, user, task, type, billing status, date range. |
| `clio_activities_get` | Get a single activity by ID. |
| `clio_activities_create` | Create a time or expense entry. Requires `date` and `type`. |

There is no `clio_activities_update` -- the SDK has no `activities.update()`.

### communications (read-only)

Logged emails and phone calls. **Read-only in the underlying SDK** -- there is no create/update/delete,
by design, since this data routinely contains privileged attorney-client content.

| Tool | Description |
|---|---|
| `clio_communications_list` | List communications, filterable by matter, contact, user, type, date. |
| `clio_communications_get` | Get a single communication by ID. |

### tasks

| Tool | Description |
|---|---|
| `clio_tasks_list` | List tasks, filterable by matter, assignee, status, priority, due date range. |
| `clio_tasks_get` | Get a single task by ID. |
| `clio_tasks_create` | Create a task. Requires `name`, `description`, and an assignee (`assignee_id` + `assignee_type`). |
| `clio_tasks_update` | Update a task. Only the fields you pass are changed. |

### documents (read-only, metadata only)

**Metadata only -- does not return document content.** The underlying SDK deliberately does not
implement document upload/download; documents are the highest-sensitivity object in a legal
practice-management system and content transfer is out of scope pending its own dedicated review.

| Tool | Description |
|---|---|
| `clio_documents_list` | List document metadata, filterable by matter, contact, category, parent folder. |
| `clio_documents_get` | Get metadata for a single document by ID. |

### calendar-entries (read-only)

| Tool | Description |
|---|---|
| `clio_calendar_entries_list` | List calendar entries, filterable by matter, calendar, date range. |
| `clio_calendar_entries_get` | Get a single calendar entry by ID. |

### bills (read-only)

Invoices. Billing/trust-accounting mutations touch regulated funds-handling workflows and are out of
scope for the underlying SDK.

| Tool | Description |
|---|---|
| `clio_bills_list` | List bills, filterable by client, matter, state, type, due/issued date range. |
| `clio_bills_get` | Get a single bill by ID. |

## Architecture

```
src/
├── index.ts          # Entry point -- picks stdio or HTTP transport
├── server.ts          # Server setup, decision-tree tool routing
├── http.ts            # HTTP streaming transport (gateway mode)
├── utils/
│   ├── client.ts       # Credential parsing + ClioClient cache/invalidation
│   ├── logger.ts        # Structured stderr-only logger
│   ├── server-ref.ts     # Shared Server reference for elicitation
│   ├── elicitation.ts     # elicitText / elicitSelection / elicitConfirmation
│   └── types.ts           # DomainHandler interface, shared result helpers
├── domains/            # One file per Clio SDK resource
│   ├── index.ts          # Lazy-loaded domain registry
│   ├── navigation.ts      # clio_navigate / clio_status / clio_back
│   ├── matters.ts
│   ├── contacts.ts
│   ├── activities.ts
│   ├── communications.ts
│   ├── tasks.ts
│   ├── documents.ts
│   ├── calendar-entries.ts
│   └── bills.ts
└── __tests__/
```

Every HTTP request gets a fresh `Server` + `StreamableHTTPServerTransport` pair (stateless, no session
ID) -- the gateway sends separate requests for `initialize`, `tools/list`, and `tools/call`, and a shared
server would reject the second `initialize`. `/mcp` requires a valid `X-Gateway-S2S` proof before any
credential is read. In gateway mode, a request without `X-Clio-Access-Token` is rejected with 401 and
does not fall back to the process environment. Per-request tenant credentials are carried in an
`AsyncLocalStorage` context opened for the duration of that one request, so two concurrent requests
bearing different tenants' tokens can never see each other's credentials.

## Testing

```bash
npm test
```

Tests mock the `@wyre-technology/node-clio` client and the MCP server's `elicitInput` -- no live Clio
credentials are needed. Coverage: every domain's tool-definition shape (valid `inputSchema`, correct
`readOnlyHint` per read vs. mutate), credential header parsing and client cache invalidation,
handler routing/elicitation behavior for representative tools in each domain, and fail-closed HTTP
startup (`CONDUIT_S2S_SECRET`, placeholder rejection, loopback-only dev bypass, gateway 401s).

## License

Apache-2.0. See [LICENSE](./LICENSE).
