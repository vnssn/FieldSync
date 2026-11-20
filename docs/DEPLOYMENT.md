# FieldSync deployment guide

The frontend deployment is now Vercel at **https://fieldsync-six.vercel.app**, with the existing API at **https://fieldsync-api-t5kg.onrender.com**. See [VERCEL_RENDER_SETUP.md](VERCEL_RENDER_SETUP.md) for root-monorepo build settings, native API rewrites, cookies/CORS, security headers and the staged cutover. No second backend/database is required. The public API target is the only backend configuration in Vercel; Neon/Redis/Cloudinary secrets remain on Render.

The Vercel shell/routes/service worker/proxied health endpoint are live and verified by HTTP. Render account access and the production Vercel origin are now verified. The idle-compute release `17333e3` is live on the existing API, with `/api/v1/live` as its platform health check and thirty-minute idle recovery. Live Vercel browser login/evidence/offline acceptance remains pending. **SERVE_WEB remains true until those browser checks work.** Update the existing Render service rather than importing this Blueprint. The Render topology/runtime notes below remain applicable during cutover; account-linked actions are authorized only within the user's requested existing service and free infrastructure.

## Existing Render API and inline worker

The Blueprint explicitly sets `plan: free` on one Node web service and private Key Value/Redis. PostgreSQL is hosted by the user's Neon Free project, not provisioned by Render. The web service serves the built React application and runs the existing BullMQ runtime in the same Node process with `RUN_INLINE_WORKER=true`. There is no separate Render background-worker service, which has no free plan. Render resources use Singapore; choose the nearest Neon region when creating the database. Review names against existing resources before import because Render can link matching names.

Use Render's free Hobby workspace and Free instance plans without adding a credit card or payment details. This configuration requests no paid compute, persistent disks, pre-deploy commands, one-off jobs or shell access. Leave `AI_ENABLED=false` and `OPENAI_API_KEY` empty to avoid paid provider calls. If the selected account or creation flow requires payment, stop; this local change does not authorize a paid plan or adding billing details.

The Blueprint selects `EVIDENCE_STORAGE_PROVIDER=cloudinary`. Provision Cloudinary separately using [CLOUDINARY_SETUP.md](CLOUDINARY_SETUP.md): evidence uses authenticated raw assets and server-proxied uploads/downloads with the existing authorization and integrity checks. S3/MinIO remains available with `EVIDENCE_STORAGE_PROVIDER=s3`. Cloudinary ignores all `S3_*` values, including stale invalid endpoints. Render's ephemeral filesystem cannot store evidence/databases. Full evidence/voice workflows require storage even with AI disabled. The Blueprint does not provision or verify a Cloudinary account or its plan limits.

### Neon database setup

Use the pooled Neon connection string for app traffic and a second, direct (unpooled) connection string for schema migrations. Neon uses PgBouncer transaction pooling on pooled endpoints and recommends direct connections for migrations. FieldSync migrations run before the web service starts, so a pooler-only URL is insufficient. Copy both URLs from the same Neon project/branch/database/role: Connection pooling **on** for `DATABASE_URL`, **off** for `MIGRATIONS_DATABASE_URL`. Keep both secret; never paste them in chat or commit them. Neon’s AWS projects support both IPv4 and IPv6, and the current `pg` driver supports the TLS SNI Neon requires; keep the DNS hostname (do not replace it with a resolved IP). Set `POSTGRES_SSL=true`; FieldSync strips URL `sslmode` toggles and enforces certificate verification in `pg`.

