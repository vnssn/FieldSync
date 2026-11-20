# FieldSync — implementation checklist

## Current status

The 2026-11-21 idle-compute update passes **150/150 automated tests** and the production build. Commit `17333e3` is now live on the existing Render API. It adds dependency-free `/api/v1/live`, shared-pool post-commit wake signals for inline jobs, known-deadline scheduling and thirty-minute idle recovery. Render uses liveness for platform probes and has the thirty-minute idle setting. Direct/proxied liveness and dependency health passed live. Optional ten-minute external cron activation and measured Neon CU savings remain pending; provider secrets were preserved and no new schema migration was added.

M0-M5 are complete and locally verified. M0 was originally verified on 2026-11-15, M1-M3 on 2026-11-16, and M4-M5 on 2026-11-17. Final M5 verification includes 110 passing automated tests, the production build, real PostgreSQL/Redis/MinIO/restore and all M3/M4/M5 browser checks. INTERVIEW.md is refreshed through M5. No Render account-linked action or paid AI call has occurred.

The current 2026-11-18 Blueprint uses a Free Render web service/private Redis with an inline BullMQ worker, Neon pooled runtime/direct migration connections, and Cloudinary authenticated raw evidence storage. Local verification now passes **134 automated tests**, the production build, M3/M4/M5 browser suites and a Cloudinary browser suite. Cloudinary tests use a local provider simulation with real PostgreSQL/Redis; live account capability, private access denial, quotas and coherent recovery remain release checks. The saved `.env` and Neon connection values were preserved. No deployment or cloud account configuration change was made.

The verification results below were captured against the real local services. Verification closes its temporary listeners and preserves user-started processes; do not start background dev servers automatically. Run npm run dev in a foreground terminal only when requested.

## Idle compute verification — 2026-11-21

