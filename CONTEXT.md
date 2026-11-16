# FieldSync — persistent engineering context

Read this file and IMPLEMENTATION.md before making changes. The user's latest instructions override this document; update both documents when accepted decisions change.

## Product and current scope

FieldSync is an offline-first field inspection application, implemented as a JavaScript modular monolith. Organizations manage assets and assign inspections to workers. Workers capture findings and photographs offline, then synchronize. Managers review and approve submitted reports.

The three planned AI features are image defect suggestions, voice-to-findings, and report narratives. Each requires explicit human review. AI_ENABLED defaults to false, and the manual inspection workflow must work without an AI service.

The accepted simplifications are:
- No email verification or password reset flows; no Mailpit or email infrastructure.
- No maintenance_tasks module.
- No ZIP recovery exports.
- No microservices, Kubernetes, chatbot, or AI-centered product redesign.

M0 and M1 are complete. M0 provides infrastructure and a live status page. M1 adds organization registration, authentication, tenant isolation, admin worker provisioning, and an asset directory with version-checked edits and transactional audit history. Inspection storage, offline saving, synchronization, job workers, and AI remain unimplemented. Never present planned behavior as implemented.

## Non-negotiable invariants

### JavaScript and runtime contracts
- Use .js for backend, shared modules, scripts and configuration; .jsx for React.
- Do not create .ts, .tsx or tsconfig files or add TypeScript tooling.
- Use ES modules with type: module. All relative backend imports include .js.
- Use Zod at environment, API, provider response, job payload and Dexie/synchronization boundaries.
- packages/contracts contains only portable JavaScript schemas/constants and has zero server, database or secret imports.
- Frontend validation improves feedback; backend validation and authorization remain mandatory.
- Convert database dates and numeric values explicitly; never silently round PostgreSQL bigint values.

### Organization isolation and authorization
- Every organization-owned entity has organization_id.
- Read and write queries scope to the authenticated organization.
- Obtain tenant and actor identity from the server session, never a client body.
- Use composite foreign keys including organization_id for organization-owned references.
- Roles are admin and worker. Only assigned workers edit editable inspection content.
- Managers administer assets/assignments and review reports; approved inspection evidence is immutable.
- Authentication uses Argon2id, HttpOnly SameSite=Lax session cookies, an exact Origin/JSON CSRF guard and server-side authorization. Cookies are Secure in production or with an HTTPS application origin; plain HTTP cookies are for local development only.

### Offline-first editing
- Dexie/IndexedDB is authoritative for unsynchronized edits; PostgreSQL is authoritative for acknowledged shared state.
- Save the working copy and pending outbox intent in one Dexie transaction.
- Display saved on this device only after that transaction commits.
- Once attempted, a mutation's ID, payload and base version are immutable.
- Preserve newer edits when acknowledging an older in-flight request.
- A failed sync, expired session, cancellation or reassignment must not delete pending local work.
- Prevent two tabs from concurrently draining one workspace queue or editing the same working copy.
- Browser storage cannot guarantee survival of device loss or deliberate site-data deletion. Handle quota/persistence errors visibly; ZIP export is not in scope.

### Idempotency and conflicts
- Each mutation has a stable client-generated UUID mutationId.
- Store its normalized request hash and outcome in a durable PostgreSQL receipt unique to organization, user and mutationId.
- A replay with identical content returns the stored outcome. Different content with the same ID is rejected.
- Apply the mutation, version increment, revision, audit event and successful receipt atomically.
- Current access checks still apply to replays; check an existing receipt before reapplying mutable workflow-state checks.
- Each editable inspection is an optimistic-locking aggregate, including its findings and attachment membership.
- A stale baseVersion returns HTTP 409 with code VERSION_CONFLICT; there is no last-write-wins.
- Resolve with a three-way comparison of base, local and remote records. A confirmed merge receives a new mutationId and current baseVersion.
- Server-controlled assignment, status and approval fields cannot be overwritten by merge choices.

### Evidence and background work
- File bytes live in private S3-compatible storage, with metadata and ownership in PostgreSQL.
- Upload with short-lived, constrained presigned requests into staging; verify size, signature, checksum and ownership.
- Promote verified files to immutable server-controlled objects. Staging credentials must not overwrite verified evidence.
- File processing status does not increment the inspection's business version; changing attachment membership does.
- Keep database transactions short and never hold them around external storage/AI calls.
- BullMQ schedules background work; PostgreSQL jobs/outbox records preserve required work and its outcome.
- Queue delivery is at least once. Use idempotent handlers, leases and reconciliation; do not claim exactly-once external execution.

### Human-reviewed AI
- Keep original AI results separate from human-confirmed findings/report text.
- Applying suggestions is an authenticated, authorized, version-checked human action.
- Preserve original output and provenance; reject stale report results.
- Provider outages must not block manual inspection work.
- Never present test fixtures or mocks as actual analysis, or predict failure accurately without suitable data.

## Repository structure

    apps/web/
      src/App.jsx
      src/api/health.js
      src/api/client.js
      src/auth.jsx
      src/query-client.js
      src/components/
      src/pages/
      src/main.jsx
      src/styles.css
      vite.config.js
    apps/server/
      src/app.js
      src/server.js
      src/config/
      src/infrastructure/
      src/modules/health/
      src/modules/auth/
      src/modules/users/
      src/modules/assets/
      src/http/
      migrations/001_init_auth.js
      migrations/002_init_assets.js
      scripts/migrate.js
    packages/contracts/src/
      constants.js
      health.js
      auth.js
      assets.js
      index.js
    scripts/
      infra.js
      setup-storage.js
      check-environment.js
    tests/
    docker-compose.yml
    .env.example
    CONTEXT.md
    IMPLEMENTATION.md

