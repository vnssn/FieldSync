# FieldSync deployment guide

The M5 deployment deliverable is the local [render.yaml](../render.yaml) and this guide. No Render service, account connection, deployment or production environment has been created or verified. **Before any Render account-linked action, stop and ask the user to switch their active account and authorize continuation.** Importing a Blueprint can create resources and start an initial deployment; `autoDeployTrigger: "off"` only disables subsequent automatic deploys.

## Single-service free-tier topology

The Blueprint explicitly sets `plan: free` on one Node web service and private Key Value/Redis. PostgreSQL is hosted by the user's Neon Free project, not provisioned by Render. The web service serves the built React application and runs the existing BullMQ runtime in the same Node process with `RUN_INLINE_WORKER=true`. There is no separate Render background-worker service, which has no free plan. Render resources use Singapore; choose the nearest Neon region when creating the database. Review names against existing resources before import because Render can link matching names.

Use Render's free Hobby workspace and Free instance plans without adding a credit card or payment details. This configuration requests no paid compute, persistent disks, pre-deploy commands, one-off jobs or shell access. Leave `AI_ENABLED=false` and `OPENAI_API_KEY` empty to avoid paid provider calls. If the selected account or creation flow requires payment, stop; this local change does not authorize a paid plan or adding billing details.

The Blueprint selects `EVIDENCE_STORAGE_PROVIDER=cloudinary`. Provision Cloudinary separately using [CLOUDINARY_SETUP.md](CLOUDINARY_SETUP.md): evidence uses authenticated raw assets and server-proxied uploads/downloads with the existing authorization and integrity checks. S3/MinIO remains available with `EVIDENCE_STORAGE_PROVIDER=s3`. Cloudinary ignores all `S3_*` values, including stale invalid endpoints. Render's ephemeral filesystem cannot store evidence/databases. Full evidence/voice workflows require storage even with AI disabled. The Blueprint does not provision or verify a Cloudinary account or its plan limits.

### Neon database setup

Use the pooled Neon connection string for app traffic and a second, direct (unpooled) connection string for schema migrations. Neon uses PgBouncer transaction pooling on pooled endpoints and recommends direct connections for migrations. FieldSync migrations run before the web service starts, so a pooler-only URL is insufficient. Copy both URLs from the same Neon project/branch/database/role: Connection pooling **on** for `DATABASE_URL`, **off** for `MIGRATIONS_DATABASE_URL`. Keep both secret; never paste them in chat or commit them. Neon’s AWS projects support both IPv4 and IPv6, and the current `pg` driver supports the TLS SNI Neon requires; keep the DNS hostname (do not replace it with a resolved IP). Set `POSTGRES_SSL=true`; FieldSync strips URL `sslmode` toggles and enforces certificate verification in `pg`.

