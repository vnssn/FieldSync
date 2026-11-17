# FieldSync Architecture (EGM)

## Overview

FieldSync is a JavaScript/JSX ES-module modular monolith with three [npm workspaces](./package.json): React/Vite web, Express API, and portable Zod contracts. M0-M4 implement infrastructure, sessions, teams/assets, versioned templates, offline checklists, human review, private evidence uploads and durable background processing. Human-reviewed AI and final hardening remain M5. See [engineering context](./CONTEXT.md) and [milestone status](./IMPLEMENTATION.md).

## Interface

### Modules and HTTP boundaries

[`createApp`](./apps/server/src/app.js) composes middleware and routes under `/api/v1`. Routes validate requests, services enforce business permissions and transactions, and repositories own parameterized SQL. [`server.js`](./apps/server/src/server.js) owns the HTTP listener, database pool, and shutdown.

| Boundary | Implemented interface | Source |
| --- | --- | --- |
| Web | Auth, dashboard, assets, inspections/detail, templates/team (admin), status; session guards and TanStack Query | [`App`](./apps/web/src/App.jsx), [`AuthProvider`](./apps/web/src/auth.jsx) |
| Offline worker | Dexie drafts/outbox, automatic replay, merge review and sync indicators; existing M2 HTTP endpoints | [`OfflineProvider`](./apps/web/src/offline/provider.jsx), [`WorkerInspections`](./apps/web/src/pages/WorkerInspections.jsx) |
| Health | Public `GET /health`; PostgreSQL and Redis probes; 200 when both succeed, otherwise 503 | [`createHealthCheck`](./apps/server/src/modules/health/service.js), [`createApp`](./apps/server/src/app.js) |
| Auth | Public `POST /auth/register-org`, `POST /auth/login`; authenticated `GET /auth/me`, `POST /auth/logout` | [`createAuthRouter`](./apps/server/src/modules/auth/routes.js) |
| Users | Admin `GET /users`, `POST /users`; creation always provisions a worker | [`createUsersRouter`](./apps/server/src/modules/users/routes.js), [`createUsersService`](./apps/server/src/modules/users/service.js) |
| Assets | Authenticated `GET /assets`, `GET /assets/:id`; admin `POST /assets`, `PATCH /assets/:id`; archival/restoration use PATCH | [`createAssetsRouter`](./apps/server/src/modules/assets/routes.js) |
| Templates | Admin list/detail/create/update/archive, with version checks and audits | [`createTemplatesRouter`](./apps/server/src/modules/templates/routes.js) |
| Inspections | Admin assignment/reassignment/cancellation/review; assigned-worker save/submit; scoped list/detail | [`createInspectionsRouter`](./apps/server/src/modules/inspections/routes.js) |
| Evidence | Assigned-worker reserve/presign/attach/remove; authorized list/download; scoped job status and printable archives | [`createEvidenceRouter`](./apps/server/src/modules/evidence/routes.js), [`createEvidenceService`](./apps/server/src/modules/evidence/service.js) |
| Background worker | Standalone BullMQ runtime; PostgreSQL claims/outcomes, retries, lease recovery and orphan cleanup | [`worker.js`](./apps/server/src/worker.js), [`createJobRuntime`](./apps/server/src/modules/jobs/worker.js) |

Evidence routes mount beneath `/inspections/:id`: `POST /evidence/reserve`, `POST /evidence/:evidenceId/upload`, `POST /evidence`, `POST /evidence/remove`, `GET /evidence`, `GET /evidence/:evidenceId/download`, `GET /jobs` and `GET /archives/:jobId`. Upload descriptors authorize direct multipart POSTs to private MinIO staging; reads pass through the authenticated API. Worker changes require current assignment, editable state and the existing Origin/JSON guard. Membership changes also require mutationId/baseVersion.

### PostgreSQL schema

Identity/assets use the five tables below. IDs are UUIDs except `sessions.id`, a TEXT token digest; timestamps use TIMESTAMPTZ.

