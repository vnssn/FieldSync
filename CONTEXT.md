# FieldSync — persistent engineering context

Read this file and IMPLEMENTATION.md before making changes. The user's latest instructions override this document; update both documents when accepted decisions change.

## Product and current scope

FieldSync is an offline-first field inspection application, implemented as a JavaScript modular monolith. Organizations manage assets and assign inspections to workers. Workers capture findings and photographs offline, then synchronize. Managers review and approve submitted reports.

The three implemented assistance features are image observation suggestions, voice-to-findings, and report narratives. Each requires explicit human review. Report narratives support a direct Groq Chat Completions call selected by AI_REPORT_PROVIDER=groq, with server-only GROQ_API_KEY and configurable GROQ_MODEL (default openai/gpt-oss-20b). An absent selector preserves the OpenAI adapter; .env.example explicitly selects Groq for new setups. Photo/voice assistance retains OpenAI. AI_ENABLED defaults to false; requests use labeled deterministic/manual fallbacks without a working provider, and the manual inspection workflow remains independent of AI.

The accepted simplifications are:
- No email verification or password reset flows; no Mailpit or email infrastructure.
- No maintenance_tasks module.
- No ZIP recovery exports.
- No microservices, Kubernetes, chatbot, or AI-centered product redesign.

M0-M5 are implemented and locally verified; M5 and the full M0-M4 regression were verified on 2026-11-17 with 110 automated tests, the build, real infrastructure/restore and all three browser harnesses passing. M0 provides infrastructure and a live status page. M1 adds sessions, tenant isolation, teams and assets. M2 adds templates, assignments, checklist execution, human-written reports, admin review, historical snapshots, audits and mutation receipts. M3 adds durable local checklists, an ordered outbox, automatic replay and explicit conflict merges. M4 adds durable local photo/audio blobs, private staging uploads, immutable verified evidence, verification-gated submission, and PostgreSQL-backed BullMQ processing/cleanup/report archives. M5 adds reviewed AI artifacts, offline voice recording, scoped analytics, HTTP/hosting hardening, a real restore exercise and local deployment guides/configuration. No Render account-linked action or paid AI call has been performed. Never present planned or cloud-unverified behavior as verified.

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
- Artifacts bind organization/inspection/source revision/evidence/requester; reviews bind organization/inspection/artifact/reviewer/applied revision through composite FKs.
- Only the assigned worker applies confirmed fields to editable content. Admins inspect/reject suggestions and review submitted reports through the existing workflow.
- Generation never updates inspection answers, report text or version. Applying a review commits content, provenance, revision, audit and receipt together.
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
      src/offline/
      src/main.jsx
      src/styles.css
      vite.config.js
      offline-shell.js
      build.js
    apps/server/
      src/app.js
      src/server.js
      src/config/
      src/infrastructure/
      src/modules/health/
      src/modules/auth/
      src/modules/users/
      src/modules/assets/
      src/modules/templates/
      src/modules/inspections/
      src/modules/evidence/
      src/modules/jobs/
      src/modules/ai/
      src/modules/analytics/
      src/worker.js
      src/http/
      migrations/001_init_auth.js
      migrations/002_init_assets.js
      migrations/003_init_inspections.js
      migrations/004_init_evidence_jobs.js
      migrations/005_init_ai_analytics.js
      scripts/migrate.js
    packages/contracts/src/
      constants.js
      health.js
      auth.js
      assets.js
      inspections.js
      offline.js
      evidence.js
      ai.js
      analytics.js
      index.js
    scripts/
      infra.js
      setup-storage.js
      check-environment.js
      verify-m3-browser.js
      verify-m4-browser.js
      verify-m5-browser.js
    tests/
    docs/DEPLOYMENT.md
    docs/SECURITY.md
    docs/BACKUP_RESTORE.md
    docker-compose.yml
    render.yaml
    .env.example
    CONTEXT.md
    IMPLEMENTATION.md
    EGM.md
    INTERVIEW.md

Add future feature modules when their milestone begins, rather than creating empty architectures.

## Layering and coding conventions

HTTP routes validate requests and call business services. Services enforce permissions, state transitions and transaction boundaries. Repositories own raw parameterized SQL. Worker handlers reuse services where appropriate.

