# FieldSync — implementation checklist

## Current status

M0 is complete, verified on 2026-11-15. M1 is complete, verified on 2026-11-16. M2-M5 have not started.

The verification results below were captured against the real local services. Development servers are stopped; do not start background dev servers automatically. Run npm run dev in a foreground terminal only when requested.

## Six milestones

### M0 — Foundation, documentation and local infrastructure
- [x] Verify the npm workspace and pure JavaScript/JSX source.
- [x] Verify shared Zod health schema and role/status constants.
- [x] Verify environment validation and secret-safe Pino logging.
- [x] Verify React/Vite/Tailwind status page build, served assets and /api proxy.
- [x] Verify exactly three Compose services with health checks and named volumes.
- [x] Copy .env.example to .env and install dependencies.
- [x] Start PostgreSQL 17, Redis 8 and the prebuilt MinIO image.
- [x] Create and verify the private fieldsync-dev bucket.
- [x] Run npm run check:env successfully.
- [x] Verify GET /api/v1/health returns 200 with PostgreSQL and Redis up.
- [x] Run meaningful foundation tests and the production web build.
- [x] Record actual Compose state, environment check and API response.

### M1 — Identity, organization isolation and assets
- [x] Registration/login/logout, Argon2id passwords and server-side sessions.
- [x] Admin/Worker authorization and tenant-scoped repositories/foreign keys.
- [x] Admin provisioning of organization workers without email infrastructure.
- [x] Asset creation, editing, archival and history.
- [x] Real PostgreSQL tests for cross-organization access and role enforcement.

### M2 — Online inspections and report review
- [ ] Assignments, fixed inspection form, findings and status transitions.
- [ ] Versioned aggregate saves and immutable revision/audit records.
- [ ] Idempotent mutation receipt service and optimistic locking.
- [ ] Submit, request changes and approve human-editable reports.
- [ ] Deterministic report rendering without an AI dependency.

### M3 — Offline editing and reliable synchronization
- [ ] Dexie schemas, working copies and transactional outbox.
- [ ] Persisted file blobs, quota handling and save-state indicators.
- [ ] Frozen attempted mutations, dependency ordering and safe acknowledgments.
- [ ] Manifest/record pull and idempotent mutation push.
- [ ] HTTP 409 VERSION_CONFLICT with base/local/remote merge.
- [ ] Session/assignment changes, multi-tab coordination and browser-restart tests.
- [ ] PWA application-shell caching and non-destructive local migrations.

### M4 — Presigned evidence uploads and durable background jobs
- [ ] Private staging uploads and server-side verification.
- [ ] Immutable verified evidence and submission upload prerequisites.
- [ ] BullMQ worker backed by durable PostgreSQL jobs/outbox records.
- [ ] Idempotent handlers, leases, retries and reconciliation.
- [ ] Tests for interrupted uploads, duplicate delivery and worker crashes.

### M5 — Human-reviewed AI and final hardening
- [ ] Asynchronous image defect suggestions.
- [ ] Offline recording, transcription and reviewed voice-to-findings.
- [ ] Report narratives tied to source versions and manager review.
- [ ] Provider failures leave manual inspection workflows operational.
- [ ] Keep original model output, provenance and confirmed human data separate.
- [ ] Inspection analytics, security review, restore exercise and deployment guide.
- [ ] Real-browser end-to-end checks and measured performance evidence.

Excluded: email verification/password resets, Mailpit, maintenance_tasks, ZIP recovery export, microservices and Kubernetes.

## First setup

Prerequisites: Node.js >=22.12, npm >=10, Docker Desktop running Linux containers.

From the repository root:

    Copy-Item .env.example .env
    npm install
    npm run infra:up
    npm run db:migrate
    npm run check:env
    npm run dev

infra:up starts exactly three Compose services, waits for readiness, and creates fieldsync-dev through the S3 setup script. It fails if startup or bucket verification fails.

Open http://localhost:5173 and register an organization. The shell exposes its organization sign-in ID; provide this ID with email/password when signing in or provisioning a worker. The protected System Status page calls http://127.0.0.1:3000/api/v1/health through Vite's /api proxy and refreshes while open. APP_ORIGIN must match the browser origin exactly for state-changing requests.