- `node --import ./.local/test-local-env.mjs --test --test-concurrency=1 tests/*.test.js` passed 150/150, zero failed/skipped/cancelled, in 110.4 seconds. The existing preload clears cloud database/Redis URLs and forces loopback Docker PostgreSQL, Redis and MinIO. Fixtures use isolated schemas/buckets/queue prefixes; the real restore test uses a new disposable local database. No production migration or data operation ran.
- The focused foundation, scheduler, idle worker and server-runtime checks first passed 23/23. The full run adds an API-driven evidence case and covers liveness GET/HEAD with no dependency probe; idle query suppression; immediate committed-job/evidence verification wake; future cleanup/deadline scheduling; rollback signal isolation; non-overlapping/coalesced wakes; error retries; and draining shutdown. A controlled clock checks the thirty-minute fallback without thirty minutes of wall-clock waiting; real PostgreSQL/Redis/MinIO checks prove the wake path and delayed work behavior.
- `npm.cmd run build` passed. Changed source/config/test files passed a private-value scan, and Git whitespace checks passed. The root `.env` was not edited.
- Local Render YAML parsing, unique variable names, free-service settings, liveness path and the thirty-minute idle setting passed. Full validation against the cached official schema could not run because its native dependency targets Python 3.12 while this machine has Python 3.11; no package installation or cloud validation was performed.
- The inline worker retains durable SQL intent, bounded retries, fenced leases and startup recovery. With no due work it can sleep between thirty-minute recovery/cleanup passes; a known earlier deadline or committed job accelerates the next pass. Separate local workers retain their existing fast polling. Lost wake hints may delay recovery up to the configured idle interval, and Render sleeping still pauses its inline worker.
- [DEPLOYMENT.md](docs/DEPLOYMENT.md#render-keep-alive-and-neon-idle-compute) records the optional cron URL, ten-minute GET schedule, timeout and existing-service rollout. Neither live endpoint behavior nor quota savings is claimed from local tests; existing Render dependency health checks must be switched to liveness after deployment before activating keep-alive.

## Live idle-compute deployment — 2026-11-21

- After the user confirmed the intended Render account was active, pushed tested commit `17333e3` and deployed the existing `fieldsync-api` service. The latest deployment `dep-dc0ad21tn18s73eviucg` is live at that commit. Render's Blueprint sync applied `/api/v1/live` as Health Check Path and `JOBS_IDLE_INTERVAL_MS=1800000`; inline processing remains enabled. No replacement service, paid instance, separate worker or Neon cron was created. Cloudinary, Neon and Redis configuration remains present; no provider credentials were copied or printed.
- HTTP verification after the latest deployment: direct and Vercel-proxied `/api/v1/live` return 200 and no-store; direct/proxied `/api/v1/health` return 200 with PostgreSQL and Redis up. The approved Vercel preflight returns 204, a foreign origin returns 403, and unauthenticated proxied `/auth/me` returns uncached JSON 401. These checks do not establish authenticated browser persistence, Cloudinary account behavior or measured CU savings.
- The ten-minute cron is not active: no cron-job.org API credential is available in the local environment. The request was made for the user to store `CRON_JOB_API_KEY` in ignored `.env.local` or configure the cron manually. Live observations are also recorded in ignored `.local/neon-idle-deploy.json` without credentials.

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

### M2 — Online inspection templates, checklist execution and admin report review
- [x] Versioned templates, assignments, checklist outcomes/notes and status transitions.
- [x] Versioned aggregate saves and historical revision/audit snapshots.
- [x] Idempotent mutation receipts and optimistic locking.
- [x] Submit, request changes and approve human-editable reports.
- [x] Deterministic, printable report rendering without an AI dependency.

### M3 — Offline editing and reliable synchronization
- [x] Tenant/user-isolated Dexie schemas, working copies and transactional outbox.
- [x] Checklist/narrative persistence, visible quota failures and device-save indicators.
- [x] Frozen attempted mutations, ordered save/submission replay and safe acknowledgments.
- [x] Existing M2 list/detail pull and idempotent save/submit push; no batch endpoint.
- [x] HTTP 409 VERSION_CONFLICT with explicit base/local/remote merge.
- [x] Session/assignment changes, multi-tab coordination and browser-restart tests.
- [x] Production application-shell caching and additive IndexedDB versioning.

### M4 — Presigned evidence uploads and durable background jobs
- [x] Persisted offline evidence/file blobs and upload ordering.
- [x] Private staging uploads and server-side verification.
- [x] Immutable verified evidence and submission upload prerequisites.
- [x] BullMQ worker backed by durable PostgreSQL jobs/outbox records.
- [x] Idempotent handlers, leases, retries and reconciliation.
- [x] Tests for interrupted uploads, duplicate delivery and worker crashes.

### M5 — Human-reviewed AI and final hardening
- [x] Asynchronous image observation suggestions with explicit human review.
- [x] Offline recording, optional transcription and reviewed voice-to-findings.
- [x] Report narratives tied to source versions and manager review.
- [x] Missing/failed providers leave manual inspection workflows operational.
- [x] Keep original model output, provenance and confirmed human data separate.
- [x] Inspection/asset analytics, security review, real restore exercise and local deployment guide/configuration.
- [x] Real-browser end-to-end checks and measured local performance evidence.

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
    npm test                    # 119 tests; real infrastructure + pure/provider-boundary cases
    npm run test:m1             # M1 PostgreSQL integration tests only
    npm run test:m2             # M2 PostgreSQL integration tests only
    npm run test:m3             # M3 core sync and PostgreSQL replay tests
    npm run test:m3:browser     # Built client, real IndexedDB/PostgreSQL; local Playwright
    npm run test:m4             # Real PostgreSQL/MinIO/Redis/BullMQ integration cases
    npm run test:m4:browser     # Built client, actual Dexie blobs and direct MinIO uploads
    npm run test:m5             # M5 integration, provider, security and restore tests
    npm run test:m5:browser     # Voice/review/approval/analytics E2E; built client + real services
    npm run worker              # Standalone worker locally, with RUN_INLINE_WORKER=false
    npm run build               # Production web build
    docker compose ps           # Container health/state
    docker compose logs -f      # Follow service logs
    docker compose stop         # Stop containers, preserving data
    docker compose start        # Start stopped containers

On Windows, npm.cmd can be used in place of npm if the shell does not run npm.ps1.

Do not use volume deletion as an ordinary reset. Password changes in .env do not automatically update users in an existing PostgreSQL volume.

## Environment

The root .env is loaded explicitly by server/scripts. Vite uses the root env directory but only exposes VITE_-prefixed values to browser code. The frontend makes relative /api requests and never receives database, Redis or S3 credentials.

M5 accepts hosting DATABASE_URL/REDIS_URL, verified external PostgreSQL TLS through POSTGRES_SSL=true and verified Redis TLS through rediss://. For Neon, use its pooled URL as DATABASE_URL and the matching direct URL as MIGRATIONS_DATABASE_URL; migrations cannot use Neon's transaction pooler. Production requires an exact HTTPS APP_ORIGIN. S3 deployments additionally require HTTPS S3 endpoints; Cloudinary deployments ignore S3 settings and use authenticated raw assets. SERVE_WEB=true serves the production client on the API origin. RUN_INLINE_WORKER defaults to false locally; the Render Blueprint sets it to true to run BullMQ in the same process with a shared pool/storage and graceful shutdown. AI_ENABLED=false remains the default; an optional server-only OPENAI_API_KEY enables provider calls, with labeled fallback on missing keys/failure. Limits/models/timeouts are in .env.example. See [DEPLOYMENT.md](./docs/DEPLOYMENT.md) for free-tier limits, Neon URL inputs, storage CORS, and the mandatory account-switch gate. Cloud evidence storage remains a separate prerequisite for hosted full workflows.

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
9. Run M3/M4/M5 browser regressions, including offline recording, explicit assistance review, analytics/mobile/cache checks; record measured local performance.

## R2-compatible evidence PUT verification — 2026-11-18

Replaced presigned HTML form POST uploads with raw SigV4 PUT uploads. `uploadResponseSchema` strictly validates URL protocol, PUT method, allowed Content-Type/SHA-256 headers, MIME-specific size and expiration. The API validates descriptors at its response boundary. The browser checks Blob size/type/expiry before upload, sends no application cookies, lets the browser set Content-Length, and retains files on rejection/interruption.

The official `@aws-sdk/s3-request-presigner` dependency signs the actual browser endpoint, exact tenant-prefixed staging key, Content-Type, Content-Length and SHA-256 metadata, for at most ten minutes within the existing reservation. Optional AWS checksum/trailer modes are disabled for R2 compatibility. The existing server independently verifies HEAD/GET size, bounded bytes, media signature and reserved SHA-256, then writes the checked buffer to a fresh verified key with `If-None-Match: *`. Authorization, versions, receipts, job fencing/reconciliation, cleanup, generation renewal and Dexie/outbox schema remain the existing protocol. No database migration or application environment value changed.

- `node --test tests/evidence-put.test.js` exited 0: five signing/contract/browser-transport cases, including a synthetic R2 endpoint with no Cloudflare requests. These verify signed headers/auto scope/expiry/public host, rejection of foreign keys/injected headers/mismatched Blobs, raw PUT/no cookies and retention on errors.
- The initial focused `node --test tests/m4-integration.test.js` run passed all 23 cases against real MinIO/PostgreSQL/Redis. Updated integration cases reject changed keys/types/metadata/length, anonymous reads and writes from a staging URL to a verified key; conditional overwrite fails with 412. The final full run also covers a successful PUT whose response is lost, proving attachment-first replay avoids re-upload and preserves mutation IDs/Blob until acknowledgment.
- `npm test` exited 0: **119 tests, 119 passed, zero failed/skipped/cancelled**, including all existing M0-M5/inline-worker regressions and real pg_dump/pg_restore/object/job recovery.
- `npm run build` exited 0: **203 modules**, largest JS chunk **394.71 kB (124.35 kB gzip)**, with no individual >500 kB advisory.
- `npm run test:m4:browser` exited 0: actual Edge/Dexie offline photo/audio reload/full restart, quota retry, raw PUT requests with type/SHA metadata and no cookies, verification-gated submission/archive, lost-response retention and merge cleanup; zero page errors.
- `npm run test:m5:browser` exited 0: actual MediaRecorder voice quota/restart/replay/PUT, private photo evidence, human review and response-loss/newer-intent recovery, approval/archive/provenance and all analytics/mobile/cache checks; zero page errors.
- `npm audit --omit=dev` exited 0 with **zero vulnerabilities**. Updated documentation local links resolve and `git diff --check` passes.

Updated deployment/security/recovery guides, EGM/context/interview/README and added [R2_SETUP.md](./docs/R2_SETUP.md) with exact token permissions, bucket privacy, CORS, existing Render variables, endpoint/region/path-style choices, migration/rollout checks and R2 limitations. `render.yaml`, `.env.example` and local `.env` were not changed. Live R2 credentials/permissions/CORS/billing and provider behavior remain unverified; no account-linked command or deployment ran.

Logs are ignored at `.local/r2-test.log`, `.local/r2-build.log`, `.local/r2-m4-test.log`, `.local/r2-m4-browser.log` and `.local/r2-m5-browser.log`. Verification closes its generated listeners/workers/browser profiles/pools and removes only its schemas/buckets/queue namespaces. Local infrastructure remains available.

## Free-tier configuration actual verification — 2026-11-18

Updated `render.yaml` to explicit `plan: free` on the web service, PostgreSQL and Key Value/Redis, removed the separate worker and custom paid database disk size, and replaced the unsupported free-service pre-deploy hook with `npm run db:migrate && npm run start --workspace=@fieldsync/server`. `RUN_INLINE_WORKER=true` starts the existing BullMQ runtime inside the web process, sharing PostgreSQL/storage. The validated flag defaults to false locally. SIGTERM/SIGINT drain HTTP/jobs before closing shared resources under one ten-second deadline; listener startup failure follows the same cleanup with a failing exit code.

The initial test attempt encountered unavailable local PostgreSQL while Docker was stopped. After Docker became available and the three existing services were healthy, verification ran against real PostgreSQL/Redis/MinIO. An overly specific closed-pool error assertion in the new tests was corrected before the final full rerun.

- `npm test` exited 0: **114 tests, 114 passed, zero failed/skipped/cancelled**. The existing 110 cases pass; four new server-runtime cases cover health with inline work disabled, actual BullMQ evidence-job draining through both SIGTERM/SIGINT handlers, repeated-shutdown idempotency and listener-startup-error cleanup. The foundation test also validates the flag's default, true value and rejection of invalid strings.
- `npm run build` exited 0: **203 modules**, largest JS chunk **394.52 kB (124.29 kB gzip)**, with no individual >500 kB advisory.
- Local PyYAML/jsonschema validation passed against the cached official Render JSON schema. Additional checks confirm exactly three Free resources, one web instance, no worker/pre-deploy/custom-disk configuration, inline work enabled, AI disabled, private datastore allowlists and consistent references/region. Validation libraries/scripts live only in ignored `.local`; no application dependency or lockfile changed.
- `git diff --check` passed. Browser harnesses were not rerun for this server/configuration update; their M5 results below remain historical.

Refreshed [DEPLOYMENT.md](./docs/DEPLOYMENT.md), [INTERVIEW.md](./INTERVIEW.md), [EGM.md](./EGM.md), [CONTEXT.md](./CONTEXT.md), `.env.example` and this checklist. The guides explain cardless Free/Hobby deployment, start-command migrations, shared-process shutdown, idle/cold-start job delays, memory-only Redis recovery, 1 GB/30-day PostgreSQL and included usage limits. Full evidence/voice workflows still require separately provisioned private HTTPS S3-compatible storage; its compatible free/cardless availability is unverified. A permanent, entirely Render-hosted M0-M5 stack at $0 is not claimed.

Final logs are ignored at `.local/free-tier-test.log` and `.local/free-tier-build.log`. No Render CLI, account-linked validation, resource creation, account connection or deployment command was run. **STOP before any Render account-linked continuation.**

## M5 actual verification results — 2026-11-17

Completed AI assistance, native offline voice recording, inspection/asset analytics and final local hardening using existing JavaScript/JSX/Zod dependencies. No TypeScript, dependency/lockfile change, extra Compose service, paid provider request or Render account-linked action was added. The final review fixed safe selected-evidence removal and 90-day mobile chart clipping, and updated the M1 migration rerun expectation to include 005.

Migration **005_init_ai_analytics** was applied to the real development PostgreSQL database. A final `npm run db:migrate` exited 0 with no migrations to run. The database records migrations 001–005, fifteen application tables and **63 application indexes**, excluding bookkeeping. The existing sequential-filename timestamp advisories remain non-fatal. AI artifacts/reviews bind tenant, inspection, source revision, selected evidence, requester/reviewer, applied revision and job through composite FKs. Source identity/completed originals are SQL-guarded; generation never changes inspection content. Human-confirmed application commits draft/version/provenance/review/revision/audit/receipt together.

`npm test` exited 0: **110 tests, 110 passed, zero failed/skipped/cancelled**, including the prior 80 M0-M4 cases and **30 M5 tests**:

| Suite | Count | Evidence |
| --- | --- | --- |
| `tests/m5-integration.test.js` | 18 | Actual PostgreSQL/MinIO/Redis/BullMQ: tenant/aggregate FKs and access; source dedupe/budget; verified evidence; original/human separation; explicit confirmation, stale/closed results and rejection; concurrent/lost-response review; rollback of request/review/output; removed evidence/revoked access; retry/reconciliation/exhaustion/fencing; analytics scope/metrics/performance. A local provider HTTP simulation is also driven through real verified objects and queue delivery. |
| `tests/m5-provider.test.js` | 6 | Native adapter with a real local HTTP server: structured Responses/multipart transcription shape, model/request metadata, missing-key/disabled no-call behavior, failures/refusals/incomplete/malformed/oversized output, unknown IDs, timeout and retained original transcript after extraction failure. These are contract simulations, not live model analyses. |
| `tests/m5-security.test.js` | 5 | Actual peer auth throttling/forwarded-header denial, bounded per-actor windows, production environment validation, real hosting URL adapters and HTTP shell/API/CSP/microphone/no-store controls. Pure boundary cases coexist with real infrastructure. |
| `tests/m5-restore.test.js` | 1 | Actual Docker pg_dump/pg_restore into a disposable database, immutable MinIO recovery into a new private bucket, byte/hash/metadata and original/review/revision/receipt/migration checks, then SQL-backed report reconciliation into a fresh Redis namespace. |

Provider adapter success/failure tests use synthetic keys and an injected local HTTP boundary. No actual model observation, transcription accuracy, provider account/model access or paid request is claimed. Disabled/missing-key fallbacks invent no image observations or transcripts; report fallback uses recorded checklist data. If transcription succeeds before extraction fails, its original transcript survives with accurate fallback metadata.

`npm run build` exited 0: Vite 8.3.8, **203 modules**, largest/main JS chunk **394.52 kB (124.29 kB gzip)**, CSS **24.55 kB (5.51 kB gzip)** and **1.55 kB sw.js**. Route splitting eliminates individual >500 kB advisories; the sum of all route/shared chunks is larger than the main chunk. Existing M0-M4 snapshots default missing aiSources to an empty array, and Dexie remains additive version 2.

`npm run test:m3:browser` exited 0 against the M5 build. Existing checklist restart/replay, multi-tab locking/reconnect, explicit conflict/fresh-remote review, tenant/session/reassignment, quota and shell/mobile checks passed with zero page errors.

`npm run test:m4:browser` exited 0. Actual Dexie v1-to-v2 upgrade, Blob quota rollback/retry, photo/audio offline reload/full browser restart, direct MinIO uploads, processing-gated submission, real BullMQ archive, lost-response retention and merge acknowledgment/blob cleanup all passed with zero page errors.

`npm run test:m5:browser` exited 0 using headless Edge, actual IndexedDB/MediaRecorder, real PostgreSQL/MinIO and BullMQ. It passed explicit edited-field confirmation, untouched generation source, lost review-response retry and one version/review; preserved newer device intent with explicit merge; stale background source rejection; photo fallback/human findings and safe removal of selected evidence; real WebM recording, quota rollback/retained-capture retry, offline reload/full browser restart/replay and reviewed voice submission; manager approval/provenance/archive; workspace analytics with 7/30/90-day filters; visible 90-day mobile bars and desktop/mobile layouts; actual dependency health, shell-only cache and **zero page errors**. The newer-device-intent race uses a valid controlled IndexedDB injection after the real review commit. Provider-disabled UI coverage makes no live AI claim.

Performance evidence from the final full run: **1,000 real inspection rows, 20 HTTP/SQL analytics reads, median 34.5 ms and p95 39.9 ms**. The final M5 browser dashboard navigation took **919 ms** locally. The restore fixture export was **97,070 bytes**, with dump/restore/object verification/job recovery work completed in **993 ms**. These are small local observations, not production throughput, model quality, or RPO/RTO guarantees.

`npm run check:env` exited 0 with PostgreSQL, Redis and the private fieldsync-dev MinIO bucket up; AI remains disabled. `npm audit --omit=dev` exited 0 with **zero runtime dependency vulnerabilities**. The [render.yaml](./render.yaml) Blueprint passed local PyYAML/jsonschema validation against Render's public official JSON schema plus resource/reference/migration placement checks. No Render CLI/API validation or account access was used.

Updated [EGM.md](./EGM.md), [CONTEXT.md](./CONTEXT.md), [README.md](./README.md), [INTERVIEW.md](./INTERVIEW.md), this checklist, and the [deployment](./docs/DEPLOYMENT.md), [security](./docs/SECURITY.md) and [backup/restore](./docs/BACKUP_RESTORE.md) guides. The deployment guide covers same-origin API/web, worker ordering, private database/queue, dedicated HTTPS storage, secret inputs, TLS limits, manual release and coherent recovery.

Verification closes generated listeners/browser profiles/pools/workers and removes only its schemas/databases/private buckets/queue namespaces. User-started processes, local .env and development data are preserved. Ignored artifacts include `.local/m5-final-test.log`, `.local/m5-m3-browser.log`, `.local/m5-m4-browser.log`, `.local/m5-final-browser.log`, and reviewed `.local/m5-voice-mobile.png`, `.local/m5-analytics-mobile.png`, `.local/m5-analytics-desktop.png`.

Final read-only cleanup audit found **zero** leftover test schemas, restore databases, test buckets or test Redis keys, and zero listeners on local API/web ports 3000/5173. All eight updated Markdown guides' local links resolve, `git diff --check` passes, and source inspection found no TypeScript files/tooling. The three development dependencies remain healthy after cleanup.

### Exactly what remains next

The local free-tier update is complete. **STOP before any Render account-linked step**: the user must switch to the intended active Render account and authorize creation/linking/configuration/deployment. After that approval, follow the deployment guide to review names/region/free limits and compatible external storage, fill secrets, provision/link the three Free resources, let the start command migrate before the API/inline worker starts, and record actual cloud smoke and backup/recovery checks before PostgreSQL expiration. AI provider activation/quality evaluation is optional and remains unverified; manual/fallback workflows are complete.

## M4 actual verification results — 2026-11-17

Completed the existing evidence/job implementation using the installed JavaScript/JSX dependencies. No new dependency, lockfile, infrastructure service, AI feature or deployment was added.

The review corrected four gaps: the job evidence FK now binds organization/inspection/evidence together; pending verification gates submission/approval without consuming a new mutation receipt; exhausted worker-crash leases settle failed evidence as well as jobs; and explicit merges clear local blobs when remote membership already satisfies the file intent. Storage cleanup validates ownership, queue errors are handled, publisher retries are bounded, and API/worker shutdown closes owned resources.

`npm run db:migrate` exited 0 and applied **004_init_evidence_jobs**, one migration, to the real development database. The existing sequential-filename timestamp advisories remain non-fatal. The final database contains migrations 001-004, thirteen application tables and 52 application indexes.

`npm test` exited 0: **80 tests, 80 passed, 0 failed/skipped/cancelled**. This includes the existing 57 M0-M3 tests and **23 M4 integration cases** in `tests/m4-integration.test.js`. M4 uses actual PostgreSQL transactions/FKs, private MinIO buckets and Redis/BullMQ. It covers tenant/worker scoping, same-tenant cross-inspection FK rejection, strict file metadata, constrained POST policies/private reads, MIME/signature/checksum validation, immutable promotion, concurrent/lost-response replay, audit/revision/receipt/job rollback, cleanup denial/reconciliation, removal, pending/failed submission prerequisites, closed-record immutability, credential renewal, offline upload interruption/order/conflicts, job execution/archives, lost Redis entries, five-attempt exhaustion and stale-lease fencing. A child running the actual handler is killed after its durable claim; BullMQ reconciliation recovers its lease or settles the exhausted final attempt.

Offline HTTP replay tests use shared pure transitions with an in-memory local store and controlled transport faults; they do not claim that store is Dexie. Actual Dexie/Blob behavior is verified separately in the browser.

`npm run build` exited 0: Vite 8.3.8, **198 modules, 575.51 kB JavaScript (172.54 kB gzip), 23.89 kB CSS (5.39 kB gzip), 1.09 kB sw.js**. The existing >500 kB advisory remains non-fatal.

`npm run test:m3:browser` exited 0 against the new build. Existing offline checklist reload/browser restart, replay/conflict, multi-tab, account/session/reassignment, quota and mobile/cache checks passed with zero page errors.

`npm run test:m4:browser` exited 0 using headless Edge, actual IndexedDB, PostgreSQL, direct MinIO uploads and the real BullMQ runtime. It passed an additive Dexie v1-to-v2 upgrade with an existing M3 pending draft; atomic file/metadata/outbox quota rollback and retained-selection retry; offline photo/audio persistence across reload and full persistent-browser restart; save/attach/attach/submit ordering; automatic submission after verification; immutable submitted UI; deterministic report archive; lost-response blob retention; and explicit merge acknowledgment/cleanup when the remote already contains the file. The 390px evidence view had no overflow, shell caches excluded API/storage responses, and there were zero page errors. The merge recovery branch uses controlled response loss and a valid injected conflict state to make the race deterministic.

`npm run check:env` exited 0 against real local PostgreSQL, Redis and the fieldsync-dev MinIO bucket, with AI disabled.

Verification uses generated schemas, separate private buckets and Redis queue prefixes. Cleanup closes temporary listeners/browser profiles/API contexts/pools/workers and removes only those test resources. User-started processes and application data are preserved. The M4 screenshot is ignored at `.local/m4-evidence-mobile.png`; an earlier harness diagnostic remains at `.local/m4-browser-failure.png`.

### M4 runtime and prerequisites

- Run migrations explicitly before starting the API/worker. Run `npm run worker` in its own foreground terminal alongside the API/web process.
- MinIO CORS must match APP_ORIGIN; S3_PUBLIC_ENDPOINT must be browser-reachable. Browser verification requires existing `.local/qa/node_modules/playwright/index.mjs` or FIELDSYNC_PLAYWRIGHT_PATH, a fresh build, all three services and a free configured local APP_ORIGIN port. The M4 harness fails on an occupied port without stopping its owner.
- Test credentials need permission to create/drop generated PostgreSQL schemas and private S3 buckets. Redis cleanup is restricted to each generated queue prefix; there is no FLUSHDB or development-bucket cleanup.
- Photo limits are 10 MiB, audio 25 MiB, at most 50 attachments per inspection and 200 MiB queued locally. Reservation/presign lifetimes are twenty/at most ten minutes. File processing is separate from inspection business versions.
- Background delivery is at least once. PostgreSQL claims use sixty-second leases/fifteen-second heartbeat and a five-attempt bound; reconciliation republishes due work every five seconds and sweeps old unreferenced objects. Storage/queue outages preserve pending work; inspections without attachments continue through the manual M0-M3 path.
- Removed file bytes are deleted; historical revisions retain metadata. Voice recording/transcription, AI analysis, generated PDFs and final analytics/security/restore/deployment/performance work remain outside M4.
- Before creating, linking or deploying a backend service on Render, stop and ask the user so they can switch their active Render account.

## M3 actual verification results — 2026-11-16

Implemented with the existing Dexie/React/Zod dependencies. IndexedDB databases are namespaced by organization and user, with validated cached records, working copies and ordered requests. Checklist edits and acknowledgments commit atomically; attempted bodies/IDs remain frozen. The worker UI retains newer input during synchronization, reports device saves after commit, and pauses submissions/conflicted or unavailable work without discarding it. Admin workflows retain their M2 endpoints and pages.

`npm test` exited 0: **57 tests, 57 passed, 0 failed/skipped**. M3 adds 14 core tests and 3 real PostgreSQL integration tests. They cover ownership/reference validation, save coalescing, ordered replay, immutable retries after lost responses, newer-edit acknowledgment, verified no-ops, workspace changes, session/access failures, and explicit three-way merges. Real HTTP replay after a committed response is lost produces one version/revision/audit per successful mutation; conflict merges use new receipts and current versions. Existing M0-M2 tests also pass.

`npm run build` exited 0: Vite 8.3.8, 195 modules, **560.96 kB JavaScript (168.79 kB gzip), 23.78 kB CSS (5.35 kB gzip), and 1.09 kB sw.js**. The existing >500 kB advisory remains non-fatal. The build now sets production NODE_ENV before Vite reads the shared development .env; production React code and service-worker registration are included. No dependencies/lockfile changes, server migrations or batch endpoints were added.

`npm run test:m3:browser` passed against built assets, headless Edge, actual IndexedDB and real PostgreSQL. It verified offline save/submission, reload and full persistent-browser restart, automatic reconnect replay, exclusive two-tab editing, simultaneous-tab reconnect, conflict preservation and fresh-remote recheck, explicit merge submission, cross-tab offline logout, isolated tenant/user switching, expired-session retention/reauthentication, reassignment/read-only retention and recovery after reassignment back, and quota failure with preserved buffer and successful retry. Shell caches contain no API/auth responses. The 390px mobile layout had no overflow and the browser reported zero page errors.

The browser harness lives at `scripts/verify-m3-browser.js`; it uses the existing local Playwright module at `.local/qa/node_modules/playwright/index.mjs`, or `FIELDSYNC_PLAYWRIGHT_PATH` pointing to an existing installation. Build first and keep PostgreSQL available. The generated browser profile, ephemeral HTTP listener, API contexts, pools and isolated schema are cleaned up in finally. User-started development processes are untouched. The reviewed mobile screenshot is ignored at `.local/m3-offline-mobile.png`.

Offline reopening requires a cached production shell, IndexedDB/Web Locks/service-worker support, and HTTPS or loopback. Worker assignments are cached through existing M2 reads; assets/admin operations remain online. M4 supplies evidence bytes/uploads/background jobs; M5 assistance/recording/analytics verification is recorded above.

## M2 actual verification results — 2026-11-16

Implemented with the existing JavaScript/JSX workspace and dependencies. The raw SQL migration `003_init_inspections.js` adds inspection_templates, inspections, template_events, inspection_events, inspection_revisions and mutation_receipts. Organization-owned references use composite tenant foreign keys. Templates/checklist items are stored as bounded JSONB, and each assignment freezes template/asset/worker snapshots.

All M2 writes validate shared Zod contracts, derive tenant/actor from the session, and use short PostgreSQL transactions. Updates lock the aggregate, check baseVersion and increment the version conditionally. Inspection writes commit revision, audit and receipt together. Receipts include canonical request hashes; identical replays return stored outcomes, while changed requests and revoked access are rejected. Expected domain errors may be recorded without aggregate changes; unexpected failures roll back completely.

`npm test` exited 0: **40 tests, 40 passed, 0 failed/skipped**. The 17 M2 tests use real PostgreSQL and cover template versions/audits, frozen assignment snapshots, strict tenant/role boundaries, injected fields, incomplete/failed checks, review/resubmission/approval, closed-record immutability, optimistic concurrency, receipt replay/content mismatch, reassignment/access revocation, composite foreign keys, and deliberate audit/revision/receipt failures with rollback and retry. Test listeners/pools close and only the generated schemas are dropped.

The root test runner now uses `--test-concurrency=1`: node-pg-migrate's database-wide lock prevents simultaneous suite migrations even in different schemas. The concurrency cases still issue simultaneous HTTP requests inside their suite. This retains production migration locking.

`npm run build` exited 0 with Vite 8.3.8, 188 transformed modules, approximately 677.88 kB JavaScript (197.17 kB gzip) and 23.66 kB CSS (5.32 kB gzip). The pre-existing >500 kB bundle advisory remains non-fatal. No dependencies or lockfile changes were needed. Tests/build used approved execution outside the restricted Windows sandbox because Node's path resolution otherwise fails above the workspace; project permission/settings were not changed.

The existing local Playwright installation drove a headless Edge smoke test against the built client and real PostgreSQL in a separate temporary schema. It passed template creation, assignment, worker draft save/submit, preservation of input on VERSION_CONFLICT and explicit reload, request changes/resubmission, approval, historical report selection, mobile overflow and print layout, with zero page errors. Reviewed screenshots at 1440px desktop and 390px mobile widths, plus the print view. Browser, HTTP listener and database pools were closed; the generated schema was dropped. This remains local smoke verification, not M5's full E2E suite.

Ignored artifacts under .local/: m2-browser-smoke.js, m2-checklist-desktop.png, m2-checklist-mobile.png, m2-approved-report.png and m2-report-print.png. An earlier diagnostic m2-browser-failure.png remains locally. No browser dependency was added to the workspace.

`npm run db:migrate` exited 0 against the local development database and applied **003_init_inspections**, one migration. The existing sequential-filename timestamp advisories appeared for 001/002/003; the migrator still applied the ordered migration successfully. Application startup continues to require explicit migration execution.

### M2 API and browser surface

All paths below are under /api/v1 and require a session. State-changing requests require JSON and the configured Origin; mutationId is mandatory, and updates/actions also require baseVersion. Templates/inspections have a 128 KiB JSON limit; M1 routes retain 32 KiB.

| Method/path | Access | Behavior |
| --- | --- | --- |
| GET /templates, GET /templates/:id | Admin | List/filter templates; detail with audit history |
| POST /templates, PATCH /templates/:id | Admin | Create/edit/archive a versioned checklist |
| GET /inspections, GET /inspections/:id | Admin/assigned Worker | Organization/assignment-scoped list and detail/history |
| POST /inspections | Admin | Assign an active asset/template to a tenant worker |
| PATCH /inspections/:id | Assigned Worker | Save checklist answers and report text as draft |
| POST /inspections/:id/submit | Assigned Worker | Atomically save a complete checklist and submit |
| PATCH /inspections/:id/assignment | Admin | Reassign editable work, preserving saved answers |
| POST /inspections/:id/cancel | Admin | Close an unapproved inspection |
| POST /inspections/:id/review | Admin | Approve or request changes on submitted reports |

Browser pages: /templates (admin), /inspections and /inspections/:id. Templates support ordered items and archival; assignments choose active assets/templates and worker accounts. Workers save incomplete drafts or submit completed checks; failures require notes. Admins review saved reports and add review notes. Historical versions and printable reports use the stored snapshots. Approved/cancelled records are read-only. Unconfirmed retries preserve the attempted payload/ID; conflicts preserve form input until explicit reload/review.

M3 supplies the durable browser draft store and synchronization described above; M4 extends it with evidence upload/processing and M5 adds reviewed assistance as recorded above. The checklist uses pass/fail/not_applicable plus notes rather than a separate findings table or configurable form engine.

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

## Cloudinary evidence verification ? 2026-11-18

Inspected the existing reserve/upload/promote/download/remove flow, worker verification and cleanup, tenant/assignment/creator authorization, editable-state/version/receipt controls, key ownership and file integrity. Added provider selection and an authenticated same-origin binary upload route. Bounded file reception checks MIME/size/SHA metadata, media signature and SHA-256 before provider writes, then rechecks authorization under locks. Staging and verified assets use authenticated raw Cloudinary uploads with overwrite disabled. Promotion writes the checked buffer to a fresh verified UUID. Private URLs stay server-side; downloads verify original bytes again. Existing durable jobs and generation-specific/age-based cleanup retain their security checks.

The Blueprint now selects Cloudinary and requires server-only cloud name/key/secret plus a dedicated namespace; inactive S3 values cannot fail configuration. APP_ORIGIN stays mandatory as an exact HTTPS origin in production and is set in Render. Existing pooled DATABASE_URL and direct MIGRATIONS_DATABASE_URL behavior, verified PostgreSQL TLS and migration-before-start order are preserved. No database schema migration was added.

Validation:

- `npm ci --include=dev` and `npm run build` exited 0.
- `npm test` exited 0: 134/134 tests, including 15 Cloudinary unit/integration cases and the existing real PostgreSQL/Redis/MinIO restore, worker, authorization, receipts and offline regression suites.
- M3, M4 and M5 browser suites exited 0. The new `npm run test:cloudinary:browser` also passed with the built UI, actual Edge/IndexedDB/cookies and real PostgreSQL/Redis: offline photo/audio replay, same-origin session uploads, worker verification, exact download hashes and authorized removal. The browser never contacted Cloudinary.
- Local `check:env` passed for PostgreSQL/Redis/MinIO. The local Render Blueprint passed the public JSON schema and assertions for Cloudinary, pooled/direct inputs and disabled automatic deployments.
- Tests used process-only local configuration; the existing `.env` was not changed. Cloudinary account operations, live provider requests and deployment were not performed.

Dependency audit reports five high-severity findings in the existing Vite/picomatch build toolchain; none are in Cloudinary. No unrelated major build-tool migration was attempted. Live authenticated raw support, maximum raw/audio file sizes, bandwidth/storage/Admin API quotas and private backup recovery still require operator verification before release. See [CLOUDINARY_SETUP.md](docs/CLOUDINARY_SETUP.md).

## Vercel frontend / Render API verification — 2026-11-18

Inspected the root Vite/React build, same-origin API/media/archive URLs, secure host-only sessions, Origin/CSRF checks, security headers, shell-only service worker, Render topology and private Cloudinary flow. Added native Vercel API rewrites to the existing Render service, root monorepo build/output settings, SPA routing and frontend security/cache headers. No additional backend, database, paid service or frontend secrets were introduced. Render permits a bounded list of exact additional HTTPS origins during acceptance; Cloudinary upload descriptors use the validated requesting origin. Existing tenant/assignment/creator/state/integrity checks, Neon pooled/direct connection handling and Render frontend serving are retained.

Validation and observed deployment status:

- `npm run build` exited 0. The final isolated `npm test` run passed 139/139 tests, including five new hosting/CORS/session/Cloudinary origin regressions. An existing BullMQ reconciliation test now waits for durable republishing when a timer-driven pass is already running. Earlier test runs hit a concurrent local migration lock and transient local AI HTTP simulation failures; the final full run passed without concurrent browser suites.
- Built-UI Cloudinary and M3 offline browser suites passed locally with real browser cookies/IndexedDB and local PostgreSQL/Redis. They covered offline photo/audio replay, exact downloaded bytes, removal, restart recovery, account isolation, assignment/conflict handling and shell-only caching. Cloudinary was simulated; these are not live Vercel acceptance or account-level storage checks.
- Vercel and Render configuration schema checks passed. Private-value scans passed for changed code and compiled frontend output; the original `.env` remained byte-for-byte unchanged. Existing unrelated local skill/configuration files were preserved.
- The existing Hobby workspace project `innova15/fieldsync` is connected to `vnssn/FieldSync`, production branch `main`, with root build `npm run build` and output `apps/web/dist`. The production frontend is https://fieldsync-six.vercel.app. Vercel has no frontend environment variables.
- Live HTTP checks passed for root/login/inspection routes, JavaScript service worker with revalidation, missing-asset 404, uncached JSON auth 401 and both direct/proxied health endpoints. The existing Render API reported PostgreSQL and Redis up. API rewrites remain private/no-store with CDN caching disabled.
- Live login from the Vercel Origin returned `403 INVALID_ORIGIN`. Render CLI authentication has expired, so updating/deploying that existing service and testing production session persistence, real evidence upload/download/delete and offline replay remain pending. Dashboard browser automation was also blocked because policy controls could not verify the active page. No live login/evidence success is claimed; `SERVE_WEB=true` remains in place. See [VERCEL_RENDER_SETUP.md](docs/VERCEL_RENDER_SETUP.md) for the remaining acceptance and retirement sequence.
