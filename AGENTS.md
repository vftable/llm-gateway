# Repository Guidelines

## Project Overview

Multi-provider LLM gateway with an admin dashboard. SQLite-backed providers, models, users, API keys and usage limits. Proxies requests to LLM providers (Anthropic, OpenAI, Google Gemini, DeepSeek, etc.) through a unified gateway that handles format conversion, key rotation, fallback chains, and usage enforcement. Includes a web-tools layer that intercepts Anthropic hosted tools (web_search/web_fetch) and runs them against a local search backend.

Two-component monorepo: a Node.js gateway server (CommonJS, tsc-built) and a React admin SPA (ESM, Vite-built). Communicates via REST + WebSocket on the same port. No project references — each builds independently.

## Architecture & Data Flow

```
src/index.ts (bootstrap)
  → createServerApp() (src/server.ts, Express)
      /api     → admin REST CRUD routes
      /v1      → LLM proxy gateway middleware stack
      /health  → health check
      /        → SPA static fallback
  → ws/ (WebSocket hub for dashboard real-time data)
  → KeySyncService (background key polling)
  → Log pruning timer
```

**Gateway request flow** (`src/gateway/router.ts` → `engine.ts`):
1. Request logger → JSON body parser (100mb) → Client-key auth (Bearer/x-api-key) → Model resolution → Usage quota enforcement + optimistic token reservation
2. `ForwardingEngine` iterates the resolved model's fallback chain (ordered provider links)
3. Per hop: adapter `routeFor()` → endpoint + wire-format conversion plan → adapter `buildFor()` → outbound HTTP request
4. Streaming SSE piped through transform streams; buffered JSON through response transforms
5. Key health tracking (rate-limit cooldowns, auth-failure marking, round-robin selection)

**Web-tools loop** (`src/web-tools/loop.ts`): intercepts Anthropic hosted tool defs, rewrites as ordinary function tools, runs multi-round agent loop against upstream model + SearchProvider backend, emits SSE to client.

**Admin API pattern**: every mutation → `router.reload()` + WS broadcast to subscribed dashboard clients.

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/` | Gateway server source |
| `src/gateway/` | Forwarding engine, model registry, key health, HTTP client |
| `src/providers/` | Provider adapter registry + catalog (17 adapters) |
| `src/providers/base/` | ProviderAdapter abstract class, base types |
| `src/providers/catalog/` | Individual provider adapters (anthropic.ts, openai.ts, deepseek.ts, etc.) |
| `src/types/` | Canonical TypeScript types (shared by backend and web mirror) |
| `src/repo/` | SQLite CRUD layer over better-sqlite3 |
| `src/services/` | Business logic (key import/sync, Anthropic usage parsing) |
| `src/admin/routes/` | Admin REST API route modules |
| `src/ws/` | WebSocket hub for dashboard real-time push |
| `src/web-tools/` | Hosted tool interception + agent loop + SSE |
| `web/` | React SPA admin dashboard |
| `web/src/pages/` | Route pages (dashboard, providers, models, users, etc.) |
| `web/src/components/` | Shared UI components + shadcn/ui primitives |
| `web/src/hooks/` | Custom React hooks (use-ws, use-theme) |
| `docs/` | Comprehensive design docs (provider adapters, transforms, wire types, etc.) |

## Development Commands

```bash
# Dev (gateway + web concurrently)
npm run dev

# Dev individually
npm run dev:gateway   # tsx watch src/index.ts
npm run dev:web       # vite (port 5173, proxies /api /v1 /ws to :8787)

# Build all
npm run build

# Build individually
npm run build:gateway   # tsc -p tsconfig.build.json
npm run build:web       # tsc --noEmit && vite build

# Start production
npm start   # node dist/index.js

# Type-check
npm run typecheck        # root only
npm run typecheck:web    # web only
npm run typecheck:all    # both