Neon Free's current limits include 1 GB database storage and 100 compute-hours per project monthly; compute can scale to zero. Render's Free web service also sleeps after inactivity, so expect cold starts and delayed queue processing. Free Key Value is volatile and jobs are recovered from PostgreSQL after a restart. Review the current [Neon plans](https://neon.com/pricing) and [connection pooling guide](https://neon.com/docs/connect/connection-pooling) before setup. This is a portfolio/demo configuration, not an always-on service.

### Private Cloudinary evidence storage

Cloudinary now uses an authenticated same-origin binary PUT route. Session, Origin, assigned worker, creator, editable inspection, active staging generation, MIME/size/SHA metadata and media signature/hash are checked before provider writes. Authorization is rechecked under locks after receiving bounded bytes. Both staging and verified assets use authenticated raw storage with overwrite disabled; promotion writes a checked buffer to a fresh immutable UUID. Private delivery URLs remain server-side. Existing version checks, receipts, verification jobs and generation-specific cleanup continue to apply.

Tests simulate Cloudinary with real PostgreSQL/Redis; live provider privacy and account limits must still be verified before release. Follow [CLOUDINARY_SETUP.md](CLOUDINARY_SETUP.md) for configuration, private access checks, upload limits and coordinated migration of any existing S3 bytes.

### Free-tier lifecycle and limits

- The web service spins down after 15 minutes without inbound traffic; BullMQ activity does not keep it awake. The inline worker stops with it, and jobs wait until an HTTP request wakes the service (cold starts take about a minute). PostgreSQL job intent and leases support reconciliation when it resumes. Do not rely on continuous background processing.
- A workspace receives 750 shared free web-service hours per month. Exhausted hours suspend free web services; without a payment method, exhausted bandwidth suspends free services and exhausted build minutes disable new builds for the remainder of the month. Stay within the included allowances for the $0 demo.
- Neon Free compute scales to zero after inactivity and resumes on connection. Monitor project compute and storage limits; exceeding Free allowances can make this database unavailable until usage or plan changes. Free Key Value is memory-only and loses data on restart; PostgreSQL remains the required-work source, and existing reconciliation republishes due jobs into Redis.
- The API and worker share the web instance's memory/CPU and one five-connection pool. Free services can restart at any time. Use this setup for demos with modest data and traffic; the local regression results do not establish free-tier capacity.

## Environment inputs

Provide the web service's `sync: false` inputs through Render's secret/environment UI **after approval**. The inline worker receives the same validated environment, pooled database connection, storage namespace and queue prefix as the API. No secrets belong in Git or `VITE_` variables.

| Input | Required value |
| --- | --- |
| `APP_ORIGIN` | Exact final HTTPS browser origin, such as `https://fieldsync.example.com`; no path. No trailing slash, credentials, query or fragment. Set it in Render before startup; build does not require it. Use the same origin for UI, cookies, CSRF and microphone permissions. Cloudinary uploads require no storage CORS. An existing local browser cache belongs to its old origin. |
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

## Release sequence after account-switch approval

1. Confirm the target free Hobby workspace, repository, resource names, region, origin, Neon URLs, Cloudinary authenticated raw capability, credentials and a dedicated namespace and recovery destination. Verify the Render web and Key Value services are Free and no payment method is needed. Keep automatic deploys disabled. Creating/linking the Blueprint is itself a gated action.
2. The web service builds with `npm ci --include=dev && npm run build`. Free web services do not support `preDeployCommand`, so its start command is `npm run db:migrate && npm run start --workspace=@fieldsync/server`. Migrations use the direct Neon URL while application requests use the pooled URL. Ordered migrations 001–005 run transactionally under the existing migration lock on every start and become no-ops when current. A migration failure prevents both the listener and worker from starting. Application code itself does not migrate automatically.
3. Push tested Cloudinary support before any deployment. Validate the dedicated Cloudinary namespace before release, including anonymous staging/verified access denial and confirmed deletion. Confirm the web logs show both `FieldSync API listening` and `FieldSync inline background worker started`, then verify actual job completion. There is no second service to deploy or restart. Start/restart of the web process starts/restarts the worker too.
4. Check `/api/v1/health`, then perform register/login, tenant isolation, real constrained evidence upload, verification, manual submit/approve, archive, microphone/offline replay and analytics smoke checks. Free services have no Render shell/SSH or one-off jobs: any approved administration or `check:env` must run from a separate trusted machine with appropriately allowlisted, verified-TLS public datastore connections. Health probes PostgreSQL/Redis; `check:env` also checks the selected storage provider (authenticated raw Admin API listing for Cloudinary). Neither replaces real private upload/download/delete checks or proves worker liveness. Record actual cloud observations separately from local results.
5. Export and verify encrypted PostgreSQL/object backups from that trusted machine before accepting demo data. Restore into fresh targets following [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Monitor Neon compute/storage allowances, Render included usage, job failure/lease ages, storage failures, auth throttling and database/storage capacity; logs omit file bytes, model output and credentials.

On SIGTERM/SIGINT, one idempotent shutdown stops accepting HTTP requests and closes the BullMQ runtime, including its reconciliation timer and Redis connections. In-flight requests and active jobs drain concurrently before shared storage and PostgreSQL close. The complete process has one ten-second deadline; interrupted jobs recover through sixty-second PostgreSQL leases and reconciliation after wake/restart. Listener startup errors use the same cleanup and leave a failing exit code. External AI calls can repeat after a crash; durable completion is fenced, not an exactly-once provider guarantee. Failed provider calls ordinarily settle with a fallback instead of wasting five paid retries.

For rollback, stop the web service, which also stops the inline worker. Prefer a forward fix or restore the coherent database/object backup to new targets; migration 005's down operation deletes AI jobs/reviews/artifacts and is not a routine production rollback. Keep the previous build and backup manifest until the release is accepted. Do not restart an older build whose worker cannot handle `assist_inspection` jobs.

Public references reviewed for this local configuration on 2026-11-18: [Render free instances and limits](https://render.com/docs/free), [Blueprint spec](https://render.com/docs/blueprint-spec), [Neon connection pooling](https://neon.com/docs/connect/connection-pooling), [Neon TLS/SNI connection notes](https://neon.com/docs/connect/connect-from-any-app), and [Neon pricing](https://neon.com/pricing). No Render or Neon account was accessed to prepare these files.