| Table | State and principal constraints |
| --- | --- |
| `organizations` | Organization name and creation timestamp; UUID primary key |
| `users` | Organization, name, normalized email, password hash, role; unique `(organization_id, email)` and `(organization_id, id)`; role is `admin` or `worker` |
| `sessions` | Digest primary key, organization/user, expiry; composite FK to `users(organization_id, id)` |
| `assets` | Organization, code/name/category/location, creator, timestamps; unique organization/code and organization/id; `active`/`archived` status; positive INT version defaults to 1; composite creator FK |
| `asset_events` | Organization, asset, actor, event type, timestamp, JSONB before/after changes; composite asset and actor FKs; events are `created`, `updated`, `archived`, `restored` |

[`001_init_auth.up`](./apps/server/migrations/001_init_auth.js) defines identity tables and session user/expiry indexes. [`002_init_assets.up`](./apps/server/migrations/002_init_assets.js) adds directory, history, creator, and actor indexes. Organization deletion cascades to users/assets; user deletion cascades to sessions; asset deletion cascades to events. Creator/actor FKs retain PostgreSQL's default NO ACTION behavior. [`runMigrations`](./apps/server/src/infrastructure/migrations.js) uses transactional, ordered migrations and a separate `pgmigrations` bookkeeping table. Migration execution is an explicit command.

[`003_init_inspections.up`](./apps/server/migrations/003_init_inspections.js) adds `inspection_templates` (versioned JSONB items), `inspections` (asset/template/worker snapshots, answers, narrative, status/version, review/approval), `template_events`, `inspection_events`, `inspection_revisions` and `mutation_receipts`. References include organization_id; revisions are unique by organization/inspection/version, receipts by organization/user/mutationId. Directory, assignment, history and FK indexes support reads. Events/revisions/receipts cascade with their referenced aggregate; inspection asset/template/user references use NO ACTION.

[`004_init_evidence_jobs.up`](./apps/server/migrations/004_init_evidence_jobs.js) adds the inspection's JSONB evidence snapshots and two tables:

| Table | State and principal constraints |
| --- | --- |
| `evidence` | UUID identity; organization/inspection/creator; filename, MIME, bounded INT size and SHA-256; staging/verified keys and expiry; staging/attached/removed membership and pending/ready/failed processing. Composite inspection/creator FKs, unique tenant/key references, and tenant/inspection/evidence prefixes in SQL CHECKs |
| `background_jobs` | Organization/inspection/evidence, kind, dedupe key, JSON payload, queued/running/retry/completed/failed state, attempts, due time, lease token/expiry and result/error. Unique organization/dedupe key; composite evidence FK binds organization, inspection and evidence together; report jobs carry no evidence ID |

Five M4 indexes support inspection/creator evidence reads and due/inspection/evidence job lookups. The jobs table is also the durable publication outbox; there is no second queue-intent table. Migrations remain explicit and transactional.

M3 adds no PostgreSQL migration or batch endpoint. [`OfflineStore`](./apps/web/src/offline/store.js) retains IndexedDB `fieldsync:<organizationId>:<userId>` version 1's `records`, `workingCopies` and ordered `outbox`. M4 adds Dexie version 2's `files` metadata and `blobs` stores without replacing older stores. Attach/remove intents share the same outbox and aggregate base version. File bytes, metadata and intent commit atomically; acknowledgment or confirmed existing remote membership releases local bytes in the same transaction. Original M3 rows without evidence snapshots read through the shared empty-array default.

### Shared Zod contracts

[`@fieldsync/contracts`](./packages/contracts/package.json) exposes its portable schemas and frozen constants through [`src/index.js`](./packages/contracts/src/index.js), with only Zod as a dependency.