React's worker editor reads local working copies through Dexie. TanStack Query is for online queries and polling; it must not become a competing draft store.

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
- M1 assets/team administration is an online workflow. M2 provides mutation receipts; M3 reuses inspection endpoints for offline checklist replay.
- tests/m1-auth-assets.test.js uses a random isolated PostgreSQL schema, the real migrations and an ephemeral HTTP listener; its after hook closes the listener/pools and drops only that generated schema. PostgreSQL must be available, with permission to create/drop test schemas. Never truncate application tables for tests.

## M2 online templates, inspections and review contract

- Templates are admin-managed, versioned ordered checklists with 1-50 UUID-addressed items, a name and instructions. Updates include baseVersion and replace the checklist explicitly. Archiving prevents new assignments. Existing inspections retain their frozen template and asset snapshots.
- Admins assign an active asset and active template to a worker in their organization. Every reference uses organization_id in SQL and composite foreign keys. Tenant and actor IDs come only from request.auth; assignment cannot provision or elevate a user.
- Workers list/read only their own assignments; admins list/read all organization inspections. Only the currently assigned worker can save checklist content or submit a report. Admins control assignments, cancellation and review, and cannot edit worker content.
- Each answer has an itemId, pass/fail/not_applicable (or null in a draft), and notes. Drafts may be incomplete. Submission requires an outcome for every frozen checklist item and a nonempty note for each failure. The report narrative is human editable; failed-check notes are the current findings representation. M4 supplies evidence; there is no separate findings table.
- Editable states are assigned, draft and changes_requested. Saving enters draft; submission enters submitted. Admins request changes with a required note or approve a submitted report. Reassignment is allowed only in editable states and retains saved answers. Approved/cancelled inspections are read-only. Versioned review and cancellation use the same locking/audit rules as worker saves.
- Every M2 write carries mutationId; updates also carry numeric baseVersion. The server locks the target with SELECT FOR UPDATE and performs a conditional version increment. Stale requests return 409 VERSION_CONFLICT. Failed/no-op requests never increment the aggregate or append a revision/audit.
- The aggregate update, inspection revision, field-level audit event and successful receipt commit together. Template updates also have atomic audits/receipts. Revisions and audit records are append-only through application code, and historical report views use stored snapshots.
- Receipt keys are unique to organization/user/mutationId. A transaction-scoped advisory lock serializes just that receipt key. The normalized request hash includes the operation and target. Identical replays return the recorded success or expected domain error; changed requests return 409 MUTATION_ID_REUSED. Current authorization runs before replay, and replay runs before workflow/version checks. Unexpected database/transaction failures roll back the receipt and permit retry.
- M2 requests/responses use packages/contracts/src/inspections.js. Templates/inspections allow JSON bodies up to 128 KiB; existing M1 routes keep their 32 KiB limit. Object schemas remain strict. M2 adds no dependencies, TypeScript, services or automatic startup migrations.
- Browser routes are /templates (admin), /inspections and /inspections/:id. Admins can filter submitted reports for review. Report printing uses escaped React text and the saved snapshot; historical report selection disables current review/edit actions.
- Admin template/assignment/review forms remain online and retain an immutable request for unconfirmed retries. M3 replaces the worker's online editor with durable local copies, replay and three-way merging; server acknowledgment remains distinct from device saving.
- npm test runs test files sequentially because node-pg-migrate uses a database-wide migration lock; concurrency tests within suites still issue simultaneous requests. tests/m2-inspections.test.js uses its own random PostgreSQL schema and ephemeral HTTP listener, real migrations/transactions, and finally cleanup. No test truncates application tables.

## M3 offline checklist and synchronization contract