Neon Free's current limits include 1 GB database storage and 100 CU-hours per project monthly; compute can scale to zero. Render's Free web service also sleeps after inactivity, so expect cold starts and delayed queue processing. Free Key Value is volatile and jobs are recovered from PostgreSQL after a restart. Review the current [Neon plans](https://neon.com/pricing) and [connection pooling guide](https://neon.com/docs/connect/connection-pooling) before setup. This is a portfolio/demo configuration, not an always-on service.

### Private Cloudinary evidence storage

Cloudinary now uses an authenticated same-origin binary PUT route. Session, Origin, assigned worker, creator, editable inspection, active staging generation, MIME/size/SHA metadata and media signature/hash are checked before provider writes. Authorization is rechecked under locks after receiving bounded bytes. Both staging and verified assets use authenticated raw storage with overwrite disabled; promotion writes a checked buffer to a fresh immutable UUID. Private delivery URLs remain server-side. Existing version checks, receipts, verification jobs and generation-specific cleanup continue to apply.

Tests simulate Cloudinary with real PostgreSQL/Redis; live provider privacy and account limits must still be verified before release. Follow [CLOUDINARY_SETUP.md](CLOUDINARY_SETUP.md) for configuration, private access checks, upload limits and coordinated migration of any existing S3 bytes.

### Free-tier lifecycle and limits

- The web service spins down after 15 minutes without inbound traffic; BullMQ activity does not keep it awake. The inline worker stops with it, and jobs wait until an HTTP request wakes the service (cold starts take about a minute). PostgreSQL job intent and leases support reconciliation when it resumes. Do not rely on continuous background processing.
- A workspace receives 750 shared free web-service hours per month. Exhausted hours suspend free web services; without a payment method, exhausted bandwidth suspends free services and exhausted build minutes disable new builds for the remainder of the month. Stay within the included allowances for the $0 demo.
- Neon Free compute scales to zero after inactivity and resumes on connection. Monitor project compute and storage limits; exceeding Free allowances can make this database unavailable until usage or plan changes. Free Key Value is memory-only and loses data on restart; PostgreSQL remains the required-work source, and existing reconciliation republishes due jobs into Redis.
- The API and worker share the web instance's memory/CPU and one five-connection pool. Free services can restart at any time. Use this setup for demos with modest data and traffic; the local regression results do not establish free-tier capacity.

### Render keep-alive and Neon idle compute

Use `GET /api/v1/live` for Render's platform health check and optional external keep-alive. It returns HTTP 200 with process status, without a PostgreSQL/Redis probe, auth lookup or storage call. `GET /api/v1/health` retains its dependency checks and 503 response when PostgreSQL or Redis is unavailable. Liveness is not evidence that the database, queue or evidence provider is healthy.

The inline worker now wakes immediately after a shared-pool transaction commits new jobs. It waits until known retry, cleanup or lease deadlines instead of polling future jobs every five seconds. With no pending work it reconciles every thirty minutes (`JOBS_IDLE_INTERVAL_MS=1800000`), including object cleanup. Redis-loss/crash recovery remains bounded by that interval when no wake signal arrives. Busy/overdue jobs and reconciliation errors retain the five-second retry cadence, and active handlers retain lease heartbeats. The separate local worker retains its existing five-second reconciliation; the idle optimization applies to the shared-pool inline deployment.

For an optional hosted scheduler such as cron-job.org, configure GET `https://fieldsync-api-t5kg.onrender.com/api/v1/live`, every ten minutes (`*/10 * * * *`), timeout 60 seconds, with no request body, credentials or query parameters. The existing Render service's Health Check Path is now `/api/v1/live`, and the endpoint was verified live on 2026-11-21 after deploying `17333e3`. The external cron is still inactive pending scheduler access. To configure it through the API, store `CRON_JOB_API_KEY` in ignored `.env.local`; never paste it in chat or commit it. Manual setup is also available in cron-job.org. Editing this Blueprint alone is not proof of a deployed setting; the current configuration was checked through Render's API.

Do not add a Neon keep-alive query or schedule dependency health for keeping Render awake. Site requests resume Neon on demand. Keeping Render awake consumes its included service hours; idle SQL reconciliation, legitimate usage, cleanup, health monitoring and any other database clients still consume Neon CU-hours. At 0.25 CU and a five-minute suspension timeout, thirty-minute recovery checks alone are approximately 30 CU-hours per 30 days, before real workload. Actual compute size, suspension behavior, quotas and cold-start timings require live measurement; this change does not guarantee staying below 100 CU-hours.

## Environment inputs

Provide the existing API service's `sync: false` inputs through Render's server environment UI as part of the authorized cutover. The inline worker receives the same validated environment, pooled database connection, storage namespace and queue prefix as the API. No secrets belong in Git or `VITE_` variables.

| Input | Required value |
| --- | --- |
| `APP_ORIGIN` | Exact final HTTPS browser origin, such as `https://fieldsync.example.com`; no path. No trailing slash, credentials, query or fragment. Set it in Render before startup; build does not require it. Use the same origin for UI, cookies, CSRF and microphone permissions. Cloudinary uploads require no storage CORS. An existing local browser cache belongs to its old origin. |
| `ADDITIONAL_APP_ORIGINS` | Exact comma-separated extra browser origins (maximum five). During acceptance, keep the existing primary origin and allow `https://fieldsync-six.vercel.app`; no wildcard/preview suffixes. After acceptance, promote Vercel to `APP_ORIGIN` and retire unused origins. |
| `DATABASE_URL` | Neon pooled connection URL (host includes `-pooler`) for app and worker queries. |
| `MIGRATIONS_DATABASE_URL` | Neon direct/unpooled connection URL for `db:migrate`. Must target the same project, branch, database and role as `DATABASE_URL`; do not use the `-pooler` hostname. |
| `POSTGRES_SSL` | Blueprint sets `true`. The app uses TLS with certificate verification; keep the Neon hostname and `sslmode=require` query in the copied URL. Do not disable certificate verification or use `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| `REDIS_URL` | Blueprint supplies the private Key Value URL. No public access; `noeviction` protects BullMQ state. Use `rediss://` with verified certificates for any external Redis connection. |
| `EVIDENCE_STORAGE_PROVIDER` | Blueprint sets `cloudinary`; defaults to `s3` locally. Only the selected provider's settings are validated. |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary product environment cloud name, without a URL. |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Server/worker credentials for signed authenticated raw uploads, private downloads, deletion and Admin API listing. Never expose in frontend variables or logs. |
| `CLOUDINARY_FOLDER` | Dedicated namespace, e.g. `fieldsync-production`, matching `fieldsync-[a-z0-9][a-z0-9_-]{0,50}`. Never share with tests/another deployment. |
| `S3_*` | Ignored for Cloudinary and absent from this Blueprint. Existing S3 deployments require HTTPS endpoints, a dedicated private bucket and restricted credentials. [R2_SETUP.md](R2_SETUP.md) applies only when explicitly choosing R2. |
| `RUN_INLINE_WORKER` | Blueprint sets `true`; strict Boolean-string validation rejects other values. Defaults to `false` locally, where `npm run worker` remains available in a separate foreground terminal. Do not run that standalone worker in addition to the free-tier web process. |
| `JOBS_IDLE_INTERVAL_MS` | Inline worker idle recovery ceiling; defaults to 1800000 (30 minutes), validated from 360000 (6 minutes) to 86400000 (24 hours). New shared-pool job commits wake it immediately; shorter settings consume more idle compute, longer settings delay recovery after a missed signal. |
| `AI_ENABLED` / `OPENAI_API_KEY` | Keep `false` and empty for this $0 setup. Optional opt-in sends selected evidence/checklist content to OpenAI and has separate provider costs; verify consent and provider settings first. Missing keys or provider failures produce labeled deterministic/manual fallbacks. |
| `OPENAI_MODEL` / `OPENAI_TRANSCRIPTION_MODEL` | Defaults `gpt-5-mini` / `gpt-transcribe`. Set models available to the chosen provider account; a local contract simulation does not verify live account access or model quality. |

Other defaults: Node major 22, `API_HOST=0.0.0.0`, `API_PORT=10000`, `SERVE_WEB=true`, `TRUST_PROXY_HOPS=1`, 168-hour sessions, auth bursts 60/minute, AI bursts 10/minute, durable AI requests 20/hour/actor and a 30-second provider timeout. One trusted proxy hop is appropriate for Render's ingress only; local/direct hosting keeps it at zero. Match provider credentials and infrastructure policy to the [security review](SECURITY.md).

## Local readiness checks

Run with the existing local `.env`, Docker services and browser prerequisites:

```text
npm run check:env
npm run db:migrate
npm test
npm run build
npm run test:m3:browser
npm run test:m4:browser
npm run test:m5:browser
npm run test:cloudinary
npm run test:cloudinary:browser
```

The Blueprint can be checked without a Render account using Python's `PyYAML` and `jsonschema` against the public JSON schema. This command reads a public schema and validates a local file; it does not call Render's CLI/API validation endpoints:

```python
import json, urllib.request, yaml, jsonschema
with open("render.yaml", encoding="utf-8") as source:
    blueprint = yaml.safe_load(source)
schema = json.load(urllib.request.urlopen("https://render.com/schema/render.yaml.json"))
jsonschema.validate(blueprint, schema)
print("Local Blueprint schema validation passed")
```

## Existing Render service release sequence

1. Confirm the target free Hobby workspace, repository, resource names, region, origin, Neon URLs, Cloudinary authenticated raw capability, credentials and a dedicated namespace and recovery destination. Verify the Render web and Key Value services are Free and no payment method is needed. Keep automatic deploys disabled. Do not create/link a replacement Blueprint for this cutover.
2. The web service builds with `npm ci --include=dev && npm run build`. Free web services do not support `preDeployCommand`, so its start command is `npm run db:migrate && npm run start --workspace=@fieldsync/server`. Migrations use the direct Neon URL while application requests use the pooled URL. Ordered migrations 001–005 run transactionally under the existing migration lock on every start and become no-ops when current. A migration failure prevents both the listener and worker from starting. Application code itself does not migrate automatically.
3. Push tested Cloudinary support before any deployment. Validate the dedicated Cloudinary namespace before release, including anonymous staging/verified access denial and confirmed deletion. Confirm the web logs show both `FieldSync API listening` and `FieldSync inline background worker started`, then verify actual job completion. There is no second service to deploy or restart. Start/restart of the web process starts/restarts the worker too.
4. Check `/api/v1/health`, then perform register/login, tenant isolation, real constrained evidence upload, verification, manual submit/approve, archive, microphone/offline replay and analytics smoke checks. Free services have no Render shell/SSH or one-off jobs: any approved administration or `check:env` must run from a separate trusted machine with appropriately allowlisted, verified-TLS public datastore connections. Health probes PostgreSQL/Redis; `check:env` also checks the selected storage provider (authenticated raw Admin API listing for Cloudinary). Neither replaces real private upload/download/delete checks or proves worker liveness. Record actual cloud observations separately from local results.
5. Export and verify encrypted PostgreSQL/object backups from that trusted machine before accepting demo data. Restore into fresh targets following [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Monitor Neon compute/storage allowances, Render included usage, job failure/lease ages, storage failures, auth throttling and database/storage capacity; logs omit file bytes, model output and credentials.

On SIGTERM/SIGINT, one idempotent shutdown stops accepting HTTP requests and closes the BullMQ runtime, including its reconciliation timer and Redis connections. In-flight requests and active jobs drain concurrently before shared storage and PostgreSQL close. The complete process has one ten-second deadline; interrupted jobs recover through sixty-second PostgreSQL leases and reconciliation after wake/restart. Listener startup errors use the same cleanup and leave a failing exit code. External AI calls can repeat after a crash; durable completion is fenced, not an exactly-once provider guarantee. Failed provider calls ordinarily settle with a fallback instead of wasting five paid retries.

For rollback, stop the web service, which also stops the inline worker. Prefer a forward fix or restore the coherent database/object backup to new targets; migration 005's down operation deletes AI jobs/reviews/artifacts and is not a routine production rollback. Keep the previous build and backup manifest until the release is accepted. Do not restart an older build whose worker cannot handle `assist_inspection` jobs.

Public references reviewed for this local configuration on 2026-11-18: [Render free instances and limits](https://render.com/docs/free), [Blueprint spec](https://render.com/docs/blueprint-spec), [Neon connection pooling](https://neon.com/docs/connect/connection-pooling), [Neon TLS/SNI connection notes](https://neon.com/docs/connect/connect-from-any-app), and [Neon pricing](https://neon.com/pricing). No Render or Neon account was accessed to prepare these files.