## Commands

    npm run dev                 # React and Express with reload; foreground terminal
    npm run infra:up            # Start infrastructure and ensure bucket
    npm run infra:setup         # Repeat safe bucket initialization
    npm run infra:down          # Remove containers/network; KEEP volumes
    npm run check:env           # Real PostgreSQL, Redis and S3 checks
    npm run db:migrate          # Apply JavaScript PostgreSQL migrations
    npm test                    # 9 foundation + 14 real PostgreSQL M1 tests
    npm run test:m1             # M1 PostgreSQL integration tests only
    npm run build               # Production web build
    docker compose ps           # Container health/state
    docker compose logs -f      # Follow service logs
    docker compose stop         # Stop containers, preserving data
    docker compose start        # Start stopped containers

On Windows, npm.cmd can be used in place of npm if the shell does not run npm.ps1.

Do not use volume deletion as an ordinary reset. Password changes in .env do not automatically update users in an existing PostgreSQL volume.

## Environment

The root .env is loaded explicitly by server/scripts. Vite uses the root env directory but only exposes VITE_-prefixed values to browser code. The frontend makes relative /api requests and never receives database, Redis or S3 credentials.

AI_ENABLED=false is parsed as a Boolean false, not JavaScript's truthy string value.

The local S3 access key/secret must match MinIO's local root settings for M0. These demo-only credentials and loopback bindings must be replaced with deployment-appropriate credentials and TLS before external hosting.

## Port and image choices

Requested ports are the defaults: 3000, 5173, 5432, 6379, 9000 and 9001. No fallback port is selected silently.

PostgreSQL: postgres:17-alpine.
Redis: redis:8-alpine, password authentication, AOF, appendfsync everysec, noeviction.
MinIO: ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z, published prebuilt community image.

The MinIO image includes mc, used for readiness. A JavaScript S3 setup command creates the bucket, so no setup container is added. Published image metadata alone is not proof of a successful local pull/start.

Vite was updated to 8.3.8 with @vitejs/plugin-react 6.3.0. Its bundler resolved the earlier Vite 7 dependency-scanning failure in this restricted Windows session. The configuration uses native JavaScript loading and preserves workspace symlinks. No TypeScript configuration or tooling was added.

node-pg-migrate is pinned to 7.6.1; the tested installation reports zero npm audit vulnerabilities.

## Verification criteria

1. docker compose config --services lists only postgres, redis and minio.
2. All three containers are healthy in docker compose ps.
3. npm run check:env exits 0 and prints status ok, PostgreSQL up, Redis up and MinIO/bucket up.
4. GET /api/v1/health returns HTTP 200 and the real dependency statuses are both up.
5. The same request succeeds through the frontend proxy.
6. A failed dependency produces 503/degraded, never a fabricated healthy result.
7. npm test and npm run build succeed.
8. Source contains no .ts/.tsx/tsconfig files or TypeScript tooling.
9. Review the UI's loading, success, degraded and API-unavailable handling; full browser interaction checks remain in M5.

## M1 actual verification results — 2026-11-16

M1 migrations, tests and the production build passed against real local PostgreSQL on Node.js v22.16.0 and npm 10.9.2. Docker Desktop was started and the existing three Compose services became healthy. No new npm dependencies were needed.

### Migration output

The first npm run db:migrate exited 0:

```text
Can't determine timestamp for 001
Can't determine timestamp for 002
> Migrating files:
> - 001_init_auth
> - 002_init_assets
### MIGRATION 001_init_auth (UP) ###
### MIGRATION 002_init_assets (UP) ###
Applied 2 migration(s).
```

The two timestamp messages are node-pg-migrate 7.6.1 advisories caused by the requested sequential filenames. The library falls back to their numeric prefixes and applies them in order. The filenames remain 001_init_auth.js and 002_init_assets.js as requested. A repeat run exited 0 with No migrations to run! and Database is up to date.

Tables: organizations, users, sessions, assets and asset_events, plus the migration bookkeeping table. Tenant-owned references use composite organization/user or organization/asset foreign keys. Migration execution is transactional.

### Test and build output