- Dexie version 1 opens `fieldsync:<organizationId>:<userId>`. `records` and `workingCopies` use inspection IDs; `outbox` uses an increasing sequence, unique mutationId, and inspection/status indexes. M4 adds version 2's file metadata/Blob stores. Every row includes both owner IDs and uses shared offline Zod schemas. Future schema changes must be additive; logout never deletes retained work.
- Worker list/detail pages use cached assignments and working copies. Each edit atomically commits raw content and an outbox intent; only unattempted pending saves coalesce. Submission is a separate ordered intent and pauses editing until acknowledgment or conflict resolution. Database failures retain the React input buffer and show a retry action.
- Before network dispatch, freeze attempted status, mutationId, normalized body, base snapshot and baseVersion in IndexedDB. Retry uncertain outcomes unchanged. Rebase only unattempted requests onto the preceding acknowledgment, and preserve newer local generations when older requests succeed. Acknowledgment updates the copy/cache/outbox atomically.
- Reuse `GET /inspections?status=all`, detail, `PATCH /inspections/:id` and `POST /inspections/:id/submit`; M3 needs no server migration or batch endpoint. List pulls cache snapshots; details cache history. Missing/reassigned records and pending edits remain retained/read-only. Pulls respect editor locks and cannot silently replace a visible draft's base.
- Web Locks serialize one workspace drainer and one editor per inspection. A separate origin session lock serializes `/auth/me` checks/replay with cookie-changing login/logout. Verify organization/user/worker identity before dispatch and stop on account changes. Dexie live queries share committed state across tabs.
- Reconnect, focus, a 15-second interval, an 800-ms edit debounce and Sync now trigger replay. Conflict/blocked heads pause only their inspection. HTTP 401 pauses for sign-in; revoked access/closed workflow keeps the copy and queue. A restored assignment can be explicitly reviewed and merged.
- Conflicts retain original base, latest local content and fetched remote. Compare answer outcomes, notes and report text independently; require explicit choices for overlaps. Recheck the remote version and local generation before confirming; queue a new mutationId/current baseVersion. Assignment, approval and workflow fields always come from the server.
- Cache only validated public session identity in localStorage, without credentials or tokens. Offline reopening uses its own database. Expiration preserves access to local work and pauses replay. Logout removes active identity immediately, broadcasts across tabs, and records pending server logout when disconnected; finish it before another login.
- The shell shows Online, Offline, Syncing or Conflict plus pending/review counts. Production `sw.js` precaches HTML and hashed static assets only, excluding API/auth responses. Shell upgrades never delete IndexedDB. `apps/web/build.js` sets production NODE_ENV before loading Vite so the shared development .env cannot omit registration or include React development code.
- Offline reopening requires a previously cached production build and a browser supporting IndexedDB, service workers and Web Locks on HTTPS or loopback. Dev mode does not install the shell cache. Asset/admin pages remain online. M4 extends the same worker workspace with file blobs and evidence replay.
- `npm test` includes core sync transitions and real PostgreSQL replay/conflict tests. `npm run test:m3:browser` runs built assets and the API on one temporary origin with real IndexedDB and an isolated PostgreSQL schema. It uses `.local/qa/node_modules/playwright/index.mjs` or an explicit `FIELDSYNC_PLAYWRIGHT_PATH`; no dependency was added. Its browser/profile/listener/pools/schema are cleaned up.

## M4 evidence and background-processing contract