# Test
npm test   # tsx --test "src/**/*.test.ts"
```

## Code Conventions & Common Patterns

### Formatting & Naming
- **Language**: TypeScript, strict mode, ES2022 target
- **Modules**: CommonJS (`src/`), ESNext (`web/`)
- **Imports**: No index imports for deep modules — prefer direct file imports. Barrel files used at module boundaries (`src/types/index.ts`, `src/providers/index.ts`)
- **Naming**: camelCase for variables/functions, PascalCase for types/components, kebab-case for files. Repo row interfaces use snake_case → camelCase mapping.
- **No semicolons** enforced (project has no linter config — follow existing style)

### Error Handling
- Structured JSON error envelopes: `{ error: { type: string, message: string } }`
- Shared `bad(res, err, code)` helper in `src/admin/routes/respond.ts`
- Engine-level catch-all per attempt — never throws to Express
- Gateway routes use try/catch wrapping each attempt in the fallback chain

### Async Patterns
- `async/await` throughout for I/O
- `better-sqlite3` is **synchronous** — no async DB calls
- Node `stream.pipeline` for SSE streaming
- Transform streams for streaming format conversion
- `unref()` on timers to not block process shutdown

### Provider Adapter Pattern
Two-phase contract:
1. `routeFor(clientFmt, provider, endpoint, model)` → `EndpointRoute` (what format + which path)
2. `buildFor(kind, ctx)` → `BuiltRequest` (URL, headers, body)

Adapters extend `ProviderAdapter`, `OpenAICompatibleAdapter`, or `AnthropicCompatibleAdapter`. Override `chatCompletions`/`messages`/`responses` for bespoke behavior. Registered in `src/providers/registry.ts` as an in-code array — no dynamic discovery.

### Repository Layer
- Each module in `src/repo/` exports stateless functions taking a `db: Database` parameter
- Row mapping from snake_case SQL to camelCase TS at the boundary
- Batch ops wrapped in `db.transaction()` for atomicity
- Safe JSON helpers: `parseJsonObject` / `parseJsonArray` with fallback + type guard (`src/repo/json.ts`)

### Dependency Injection
**None.** No DI container. Modules import the DB directly and call prepared statements. Services are stateless exports or small classes (e.g., `KeySyncService`). Tests use in-memory DBs (`new Database(":memory:")`).

### State Management (Web)
- No Redux/Zustand. Pages fetch own data on mount via `api.*` or subscribe via WebSocket
- `WsProvider` context at root for the WS connection; `useWsSubscription(topic)` hook per page
- Auth token stored in `localStorage` key `gw_admin_token` as a Bearer header

### Configuration
- Single `config.json` (copy of `config.example.json`). No environment variables.
- Bootstrap values (port, paths, admin password) + seed data (upstream provider, models, API keys)
- Seed data hashed/diffed on boot; changes sync to SQLite via `src/db/sync.ts`
- Runtime state lives entirely in the SQLite DB, managed via admin dashboard

## Important Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — bootstraps config, DB, server, WS hub, background timers |
| `src/server.ts` | Express app assembly (middleware, route mounting, error handlers) |
| `src/config.ts` | Config file loader (`config.json`) |
| `src/gateway/engine.ts` | Core forwarding engine (2297 lines) |
| `src/gateway/router.ts` | Gateway /v1 middleware stack |
| `src/gateway/registry.ts` | ModelRegistry — DB-driven model resolution with caching |
| `src/gateway/key-health.ts` | KeyHealthStore — key health tracking + round-robin |
| `src/providers/registry.ts` | Provider adapter array + resolution |
| `src/providers/base/adapter.ts` | ProviderAdapter abstract class |
| `src/ws/hub.ts` | WebSocket hub (subscriptions, push, heartbeat) |
| `src/web-tools/loop.ts` | Multi-round agent loop for hosted tool interception |
| `config.example.json` | Configuration template |
| `web/src/main.tsx` | Frontend entry point |
| `web/src/app.tsx` | Route definitions |
| `web/src/lib/api.ts` | Fetch-based REST API client |
| `web/src/hooks/use-ws.tsx` | WebSocket client hook |

## Runtime / Tooling Preferences

- **Runtime**: Node.js >= 18
- **Package manager**: npm (use `npm` for all commands; no yarn/pnpm)
- **TypeScript**: ^6.0.3 (root), ^5.5.4 (web — Vite constraint)
- **Dev runner**: `tsx` (TypeScript execution, no build step needed for dev/test)
- **Frontend build**: Vite 5 + Tailwind CSS v4 + shadcn/ui New York style
- **Database**: SQLite via better-sqlite3 (synchronous, no ORM)
- **No linter/formatter** configured — follow existing code style
- **Sensitive config** (`config.json`) is gitignored; keep credentials out of the repo

## Testing & QA

### Test Framework
- **Node built-in test runner**: `node:test` + `node:assert/strict`
- Run with: `npm test` (`tsx --test "src/**/*.test.ts"`)
- No Jest, no Mocha, no test framework dependencies

### Test Patterns
- **In-memory SQLite**: `new Database(":memory:")` for isolated repo tests
- **Exact-value assertions**: `assert.strictEqual(got, expected)` — no snapshot testing
- **Edge case coverage**: null/undefined inputs, malformed JSON, empty arrays, boundary values (e.g., `0`, `0.5M` rounding guard in `fmtCompact`)
- **File pattern**: test files co-located with source (`foo.ts` → `foo.test.ts`)
- **Transactional isolation**: batch operations tested for atomicity (rollback on failure)

### Test Files

| File | Tests |
|------|-------|
| `src/utils.test.ts` | `fmtCompact` token formatting |
| `src/repo/providers.test.ts` | Provider CRUD, path normalization |
| `src/repo/provider-keys.test.ts` | Key CRUD, batch atomicity, dedup |
| `src/repo/models.test.ts` | Model link batch atomicity |
| `src/repo/provider-models.test.ts` | Upsert, JSON round-trip |
| `src/repo/request-logs.test.ts` | Log round-trip, null attribution |
| `src/repo/provider-key-usage.test.ts` | Unified usage snapshot, 7d_oi preservation |
| `src/repo/json.test.ts` | Safe JSON helpers |
| `src/services/key-import.test.ts` | Key parsing + reconcile modes |
| `src/services/anthropic/unified-usage.test.ts` | Header parsing, utilization clamping |
| `src/services/anthropic/rate-limit-scope.test.ts` | Scope classification, Fable/Mythos detection |
| `src/services/anthropic/usage-credits.test.ts` | Claude Code credits error detection |
| `src/gateway/engine.test.ts` | Engine forwarding (integration) |
| `src/providers/builder.test.ts` | Provider builder |
| `src/providers/catalog/openai.test.ts` | OpenAI adapter specifics |
| `src/providers/auth-headers.test.ts` | Auth header generation |
| `src/providers/schema.test.ts` | Schema validation |
| `src/providers/test-model.test.ts` | Model testing |
| `src/providers/test-provider.test.ts` | Provider testing |
| `src/providers/models.test.ts` | Provider models |
| `src/providers/paths.test.ts` | URL path utilities |
| `src/providers/usage.test.ts` | Provider usage |
| `src/providers/catalog.test.ts` | Catalog resolution |
| `src/web-tools/tool-ops.test.ts` | Tool operations |
| `src/gateway/engine-support/response-headers.test.ts` | Response header handling |

### No web frontend tests
The web app has no test files — UI testing is not yet established in this project.