- [`auth.js`](./packages/contracts/src/auth.js): registration, login, worker creation, public users/organizations, session responses, and empty requests. Email is trimmed/lowercased; passwords retain whitespace and require 12-128 characters. `authResponseSchema` checks matching organization IDs. `passwordSchema` is a module export omitted from the package barrel.
- [`assets.js`](./packages/contracts/src/assets.js): create/update, metadata, events/changes, detail/list responses, filters, and ID parameters. Metadata is trimmed; list status defaults to `active`; PATCH requires numeric `baseVersion` and an editable field.
- [`health.js`](./packages/contracts/src/health.js): dependency/overall health and stable error envelopes with request UUIDs; overall status must agree with dependency health.
- [`inspections.js`](./packages/contracts/src/inspections.js): template CRUD/snapshots, assignment, checklist answers, versioned save/submit/review/cancellation, and audit/revision responses. Templates contain 1-50 unique items; drafts allow null outcomes; failures need notes before submission.
- [`offline.js`](./packages/contracts/src/offline.js): workspace ownership, cached records, raw local content, working copies, outbox requests and cached public session identity. Reference/owner checks validate IndexedDB reads and writes; existing inspection contracts validate HTTP replay.
- [`evidence.js`](./packages/contracts/src/evidence.js): strict file/reservation/membership, upload descriptor, evidence snapshot, job pointer/result and archive schemas. JPEG/PNG/WebP photos are limited to 10 MiB; MP3/WAV/Ogg/WebM audio to 25 MiB. Offline contracts add owned metadata/Blob rows and attach/remove actions. At most 50 attachments belong to an inspection; the local queued-file budget is 200 MiB.
- [`constants.js`](./packages/contracts/src/constants.js): current roles, asset and inspection states; sync/job constants remain reserved for future workflows.

Object schemas reject unknown keys. Server [`parseRequest`](./apps/server/src/http/errors.js), response serializers, browser forms, and [`apiRequest`](./apps/web/src/api/client.js) consume these contracts. Frontend validation supplements server validation and authorization.

## Invariants

- **Tenant identity:** [`createRequireAuth`](./apps/server/src/modules/auth/middleware.js) derives organization, actor, and role from an unexpired session with tenant-aware joins. Login accepts an organization ID to resolve organization-scoped credentials; authenticated operations use `request.auth`.
- **Isolation:** Tenant-owned tables carry `organization_id`; composite FKs prevent cross-tenant references. [`asset repositories`](./apps/server/src/modules/assets/repository.js) scope queries explicitly; foreign-tenant asset IDs return 404. These migrations implement constraints and application predicates without row-level-security policies.
- **Authorization and sessions:** Admin checks protect team operations and asset writes at route/service boundaries. Passwords use [`Argon2id`](./apps/server/src/modules/auth/passwords.js). [`session helpers`](./apps/server/src/modules/auth/session.js) issue random 32-byte tokens, store SHA-256 digests, and use HttpOnly, SameSite=Lax cookies, Secure in production or HTTPS. [`createOriginGuard`](./apps/server/src/http/security.js) requires the configured Origin and JSON for state-changing requests, including registration/login.
- **Consistency:** [`createAssetsService`](./apps/server/src/modules/assets/service.js) atomically writes assets/events, locks edits, checks versions, increments successful updates, rejects no-op changes, and returns 409 `VERSION_CONFLICT` for stale edits. Detail/history share a read-only repeatable-read [`transaction`](./apps/server/src/infrastructure/transaction.js).
- **Inspection workflow:** [`createInspectionsService`](./apps/server/src/modules/inspections/service.js) uses frozen checklists and the same locking/version rules. Only assigned workers edit; admins review submitted reports, request changes or approve. Approved/cancelled records are read-only. Every change appends revision/audit snapshots atomically.
- **M2 replay safety:** [`mutate`](./apps/server/src/infrastructure/mutations.js) serializes each receipt key, hashes normalized operation/input, and commits the outcome with the aggregate. Current access checks precede replay; version/workflow checks follow it. Changed content with the same ID returns 409 `MUTATION_ID_REUSED`; unexpected failures roll back for retry.
- **Browser isolation:** [`AuthProvider`](./apps/web/src/auth.jsx) cancels queries, removes non-session queries on authentication/logout, and remounts descendants when organization/user/role changes. PostgreSQL dates are explicitly serialized as ISO strings by [`publicAsset`](./apps/server/src/modules/assets/repository.js) and [`publicUser`](./apps/server/src/modules/users/repository.js).
- **Device isolation:** Logout removes active public identity and isolates retained databases. Offline logout records pending server logout; expired sessions keep local work accessible and pause sync. [`sessionLock`](./apps/web/src/offline/session.js) serializes cookie changes and replay identity checks across tabs; `/auth/me` must match the workspace before dispatch.
- **Offline consistency:** [`flushOutbox`](./apps/web/src/offline/sync.js) freezes attempts before dispatch, preserves newer generations on acknowledgment, and pauses conflicted/blocked inspections while others continue. Web Locks exclude duplicate drainers and editors. Three-way merge compares only answers/notes/narrative, rechecks the remote version, and queues a confirmed merge under a new mutationId.
- **Offline UI:** Worker edits display device-saved state after commit; errors retain the input buffer for retry. The shell shows Online/Offline/Syncing/Conflict and pending counts. Reconnect, focus, 15-second interval and debounced edits trigger replay. [`offlineShell`](./apps/web/offline-shell.js) precaches production HTML/static bundles and excludes API/auth responses; cache upgrades preserve IndexedDB.