- Migration 004 adds `evidence`, `background_jobs` and inspection evidence snapshots. Evidence references organization/inspection/creator through composite FKs; a job's evidence FK includes organization, inspection and evidence ID together. SQL checks enforce tenant-prefixed staging/verified keys.
- Shared evidence contracts accept JPEG/PNG/WebP photos up to 10 MiB and MP3/WAV/Ogg/WebM audio up to 25 MiB, with strict filenames, sizes, MIME and SHA-256. At most 50 files belong to an inspection. Local queued bytes are limited to 200 MiB; quota failures retain the selected file for retry.
- Dexie version 2 adds `files: 'id,inspectionId'` and `blobs: 'id'`; version 1 stores/rows survive. Hash outside IndexedDB transactions, then commit one Blob, owned metadata and an attach intent together. Never store repeated base64 bytes in outbox/snapshots. Attach/remove share aggregate versions and ordered save/submit replay. Acknowledgment clears local bytes atomically; merge confirmation also clears blobs when remote membership already satisfies the intent.
- Reserve through `POST /inspections/:id/evidence/reserve`, obtain a descriptor through `POST /evidence/:evidenceId/upload`, PUT directly to S3-compatible storage, then attach through `POST /evidence`. Reserve uses its own stable mutationId; attachment retries keep their attempted membership mutationId/body/baseVersion immutable. Expired reservations renew transport on a new staging-key generation. Old credentials/cleanup jobs address only their old key.
- Staging reservation TTL is twenty minutes; the signed PUT lasts at most ten minutes and constrains exact key, MIME, hash metadata and file length. Verify actual byte length, magic signature and SHA-256; promote the checked buffer to a fresh server-controlled immutable key. No storage call occurs inside an inspection SQL transaction. API downloads recheck current tenant/assignment and reject removed/failed evidence.
- Attachment/removal atomically updates membership, inspection version, revision, audit, receipt and SQL job intent. Cleanup after rollback deletes only an unreferenced promoted candidate; retain staging for retry. Removal deletes bytes after commit and schedules durable cleanup. Submitted/approved/cancelled membership is read-only; changes_requested allows revision by the assigned worker. Historical reports retain metadata for removed files, whose bytes are deleted.
- Submission/approval require every attached file's processing status to be ready. `EVIDENCE_PROCESSING` and failed-evidence prerequisites are checked before a new receipt is written; existing successful receipts still replay after workflow advances. The client defers pending verification without changing the attempted submission and retries on its normal wake-ups. Failed evidence retains blocked work for explicit review/removal. Processing status never changes inspection business version.
- `npm run worker` starts a separate foreground BullMQ process using the API's .env/bucket/QUEUE_PREFIX. PostgreSQL `background_jobs` is both required-work outbox and authoritative outcome; Redis is scheduling transport. Handlers support verification, staging/removal cleanup and deterministic report archives. Reports read the saved source revision, validate tenant/inspection/version and escape human text; AI and generated PDFs remain outside M4.
- Five durable attempts use exponential delays. Sixty-second leases heartbeat every fifteen seconds; completion/failure writes require the current lease token. Five-second reconciliation republishes due/lost work and settles exhausted crash leases plus failed evidence status. Queue errors are handled; bounded publisher retries preserve SQL work during Redis outages. Minute sweeps reap objects older than one hour only if no live staging/attached reference remains. A deployment must own its bucket/schema; verification uses isolated buckets.
- MinIO CORS matches APP_ORIGIN; S3_PUBLIC_ENDPOINT must be reachable by the browser. M4 browser verification uses that local APP_ORIGIN port for real direct uploads and fails safely if it is occupied. Both browser harnesses use existing Playwright, temporary profiles/listeners/schemas and finally cleanup; M4 also removes its private bucket/Redis queue. No development process is stopped or left running.

## Accepted free-tier deployment update — 2026-11-18

The Render Blueprint uses `plan: free` on the web service, PostgreSQL and Key Value; the separate paid worker service is removed. `RUN_INLINE_WORKER=true` starts the existing BullMQ runtime inside `server.js`, sharing the API pool and storage. The flag is validated as a strict Boolean string and defaults to false for standalone local development. SIGTERM/SIGINT drain HTTP/jobs before closing shared resources under one ten-second deadline; listener startup failures also clean up.

Free services lack pre-deploy hooks, so the Blueprint start command explicitly runs `npm run db:migrate && npm run start --workspace=@fieldsync/server`. Migrations rerun safely before both runtimes; application code itself still does not migrate. No paid resources or payment details are requested. Idle web shutdown pauses jobs, free Redis loses state on restart, and free PostgreSQL is limited to 1 GB and expires after 30 days. Full evidence/voice workflows still require external private HTTPS S3-compatible storage, whose free/cardless availability is separate from the Blueprint. No indefinite, entirely Render-hosted M0-M5 deployment is claimed. See [DEPLOYMENT.md](./docs/DEPLOYMENT.md).

## Accepted R2 PUT transport update — 2026-11-18

Evidence descriptors now authorize raw presigned PUT uploads, with a strict method/headers/size/expiry contract. SigV4 binds the browser endpoint, tenant staging key, exact Content-Type, Content-Length and SHA-256 metadata. The browser sends the Blob directly without cookies or storage secrets; the API independently checks HEAD/GET size, media signature and reserved SHA-256 before immutable conditional promotion. The official S3 presigner is a server dependency; optional AWS checksum/trailer behavior is disabled for R2 compatibility. Reservations, key-generation renewal, authorization, SQL membership/receipts/jobs, cleanup and Dexie/outbox formats remain the existing protocol.