```text
npm test
tests 23
pass 23
fail 0
cancelled 0
skipped 0

npm run test:m1
tests 14
pass 14
fail 0
```

The 14 PostgreSQL tests cover registration/login/me/logout, token hashing and rotation, session expiry, Worker restrictions, tenant-scoped listings and asset IDs, four cross-tenant composite-FK failures, asset history/archive/restore, invalid Zod/JSON input, Origin/CSRF checks, duplicate email/code handling, concurrent version conflicts, literal search, transaction rollback on audit/session failure, and migration reruns. Each run uses a fresh schema; cleanup removes only that schema and closes its HTTP listener and pools.

npm run build passed with Vite 8.3.8 (183 transformed modules). The final build produced approximately 638.21 kB JavaScript (189.68 kB gzip) and 22.36 kB CSS (5.08 kB gzip). The existing >500 kB bundle advisory remains non-fatal. Source inspection found no project .ts/.tsx/tsconfig files.

npm run check:env exited 0 with configuration valid, AI disabled, PostgreSQL up, Redis up and the fieldsync-dev MinIO bucket up.

### Browser smoke verification and cleanup

A headless Edge check exercised the built frontend against the real API/PostgreSQL in a separate temporary schema: registration, dashboard, asset creation/edit/archive/history, archive filtering, worker provisioning/login, role-aware navigation, the Team route guard, live system status and logout. It passed with zero page errors. Screenshots were reviewed at 1440px desktop and 390px mobile widths; the mobile asset directory uses cards and has no viewport overflow.

The smoke harness serves built assets and the API on one ephemeral loopback HTTP listener; it does not start Vite or npm run dev. Browser, listener and database pools close in finally, and the temporary schema is dropped. The API suite also exited normally with its listener closed. A final netstat check found no listeners on 3000 or 5173. Infrastructure containers remain available; development/test servers were not left running.

Local-only verification artifacts are ignored under .local/: m1-browser-smoke.js, m1-final-checks.js, m1-assets-desktop.png, m1-assets-mobile.png and m1-asset-history-desktop.png. An earlier diagnostic screenshot, m1-browser-failure.png, is also retained locally. The smoke harness uses the pre-existing local Playwright installation; it is not a new project dependency or a claim that M5's full E2E suite exists. The final database check found both migrations recorded and zero leftover integration/browser test schemas.

### M1 API and frontend surface

All API paths below are under /api/v1. POST/PATCH/DELETE requests require application/json and the configured Origin. Protected paths use fieldsync_sid. All responses prevent HTTP caching.

| Method/path | Access | Response |
| --- | --- | --- |
| POST /auth/register-org | Public, Origin checked | 201 { user, organization } and session cookie |
| POST /auth/login | Public, Origin checked | 200 { user, organization } and rotated session cookie |
| POST /auth/logout | Authenticated | 204 and cleared session cookie |
| GET /auth/me | Authenticated | { user, organization } |
| GET /users | Admin | { users } for the authenticated organization |
| POST /users | Admin | 201 public Worker record |
| GET /assets | Admin/Worker | { assets }; status defaults to active, optional q |
| GET /assets/:id | Admin/Worker | { asset, events } with chronological history |
| POST /assets | Admin | 201 asset, with atomic created event |
| PATCH /assets/:id | Admin | Updated asset, incremented version and atomic event |

Login requires organizationId, email and password. Registration requires organizationName, name, email and password. PATCH requires numeric baseVersion and changed fields from code/name/category/location/status. The server derives organization and actor IDs from the session; unknown body/query fields are rejected.

Frontend routes: /login, /register, / (dashboard), /assets, /assets/:id, /team (Admin), /status. Signup and sign-in share runtime validation with the API. The session query remains subscribed during account transitions; other account query data is discarded and views remount when identity changes.

### Created and updated project files

Paths below are relative to the repository root. The original project was already untracked, so this list records M1 changes relative to the inspected M0 workspace rather than a Git commit.