- **Evidence ownership and immutability:** SQL composite references and `org/<organization>/inspections/<inspection>/<evidence>/staging|verified/<UUID>` keys agree. Storage and cleanup validate exact prefixes. Presigned POST policies constrain key, MIME, hash metadata and exact length for at most ten minutes within a twenty-minute staging reservation. Promotion checks actual size, MIME signature and SHA-256, then writes the verified buffer to a new server-only key with a conditional put. Staging credentials cannot overwrite that object.
- **Evidence transactions and prerequisites:** Promotion happens outside SQL transactions; attachment/removal commits membership, version, revision, audit, receipt and required job together. Rollbacks clean only an unreferenced promoted candidate, retaining staging for retry; removal deletes bytes after commit, with durable cleanup/reconciliation as fallback. Submitted/approved/cancelled membership is read-only; changes_requested permits revision. Submission and approval require ready evidence. Temporary processing errors precede a new receipt, so the same frozen submission retries; permanent failures retain work for removal/review. Processing status never increments business version. Historical revisions retain removed metadata; removed bytes are unavailable.
- **Background delivery:** BullMQ delivers at least once; PostgreSQL dedupe keys and fenced lease-token claims determine outcomes. Handlers retry at most five durable attempts with exponential delays; sixty-second leases refresh every fifteen seconds. Five-second reconciliation republishes lost/due work and settles exhausted crash leases plus failed evidence status. An age-based sweep removes old unreferenced objects, retaining live staging and attached objects. Each deployment owns its schema/bucket; tests use separate buckets. Queue errors are handled and bounded publisher retries leave required work in PostgreSQL during Redis outages.
- **Version-bound archives:** Submission queues deterministic HTML preparation from its saved revision. The handler validates snapshot organization, inspection and source version; output escapes human text and is served through an authorized sandboxed archive route. AI remains disabled/planned.

## Side Effects

[`createAuthService`](./apps/server/src/modules/auth/service.js) transactionally creates organization/admin/session records, rotates the presented same-user session on login, and deletes the current session on logout. Asset operations persist audit events. [`createApp`](./apps/server/src/app.js) emits request IDs, validated errors, and `Cache-Control: no-store` responses; [`createLogger`](./apps/server/src/infrastructure/logger.js) redacts sensitive fields.

[`docker-compose.yml`](./docker-compose.yml) declares PostgreSQL 17, Redis 8, and MinIO with loopback ports and persistent named volumes. [`infra.js`](./scripts/infra.js) starts/stops containers while preserving volumes. [`setupStorage`](./scripts/setup-storage.js) checks/creates/verifies the bucket; [`check-environment.js`](./scripts/check-environment.js) additionally probes MinIO. API health probes PostgreSQL/Redis only. Run `npm run worker` in a separate foreground terminal for evidence verification, cleanup and report archives. MinIO CORS must match APP_ORIGIN; S3_PUBLIC_ENDPOINT is the browser-reachable storage endpoint. API/worker shutdown closes owned storage/pool/queue connections.

## Verification

M4 verification on 2026-11-17 passed `npm run db:migrate`, `npm test` (**80 passed, zero failed/skipped**), `npm run build`, `npm run check:env` and both M3/M4 browser harnesses. [`tests/m4-integration.test.js`](./tests/m4-integration.test.js) adds 23 real PostgreSQL/MinIO cases, with real Redis/BullMQ delivery/recovery and controlled offline-transport/crash faults. [`verify-m4-browser.js`](./scripts/verify-m4-browser.js) exercises actual Dexie upgrades/blobs, photo/audio restart/replay, direct MinIO POSTs, quota rollback, verification-gated submission and merge cleanup. It uses existing local Playwright and the configured local APP_ORIGIN port for CORS; that port must be free. See [IMPLEMENTATION.md](./IMPLEMENTATION.md) for results and cleanup.