For R2, use the same private S3 API endpoint for S3_ENDPOINT/S3_PUBLIC_ENDPOINT, region auto, path-style addressing and a dedicated bucket-scoped Object Read & Write token. CORS permits PUT from the actual APP_ORIGIN with Content-Type/x-amz-meta-sha256. R2 resources, live verification, billing, existing-object migration and rollout remain user tasks; no account or environment settings were changed. See [R2_SETUP.md](./docs/R2_SETUP.md).

## Deployment gate

Before creating, linking, configuring, or starting deployment of any backend service on Render, stop and ask the user so they can switch their active Render account. All Render CLI/API/account-linked steps remain gated, including account-linked validation. Local configuration files and public-schema validation are allowed. Blueprint creation can trigger an initial deploy even when autoDeployTrigger is off. This gate is an explicit user requirement.

## M5 assistance, analytics and hardening contract

Deployment follow-up (2026-11-21): Groq/Blueprint repair `5849547` is live on the existing Free Render API. `render.yaml` declares `AI_ENABLED` and `GROQ_API_KEY` with `sync: false` to preserve manually configured values during Blueprint updates. The previous literal defaults could reset the integration; the two variables were restored individually while preserving every other environment value and the Free plan. Render validation passed. After deployment, hosted AI was enabled, the stored key matched the ignored local value, and the latest startup log reported `aiEnabled:true` with the inline worker enabled. Direct/proxied liveness and dependency health passed with PostgreSQL/Redis up; the frontend returned 200 and proxied unauthenticated session lookup returned private/no-store JSON 401. Never display the root `.env` key or Render credential. An authenticated hosted Draft report request remains unverified.

