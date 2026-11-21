# FieldSync: Interview and Project Viva Study Guide

Source snapshot: M0-M5, refreshed on 2026-11-18 for the single-service Render free-tier configuration and R2-compatible evidence PUT uploads. Final verification is recorded in [IMPLEMENTATION.md](./IMPLEMENTATION.md). Read this alongside [EGM.md](./EGM.md) and [CONTEXT.md](./CONTEXT.md). Paths below are relative to the repository root; function names identify actual implementations rather than hypothetical components. Render deployment remains gated on the user's active-account switch and approval.

Three corrections to remember before an interview:

- Passwords use **Argon2id**, not scrypt. SHA-256 is used separately for session-token digests and mutation-request fingerprints.
- There is no PostgreSQL table named `audit_events`. The actual audit tables are `asset_events`, `template_events`, and `inspection_events`; full inspection snapshots live in `inspection_revisions`.
- Real PostgreSQL/MinIO/Redis/BullMQ and browser tests coexist with pure tests using an in-memory store and injected transports. Provider contract success/failure is simulated by a local HTTP server; no paid model call or model accuracy is claimed. Evidence, reviewed AI, voice recording and analytics are implemented.

## Contents

1. [60-Second Elevator Pitch & System Overview](#1-60-second-elevator-pitch--system-overview)
2. [Database Schema & Multi-Tenancy Deep Dive](#2-database-schema--multi-tenancy-deep-dive)
3. [Distributed Systems, Concurrency & Idempotency](#3-distributed-systems-concurrency--idempotency)
4. [Offline-First Architecture & Sync Engine](#4-offline-first-architecture--sync-engine-m3-m4)
5. [Security, Authentication & Validation](#5-security-authentication--validation)
6. [Testing Strategy & Engineering Trade-offs](#6-testing-strategy--engineering-trade-offs)
7. [Top 25 Interview & Viva Questions](#7-top-25-likely-interview--viva-questions)

## 1. 60-Second Elevator Pitch & System Overview

### 1.1 A pitch to say aloud

> FieldSync helps organizations inspect equipment when field connectivity is unreliable. Admins manage assets and versioned checklists, assign workers and review submitted reports. Workers retain checklists, photos and voice recordings offline in Dexie with an ordered outbox. Stable mutation IDs and base versions let PostgreSQL commit content, audits, revisions, receipts and job intent together. Evidence uploads into private MinIO staging, is verified and becomes immutable. BullMQ schedules verification, cleanup, report archives and optional AI assistance using SQL-backed retries and leases. AI originals remain separate until a worker edits and explicitly confirms a current-source suggestion; missing providers return labeled fallbacks. Managers still approve reports. Tenant sessions, composite FKs and storage prefixes enforce ownership, while analytics describe accessible inspections and assets. M0-M5 are implemented in a JavaScript modular monolith; local recovery and deployment readiness are verified separately from any cloud deployment.

### 1.2 Users, problem, and implemented scope

| User | Responsibilities | Authority boundary |
| --- | --- | --- |
| Admin | Register the organization, provision workers, maintain assets/templates, assign/reassign/cancel inspections, approve or request changes | Organization-scoped administration; cannot use worker save/submit endpoints to rewrite inspection content |
| Worker | Read organization assets; list/read their assignments; save answers/notes/narrative; submit complete checklists | Only the currently assigned worker edits content, and only in editable workflow states |

The difficult problem is preserving intent across unreliable networks and concurrent administrative changes. A local save, a server commit, a received HTTP response, and an admin approval are different events. FieldSync makes these distinctions visible and gives each a separate persistence or validation mechanism.

Current findings are failed-check notes and `reportText`, without a separate findings table. M3 persists checklist/narrative data; M4 adds photo/audio blobs, upload ordering and evidence membership; M5 adds native voice recording and human-reviewed AI originals/provenance. AI request/review, analytics and administrative operations remain online. Reports use React printing and version-bound background HTML archives, including reviewed assistance provenance. Generated PDFs are not implemented. AI image/voice fallbacks invent no observations/transcripts; report fallback summarizes existing recorded data.

### 1.3 Architecture diagram

```text
                         THREE NPM WORKSPACES
                +-------------------------------------+
                | packages/contracts                  |
                | Portable JS + shared Zod schemas    |
                | API, identity, inspection, local DB |
                +-------------+-----------------------+
                      imports | imports
                 +------------+----------------------+
                 v                                   v
  +----------------------------------+    +-------------------------------+
  | apps/web: React / Vite            |    | apps/server: Express 5 API     |
  |                                  |    | /api/v1                       |
  | Admin: TanStack Query + forms     |    |                               |
  | Worker: local input buffer       |    | Routes: parse requests        |
  |       -> Dexie / IndexedDB       |--->| Services: access + workflow   |
  |          workingCopies + outbox  |HTTP| Repositories: parameter SQL   |
  |       -> in-page auto-sync       |<---| Transactions + durable receipt|
  |                                  |    +------------+------------------+
  | Service Worker / Cache Storage   |                 |
  | HTML + JS + CSS + favicon only   |                 | current queries
  | No auth/API response caching    |                 v
  +----------------------------------+    +-------------------------------+
                                           | PostgreSQL 17                |
                                           | sessions / tenant entities   |
                                           | snapshots / audits / receipts|
                                           +-------------------------------+

        Current infrastructure / tooling          Current M4-M5 runtime
  +------------------------------+          +-------------------------------+
  | Redis 8                      |<---------| BullMQ jobs / retry scheduling |
  | Current API health: PING     |          | Durable PostgreSQL job intent |
  | AOF + noeviction             |          +-------------------------------+
  +------------------------------+
  +------------------------------+          +-------------------------------+
  | MinIO / S3-compatible bucket |<---------| Evidence staging / verification|
  | Current setup + HeadBucket  |          | Immutable verified objects     |
  | Direct signed PUT uploads   |          +-------------------------------+
  +------------------------------+

  HTTP/SQL/storage/queue paths shown here are implemented through M5.
  AI jobs use optional Groq report drafting or OpenAI evidence/report assistance; human review applies current results.
  AI originals/reviews and scoped analytics use the same tenant database.
  Redis is also probed by the current API; MinIO is checked by setup/check:env.
```

`docker-compose.yml` runs exactly PostgreSQL, Redis and MinIO, with loopback published ports and named persistent volumes. Sessions live in PostgreSQL. Checklist saves/submissions use SQL, including durable required-job intent. Evidence promotion/download performs MinIO calls outside SQL transactions; the separate BullMQ runtime connects to Redis. These infrastructure services do not make the business modules microservices.

### 1.4 Why three workspaces and a modular monolith?

Root `package.json` declares `apps/web`, `apps/server`, and `packages/contracts`; all use ES modules. The server is one API deployment with feature modules rather than independently deployed business services. The frontend can be served as static assets, but that does not make each feature a separate service.

| Workspace / layer | Actual source entry points | Purpose |
| --- | --- | --- |
| Shared contracts | `packages/contracts/src/index.js`; `auth.js`, `assets.js`, `inspections.js`, `offline.js`, `evidence.js`, `ai.js`, `analytics.js`, `health.js`, `constants.js` | Browser/server/local-store/job agreement at runtime; only Zod is a package dependency |
| Express composition | `apps/server/src/app.js`, `apps/server/src/server.js` | Middleware/router composition versus listener/pool/shutdown ownership |
| Feature routers | `apps/server/src/modules/{auth,users,assets,templates,inspections,evidence,ai,analytics}/routes.js` | HTTP shape, status codes, authentication/role guards |
| Business services | Corresponding `service.js` files | Access checks, state transitions, optimistic version checks, transaction orchestration |
| Repositories | Corresponding `repository.js` files | Explicit tenant predicates, parameterized SQL, response serialization |
| Shared infrastructure | `apps/server/src/infrastructure/{transaction,mutations,audit,database,migrations}.js` | Transaction boundaries, replay protocol, audit operations, pool and migration configuration |
| Web composition | `apps/web/src/main.jsx`, `App.jsx`, `auth.jsx`, `query-client.js` | Providers, role/session guards, routing, online query behavior |
| Offline worker | `apps/web/src/offline/{state,store,sync,session,evidence}.js`, `provider.jsx`; `apps/web/src/pages/WorkerInspections.jsx` | Local transitions/blobs, upload replay, identity coordination, worker UI |
| Background runtime | `apps/server/src/server.js`, `src/worker.js`, `modules/jobs/{repository,worker}.js`, `infrastructure/storage.js` | Inline or standalone BullMQ runtime, durable job insertion, fenced claims/outcomes, Redis scheduling, storage verification/cleanup and HTML archives |
| Assistance / analytics | `modules/ai/{provider,repository,service,routes}.js`, `modules/analytics/{service,routes}.js`; web `ai-ui.jsx`, `VoiceRecorder.jsx`, `DashboardPage.jsx` | Source-bound suggestions, explicit reviews, offline audio capture and tenant/assignment-scoped aggregates |
| Deployment / recovery | `render.yaml`, `docs/{DEPLOYMENT,SECURITY,BACKUP_RESTORE}.md` | Local hosting blueprint, secret/network policy, recovery procedure and mandatory Render account-switch gate |

The design keeps cross-table inspection updates inside one PostgreSQL transaction, avoids network boundaries between business modules, and shares validation without duplicating schema definitions. The cost is a shared API deployment and database: modules cannot scale or release independently, and changes still need integration testing.

### 1.5 Trace a request through the code

For `PATCH /api/v1/inspections/:id`:

1. `app.js` applies Helmet, request logging/UUIDs, `Cache-Control: no-store`, the Origin/JSON guard, and the bounded JSON parser.
2. `modules/inspections/routes.js` authenticates, requires `worker`, validates empty query parameters, parses the UUID path and `saveInspectionSchema` body.
3. `createInspectionsService().save()` delegates to `change()` and `mutate()`.
4. The service/repository locks and loads the tenant-scoped inspection, verifies current assignment, then processes receipt replay or checks version/workflow.
5. Repository update, revision, audit, and receipt use the same transaction client.
6. The router returns an `inspectionSchema`-validated response; the browser's `apiRequest()` validates it again before local acknowledgment.

The core API includes `/auth/register-org`, `/auth/login`, `/auth/me`, `/auth/logout`, `/users`, `/assets`, `/templates`, and `/inspections`. Inspection actions are `/:id/submit`, `/:id/assignment`, `/:id/cancel`, and `/:id/review`; save is PATCH on `/:id`. There is no batch sync endpoint.

## 2. Database Schema & Multi-Tenancy Deep Dive

### 2.1 Reading the schema correctly

The complete application schema below comes from:

- `apps/server/migrations/001_init_auth.js`
- `apps/server/migrations/002_init_assets.js`
- `apps/server/migrations/003_init_inspections.js`
- `apps/server/migrations/004_init_evidence_jobs.js`
- `apps/server/migrations/005_init_ai_analytics.js`

There are **fifteen application tables**. `pgmigrations` is a separate node-pg-migrate bookkeeping table, configured in `apps/server/src/infrastructure/migrations.js`; it is not a business table declared by these five migrations.

In the column inventories, **NN** means `NOT NULL`. Every primary-key column is also implicitly NN. A dash in the default column means no declared SQL default. UUIDs are supplied by application `randomUUID()`, not generated by a PostgreSQL UUID default. `INT` is PostgreSQL's 32-bit integer. Unspecified foreign-key update/delete actions use PostgreSQL's default `NO ACTION`; composite FKs use default `MATCH SIMPLE` and are not declared deferrable.

#### `organizations` — migration 001

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Organization identity |
| `name` | TEXT, NN | — | Organization name |
| `created_at` | TIMESTAMPTZ, NN | `now()` | Creation time |

Constraint/index: primary key `organizations_pkey(id)`. No separate explicit index or SQL name-length check.

#### `users` — migration 001

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | User identity |
| `organization_id` | UUID, NN | — | Owner organization |
| `name` | TEXT, NN | — | Display name |
| `email` | TEXT, NN | — | Tenant-qualified normalized email |
| `password_hash` | TEXT, NN | — | Encoded Argon2id hash, parameters, and salt |
| `role` | TEXT, NN | — | `admin` or `worker` |
| `created_at` | TIMESTAMPTZ, NN | `now()` | Creation time |

Constraints: PK `id`; FK `organization_id -> organizations(id) ON DELETE CASCADE`; UNIQUE `(organization_id, id)`; UNIQUE `(organization_id, email)`; CHECK `role IN ('admin','worker')`; CHECK `email = lower(btrim(email))`. There is no global email uniqueness and no SQL password-length check.

Implicit unique indexes: `users_pkey`, `users_organization_id_id_key`, `users_organization_id_email_key`. The tenant/ID unique key is required as the target of composite foreign keys even though `id` is globally unique.

#### `sessions` — migration 001

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | TEXT, PK | — | SHA-256 digest of the opaque cookie token |
| `user_id` | UUID, NN | — | Authenticated user |
| `organization_id` | UUID, NN | — | Session organization |
| `expires_at` | TIMESTAMPTZ, NN | — | Server-enforced expiry |
| `created_at` | TIMESTAMPTZ, NN | `now()` | Creation time |

Constraints: PK `id`; composite FK `(organization_id, user_id) -> users(organization_id, id) ON DELETE CASCADE`. Expiry is checked by the authentication query, not a CHECK requiring future timestamps. No SQL regex enforces the digest format.

Indexes: implicit `sessions_pkey`; explicit `sessions_user_idx(organization_id, user_id)` and `sessions_expiry_idx(expires_at)`.

#### `assets` — migration 002

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Asset identity |
| `organization_id` | UUID, NN | — | Owner organization |
| `code` | TEXT, NN | — | Organization-unique code |
| `name` | TEXT, NN | — | Display name |
| `category` | TEXT, NN | — | Category |
| `location` | TEXT, NN | — | Location |
| `status` | TEXT, NN | `'active'` | `active` or `archived` |
| `version` | INT, NN | `1` | Optimistic aggregate version |
| `created_by` | UUID, NN | — | Creator |
| `created_at` | TIMESTAMPTZ, NN | `now()` | Creation time |
| `updated_at` | TIMESTAMPTZ, NN | `now()` | Last mutation time |

Constraints: PK `id`; organization FK with `ON DELETE CASCADE`; UNIQUE `(organization_id, id)`; UNIQUE `(organization_id, code)`; composite creator FK `(organization_id, created_by) -> users(organization_id, id)`; CHECK status in `active/archived`; CHECK `version > 0`.

Implicit indexes: `assets_pkey`, `assets_organization_id_id_key`, `assets_organization_id_code_key`. Explicit indexes: `assets_directory_idx(organization_id, status, code)`; `assets_creator_idx(organization_id, created_by)`.

Archival is a versioned PATCH, not a row DELETE. The SQL TEXT columns do not have the nonempty/length constraints of the Zod API schema.

#### `asset_events` — migration 002

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Audit event identity |
| `organization_id` | UUID, NN | — | Owner organization |
| `asset_id` | UUID, NN | — | Audited asset |
| `actor_user_id` | UUID, NN | — | Acting user |
| `event_type` | TEXT, NN | — | `created`, `updated`, `archived`, or `restored` |
| `changes` | JSONB, NN | `'{}'::jsonb` | Changed fields with before/after values |
| `created_at` | TIMESTAMPTZ, NN | `now()` | Audit time |

Constraints: PK `id`; event-type CHECK; composite asset FK with `ON DELETE CASCADE`; composite actor FK to `users` with default `NO ACTION`. Unlike M2 inspection events, this table has no version column or SQL JSON-object shape check.

Indexes: implicit `asset_events_pkey`; explicit `asset_events_history_idx(organization_id, asset_id, created_at, id)` and `asset_events_actor_idx(organization_id, actor_user_id)`. `insertEvent()` actually supplies `clock_timestamp()` in its SQL, overriding the declared timestamp default.

#### `inspection_templates` — migration 003

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Template identity |
| `organization_id` | UUID, NN | — | Owner organization |
| `name` | TEXT, NN | — | Checklist name |
| `description` | TEXT, NN | `''` | Instructions |
| `items` | JSONB, NN | — | Ordered UUID-addressed checklist items |
| `status` | TEXT, NN | `'active'` | `active` or `archived` |
| `version` | INT, NN | `1` | Template aggregate version |
| `created_by` | UUID, NN | — | Creator |
| `created_at` | TIMESTAMPTZ, NN | `now()` | Creation time |
| `updated_at` | TIMESTAMPTZ, NN | `now()` | Last mutation time |

Constraints: PK `id`; organization FK with `ON DELETE CASCADE`; UNIQUE `(organization_id, id)`; composite creator FK; status CHECK; positive version CHECK; CHECK `jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 50`.

Implicit indexes: `inspection_templates_pkey`, `inspection_templates_organization_id_id_key`. Explicit indexes: `templates_directory_idx(organization_id, status, name, id)` and `templates_creator_idx(organization_id, created_by)`.

The database does not validate every item's UUID/label or item-ID uniqueness; shared Zod schemas do. Template names are not unique. Updates replace the ordered item list; no `template_items` table or full template-revision table exists.

#### `inspections` — migration 003

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Inspection aggregate identity |
| `organization_id` | UUID, NN | — | Owner organization |
| `asset_id` | UUID, NN | — | Referenced asset |
| `template_id` | UUID, NN | — | Referenced template |
| `assigned_to` | UUID, NN | — | Current worker |
| `asset_snapshot` | JSONB, NN | — | Asset metadata frozen at assignment |
| `template_snapshot` | JSONB, NN | — | Frozen template ID, version, instructions, items |
| `worker_snapshot` | JSONB, NN | — | Assigned worker ID/name/email |
| `answers` | JSONB, NN | `'[]'::jsonb` | Checklist answers |
| `report_text` | TEXT, NN | `''` | Human-authored narrative |
| `evidence` | JSONB, NN | `'[]'::jsonb` | M4 attachment metadata snapshots; membership is part of the business version |
| `ai_sources` | JSONB, NN | `'[]'::jsonb` | M5 human-reviewed assistance provenance carried into revisions/reports |
| `status` | TEXT, NN | `'assigned'` | Workflow state |
| `version` | INT, NN | `1` | Whole-inspection optimistic version |
| `review_note` | TEXT, NN | `''` | Admin review/cancellation note |
| `submitted_at` | TIMESTAMPTZ, nullable | — | Last recorded submission time |
| `approved_at` | TIMESTAMPTZ, nullable | — | Approval time |
| `approved_by` | UUID, nullable | — | Approving admin |
| `created_by` | UUID, NN | — | Assigning admin |
| `created_at` | TIMESTAMPTZ, NN | `now()` | Assignment time |
| `updated_at` | TIMESTAMPTZ, NN | `now()` | Last mutation time |

Constraints:

- PK `id`; organization FK with `ON DELETE CASCADE`; UNIQUE `(organization_id, id)`.
- Composite FKs: `(organization_id, asset_id) -> assets(organization_id, id)`; `(organization_id, template_id) -> inspection_templates(organization_id, id)`; `(organization_id, assigned_to)`, `(organization_id, created_by)`, and `(organization_id, approved_by)` each reference `users(organization_id, id)`. All five use default `NO ACTION` deletion.
- CHECK `jsonb_typeof(answers) = 'array'`; CHECK `version > 0`.
- Status CHECK: `assigned`, `draft`, `submitted`, `changes_requested`, `approved`, `cancelled`.
- Exact approval CHECK: `(status = 'approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL)`.

The approval CHECK requires both approval fields on approved rows and forbids both being present together on other states. It does **not** require both fields to be NULL for every nonapproved state; one non-NULL field could satisfy the expression. Likewise, SQL does not enforce complete submitted answers, worker/admin roles, snapshot shapes, or `submitted_at` presence. Business services enforce stronger workflow semantics. The nullable approver FK is skipped when its referencing value is NULL under `MATCH SIMPLE`.

Implicit indexes: `inspections_pkey`, `inspections_organization_id_id_key`. Explicit indexes:

| Index | Ordered keys | Intended query/reference support |
| --- | --- | --- |
| `inspections_directory_idx` | `(organization_id, status, created_at, id)` | Organization/status directory |
| `inspections_worker_idx` | `(organization_id, assigned_to, status)` | Worker assignment filtering |
| `inspections_asset_idx` | `(organization_id, asset_id)` | Referenced asset lookups/FK operations |
| `inspections_template_idx` | `(organization_id, template_id)` | Referenced template lookups/FK operations |
| `inspections_creator_idx` | `(organization_id, created_by)` | Creator reference |
| `inspections_approver_idx` | `(organization_id, approved_by)` | Approver reference |

#### `template_events` — migration 003

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Event identity |
| `organization_id` | UUID, NN | — | Owner organization |
| `template_id` | UUID, NN | — | Audited template |
| `actor_user_id` | UUID, NN | — | Acting admin |
| `event_type` | TEXT, NN | — | `created` or `updated` |
| `version` | INT, NN | — | Resulting template version |
| `details` | JSONB, NN | — | `{ changes, note }` |
| `created_at` | TIMESTAMPTZ, NN | `clock_timestamp()` | Actual event wall-clock time |

Constraints: PK; positive version CHECK; event-type CHECK; composite template FK with `ON DELETE CASCADE`; composite actor FK to `users`, default `NO ACTION`.

Indexes: implicit `template_events_pkey`; explicit `template_events_history_idx(organization_id, template_id, version)` and `template_events_actor_idx(organization_id, actor_user_id)`. There is no UNIQUE event-per-version constraint.

#### `inspection_events` — migration 003

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Event identity |
| `organization_id` | UUID, NN | — | Owner organization |
| `inspection_id` | UUID, NN | — | Audited inspection |
| `actor_user_id` | UUID, NN | — | Worker or admin actor |
| `event_type` | TEXT, NN | — | Business action |
| `version` | INT, NN | — | Resulting inspection version |
| `details` | JSONB, NN | — | `{ changes, note }` |
| `created_at` | TIMESTAMPTZ, NN | `clock_timestamp()` | Event wall-clock time |

Constraints: PK; positive version CHECK; event type in `created`, `saved`, `submitted`, `changes_requested`, `approved`, `reassigned`, `cancelled`, plus M4's `evidence_attached`/`evidence_removed` and M5's `ai_applied`; composite inspection FK with `ON DELETE CASCADE`; composite actor FK to `users`, default `NO ACTION`.

Indexes: implicit `inspection_events_pkey`; explicit `inspection_events_history_idx(organization_id, inspection_id, version)` and `inspection_events_actor_idx(organization_id, actor_user_id)`. The shared audit schema also accepts `updated` for templates, but this table's SQL event CHECK does not include it.

#### `inspection_revisions` — migration 003

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Revision identity |
| `organization_id` | UUID, NN | — | Owner organization |
| `inspection_id` | UUID, NN | — | Revised aggregate |
| `version` | INT, NN | — | Snapshot business version |
| `snapshot` | JSONB, NN | — | Full public inspection object, including embedded snapshots |
| `created_by` | UUID, NN | — | Actor who produced this revision |
| `created_at` | TIMESTAMPTZ, NN | `clock_timestamp()` | Revision time |

Constraints: PK; CHECK `version > 0`; UNIQUE `(organization_id, inspection_id, version)`; composite inspection FK with `ON DELETE CASCADE`; composite creator FK to `users`, default `NO ACTION`.

Indexes: implicit `inspection_revisions_pkey`, `inspection_revisions_organization_id_inspection_id_version_key`; explicit `inspection_revisions_creator_idx(organization_id, created_by)`. The composite unique index also supports tenant/inspection history ordered by version. SQL does not validate the JSON snapshot against these columns; serializers/contracts and the insertion path establish that agreement.

#### `mutation_receipts` — migration 003

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `organization_id` | UUID, composite PK | — | Receipt organization |
| `user_id` | UUID, composite PK | — | Receipt actor |
| `mutation_id` | UUID, composite PK | — | Client-generated stable intent ID |
| `request_hash` | TEXT, NN | — | SHA-256 hex fingerprint of canonical operation/input |
| `outcome` | JSONB, NN | — | `{ body: ... }` or `{ error: { status, code, message } }` |
| `template_id` | UUID, nullable | — | Template referenced by the receipt |
| `inspection_id` | UUID, nullable | — | Inspection referenced by the receipt |
| `created_at` | TIMESTAMPTZ, NN | `clock_timestamp()` | Receipt time |

Constraints: PK `(organization_id, user_id, mutation_id)`; composite user FK with `ON DELETE CASCADE`; nullable composite template and inspection FKs, both with `ON DELETE CASCADE`; CHECK `template_id IS NULL OR inspection_id IS NULL`. That last expression permits **at most one** resource reference, including both NULL; it does not require exactly one. No SQL CHECK validates hash length or the outcome envelope.

Indexes: implicit `mutation_receipts_pkey`; explicit `receipts_template_idx(organization_id, template_id)` and `receipts_inspection_idx(organization_id, inspection_id)`. Mutation IDs share one namespace per organization/actor across M2/M4/M5 operations, not one namespace per inspection. No receipt expiry/pruning job currently exists.

#### `evidence` — migration 004

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Stable client-selected evidence identity |
| `organization_id` | UUID, NN | — | Owner organization |
| `inspection_id` | UUID, NN | — | Parent aggregate |
| `created_by` | UUID, NN | — | Reserving worker |
| `name` | TEXT, NN | — | Validated display filename |
| `mime_type` | TEXT, NN | — | Whitelisted image/audio MIME |
| `size` | INT, NN | — | Positive file length, at most 25 MiB; photos at most 10 MiB |
| `sha256` | TEXT, NN | — | Lowercase 64-hex expected byte digest |
| `staging_key` | TEXT, NN | — | Current tenant/inspection/evidence staging generation |
| `object_key` | TEXT, nullable | — | Immutable verified object; required when attached |
| `status` | TEXT, NN | `staging` | staging/attached/removed membership |
| `processing_status` | TEXT, NN | `pending` | pending/ready/failed verification, separate from business version |
| `expires_at` | TIMESTAMPTZ, NN | — | Current twenty-minute staging reservation expiry |
| `created_at` | TIMESTAMPTZ, NN | `clock_timestamp()` | Reservation time |
| `removed_at` | TIMESTAMPTZ, nullable | — | Committed removal time |

Composite inspection/creator FKs include organization. UNIQUE constraints cover organization/id, organization/inspection/id, organization/staging_key and organization/object_key. SQL CHECKs enforce MIME/size/hash/status and keys under `org/<org>/inspections/<inspection>/<evidence>/staging|verified/`. Storage also validates the UUID generation suffix before use. Indexes `evidence_inspection_idx` and `evidence_creator_idx` support scoped membership/creator lookups. Revisions embed metadata snapshots, not file bytes or credentials.

#### `background_jobs` — migration 004

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Durable job identity and normal BullMQ job ID |
| `organization_id` | UUID, NN | — | Job owner |
| `inspection_id` | UUID, NN | — | Parent inspection |
| `evidence_id` | UUID, nullable | — | Required for evidence jobs, absent for reports |
| `ai_artifact_id` | UUID, nullable | — | M5 assistance artifact; only present for AI jobs |
| `kind` | TEXT, NN | — | verify_evidence/cleanup_stage/cleanup_evidence/prepare_report/assist_inspection |
| `dedupe_key` | TEXT, NN | — | Unique required operation within an organization |
| `payload` | JSONB, NN | `{}` | Validated object: empty, staging-key generation, or sourceVersion |
| `status` | TEXT, NN | `queued` | queued/running/retry/completed/failed |
| `attempts` | INT, NN | `0` | Durable claims, at most five through the handler |
| `run_after` | TIMESTAMPTZ, NN | `clock_timestamp()` | Next eligible dispatch |
| `lease_token` | UUID, nullable | — | Fences each claimed attempt |
| `lease_until` | TIMESTAMPTZ, nullable | — | Sixty-second ownership deadline |
| `result` | JSONB, nullable | — | Verified-file result, report HTML/summary/sourceVersion, or M5 artifact/unavailable pointer |
| `last_error` | TEXT, nullable | — | Generic safe failure description |
| `created_at`, `updated_at` | TIMESTAMPTZ, NN | `clock_timestamp()` | Job lifecycle timestamps |

UNIQUE organization/id and organization/dedupe_key constraints prevent duplicate required work. The evidence FK binds **organization, inspection and evidence ID together**; two independent tenant FKs would still permit a same-tenant cross-inspection reference. Job CHECKs validate kind/status, nonnegative attempts, object payload and evidence presence appropriate to kind. `jobs_due_idx`, `jobs_inspection_idx`, and `jobs_evidence_idx` support dispatch/scoped history. This table doubles as the publication outbox; Redis loss does not remove the SQL intent.

Migration 005 adds the composite `(organization_id,inspection_id,ai_artifact_id)` FK and `jobs_ai_artifact_idx`. AI jobs use an empty payload and the artifact's frozen source revision; their result points to the artifact/unavailable outcome. The worker checks that job evidence matches artifact evidence. The original M4 job status endpoint still exposes verification/report jobs; AI status is exposed through the scoped artifact endpoint.

#### `ai_artifacts` — migration 005

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Original assistance identity |
| `organization_id`, `inspection_id` | UUID, NN | — | Owner and aggregate |
| `evidence_id` | UUID, nullable | — | Selected photo/audio; NULL for a report |
| `source_version` | INT, NN | — | Existing immutable inspection revision, positive and below INT maximum |
| `kind` | TEXT, NN | — | image/voice/report |
| `requested_by` | UUID, NN | — | Assigned requesting worker |
| `status` | TEXT, NN | queued | queued/ready/failed |
| `provider`, `model`, `mode` | TEXT, nullable | — | Origin/model and provider/fallback mode |
| `fallback_reason` | TEXT, nullable | — | disabled/missing_key/provider_error when in fallback mode |
| `prompt_version` | TEXT, NN | m5-v1 | Version of adapter instructions |
| `provider_request_id` | TEXT, nullable | — | Provider response provenance |
| `original_output`, `raw_output` | JSONB / TEXT, nullable | — | Structured original and retained raw model/transcript output |
| `created_at` | TIMESTAMPTZ, NN | clock_timestamp() | Request time |
| `completed_at` | TIMESTAMPTZ, nullable | — | Ready/failed settlement time |

Composite FKs bind source revision `(organization_id,inspection_id,source_version)`, evidence `(organization_id,inspection_id,evidence_id)` and requester `(organization_id,requested_by)`. UNIQUE `(organization_id,inspection_id,id)` supports review/job references. `UNIQUE NULLS NOT DISTINCT (organization_id,inspection_id,source_version,kind,evidence_id)` deduplicates report requests even though their evidence is NULL. Ready rows require original/raw/provider/model/mode/completion metadata. Fallback rows require a reason; image/voice require evidence, reports forbid it.

`guard_ai_artifact()` rejects source-identity changes and all updates once the old status is no longer queued. Services do not delete original outputs. `ai_artifacts_requester_idx` supports scoped hourly budgets; `ai_artifacts_evidence_idx` supports source lookups. SQL checks require object-shaped original JSON; bounded text/findings/checklist validity are enforced through Zod/provider validation.

#### `ai_reviews` — migration 005

| Column | Type / nullability | Default | Meaning |
| --- | --- | --- | --- |
| `id` | UUID, PK | — | Human review identity |
| `organization_id`, `inspection_id`, `artifact_id` | UUID, NN | — | Tenant/aggregate/original artifact |
| `decision` | TEXT, NN | — | apply/reject |
| `confirmed_output` | JSONB, nullable | — | Human-edited answers/report text for apply |
| `reviewed_by` | UUID, NN | — | Authenticated reviewer |
| `applied_version` | INT, nullable | — | New inspection revision for apply |
| `reviewed_at` | TIMESTAMPTZ, NN | clock_timestamp() | Human decision time |

Composite artifact/reviewer/applied-revision FKs prevent tenant and aggregate mixing. UNIQUE `(organization_id,inspection_id,artifact_id)` permits one review. Apply requires object-shaped confirmed output and a positive applied revision; reject requires both fields NULL. Service permissions additionally restrict applying to the assigned worker, current source version and editable state; admins can reject and later approve submitted reports. Reviews are append-only through the API, without a separate SQL immutability trigger. Reviewer/version indexes support references. Inspection `ai_sources` and saved revisions retain model/source/human-review provenance, separate from original and confirmed content.

### 2.2 Index inventory and query-plan reasoning

The five migrations declare **32 explicit indexes**: 2 in 001, 4 in 002, 15 in 003, 5 in 004 and 6 in 005. PK/UNIQUE constraints create 31 implicit unique indexes. The real development database verification found **63 application indexes**, excluding migration bookkeeping. M5 adds requester/evidence/review/job indexes and `inspections_analytics_idx(organization_id,created_at,id)`; analytics compute bounded reads without an extra analytics table.

Tenant ID is generally the first key because most directory/history operations start with tenant equality. B-tree index left-prefix behavior matters: `(organization_id, inspection_id, version)` supports a tenant/inspection history scan; an index on `inspection_id` alone would not express the application's principal scope as directly.

PostgreSQL does not automatically create indexes on referencing FK columns. The explicit creator/actor/asset/template/approver indexes help reference lookups and parent update/delete checks. UNIQUE and PRIMARY KEY constraints do create their own supporting indexes.

Do not promise every index removes sorting for every query. `listInspections()` orders `created_at DESC, id`, while the directory index has default ascending keys; `status='all'` also removes a useful equality predicate. The optional-filter OR expressions and table size can affect index choice. Use actual `EXPLAIN (ANALYZE, BUFFERS)` measurements before adding indexes. No application migration defines GIN JSONB, trigram, partial, or expression indexes. Asset substring search uses `%...%` ILIKE and can require scanning; the directory B-tree is not a general substring index.

### 2.3 Tenant identity at the application boundary

`apps/server/src/modules/auth/session.js` extracts exactly one well-formed `fieldsync_sid` cookie. Its raw token is hashed; `modules/auth/repository.js::findSession()` joins `sessions`, `users`, and `organizations` with matching organization keys and checks `expires_at > now()`.

`modules/auth/middleware.js::createRequireAuth()` builds:

```js
request.auth = {
  user: publicUser(row),
  organizationId: row.organization_id,
  organization: /* validated public organization */,
};
```

Repositories then use this identity in parameterized predicates, for example:

```sql
SELECT * FROM inspections
WHERE organization_id = $1 AND id = $2
FOR UPDATE;
```

`$1` is `auth.organizationId`, not a body/query organization ID. Login is the deliberate exception: it accepts `organizationId` to identify tenant-qualified credentials **before** authentication. Strict request schemas reject ownership/role/creator fields outside their allowed shapes. A foreign-tenant UUID returns a scoped 404; UUID unpredictability is not authorization.

Within a tenant, `modules/inspections/service.js::assertAccess()` also restricts workers to `assignedTo === auth.user.id`. `listInspections()` adds the worker predicate, while admin listings cover the organization's inspections. Both tenant scoping and record-level worker authorization are necessary.

### 2.4 Tenant integrity in the database

An inspection with organization A cannot reference organization B's asset, template, assigned worker, creator, or approver because each FK includes the organization:

```sql
FOREIGN KEY (organization_id, asset_id)
  REFERENCES assets(organization_id, id)
```

A globally unique UUID alone would only prove that the asset exists. Pairing it with the owner proves it exists **in the same organization**. Audit and receipt references use the same pattern, so an incorrectly assembled insert cannot attach tenant A's history to tenant B's resource or actor.

These constraints enforce relationship integrity, not read authorization. A query that omits the tenant predicate can still expose rows; FKs do not filter SELECTs. Likewise, a direct privileged SQL insert can assign an admin where a worker is required: role constraints validate the role value, while `findWorker()` validates the business relationship. Shared snapshots stored inside JSONB are not FK-protected references.

Direct user deletion can be blocked by creator/actor/approver references using `NO ACTION`; session and receipt user references cascade. Organization deletion cascades through its users and principal aggregates, with further child cascades. The HTTP application does not offer general destructive entity-delete endpoints.

### 2.5 Composite FKs versus Row-Level Security

No migration enables RLS or creates tenant policies. `database.js` sets `search_path` for the production/public schema or isolated **test** schema, not a separate database schema per organization. Production tenancy is shared tables with explicit owner columns.

The source establishes the implementation choice; it does not contain an ADR proving every historical reason for rejecting RLS. A defensible explanation of the current trade-off is:

| Current explicit predicates + composite FKs | RLS alternative |
| --- | --- |
| Tenant scope is visible in repository SQL and independently tested | Policies can add database-side filtering even when a query forgets a predicate |
| One pooled service identity; no per-request PostgreSQL tenant setting | Typically needs trustworthy tenant context, e.g. transaction-local configuration, and careful pool handling |
| Composite FKs guard cross-tenant relationships | RLS does not replace relationship constraints |
| Simpler current transaction/service model | Policy design, privileges, table-owner/bypass behavior, migrations, and background jobs require auditing |
| A missed SELECT predicate remains a confidentiality risk | Incorrect policy/context or bypass privileges remain risks |

Say, “We currently use explicit repository scope plus composite FKs; RLS could be an additional defense if our threat model requires it.” Do not say FKs provide the same SELECT protection as RLS or that RLS is inherently incompatible with connection pools.

### 2.6 Frozen snapshots and historical integrity

`modules/inspections/repository.js::assignmentSnapshots()` reads the tenant's template, asset, and worker using `FOR SHARE`, preventing conflicting changes to those selected rows while assignment is created. It checks active template/asset status and worker role.

The stored shapes are precise:

- Asset: `id`, `code`, `name`, `category`, `location`. The selected `status` is removed. **Asset version is not stored** in this snapshot.
- Template: `id`, `name`, `description`, ordered `items`, and `version`, parsed by `templateSnapshotSchema`.
- Worker: `id`, `name`, `email` from `findWorker()`.

`insertInspection()` serializes these objects into JSONB. `updateInspection()` updates answers/workflow/worker metadata but does not rewrite `asset_snapshot` or `template_snapshot`. Changing or archiving the source template/asset therefore cannot change the checklist or equipment description of an existing inspection. New assignments use the current active source records.

Reassignment intentionally updates `assigned_to` and `worker_snapshot`, sets status to `assigned`, and preserves saved answers/narrative. The prior complete inspection revision still contains the old worker snapshot. Each successful inspection mutation appends a full `inspection_revisions.snapshot`; historical reports select that snapshot instead of joining current templates/assets.

The report component is `apps/web/src/components/inspection-ui.jsx::InspectionReport`. Admin and worker detail pages provide version selection and `window.print()`, with print styles in `apps/web/src/styles.css`. Audit actor names come from a live `users` join in `listAudit()`/`listEvents()`; actor IDs are stable, but these names are not frozen audit-name snapshots. This is snapshot-based aggregate history with field-level audits, not an event-sourced application that reconstructs current state from events.

## 3. Distributed Systems, Concurrency & Idempotency

### 3.1 The server-side workflow state machine

Source: `apps/server/src/modules/inspections/service.js`.

```text
created -> assigned
assigned / draft / changes_requested --worker save--> draft
assigned / draft / changes_requested --worker submit--> submitted
submitted --admin request_changes--> changes_requested
submitted --admin approve--> approved
assigned / draft / changes_requested --admin reassign--> assigned
any nonclosed state --admin cancel--> cancelled

approved / cancelled = closed: reject further business changes
submitted = awaiting review: worker cannot save or resubmit as a new mutation
```

Submission requires an outcome for every frozen item and a note for each `fail`. `normalizeAnswers()` checks item membership, fills missing draft answers with `{ outcome: null, notes: '' }`, and orders answers by the frozen template. Zod has already trimmed request notes/narrative and checked duplicate answer IDs.

Saving enters `draft`; submitting sets `submittedAt` from the server process clock and clears `reviewNote`. Request changes requires a nonempty note. Approving sets admin ID/time. Reassignment preserves content rather than restarting an empty checklist. No-op changes reject with `400 NO_CHANGES`; successful changes increment the aggregate version exactly once.

### 3.2 Optimistic concurrency plus a short pessimistic lock

The client supplies numeric `baseVersion`, the version it edited. The server takes `SELECT ... FOR UPDATE`, compares the stored version, and conditionally updates with a version predicate:

```sql
UPDATE inspections SET
  answers = $3::jsonb,
  report_text = $4,
  -- additional allowed fields omitted here
  version = version + 1,
  updated_at = clock_timestamp()
WHERE organization_id = $1 AND id = $2 AND version = $12
RETURNING *;
```

This is an excerpt of `modules/inspections/repository.js::updateInspection()`. The actual query also writes status, assignment/worker snapshot, review and submission/approval metadata. A version mismatch in the service or a zero-row conditional UPDATE becomes `409 VERSION_CONFLICT`.

```text
Two distinct mutations both start from inspection version 7:

A: locks row -> sees 7 -> updates to 8 -> revision/audit/receipt -> COMMIT
B: waits     -> acquires row after A -> sees 8 != baseVersion 7 -> 409

B's business update is not applied. Its expected error may receive a receipt.
```

The approach is optimistic because it does not hold a lock while a worker edits offline or spends minutes in a form. The short transaction lock serializes the final read/validate/write step. A lock alone would not reject stale human intent; the waiting writer could overwrite newer content after acquiring it. A version predicate alone protects one UPDATE, but the locked aggregate simplifies safe validation and consistent audit/revision computation.

Asset and template services follow the same pattern. M1 assets have optimistic versions/audits but **no mutationId receipt protocol**. M2 templates/inspections do. Current updates guard against INT overflow by bounding request `baseVersion` at 2,147,483,646; inspection/template response versions can reach 2,147,483,647.

### 3.3 Transaction isolation and resource locks

`apps/server/src/infrastructure/transaction.js` checks out one pool client, issues `BEGIN`, executes all work through that client, commits or rolls back, and releases it in `finally`. Write transactions do not explicitly override PostgreSQL's default isolation level. Detail/history reads use `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` so resource, audits, and revisions describe one database snapshot.

`FOR UPDATE` protects the inspection/template aggregate being changed. Assignment uses `FOR SHARE` on source template/asset/worker rows. There is no application-wide row lock or long SQL transaction around offline editing, HTTP uploads, Redis, or AI calls.

`database.js` configures pool max 5, idle timeout 10 seconds, connection timeout 2.5 seconds, and query/statement timeouts 3 seconds. Lock waits and slow statements can fail; unexpected failures roll back and the unchanged mutation can retry. The code does not implement a separate generic server-side deadlock retry loop.

### 3.4 Replay-safe idempotency: exact algorithm

Source: `apps/server/src/infrastructure/mutations.js::mutate()`.

Let the receipt key be:

```text
K = (auth.organizationId, auth.user.id, input.mutationId)
operation = e.g. "inspections:<inspection UUID>:saved"
H = SHA256(JSON.stringify(canonical({ operation, input })))
```

`canonical()` recursively sorts object keys, preserves array order, and retains scalar values. Request schemas normalize trimmed text before this helper runs. The fingerprint includes the operation/target and parsed input, including `baseVersion` and `mutationId`. Reordering arrays or changing the base version is still a changed request; canonicalization is not a semantic CRDT merge.

Algorithm, in the actual order:

1. Start one PostgreSQL transaction.
2. Acquire `pg_advisory_xact_lock(hashtextextended($1, 0))` using the string `organizationId:userId:mutationId`.
3. Read the receipt with all three key predicates.
4. Run the authorization callback. Existing resources are tenant-scoped, locked, and checked for current access **even when a receipt exists**. Creation replay callbacks use the resource ID recorded in the receipt.
5. If a receipt exists, reject a different `request_hash` with `409 MUTATION_ID_REUSED`; otherwise return its stored outcome without reapplying the mutation.
6. If no receipt exists, establish `SAVEPOINT mutation_work` and execute business version/workflow validation and writes.
7. On success, prepare `{ body: saved.body }`. On an expected `HttpError`, roll back to the savepoint and prepare an error outcome. Unexpected errors escape and roll back the entire transaction.
8. Insert `mutation_receipts` with the fingerprint, outcome, actor, organization, and optional resource ID; commit.
9. After transaction completion, throw the recorded `HttpError` or return the stored body for HTTP serialization.

The transaction-scoped advisory lock serializes the **receipt key**, not every request in an organization. Two different mutation IDs against one inspection still compete for the aggregate row lock. A theoretical advisory-key hash collision can create extra serialization, but exact receipt queries/PKs still distinguish identities; it does not authorize cross-tenant replay.

### 3.5 Why replay precedes mutable workflow/version validation

After submission, the row is now `submitted` and its version has increased. If a retry checked “editable state” or old baseVersion before examining its receipt, it would reject an operation that already succeeded. The server instead rechecks **current access**, then returns the old receipt before reapplying workflow/version checks.

Current access cannot be skipped: a worker whose assignment has moved to another worker must not retrieve a previous result through receipt replay. `assertAccess()` returns a scoped 404. An expired session is rejected by middleware before `mutate()` is reached. Idempotency is not an authorization bypass.

### 3.6 The lost-response timeline

```text
Device persists mutation M with baseVersion 10.
Device freezes M as attempted, then PATCHes the API.
Server updates inspection to 11 and commits revision/audit/receipt(M).
Network drops before the client receives the response.
Device retains attempted M: it cannot infer whether the server committed.
Later it sends the identical M/body/baseVersion 10.
Server verifies current access, finds receipt(M), and returns stored version 11.
Device acknowledges M locally and removes only that completed intent.
```

If the client generated a new ID after the lost response, it would lose the ability to correlate the retry with the committed operation. If it changed content under M, the server would reject ID reuse. Stable identity plus immutable attempted payload is the required pair.

This gives replay-safe, effectively once-per-receipt business effects inside PostgreSQL while requests may be delivered multiple times. It does not guarantee exactly-once networks or external MinIO/AI execution. Successful receipt bodies are snapshots of the original result, not automatically refreshed current state; separate reads obtain newer shared state.

### 3.7 Atomicity of revisions, audits, and receipts

For an inspection update, `change()` executes the conditional aggregate update, `appendRevision()`, and `appendAudit()` within `mutate()`'s transaction. The helper then inserts the receipt before COMMIT. Creation likewise creates aggregate/revision/audit/receipt together. Template operations write template/audit/receipt; M1 asset operations write asset/event together, without M2 receipts/revisions.

`infrastructure/audit.js::changesBetween()` compares selected fields with JSON serialization and records `{ before, after }`. `appendAudit()` uses a fixed source map for the two M2 audit table/foreign-key names and binds all request values as SQL parameters. `listAudit()` sorts by version/time/ID and joins actor names with matching tenants.

| Failure | Aggregate/revision/audit | Receipt | Retry consequence |
| --- | --- | --- | --- |
| Successful commit, response lost | Committed together | Successful outcome committed | Exact retry returns stored success |
| Stale version, closed workflow, no-op inside business work | No business change | Expected error can be committed after savepoint rollback | Exact retry returns the same domain error; a revised intent needs a new ID |
| Authorization fails before business work | No business change | No new outcome inserted by that request | Current permissions still govern any existing receipt |
| Audit/revision/receipt insert unexpectedly fails | Entire transaction rolled back | No new durable receipt | Retry unchanged intent after failure is removed |

An error receipt is not a successful business event. This explains why receipt counts can exceed successful version changes. Application code appends history but no SQL trigger/permission scheme makes it tamper-proof against privileged manual database edits. History is not cryptographically signed or an immutable ledger.

## 4. Offline-First Architecture & Sync Engine (M3-M4)

### 4.1 Two authorities and one temporary input buffer

PostgreSQL is authoritative for acknowledged shared state. Dexie is authoritative for successfully committed unsynchronized intent. A React input buffer provides immediate typing feedback and retains uncommitted content when device storage fails; it is not a second durable database.

Admin/asset queries use TanStack Query. Worker list/detail components use `OfflineProvider` and Dexie `liveQuery()`, not query-cache drafts. `apps/web/src/pages/InspectionsPage.jsx` and `InspectionDetailPage.jsx` choose worker versus online admin components by role. `main.jsx` mounts `AuthProvider -> OfflineProvider -> App` under the query/router providers.

### 4.2 IndexedDB namespace and full local model

`apps/web/src/offline/store.js::OfflineStore` opens:

```js
name = `fieldsync:${organizationId}:${userId}`;
db.version(1).stores({
  records: 'id',
  workingCopies: 'id',
  outbox: '++sequence,&mutationId,inspectionId,status',
});
db.version(2).stores({ files: 'id,inspectionId', blobs: 'id' });
```

`++sequence` is the workspace's auto-increment primary key; `&mutationId` is a unique secondary index. Inspection/status are secondary indexes. IDs can be short keys within a database because its namespace includes both tenant and user, and every stored row redundantly carries the same owner IDs.

| Store | Persisted shape | Role |
| --- | --- | --- |
| `records` | `organizationId`, `userId`, `id`, `inspection`, nullable `detail`, `unavailable` | Last cached server record; detail includes events/revisions |
| `workingCopies` | Owner IDs, `id`, `base`, `content`, `generation`, `acknowledgedGeneration`, nullable `conflict`, nullable `blocked`, `updatedAt` | Editable/retained content and its synchronization ancestry |
| `outbox` | Owner IDs, `sequence`, `mutationId`, `inspectionId`, `action`, `body`, `base`, `generation`, `status`, nullable `attemptedAt`, nullable `error` | Ordered save/attach/remove/submit intents and frozen attempts |
| `files` | Owner IDs, evidence `id`, `inspectionId`, `reserveMutationId`, filename/MIME/size/SHA-256, queued/synced status | Durable file metadata and stable reservation identity |
| `blobs` | Owner IDs, evidence `id`, one actual `Blob` | Unsynchronized bytes; cleared after acknowledgment or confirmed existing membership |

The shared schemas in `packages/contracts/src/offline.js` validate row shape, owner/reference consistency, matching body/entry mutation IDs, checklist membership and generation bounds. `OfflineStore.validate()` additionally checks rows against the open database owner. Request bodies use `saveInspectionSchema` or M4's `evidenceMutationSchema`. Replay verifies local file metadata belongs to the exact attempted inspection and workspace before reserving/uploading it.

`offlineContentSchema` deliberately preserves raw notes/narrative whitespace. API request schemas trim these fields. This separates what the worker typed from the normalized request used by the receipt protocol. Local `updatedAt` is diagnostic; ordering is by sequence/generation and concurrency by server version, not by comparing device clocks.

M4's additive version 2 is implemented and browser-tested against a native version-10 database produced by Dexie version 1, including an existing pending M3 save and rows without the new evidence field. Shared empty-array defaults make those older snapshots readable. Upgrades/logout never delete retained work. Future migrations must preserve this behavior.

### 4.3 Pure transitions in `state.js`

| Function | Actual responsibility |
| --- | --- |
| `contentOf()` / `initialCopy()` | Fill every frozen item with an answer or null outcome; establish a working base/content and generation zero |
| `sameContent()` | Compare normalized request semantics, trimming text and using checklist order |
| `localChange()` | Validate local content/submission; increment generation; coalesce only the last pending unattempted save, or append a new save/submit intent |
| `prepareRequest()` | Only prepare the per-inspection head; preserve an existing attempted request unchanged; otherwise take the current acknowledged base/version, freeze status/body/base/time, or skip a verified unattempted no-op draft |
| `acknowledge()` | Validate response owner/inspection/worker/version; advance base/generation; preserve worker content for file acknowledgments or newer local edits; remove the acknowledged mutation |
| `pauseRequest()` | Retain content/queue and mark one head as conflict if a current editable same-worker remote exists, otherwise blocked |
| `resolvedChange()` | Check generation/assignment; retain unsatisfied file intent with fresh mutation IDs against remote base, then queue the reviewed save/submission |
| `mergeContent()` | Three-way comparison of worker-owned fields only; produce merged content, overlap descriptors, and an explicit-choice completeness flag |

`localChange()` also accepts the editor's expected working copy. If its base differs from the stored base without a newer acknowledgment generation explaining the advance, the edit is retained as a conflict against the observed remote instead of silently using the newer base. This guards the brief lock-acquisition/live-render gap.

### 4.4 Outbox state machine and ordering

```text
local edit -> pending
pending --atomic prepare before HTTP--> attempted
attempted --network uncertainty / 5xx--> attempted, same ID/body/base
attempted --validated success + atomic local ack--> removed
attempted --409 + readable editable remote--> conflict
attempted --revoked access / closed or invalid workflow--> blocked
conflict --explicit reviewed merge--> old inspection intents replaced
                                      by a new pending save/submit ID
blocked --assignment restored + explicit review--> conflict/merge review
401 -> workspace replay paused for reauthentication; request remains retained
```

Completed entries are removed; the current schema does not persist a `synced` status. The actual states are `pending`, `attempted`, `conflict`, and `blocked`. `SYNC_STATUSES` in `packages/contracts/src/constants.js` still contains reserved `in_flight/synced` values; these are not the M3 outbox implementation's state machine.

The last **unattempted pending save** can coalesce, retaining its ID and sequence but taking the newest content/generation. An attempted request can never be coalesced or rebased. A submission is its own ordered entry. Later ordinary editing is rejected while a nonconflicted/nonblocked submission is queued; the UI also disables editing immediately while submission is being persisted.

Global sequence order is preserved for eligible entries, with a per-inspection head restriction. A conflicted/blocked inspection pauses its own following entries; unrelated inspections can continue. An uncertain network/5xx error throws out of that drain, so the current implementation can temporarily delay unrelated work until the next wake-up. There is no dependency DAG, CRDT, or reorder-by-timestamp algorithm.

### 4.5 Why both local writes must be atomic

`OfflineStore.transition()` runs one Dexie read/write transaction over the stores. It reads and validates copy/ordered queue, applies the pure transition, writes the copy, deletes superseded/completed entries, writes retained/new entries, and optionally updates the acknowledged cached record.

If content were committed without its outbox intent, the edit might never reach PostgreSQL. If an outbox request were committed without corresponding local content, the UI could misrepresent what would be sent. Acknowledgment similarly updates base/cache and removes the matching intent in one transaction; a crash cannot leave only half of that bookkeeping committed.

`prepare()` persists `attempted` plus the frozen request before network dispatch. A crash after preparing but before sending is safe: later replay sends that exact request. A crash after a server commit but before a local acknowledgment is safe through the same durable receipt protocol.

### 4.6 Generation counters and two subtle races

**An old response while the worker continues typing.** Suppose save A captures generation 4. While A is in flight, the worker creates generation 5 and queues B. A's acknowledgment advances the server base but retains generation 5's content. B is still unattempted, so its first preparation can use A's acknowledged version. The server response cannot overwrite the newer draft.

**A committed write before its live-query render.** In `WorkerInspections.jsx::LocalEditor`, writes are serialized through a promise ref. `committedGeneration` records the completed transaction generation. A React effect may replace the fast buffer with Dexie content only when there is no dirty buffer, no pending device write, and the incoming copy generation is at least that committed generation. Otherwise a stale render could restore an unanswered checklist immediately after the worker saved an outcome. The browser test checks rapid outcome/narrative changes, not just individual slow saves.

Quota/database failures keep the fast input buffer, show that device save failed, and offer retry. “Saved on this device” appears after commit, not merely after `setState()`. A buffer whose database write failed is still volatile: the message tells the worker to keep the page open. Browser storage does not survive deliberate site-data deletion or device loss, and no ZIP recovery/export feature exists.

### 4.7 Locks and background refresh safety

| Web Lock name | Owner | Protection |
| --- | --- | --- |
| `fieldsync:<org>:<user>:sync` | `OfflineProvider` drainer, using `ifAvailable` | One active drainer per workspace across tabs |
| `fieldsync:<org>:<user>:editor:<inspectionId>` | `useEditorLock()` in worker UI | One writer for an inspection's local input buffer |
| `fieldsync-session` | `sessionLock()` | Origin-wide serialization of cookie-changing auth and sync identity-check/dispatch sequences |

`OfflineStore.cache()` tries the same editor lock with `ifAvailable`. It may cache the remote record, but only refreshes an existing clean working copy when there is no pending queue and no tab holds the editor lock. A newer closed server state marks retained work read-only rather than deleting it. Clean refreshes preserve monotonically increasing local generations; older remote versions do not downgrade the cached record.

The editor lock is held until cleanup and final pending writes settle. A second tab remains read-only and can acquire the lock when the first releases it. Dexie live queries propagate committed state. Storage/custom events propagate active identity changes; there is no BroadcastChannel-based sync protocol. Provider cleanup removes listeners/timers and aborts requests, without closing database handles beneath unfinished editor writes.

Web Locks coordinate same-origin tabs in one browser profile, not different devices. Different devices still require PostgreSQL versions and receipts. The current session helper has no unlocked fallback: missing Web Locks can also prevent its coordinated authentication path, and the worker editor/sync require this browser capability.

### 4.8 Replay worker and automatic wake-ups

`apps/web/src/offline/sync.js::flushOutbox()` is an injectable asynchronous function; `provider.jsx` owns browser lifecycle wiring.

```text
Acquire workspace drainer lock + origin session lock
  -> verify active cached workspace and GET /auth/me identity/worker role
  -> enumerate ordered entries
  -> prepare/commit immutable per-inspection head
  -> recheck active state
  -> PATCH save or POST submit using existing payload/schema
  -> acknowledge, preserve uncertainty, or pause the inspection
  -> revalidate identity, pull existing assignment list, cache records
  -> mark missing assignments unavailable without deleting local work
```

Wake-ups are browser `online`, `focus`, a 15-second interval, manual “Sync now,” and an 800-ms debounce after device edits. `offline` updates status; session/storage events abort inactive work or schedule replay. The provider also guards against overlapping runs within one instance.

`apiRequest()` uses same-origin credentials, no-store fetches, JSON headers, response Zod parsing, and a 15-second abort timeout combined with any caller signal. A timeout/abort cannot prove the server did not commit; attempted requests remain unchanged for retry. Retry is interval/event-driven, not exponential backoff, and TanStack Query's generic retry setting is false.

The sync function checks `/auth/me` before dispatching work and activity before each entry/request. App cookie changes are serialized through the origin lock. Every server operation independently authenticates and checks permissions, so client guards are coordination rather than server security.

### 4.9 Error handling and the verified no-op case

| Result | Client behavior |
| --- | --- |
| Valid success | Atomic local acknowledgment; keep any newer generation |
| Network failure/timeout/5xx | Keep attempted request frozen; retry on a later wake-up |
| 401 | Mark cached identity expired; retain copy/queue; stop replay until valid sign-in |
| `409 VERSION_CONFLICT` | Fetch detail; retain base/local/remote; pause this inspection for review |
| `409 EVIDENCE_PROCESSING` | Keep the attempted submission frozen; defer this inspection until the next normal retry wake-up |
| Revoked assignment or inaccessible detail | Keep a blocked/read-only local copy and request |
| Closed/invalid workflow or other domain failure | Block intent without deleting edits |
| Device write failure | Keep input buffer; report unsaved device state and allow retry |

For `NO_CHANGES`, `flushOutbox()` fetches current detail and acknowledges only if it belongs to the same worker, is `draft`, has exactly the attempted baseVersion, and has identical normalized content. An unattempted local no-op may be removed before dispatch, but an attempted request is never silently discarded just because an error looks harmless. An unverifiable no-op becomes a retained conflict/block.

### 4.10 End-to-end three-way merge

`pauseRequest()` records the original request's `base` and freshly fetched `remote`; the working copy retains the latest `local` content, including edits newer than the attempted request. `ConflictReview` displays version context, base/local/remote values for overlapping fields, and a preview of the whole merged report.

For each scalar field, `mergeContent()` implements:

```text
if local == base:               choose remote
else if remote == base:         choose local
else if local == remote:        choose local
else:                          require explicit local/remote choice
```

It compares `reportText`, each answer's `outcome`, and each answer's `notes` independently. Checklist item UUIDs align fields. A local narrative and independently changed remote note therefore combine automatically. Different edits to the same narrative require a choice. This is whole-field comparison, not a character-level text merge; raw strings can differ by whitespace.

Example:

| Field | Base | Local | Remote | Merge |
| --- | --- | --- | --- | --- |
| Report summary | `Initial` | `Valve repaired` | `Initial` | Local |
| Pressure notes | `''` | `''` | `Measured 4 bar` | Remote |
| Seal outcome | `pass` | `fail` | `not_applicable` | Explicit choice |

The result contains only `answers` and `reportText`. Assignment, status, approval, creator, and template/asset identities remain server-controlled. If checklist identity cannot be aligned, the helper throws rather than guessing; current frozen-template behavior normally prevents that situation.

M4 keeps file membership as separate ordered intent rather than merging client-controlled evidence JSON. Unsatisfied attach/remove intents receive new mutation IDs on explicit rebase. If the current remote already contains an attachment or has already removed it, `OfflineStore.resolve()` acknowledges that membership and clears corresponding local bytes/metadata in the same Dexie transaction. A lost-response blob cannot become permanently orphaned just because the reviewed queue no longer contains its attach action.

Before confirming, the UI fetches current remote detail again. A different remote version refreshes the comparison; the choices must be reviewed again. `store.resolve()` checks the displayed conflict remote version and, inside the transaction, the displayed local generation. It replaces that inspection's superseded intents with a new pending save or submit against the checked remote base and a fresh mutation ID. Other inspections' queues are untouched. Server OCC still detects a new change between this read and eventual push.

A returned assignment can be reviewed with “Review current assignment.” If it is once again editable for the same worker, retained work enters merge review. Reassignment/cancellation never causes automatic deletion or an automatic write of old local content over new shared state.

### 4.11 Logout, expiry, and account switching

`apps/web/src/offline/session.js` stores only validated public `{ user, organization }` and flags in localStorage key `fieldsync:session`: `expired`, `loggedOut`, `pendingLogout`. There are no cached passwords, raw session cookies, or bearer tokens. Malformed/unreadable metadata falls back to logged-out state.

`AuthProvider` starts from cached identity for offline reopening and normally verifies `/auth/me`. A 401 retains public identity but marks it expired. Network/server failures can retain an existing identity so local editing stays accessible; this does not authorize server writes. `query-client.js` turns 401 failures into expiration instead of erasing local drafts.

Explicit logout immediately writes `session: null, loggedOut: true, pendingLogout: true`, clears non-session query data, and isolates the retained database. If online, it attempts server logout; otherwise the pending marker is processed on reconnect/before another login. A 401 on pending server logout is acceptable because that session is already invalid. Logged-out metadata prevents an existing cookie from silently reopening the old workspace.

Before login/registration rotates the cookie, the active namespace is marked expired to pause every tab. The shared session lock finishes pending logout and performs authentication. Successful auth clears other query caches and stores the new identity. Children are keyed by organization/user/role and remount on changes; provider activity checks prevent an old namespace's outbox from dispatching under the new cookie. Returning to the original account reopens its retained database.

Namespace isolation prevents app-level account mixing; it is not encryption or protection from same-origin XSS, DevTools access, or an attacker controlling the browser profile. Offline authorization cannot learn a remote revocation until reconnect. These are explicit limits of preserving offline work after logout/expiry.

### 4.12 Shell-only Service Worker caching

`apps/web/offline-shell.js::offlineShell()` is a Vite build plugin. It emits `sw.js` with a cache name `fieldsync-shell-<16-character hash>` derived from the precache file list: `/`, `/favicon.svg`, and emitted JS/CSS bundle paths.

- Install: `cache.addAll(files)`, then `skipWaiting()`.
- Activate: delete older caches whose names start with `fieldsync-shell-`, then `clients.claim()`.
- Fetch guard: same-origin GET only; immediately ignore paths starting `/api/`.
- Navigation: network first, falling back to cached `/` when fetch rejects.
- Listed static assets: cache first, otherwise network.

No API/auth response is stored in Cache Storage; scoped application data belongs in Dexie. Old shell cache cleanup does not delete IndexedDB. Navigation fallback handles network rejection, not every HTTP error response. This worker has no outbox drain, Background Sync event, upload handler, or periodic background job. Auto-sync runs in the mounted page, so queued work can wait while the application is closed.

`main.jsx` registers `/sw.js` only for production builds and when service workers exist. `apps/web/build.js` sets `NODE_ENV='production'` before loading Vite: the shared local `.env` otherwise describes a development server and could remove production-only registration/include React development code. The build uses native JS config loading; no TypeScript or extra PWA library was added.

Offline reopening requires a previously cached production shell, compatible IndexedDB/service-worker/Web Locks support, and a secure context (HTTPS or loopback). A first-ever offline visit cannot download the shell or assignments. The current implementation supplies shell caching, not a full installability/manifest or background-execution guarantee.

## 5. Security, Authentication & Validation

### 5.1 Password hashing: Argon2id, salts, and cost placement

Source: `apps/server/src/modules/auth/passwords.js`:

```js
const options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};
```

`memoryCost` is KiB: 19 MiB; there are two iterations and one lane. `argon2.hash()` generates the salt and encodes salt/parameters/hash in the stored Argon2 string, so `users` needs no separate salt column. `argon2.verify()` validates it. Passwords are 12-128 characters in the shared contract and are neither trimmed nor lowercased.

Unknown accounts still perform verification against a lazily generated dummy Argon2 hash, reducing obvious account-enumeration timing differences. Failed login uses one generic `INVALID_CREDENTIALS` message covering organization/email/password. This is timing mitigation, not a proof of constant end-to-end latency or complete brute-force protection.

Password hashing happens before registration's SQL transaction; worker provisioning also hashes before its insert. Memory/CPU-expensive work does not occupy an aggregate row lock. Scrypt is another memory-hard password KDF that could be discussed as an alternative, but no scrypt implementation or scrypt salt format exists here. Fast SHA-256 without a password KDF would be the wrong substitute for low-entropy human passwords.

### 5.2 Opaque server-side sessions

`newSession()` generates 32 random bytes, encodes them as 64 lowercase hex characters, and computes SHA-256 for `sessions.id`. The cookie contains the raw high-entropy token; the database contains its digest. Fast hashing is suitable for this random token and is separate from password hashing.

`readSessionToken()` rejects malformed tokens and duplicate named cookies. `/auth/me` uses the server expiry predicate and current user role from PostgreSQL. Default session lifetime is 168 hours; environment validation bounds it to 1-720 hours.

Cookie attributes from `cookieOptions()`:

| Attribute | Actual setting | Reason |
| --- | --- | --- |
| Name | `fieldsync_sid` | One opaque session credential |
| `HttpOnly` | true | JavaScript cannot directly read the token |
| `SameSite` | `lax` | Reduce cross-site cookie delivery for unsafe requests |
| `Path` | `/` | Consistent application scope |
| `Secure` | production NODE_ENV or HTTPS APP_ORIGIN | Restrict transmission to HTTPS in those environments |
| Expiry | `session.expiresAt` | Browser expiry aligns with server session lifetime |
| Domain | Not explicitly set | Host-scoped cookie rather than an application-defined shared domain |

Registration creates organization/admin/session atomically. Login verifies tenant-qualified credentials, creates a new token, deletes the **presented same-user** previous session in a transaction, and inserts the new session. It does not revoke every session on every other device or implement account-wide logout. Logout deletes the current digest scoped by organization/user and clears the cookie with matching path/security options.

HttpOnly does not make same-origin XSS harmless: injected code could issue authenticated requests or read cached data even without reading the token. If a database leak also exposes `users`, Argon2id protects their encoded password hashes; token digests and password KDFs address different recovery risks.

### 5.3 CSRF, Origin, and JSON enforcement

`apps/server/src/http/security.js::createOriginGuard()` checks POST/PUT/PATCH/DELETE under `/api/v1`. The Origin must equal `new URL(env.APP_ORIGIN).origin`; absent, `null`, or foreign origins return `403 INVALID_ORIGIN`. The media type must be `application/json`, otherwise `415 JSON_REQUIRED`. This includes public registration/login to prevent login CSRF.

There is no synchronizer-token CSRF scheme. The defense combines exact Origin enforcement, JSON requests, same-origin application fetches, and SameSite cookies. Origin checks are not authentication and cannot stop an attacker with stolen credentials from an arbitrary HTTP client. They address browser-origin threats; same-origin XSS remains a separate issue.

`apps/web/vite.config.js` proxies relative `/api` requests to the API in development, so the browser uses its app origin. `http://localhost:5173` and `http://127.0.0.1:5173` are different origins; using the wrong one can produce legitimate CSRF rejections. This guard is not a permissive CORS setup.

### 5.4 RBAC plus object-level authorization

`requireRole()` protects routers/actions; `assertAdmin()` and worker-only checks also protect service entry points. Strict `createWorkerSchema` has no `role` field, and `createUsersService()` writes `role:'worker'`. An admin cannot elevate a provisioned user through body injection.

Worker save/submit additionally require current assignment and editable state. Admin review requires `submitted`; approved/cancelled are closed. `findWorker()` queries a user with matching tenant and `role='worker'` under `FOR SHARE`. A composite user FK alone cannot enforce those roles.

Client `RequireSession`/`RequireAdmin` guards and role-aware navigation are usability controls. Server middleware, service access checks, row predicates, and constraints remain the authorization boundary.

### 5.5 Shared Zod validation at each boundary

| Source file | Key constraints to recall |
| --- | --- |
| `packages/contracts/src/auth.js` | Strict objects; UUID organization; trimmed names; trimmed/lowercase valid email up to 254; untrimmed 12-128 password; public response owner agreement |
| `packages/contracts/src/assets.js` | Nonempty trimmed code/name/category/location limits 64/160/100/240; status enum; numeric baseVersion; update must include an editable field; query status/q limits |
| `packages/contracts/src/inspections.js` | Template items 1-50 with unique UUIDs and labels up to 240; template name 160/instructions 2000; unique answer IDs, nullable outcomes, notes 1000; report 10000; review note 2000; mandatory mutationId and update baseVersion; snapshot reference agreement |
| `packages/contracts/src/evidence.js` | Simple filenames up to 180 characters; allowed photo/audio MIME types; 10/25 MiB limits; lowercase SHA-256; UUID ownership/mutation/job pointers; bounded membership baseVersion; strict upload, processing and report result schemas |
| `packages/contracts/src/ai.js` | Source-bound image/voice/report requests; explicit confirmed apply/reject; bounded unique checklist findings/transcript/report text; original/review/model metadata schemas |
| `packages/contracts/src/analytics.js` | Strict 7/30/90-day/asset queries; safe integer counts, current states, bounded daily activity and at most 50 asset summaries |
| `packages/contracts/src/offline.js` | Raw local text; workspace IDs; row/reference ownership; matching outbox mutation IDs and checklist membership; nonnegative generations with acknowledged <= local |
| `packages/contracts/src/health.js` | Exact health/error envelopes; finite nonnegative latency; overall health agrees with dependencies; UUID requestId |

Browser forms call `safeParse()` for feedback. `http/errors.js::parseRequest()` parses request body/path/query and returns stable `400 INVALID_REQUEST` field names. Services perform database-dependent checks that schemas cannot prove. Repository serializers map snake_case to camelCase, convert PostgreSQL Dates to ISO strings, and parse public response schemas. Routers and `apiRequest()` validate response envelopes; Dexie reads/writes parse the local contracts.

This is runtime validation in `.js`/`.jsx`, not TypeScript compile-time typing. Unknown keys are rejected rather than silently mass-assigned. API version fields are numbers, not coercively parsed strings; environment ports deliberately use coercion. JSONB SQL checks and Zod checks complement each other but do not have identical strength.

### 5.6 HTTP hardening, SQL safety, and operational limits

`app.js` disables `x-powered-by`, applies Helmet, supplies random `X-Request-Id`, and prevents HTTP caching. M2 template/inspection JSON bodies are capped at 128 KiB; M1 forms at 32 KiB. Invalid JSON is `400 INVALID_JSON`; oversized bodies are `413 REQUEST_TOO_LARGE`. Known uniqueness violations (`23505`) map to duplicate-email/code/record errors. Unexpected exceptions return generic `500 INTERNAL_ERROR` without connection strings or SQL text.

`infrastructure/logger.js` redacts authorization/cookie/Set-Cookie and named secret fields. It does not justify logging arbitrary raw report bodies or dumping environment objects. The exception handler logs an error type, not raw database error details. Parameterized SQL prevents data becoming executable SQL; escaping `\\`, `%`, and `_` in asset ILIKE search additionally makes wildcard input literal. These are different protections.

The fixed audit table/key map and validated migration/test schema names are the only sources for those interpolated SQL identifiers; values remain parameters. Identifiers cannot generally be bound as `$1`, so allowlisting matters. `createPool()` validates `search_path` identifiers with a conservative regex before constructing its connection option.

`config/schema.js` parses boolean strings explicitly, so `AI_ENABLED=false` is Boolean false, not a truthy string. Production requires HTTPS APP_ORIGIN and storage endpoints. DATABASE_URL/REDIS_URL hosting adapters support verified external TLS. Server `.env` loading is explicit; Vite exposes only VITE-prefixed variables rather than database/Redis/S3/provider secrets. Docker ports bind to loopback. API and worker shutdown have ten-second deadlines; interrupted jobs recover through leases. HTTP CSP restricts scripts/storage connections and permits self-only microphone recording and blob media.

`http/rate-limit.js` implements bounded per-process auth/AI burst guards (60/minute/peer and 10/minute/tenant/user by default). PostgreSQL separately serializes the durable 20/hour/actor AI budget across instances. These are not a distributed brute-force prevention guarantee. Trust proxy defaults to zero; the proposed Render ingress uses one hop. Email verification/reset, MFA, local-data encryption, general role management and antivirus scanning remain outside scope. M4 MIME/checksum validation is not malware scanning. A real local recovery drill is implemented; continuous production backups and cloud recovery are operator/deployment work described in [SECURITY.md](./docs/SECURITY.md) and [BACKUP_RESTORE.md](./docs/BACKUP_RESTORE.md).

## 6. Testing Strategy & Engineering Trade-offs

### 6.1 Test pyramid and recorded verification

`IMPLEMENTATION.md` records M5 verification on 2026-11-17: **110 automated tests passed, zero failed/skipped**, migration 005 applied, and a successful production build. The count is **9 foundation + 14 M1 + 17 M2 + 3 PostgreSQL M3 + 14 core M3 + 23 M4 + 18 M5 integration + 6 provider + 5 security + 1 restore = 110**. Real PostgreSQL/MinIO/Redis/BullMQ coexist with controlled transport/crash faults and local provider HTTP simulations. Browser harness results and their limits are recorded separately; no paid provider or Render deployment is claimed.

| File | Layer | Main evidence |
| --- | --- | --- |
| `tests/foundation.test.js` | Unit/HTTP contract tests with injected health behavior | Environment parsing, inconsistent health rejection, 200/503 semantics, malformed output, secret-safe errors |
| `tests/m1-auth-assets.test.js` | Real PostgreSQL + Express HTTP | Sessions/Argon2 format, tenant predicates, role guards, composite FK failures, origin/JSON errors, versions, asset audits, rollback, migration rerun |
| `tests/m2-inspections.test.js` | Real PostgreSQL + Express HTTP | Frozen snapshots, checklist validation, workflow/review, concurrent writers/replays, scoped receipts, reassignment revocation, atomic revision/audit/receipt failure handling |
| `tests/m3-sync.test.js` | Pure transitions + injected store/transport | Coalescing, frozen retries, ordered version advancement, newer-edit retention, conflict merge, no-ops, stopped/mismatched workspace, access failure, stale render |
| `tests/m3-postgres.test.js` | In-memory local transition fixture + real HTTP/PostgreSQL server | Actual receipt replay after response loss, new-ID merge submission, cancellation/session failure retention |
| `scripts/verify-m3-browser.js` | Built React app + actual IndexedDB/service worker + real PostgreSQL | Offline save/submission, reload/restart, reconnect, two tabs, tenant switch/logout, expiry, reassignment return, quota retry, mobile/cache/page-error checks |
| `tests/m4-integration.test.js` | Real PostgreSQL/MinIO + Redis/BullMQ; controlled offline/worker faults | Tenant/composite-key boundaries, constrained policies, validation/promotion, rollback/removal cleanup, immutable closed membership, readiness gates, file replay/conflicts, archives, retries, lost entries, real process termination and lease fencing |
| `tests/m5-integration.test.js` | 18 real PostgreSQL/MinIO/Redis/BullMQ cases, including local HTTP provider simulation | Source/review/tenant boundaries, explicit apply/reject, immutable originals, rollback/retry/reconciliation/fencing, durable cost budget and analytics scope/performance |
| `tests/m5-provider.test.js` | 6 provider contract simulations on a real local HTTP server | Structured responses, multipart transcription, model provenance, bounded failure/fallback/timeout and partial transcription retention; no paid calls |
| `tests/m5-security.test.js` | 5 mixed real HTTP/URL-adapter and pure boundary cases | Peer/actor throttling, production configuration, CSP/microphone/no-store and hosting adapters |
| `tests/m5-restore.test.js` | 1 actual pg_dump/pg_restore plus MinIO/Redis recovery | Restored originals, reviews, provenance, revisions, receipts and jobs in disposable targets |
| `scripts/verify-m4-browser.js` | Built app + actual Dexie blobs + real PostgreSQL/MinIO/BullMQ | M3-to-M4 storage upgrade, photo/audio quota rollback/retry and restart/replay, direct uploads, gated submission, archives, lost-response retention/merge cleanup, mobile/cache/page-error checks |

`tests/helpers/offline.js::MemoryStore` reuses the production pure transitions and simulates local persistence/order; it is not actual Dexie/IndexedDB. Injected network failures make scenarios deterministic. Actual browser tests close the remaining storage/lifecycle gap. The quota test deliberately overrides `IDBObjectStore.prototype.put` to throw `QuotaExceededError`; the rest of storage and the server are real. “Real infrastructure where semantics matter, controlled fault injection where timing matters” is the accurate description.

### 6.2 Isolated PostgreSQL schemas

M1-M5 generate regex-validated isolated schemas, including `fieldsync_m5_<UUID without hyphens>` and scoped M5 pipeline/security/restore/browser prefixes. An admin pool creates the generated schema; a separate pool sets search_path; actual migrations run there. M4/M5 also create private MinIO buckets and Redis queue prefixes. Tests never flush Redis or run the orphan sweeper against the development bucket. The restore drill additionally provisions a disposable database and another private bucket/queue target.

Schema identifiers are generated/regex-validated before trusted DDL interpolation. Values still use parameterized SQL. Tests can assert real `23503` FK failures and locking/transaction behavior without touching development tables. Cleanup closes explicit M1/M2 listeners and pools, drops only the generated schema, and closes the admin pool. M3 uses Supertest's managed HTTP lifecycle around `createApp()` and closes its pools/schema in hooks.

Root `npm test` uses `node --test --test-concurrency=1 tests/*.test.js`. node-pg-migrate uses database-wide migration locking even when suites use different schemas, so suite migrations run sequentially. Concurrency tests **inside** a suite still use `Promise.all()` to issue simultaneous requests. Sequential test-file execution does not remove the writer races being tested.

`runMigrations()` validates the schema, sets `checkOrder:true`, `singleTransaction:true`, and uses `pgmigrations`. Startup does not automatically migrate; `npm run db:migrate` is explicit. Sequential filenames produce the recorded node-pg-migrate timestamp advisories but ordered reruns are tested as no-ops.

### 6.3 Proving atomic failure, not merely successful CRUD

M1 creates temporary PL/pgSQL triggers that reject `asset_events` or `sessions` insertion. Tests verify no asset/organization/user partial state survives. M2 similarly rejects `template_events`, and iterates through `inspection_events`, `inspection_revisions`, and `mutation_receipts` insert failures. It checks the aggregate/history remain unchanged and no successful receipt exists; after removing the trigger, the identical mutation succeeds.

Distinct concurrent updates from the same base produce one success and one version conflict. Simultaneous identical receipt replays produce one business effect and consistent returned results. Changed content under the same mutation ID is rejected. Revoked/expired access cannot replay old success.

The M3 PostgreSQL lost-response test first waits for a **real successful server response/commit**, then throws a simulated transport error before the local ack. Later it replays unchanged content and asserts inspection version 3 after save+submit, exactly three revisions/events including creation, and two worker success receipts. This tests the ambiguous-commit boundary more directly than mocking a successful mutation entirely.

### 6.4 Real-browser offline verification

The browser harness serves built assets and the actual API from one ephemeral loopback origin, uses a generated persistent Edge profile, and runs migrations in a separate PostgreSQL schema. `launchPersistentContext()` plus close/reopen verifies a full browser restart, not only a React rerender. `context.setOffline()` affects the browser while independent API contexts can create remote changes.

It reads real IndexedDB stores to assert owner IDs, queue order, and content. It checks version/receipt outcomes in PostgreSQL, second-tab read-only/edit-lock transfer and simultaneous reconnect, stale remote recheck during merge, cross-tab offline logout, switching tenants without draining the old namespace, reauthentication, lost assignment and its return, quota failure with intact buffer, shell cache exclusion of `/api/`, zero page errors, and no overflow at 390px.

The harness cleans up profile/listener/API contexts/pools/schema in `finally`, validating its generated profile path before recursive deletion. M4/M5 also close workers/queues and remove their private buckets/Redis keys. Playwright comes from existing `.local/qa/node_modules/playwright/index.mjs` or FIELDSYNC_PLAYWRIGHT_PATH; no project dependency was added. M3 uses an ephemeral loopback port; M4/M5 use local APP_ORIGIN for real MinIO CORS and fail safely if that port is occupied. M5 adds explicit AI confirmation/response-loss retry, newer-device-intent merging, stale-job prevention, actual offline MediaRecorder quota/restart/replay, voice/photo fallback review, manager approval/provenance/archive, scoped analytics and mobile chart checks. These local checks do not verify cloud deployment or live model accuracy.

Useful existing commands:

```text
npm test
npm run test:m1
npm run test:m2
npm run test:m3
npm run test:m4
npm run test:m5
npm run build
npm run test:m3:browser     # build first; existing Playwright and PostgreSQL needed
npm run test:m4:browser     # build first; all services; free local APP_ORIGIN port
npm run test:m5:browser     # actual MediaRecorder, review/approval and analytics
node --test tests/m5-restore.test.js  # disposable local database/object recovery
npm run worker             # separate foreground evidence/cleanup/report process
npm run db:migrate        # explicit application migration
npm run check:env         # actual PostgreSQL, Redis, MinIO bucket probes
```

### 6.5 Design trade-offs to defend

| Decision | Benefit in this codebase | Cost / condition for reconsideration |
| --- | --- | --- |
| Modular monolith, three workspaces | Shared contracts and one database transaction; fewer deployment/network boundaries | Independent scaling/releases may eventually justify extracting measured bottlenecks |
| Raw parameterized SQL rather than ORM | Tenant predicates, locks, casts, conditional updates, and indexes are directly reviewable | More handwritten mapping/query maintenance; correctness relies on contracts/tests |
| Shared Zod in JavaScript | Runtime safety for HTTP, config, and Dexie without a TypeScript migration | No compile-time guarantees; schemas do not prove database-dependent authorization |
| Shared tables + composite tenant FKs | Explicit scope and structurally impossible cross-tenant references | Missing read predicate still leaks; RLS could add defense-in-depth |
| Bounded JSONB checklists/snapshots | Ordered flexible forms and self-contained reports; no separate item engine | Repeated snapshots, limited SQL validation/analytics; bounded 50-item forms reduce complexity |
| Full inspection revisions + field audits | Immediate historical report rendering and readable change trails | Storage/write amplification; no event-sourced reconstruction or cryptographic history protection |
| Base version + row lock | Simple aggregate invariants and no silent stale writes | One aggregate's writes serialize; users must resolve genuine conflicts |
| Durable receipts + immutable attempts | Safe retries through ambiguous network outcomes | Receipt retention/storage growth; mutation IDs must never be reused for changed input |
| Client outbox + per-endpoint replay | Reuses M2 security/transactions; per-inspection error isolation | Extra HTTP round trips/full-list pulls; no atomic multi-inspection batch |
| Explicit three-way field merge instead of CRDT | Fits finite checklists and controlled approval/assignment transitions | Whole-field text conflicts need human choices; concurrent collaborative text editing is limited |
| Per-user Dexie database | Easy account isolation and durable return-to-account recovery | Multiple retained databases; same-origin local data is not encrypted |
| Web Locks + in-page worker | Minimal native coordination, no leases/dependencies | Browser support required; tab closure delays replay; origin session lock can serialize lengthy drains |
| Page replay interval/debounce | Predictable device replay with finite request timeouts | Browser replay has no exponential backoff/jitter; background jobs separately use bounded exponential delays |
| Shell-only service worker | Offline reopening without auth/API cache leaks | Requires prior production cache; no background sync/full PWA installability guarantee |
| Real PostgreSQL/browser tests | Actual FK, lock, transaction, IndexedDB, and lifecycle evidence | Infrastructure setup/runtime cost; focused fixtures do not replace broad production-scale testing |

CAP reasoning should be scoped: during a network partition, FieldSync permits local draft writes, but does not pretend those writes are already globally accepted/approved. Shared synchronization later resolves conflicts under a central PostgreSQL aggregate version. That is local availability with deferred shared consistency, not an automatic theorem that every operation is AP or that the system is globally linearizable.

Potential scaling work should follow measurements: list pagination/incremental pulls, index plans for searches, bounded receipt/history retention, query/pool contention and browser-store size. The 110-test suite and largest 394.52 kB JS chunk do not establish fleet throughput. M5 measured 20 real HTTP/SQL analytics reads over 1,000 inspection rows: median 34.5 ms, p95 39.9 ms locally. Route splitting removes individual >500 kB build warnings; it does not mean the sum of all chunks is below 500 kB.

### 6.6 M4 evidence/background processing

M4 is implemented in migration 004, `packages/contracts/src/evidence.js`, server evidence/jobs/storage modules, `src/worker.js`, and browser offline/evidence UI modules:

- `OfflineStore.attachFile()` hashes outside the transaction, then commits one Blob, owned metadata and attach intent together. Photo/audio limits are 10/25 MiB; the queued-device budget is 200 MiB and aggregate membership is limited to 50. Quota failures retain the chosen file.
- `replayEvidence()` first checks for a previously committed membership receipt, then reserves/uploads if needed. Reservation and attachment have separate stable IDs. Ordered save/attach/remove/submit replay advances base versions and preserves bytes through uncertain outcomes.
- Presigned S3 SigV4 PUT signatures constrain staging key, MIME, hash metadata and exact file length. Reservations last twenty minutes; transport lasts at most ten. Expired transport renews on a fresh staging generation so old credentials/cleanup cannot affect the new upload.
- `createEvidenceStorage().promote()` checks actual size, MIME signature and SHA-256, then conditionally writes the verified buffer to a fresh server-only UUID key. It does not copy a staging object that could change after verification. Keys and cleanup agree with tenant/inspection/evidence identity.
- Attachment/removal commits membership, version, revision, audit, receipt and required job in one SQL transaction. Rollback cleans an unreferenced candidate; removal cleans bytes after commit with jobs/reconciliation as fallback. Historical revisions keep metadata for deleted files.
- Submitted/approved/cancelled membership is read-only. A requested revision reopens the worker workflow. Processing status is separate from business version. Submission/approval wait for ready evidence; the pre-receipt `EVIDENCE_PROCESSING` check lets a frozen queued submission retry after verification rather than permanently replaying a transient failure.
- PostgreSQL jobs are durable work/outcomes; BullMQ schedules at least once. Five attempts, sixty-second fenced leases, fifteen-second heartbeats, bounded queue-command retries and five-second reconciliation recover lost delivery and process crashes. Final exhausted crash leases also mark attached evidence failed. Age-based cleanup retains live staging and attached objects.
- `prepare_report` reads the saved revision and validates organization/inspection/sourceVersion. It produces escaped manual HTML and a summary, served through a scoped sandboxed archive route. This is asynchronous report preparation without AI or PDF generation.

For local development, `RUN_INLINE_WORKER` defaults to false; run `npm run worker` alongside the API/web process in a separate foreground terminal. The free-tier Render Blueprint sets it to true, so `server.js` starts the same `createJobRuntime()` inside the API process, sharing its environment, PostgreSQL pool and storage. API mutations retain SQL required work during Redis outages; inspections without attachments do not require a live queue to save/submit. MinIO CORS must match APP_ORIGIN and S3_PUBLIC_ENDPOINT must be browser-reachable. A deployment owns its schema/bucket; tests use isolated buckets to prevent an orphan sweep from treating development objects as missing references.

### 6.7 M5 human review, voice, analytics and readiness

`POST /inspections/:id/ai` inserts a source-bound artifact and `assist_inspection` job/receipt atomically without changing the inspection. BullMQ loads the frozen revision and verified selected bytes outside SQL transactions. The optional native-fetch adapter uses structured Responses output and multipart transcription, a combined bounded timeout and no model tools. Disabled/missing-key requests make no provider call. Provider failure/refusal/malformed output settles labeled manual/deterministic assistance; successful transcription is retained if extraction subsequently fails.

`ai_artifacts.original_output/raw_output` retain originals and `sourceVersion`, provider/model/mode, prompt and request metadata. `ai_reviews.confirmed_output` holds human-edited data. Only the assigned worker can apply `confirmed=true` at the current source/base version, atomically advancing draft/version, provenance, revision, audit, review and receipt. Admins can reject and review submitted reports; they do not rewrite worker content. Stale/closed results cannot apply. Provider execution can repeat after a crash, but only the current SQL lease can commit artifact output.

`AiPanel` requires synced online work, holds uncertain in-page review requests for identical retries and freezes the editor. `OfflineStore.acceptReview()` checks local generation/base before acknowledgment; newer device intent remains intact and requires the existing explicit merge. `VoiceRecorder` captures WebM/Ogg up to five minutes through actual MediaRecorder. Attach before leaving the page; M4's Blob/metadata/outbox transaction supplies durable offline storage, quota retry, browser restart and upload-before-submit. No new Dexie version or offline AI action is added.

`GET /analytics` derives scope from the session: workspace for admins, current assignments for workers. A read-only repeatable-read query reports current statuses/failed checks of records created within 7/30/90 UTC days, latest-submission timing/activity, current asset counts and up to 50 asset summaries. Counts are checked safe integers. These metrics do not predict failure.

The local restore test performs actual pg_dump/pg_restore into fresh targets, recovers verified MinIO bytes/headers and reconciles a report job from restored SQL into Redis. It preserves AI originals/confirmed reviews/revisions/receipts. The recorded fixture dump was 97,070 bytes and recovery work took 993 ms; this is not a production RPO/RTO. [render.yaml](./render.yaml) and the [deployment](./docs/DEPLOYMENT.md), [security](./docs/SECURITY.md) and [recovery](./docs/BACKUP_RESTORE.md) guides are locally validated readiness artifacts. They document external private HTTPS storage, private hosted services, secret inputs and the internal Render PostgreSQL self-signed TLS limitation. No Render account-linked step has occurred.

Email verification/password reset, Mailpit, maintenance tasks, ZIP recovery, generated PDFs, microservices and Kubernetes remain outside scope.

The explicit Render gate applies before creating, linking, configuring or deploying a backend service, and before any account-linked CLI/API step. Stop and ask the user to switch their active account and authorize continuation. Blueprint creation itself may deploy even with auto-deploy disabled.

### 6.8 Why a single Render web service on the free tier?

`render.yaml` selects `plan: free` for the Node web service, PostgreSQL 17 and private Key Value/Redis. Render has no free background-worker service, so `RUN_INLINE_WORKER=true` runs BullMQ inside the web process that also serves React and the API. The local standalone worker remains available with the flag false. The Render setup uses a free Hobby workspace without a credit card/payment details, no persistent disk and disabled paid AI calls; no account-linked deployment has been performed.

Free web services have no pre-deploy command or shell/one-off jobs. The build remains `npm ci --include=dev && npm run build`; the start command is `npm run db:migrate && npm run start --workspace=@fieldsync/server`. Transactional, locked migrations rerun safely as no-ops on restart, and a migration failure prevents both API and worker startup. `server.js` itself does not run migrations.

`server.js::startServer()` owns the listener and optional runtime. SIGTERM/SIGINT trigger one idempotent shutdown: stop accepting requests, close BullMQ/reconciliation/Redis, drain active HTTP requests and jobs, then destroy shared storage and close PostgreSQL. One ten-second deadline bounds the process; interrupted jobs recover through SQL leases on the next start. Listener startup failure follows the same cleanup with a failing exit code.

The trade-off is delayed background work and shared memory/CPU. Render spins the free web service down after 15 idle minutes; jobs wait until an HTTP request wakes it. Free Key Value loses all state on restart, so SQL job intent and reconciliation matter. Free PostgreSQL is limited to 1 GB and expires after 30 days, with no managed backups; export before expiration and prepare a fresh demo database/restore. A workspace supports only one free database and one free Key Value instance, and its 750 monthly free web hours plus bandwidth/build allowances constrain availability without payment details.

Evidence uses presigned PUT uploads into separately provisioned private HTTPS S3-compatible storage, including Cloudflare R2. SigV4 binds the exact staging key, Content-Type, Content-Length and SHA-256 metadata; backend byte verification and conditional promotion remain mandatory. R2 uses its S3 API endpoint, auto region, a bucket-scoped Object Read & Write token and origin-specific PUT CORS; [R2_SETUP.md](./docs/R2_SETUP.md) documents the inputs. R2 billing/included usage is separate from Render. The Blueprint alone cannot host every M0-M5 feature entirely on Render's free tier or keep the database available indefinitely. See [DEPLOYMENT.md](./docs/DEPLOYMENT.md) for lifecycle, secrets, release and backup details.

## 7. Top 25 Likely Interview & Viva Questions

### Architecture & DB

#### 1. What does FieldSync do, and what is technically difficult about it?

Admins assign/review inspections; workers record checklists/narratives offline. The hard part is preserving local intent across ambiguous network results and concurrent shared changes, handled by Dexie outbox transactions, PostgreSQL versions/receipts, and explicit merges. Start with `apps/web/src/offline/` and `apps/server/src/modules/inspections/`.

#### 2. Why a modular monolith and three npm workspaces?

One Express business deployment keeps aggregate, history and receipt writes in one transaction. React and portable Zod contracts are separate packages for clear dependency boundaries and reuse, without introducing network calls between business modules. Root `package.json` defines the workspaces.

#### 3. How do you prevent cross-tenant access when the client knows another UUID?

Authentication derives the organization from the session; repositories include it and worker access checks assignment. Composite FKs prevent foreign-tenant references; M4 also binds a job's evidence to the same inspection and validates storage prefixes. Foreign UUIDs return scoped 404s. See auth middleware, inspection/evidence services and migrations 001-004.

#### 4. Why do globally unique IDs still need `(organization_id, id)` unique constraints?

A single UUID FK proves existence, not same-tenant ownership. The composite unique key is the valid PostgreSQL target for a composite owner/resource FK. It prevents, for example, an organization A inspection from referencing organization B's asset.

#### 5. Do composite FKs replace RLS?

No. FKs enforce relationship integrity; explicit predicates enforce current read scope. No RLS policies are installed. RLS could add filtering defense, but would require audited tenant context and privileges, and would still need the composite relationships.

#### 6. What happens if a template changes after an inspection is assigned?

`assignmentSnapshots()` stores a template ID/version/item snapshot and asset metadata. Later source edits do not rewrite existing inspection snapshots. Full `inspection_revisions` preserve prior report states; reassignment updates the current worker snapshot while old revisions retain the old worker.

#### 7. Why JSONB, and is this event sourcing?

Bounded ordered forms and frozen reports fit JSONB without a configurable form engine or item table. Services/Zod validate stronger shapes than SQL array checks. The current row is authoritative with appended revisions/audits; it is not reconstructed from events, so this is not event sourcing.

### Concurrency & Offline Sync

#### 8. Why use both `baseVersion` and `SELECT FOR UPDATE`?

The version detects stale intent; the short lock serializes the final read/validate/update plus audit/revision computation. The conditional UPDATE repeats the version guard. A waiting writer must reject a stale base instead of overwriting after it acquires the lock.

#### 9. What if the server commits but the worker receives no response?

The attempted request remains frozen in IndexedDB. Replaying the same ID/body/base returns the stored PostgreSQL receipt after current access checks, without another version/audit/revision. `mutations.js` and the M3 PostgreSQL lost-response test demonstrate this.

#### 10. Why hash the payload when the mutation ID is already unique?

Uniqueness locates the intent; the fingerprint proves the retry is the same operation/input. Recursive object-key canonicalization plus SHA-256 rejects changed payload/target/base under that ID with `MUTATION_ID_REUSED`. Arrays remain ordered.

#### 11. Why does the server check access before replay but workflow/version after it?

Revoked workers cannot replay old data. However, a successful submit already changed version/state, so rechecking its old mutable preconditions before receipt lookup would falsely reject the retry. `mutate()` separates these checks in that order.

#### 12. Can typing continue while a save is in flight?

Yes for saves. A later generation gets its own pending intent; the old acknowledgment advances base but cannot replace newer content. Only unattempted work can take the acknowledged version. Submission and uncertain online AI reviews pause editing. `state.js::acknowledge()`, `LocalEditor` generation guards and M5 `acceptReview()` preserve newer intent.

#### 13. Why must content and outbox writes share one IndexedDB transaction?

Otherwise a crash could leave unsent content with no replay intent, or replay an intent the local UI did not commit. `OfflineStore.transition()` commits both; prepare freezes before HTTP and ack updates copy/cache/queue atomically.

#### 14. How do two tabs and two devices differ?

Same-origin tabs share Dexie state and native Web Locks for an editor, workspace drainer, and session transitions. Different devices do not share those locks; PostgreSQL OCC/receipts and merge review arbitrate their shared updates. `provider.jsx` and `useEditorLock()` cover tabs.

#### 15. How is a 409 merged without last-write-wins?

Retain original base, latest local, and fetched remote. Independent outcome/note/narrative edits combine; overlapping scalar changes need an explicit choice. Recheck remote version/local generation and queue a fresh ID against that base. Server-controlled workflow/assignment/approval fields are never merged from local input.

#### 16. Why no CRDT or batch sync endpoint?

Finite checklists and approval/assignment invariants fit aggregate versions plus explicit review. Existing M2 endpoints already provide validation, permissions and atomic receipts. CRDT text semantics or batches would add complexity and would not automatically solve workflow authorization; revisit only for demonstrated collaboration/round-trip needs.

### Security

#### 17. Do you use scrypt? Why is SHA-256 also present?

Passwords use salted Argon2id with 19 MiB memory, two iterations and one lane. SHA-256 fingerprints high-entropy session tokens and canonical mutation requests, not human passwords. The salt/parameters are encoded in `users.password_hash`; no separate salt column exists.

#### 18. How are sessions secured and revoked?

A 32-byte random token is in a HttpOnly, SameSite=Lax cookie, Secure in production/HTTPS. PostgreSQL stores only its digest and expiry. Same-user presented-token rotation invalidates that session; logout deletes the current scoped session. There is no JWT or automatic account-wide revocation.

#### 19. How do you prevent CSRF and SQL injection?

Unsafe HTTP methods require exact APP_ORIGIN and JSON, including login/register; cookies also use SameSite. SQL binds request values, while identifiers come from fixed maps/validated schema names. Asset search escapes LIKE wildcards separately. See `http/security.js`, repositories, and origin/FK/search tests.

#### 20. Is a client role guard or cached offline identity sufficient authorization?

No. Client guards select usable views and the correct local namespace. Every server request derives live session identity/role, checks tenant and assignment, and enforces workflow. Cached identity can keep local work visible offline but cannot authorize a network mutation after expiry/reassignment.

### Debugging / Failure Scenarios

#### 21. An audit insert fails after the inspection UPDATE. What survives?

An unexpected SQL failure rolls back the aggregate, revision, audit and new receipt together. The same intent can retry after the fault is removed. M2 tests inject rejecting PostgreSQL triggers into each of those write points and prove rollback/retry.

#### 22. A worker is reassigned, cancelled, or logged out with pending work. Do you delete it?

No. Reassignment/cancellation retain a blocked/read-only copy and queue. Expiry pauses for sign-in. Logout removes active identity and isolates the database; offline logout queues server logout before a later login. A restored assignment can explicitly re-enter merge review, and returning to the original account reopens its retained namespace.

#### 23. The UI says saved, but an answer disappeared after rapid typing. Where would you look?

Inspect `LocalEditor`'s serialized writes, dirty/pending flags, `committedGeneration`, and incoming Dexie generation. A transaction can complete before its live-query render; accepting an older render overwrites the fast buffer. Also check acknowledgment generation versus the attempted entry. For AI review, inspect `acceptReview()`'s expected generation/base and its explicit conflict path for newer device edits. Do not solve it by indiscriminately replacing content with a server response.

#### 24. The app will not reopen offline, or displays Online but never syncs. What do you inspect?

Check prior production shell registration/control/cache, secure context and Web Locks support; dev mode installs no shell. For replay, inspect `fieldsync:session` flags/owner, `/auth/me`, workspace/editor/session locks, retained head status/errors, and network responses. Online is based on `navigator.onLine`, not proof the API is reachable. Never delete IndexedDB or regenerate an attempted ID as a first debugging step.

#### 25. Redis/AI is down, quota is exhausted, or migrations conflict. How do the responses differ?

Redis failure makes `/health` degraded/503; inspection writes keep SQL job intent for reconciliation. Missing/failing AI yields labeled fallback assistance and never blocks manual content. A device quota failure retains input/captured audio until a successful attachment/save. Parallel suite migrations collide with node-pg-migrate's database-wide lock, so files run sequentially while writer races remain concurrent inside suites. These are different infrastructure, provider, durability and test-orchestration failures.

### A final rehearsal exercise

Using only the named files, explain one worker edit from `LocalEditor` through a committed Dexie transaction, frozen HTTP attempt, server row/receipt locks, inspection/revision/audit/receipt commit, and generation-aware local acknowledgment. Then change one assumption: lose the response, change the remote version, expire the session, switch the account, or fail the audit insert. For each, state what is durable, what is uncertain, which layer stops the operation, and which identity/version must be checked before recovery.

Repeat for an AI request: trace the source revision, selected verified bytes, provider/fallback job, immutable original, human-edited confirmation and version-aware apply. Then make the source stale, lose the review response or restore into empty Redis. Explain why generation never approves findings, how original and confirmed content remain separate, and why local readiness still requires an explicit Render account-switch approval before deployment.