Add future feature modules when their milestone begins, rather than creating empty architectures.

## Layering and coding conventions

HTTP routes validate requests and call business services. Services enforce permissions, state transitions and transaction boundaries. Repositories own raw parameterized SQL. Worker handlers reuse services where appropriate.

React's worker editor will read local working copies through Dexie. TanStack Query is for online queries and polling; it must not become a competing draft store.

Use named exports, small focused modules, descriptive names and brief comments explaining invariants. Use database constraints alongside application checks. Return stable error codes and request IDs. Redact secrets and evidence from logs.

No secrets are exposed through VITE_ variables or included in bundles. Do not blindly serialize configuration into responses or logs.

## M0 infrastructure and contract

Exactly three Compose services: postgres (PostgreSQL 17), redis (Redis 8, password auth, AOF and noeviction), and minio (prebuilt MinIO). Every published infrastructure port binds to 127.0.0.1. Named volumes survive infra:down.

The bucket is created by a JavaScript setup command using the S3 API; there is no fourth Compose service. Bucket creation is idempotent and a credentials error is not treated as a missing bucket.

Default ports: API 3000, web 5173, PostgreSQL 5432, Redis 6379, S3 API 9000 and MinIO console 9001. Host npm processes use loopback addresses; future containers use service DNS names.

The storage image is ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z, a prebuilt community image from official MinIO source. Its image contains mc; its runtime must not be assumed to contain curl. Image source: https://github.com/coollabsio/minio

Local development uses documented local-only credentials. Restrict storage/database service identities and configure TLS before an external deployment. These local defaults are not production credentials.

GET /api/v1/health returns a validated HealthResponseSchema:
- service: fieldsync-api
- status: ok or degraded
- timestamp: ISO UTC datetime
- uptimeSeconds: nonnegative integer
- dependencies.postgres and dependencies.redis: status up/down, measured latencyMs
Return 200 only when both actual probes succeed, otherwise 503. Responses are not cached. Public responses contain no credentials or raw connection errors.

Health probes SELECT a parameterized integer from PostgreSQL and authenticate/PING Redis. check:env additionally verifies the named S3 bucket. M0 requires Redis in health as requested; this is not a promise that future inspection writes require Redis to be available.

## M1 identity and assets contract

- Run npm run db:migrate explicitly before using authentication/assets. Migrations are JavaScript ES modules run through node-pg-migrate; application startup does not migrate automatically.
- Organization registration accepts organizationName, name, email and password. Login accepts organizationId, email and password because email uniqueness is per organization. Emails are trimmed/lowercased; passwords are 12–128 characters.
- Registration creates the organization, admin and session in one transaction. Password hashing uses Argon2id outside SQL transactions (19,456 KiB memory, two iterations, one lane).
- The fieldsync_sid cookie contains a random 32-byte opaque token. PostgreSQL sessions.id stores its SHA-256 digest. SESSION_TTL_HOURS defaults to 168, and expired sessions are rejected. Login rotates the presented session for the same user; logout deletes the current session.
- The session-token lookup is the identity bootstrap. Its joins include organization_id; subsequent tenant identity and actor identity come only from req.auth. Request bodies cannot choose organization, creator, or role. Admins can provision workers; workers can read assets/history but cannot modify them or access the team API.
- State-changing API requests must include the exact configured APP_ORIGIN origin and application/json. Missing/null/foreign origins fail closed, including login and registration. Use the documented localhost:5173 frontend address when APP_ORIGIN has that value.
- Assets have active/archived status, organization-unique codes and composite tenant foreign keys. PATCH requires baseVersion plus at least one editable field. A row lock and conditional version update prevent stale overwrites; HTTP 409 VERSION_CONFLICT requires reloading and reviewing the latest asset. Empty/no-op changes return 400.
- Asset creation and every metadata/status update write their audit event in the same transaction. Status changes use archived/restored events; other edits use updated. History is chronological and contains actor identity and field-level before/after values. Detail reads use a consistent read-only transaction.
- GET /assets defaults to status=active, supports active/archived/all and literal case-insensitive q search across code/name/category/location. Search wildcards are escaped and all request values are SQL parameters.
- Browser routes: /login, /register, / (dashboard), /assets, /assets/:id, /team (admin), /status. The shell shows user/organization/role, logout and the organization ID needed for sign-in. Account switches discard prior account query data and remount views; the active session query remains subscribed.
- M1 is an online workflow. Inspection aggregate mutation receipts, Dexie and offline behavior remain in M2/M3.
- tests/m1-auth-assets.test.js uses a random isolated PostgreSQL schema, the real migrations and an ephemeral HTTP listener; its after hook closes the listener/pools and drops only that generated schema. PostgreSQL must be available, with permission to create/drop test schemas. Never truncate application tables for tests.

## Verification and change discipline

Run relevant tests, build the web client, and record actual live verification in IMPLEMENTATION.md. Never mark a live infrastructure check passed based on code inspection, mocks, or an image's published listing.

Do not proceed into M2-M5 unless requested. Keep the checklist accurate when an environment blocker prevents a required check. Never leave temporary test servers or development servers running after verification.