- Migration 005 adds `ai_artifacts`, `ai_reviews`, inspection `ai_sources`, six supporting indexes and `assist_inspection` job references. Source revisions, evidence, users/reviewers and applied revisions have composite tenant FKs. Artifact source identity and completed original output are guarded against SQL updates. The database now has fifteen application tables and 63 application indexes; `pgmigrations` is separate.
- Assistance endpoints are `GET/POST /inspections/:id/ai` and `POST /inspections/:id/ai/:artifactId/review`. Authenticated workers request editable inspection assistance at their current baseVersion; image/audio requests require matching attached, ready evidence. Source/kind/evidence requests deduplicate independently of mutation IDs. A PostgreSQL per-actor hourly budget serializes across API processes.
- The existing BullMQ runtime reads the frozen source revision, validates tenant/source/evidence ownership, and reads verified MinIO bytes before provider dispatch. Removed evidence, revoked assignment and closed inspections settle unavailable artifacts. Original output/model metadata and job completion commit in one fenced SQL transaction; exhausted crash leases settle queued artifacts as failed. Storage/SQL errors retain the five-attempt retry policy. Provider errors normally settle with a labeled fallback, not repeated paid retries.
- The optional native-fetch OpenAI adapter uses Responses structured outputs and multipart transcription on the official host. Defaults are gpt-5-mini/gpt-transcribe, a 30-second combined timeout and a bounded response. AI_ENABLED=false or a missing key makes no external provider call. Failures/refusals/malformed outputs fall back deterministically. Image/voice fallback invents no observations/transcript; a successfully obtained transcript survives a later extraction failure with accurate metadata.
- Groq report drafting makes one native-fetch request to https://api.groq.com/openai/v1/chat/completions with recorded asset/checklist/notes only, JSON Object Mode, and a 4096-token output cap. Zod validates completion status, text/warnings, bounds and provenance; report output cannot supply checklist changes. It uses the existing timeout, durable job and human-review path. A missing Groq key never switches a report to another provider. No new SDK, schema migration or job type is needed; GROQ_API_KEY is redacted from logs. HTTP simulations verify contracts. After the user configured the ignored root .env, a local live request returned HTTP 200 from openai/gpt-oss-20b and a validated 250-character demo report in 1.2 seconds. The key was not displayed. This checks connectivity and response compatibility, not model accuracy or hosted deployment.
- Artifact `sourceVersion`, provider/model/mode/fallback reason, prompt version, provider request ID, original structured output and raw output remain separate from `ai_reviews.confirmed_output`. Public responses omit raw output. Report fallback uses recorded checklist data only. There are no tools, autonomous actions, automatic defect outcomes, predictive failure claims or generated PDFs.
- Applying `decision=apply` requires `confirmed=true`, complete inspection-owned answer IDs, worker authorization, current baseVersion and matching artifact sourceVersion. It writes a new draft/version plus reviewed provenance, revision, audit and receipt atomically; original output remains immutable. Explicit reject records only the human review without changing inspection content/version. Submitted/approved/cancelled reports cannot accept AI edits; manager approval remains the existing M2 review step.
- Worker review requires an online, synced copy and editor lock. Uncertain responses freeze the exact in-page review request/editor for retry; read server state after reopening. `OfflineStore.acceptReview()` installs an acknowledgment only if local generation/base still match; newer device intent is retained and uses the existing explicit merge. AI does not add an offline mutation kind or Dexie schema version.
- `VoiceRecorder` uses actual MediaRecorder in supported HTTPS/localhost browsers, captures WebM/Ogg up to five minutes, and queues the recording through M4's atomic Blob/metadata/outbox flow. Attach captured audio before leaving the page. Quota failures retain the captured file for retry; attached bytes survive offline reload/browser restart and upload before submission. Existing MP3/WAV/Ogg/WebM file attachment remains available without microphone support.
- `GET /analytics` accepts strict 7/30/90-day and optional asset filters. Admins see the organization; workers see only current assignments and their assets. Read-only repeatable-read SQL reports current status/failed checks for inspections created in the UTC period, latest-submission duration, daily creation/latest-submission dates and up to 50 asset rows. Current asset counts include archived assets. Metrics describe recorded data, not predictions; analytics/admin operations remain online.
- Hosting accepts DATABASE_URL/REDIS_URL, supports verified external PostgreSQL/Redis TLS, requires HTTPS origin/storage in production, and optionally serves the built web client through the API. Helmet CSP permits configured storage connections and blob media; microphone is self-only. Burst limits are 60/minute/peer for auth and 10/minute/tenant/user for AI; the durable AI budget defaults to 20/hour/actor. Route splitting keeps individual web chunks below 500 kB in the verified build.
- [DEPLOYMENT.md](./docs/DEPLOYMENT.md), [SECURITY.md](./docs/SECURITY.md), [BACKUP_RESTORE.md](./docs/BACKUP_RESTORE.md) and [render.yaml](./render.yaml) document a same-origin API/worker, private database/queue, external private HTTPS storage, secret inputs, internal Render PostgreSQL TLS limits and coherent recovery. The restore integration uses real pg_dump/pg_restore, new MinIO targets and actual job reconciliation. No cloud deployment, continuous backup service, live model quality or production capacity is claimed.

## Verification and change discipline

### Inline worker idle compute update

`GET /api/v1/live` is process-only liveness for Render platform/optional cron probes; `/api/v1/health` still probes PostgreSQL and Redis. The Blueprint health check targets liveness so idle platform checks need not resume Neon. This local configuration is not a deployed Render setting.

Inline worker transactions signal committed job intent through their shared PostgreSQL pool, after commit and client release. Signals are coalesced and never overlap reconciliation; SQL remains authoritative. Known retry/cleanup/lease deadlines bound the next pass. Empty inline runtimes fall back to `JOBS_IDLE_INTERVAL_MS` (30 minutes by default); overdue work/errors retain five-second retry. Object sweeps run inside these passes, so idle cleanup/recovery can wait up to the idle interval. Standalone local workers retain five-second reconciliation. Restart reconciliation and lease fencing remain unchanged; no schema migration or separate Neon cron is introduced.

Run relevant tests, build the web client, and record actual live verification in IMPLEMENTATION.md. Never mark a live infrastructure check passed based on code inspection, mocks, or an image's published listing.

Keep the checklist accurate when an environment blocker prevents a required check. Close temporary verification servers; preserve user-started development processes. Work beyond the accepted M0-M5 scope requires a new request. Deployment approval is still outstanding after local M5 completion.