| Directory | Created files | Updated files |
| --- | --- | --- |
| Root | — | .env.example, package.json, CONTEXT.md, IMPLEMENTATION.md, README.md |
| apps/server | — | package.json |
| apps/server/migrations | 001_init_auth.js, 002_init_assets.js | — |
| apps/server/scripts | migrate.js | — |
| apps/server/src | — | app.js, server.js |
| apps/server/src/config | — | schema.js |
| apps/server/src/http | errors.js, security.js | — |
| apps/server/src/infrastructure | migrations.js, transaction.js | database.js |
| apps/server/src/modules/auth | middleware.js, passwords.js, repository.js, routes.js, service.js, session.js | — |
| apps/server/src/modules/users | repository.js, routes.js, service.js | — |
| apps/server/src/modules/assets | repository.js, routes.js, service.js | — |
| packages/contracts/src | auth.js, assets.js | constants.js, index.js |
| apps/web | — | index.html |
| apps/web/src | auth.jsx, query-client.js | App.jsx, main.jsx, styles.css |
| apps/web/src/api | client.js | — |
| apps/web/src/components | AppShell.jsx, AssetForm.jsx, ui.jsx | — |
| apps/web/src/pages | AuthPage.jsx, DashboardPage.jsx, AssetsPage.jsx, AssetDetailPage.jsx, TeamPage.jsx, SystemStatusPage.jsx | — |
| tests | m1-auth-assets.test.js | — |

## M0 actual verification results — 2026-11-15

Verified on 2026-11-15 with Node.js v22.16.0 and npm 10.9.2.

- npm install completed; the final dependency audit reported 0 vulnerabilities.
- npm test passed all 9 foundation tests, including invalid configuration, inconsistent health data, HTTP 503, and secret-safe error responses.
- npm run build passed with Vite 8.3.8. The approximately 600 kB JavaScript bundle produces a size advisory; this does not fail the build.
- npm run dev started both Express on 3000 and Vite on 5173 successfully during verification. Both have since stopped.
- The frontend HTML, JSX modules and stylesheet returned HTTP 200. The actual health request also returned 200 through the Vite proxy.
- A separate real probe with deliberately incorrect Redis credentials returned HTTP 503, PostgreSQL up and Redis down. No infrastructure settings were changed for that check.
- Repeating npm run infra:setup returned: Private S3 bucket fieldsync-dev: already exists.
- Browser interaction verification was interrupted and is not claimed as passed.

### Docker Compose status

The user ran npm run infra:up and saved docker compose ps to .local/docker-compose-ps.txt because this execution sandbox could not access Docker's Windows named pipe. The captured state is shown below with command/creation columns omitted; all status and port values are from that output.

```text
NAME                  SERVICE    STATUS                  PORTS
fieldsync-minio-1      minio      Up 7 seconds (healthy)  127.0.0.1:9000-9001->9000-9001/tcp
fieldsync-postgres-1   postgres   Up 7 seconds (healthy)  127.0.0.1:5432->5432/tcp
fieldsync-redis-1      redis      Up 7 seconds (healthy)  127.0.0.1:6379->6379/tcp
```

### npm run check:env

Exit code: 0. Captured output:

```json
{
  "status": "ok",
  "node": "v22.16.0",
  "configuration": "valid",
  "aiEnabled": false,
  "postgres": { "status": "up", "latencyMs": 53.9 },
  "redis": { "status": "up", "latencyMs": 45.5 },
  "minio": { "status": "up", "latencyMs": 33.1, "bucket": "fieldsync-dev" }
}
```

### GET /api/v1/health

HTTP 200 from http://127.0.0.1:3000/api/v1/health, with Cache-Control: no-store:

```json
{
  "status": "ok",
  "service": "fieldsync-api",
  "timestamp": "2026-11-15T07:26:30.380Z",
  "uptimeSeconds": 194,
  "dependencies": {
    "postgres": { "status": "up", "latencyMs": 36 },
    "redis": { "status": "up", "latencyMs": 22 }
  }
}
```

The proxy request to http://127.0.0.1:5173/api/v1/health also returned HTTP 200 at 2026-11-15T07:26:30.431Z, with both dependencies up. These are captured verification responses, not a claim that development servers are currently running.

### Restricted-session setup note

This session used NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main' to avoid Node attempting filesystem canonicalization above the accessible workspace. This is a session-specific setting, not a requirement to change Windows permissions. Docker startup was performed in the user's own terminal; no Docker permissions or service exposure were changed.
