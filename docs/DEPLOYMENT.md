# FieldSync deployment guide

The M5 deployment deliverable is the local [render.yaml](../render.yaml) and this guide. No Render service, account connection, deployment or production environment has been created or verified. **Before any Render account-linked action, stop and ask the user to switch their active account and authorize continuation.** Importing a Blueprint can create resources and start an initial deployment; `autoDeployTrigger: "off"` only disables subsequent automatic deploys.

## Single-service free-tier topology

The Blueprint explicitly sets `plan: free` on one Node web service, PostgreSQL 17 and private Key Value/Redis. The web service serves the built React application and runs the existing BullMQ runtime in the same Node process with `RUN_INLINE_WORKER=true`. There is no separate Render background-worker service, which has no free plan. All resources use Singapore; change every region together before applying if another region is preferred. Review names against existing resources before import because Render can link matching names.

Use Render's free Hobby workspace and Free instance plans without adding a credit card or payment details. This configuration requests no paid compute, persistent disks, pre-deploy commands, one-off jobs or shell access. Leave `AI_ENABLED=false` and `OPENAI_API_KEY` empty to avoid paid provider calls. If the selected account or creation flow requires payment, stop; this local change does not authorize a paid plan or adding billing details.

The private S3-compatible evidence bucket is provisioned separately. Use an externally reachable HTTPS MinIO-compatible service supporting path-style SigV4 POST policies, conditional PutObject, Head/Get/DeleteObject and ListObjectsV2. Render's ephemeral application filesystem cannot store evidence or databases. Never expose the local Compose services to the internet. Full evidence/voice workflows still require this external bucket and its credentials, including while AI is disabled. Its provider must independently offer compatible free storage without billing details to keep the whole demo at $0; this Blueprint does not provision or verify that storage. The application cannot run every M0-M5 feature entirely on Render's free resources alone.

### Free-tier lifecycle and limits

- The web service spins down after 15 minutes without inbound traffic; BullMQ activity does not keep it awake. The inline worker stops with it, and jobs wait until an HTTP request wakes the service (cold starts take about a minute). PostgreSQL job intent and leases support reconciliation when it resumes. Do not rely on continuous background processing.
- A workspace receives 750 shared free web-service hours per month. Exhausted hours suspend free web services; without a payment method, exhausted bandwidth suspends free services and exhausted build minutes disable new builds for the remainder of the month. Stay within the included allowances for the $0 demo.
- Free PostgreSQL has fixed 1 GB storage, expires after 30 days, and has no managed backups. Export data before expiration; the database becomes inaccessible at expiration and is deleted after the subsequent 14-day upgrade grace period. Plan a fresh demo database and restoration before expiration rather than assuming indefinite free hosting.
- Only one free PostgreSQL database and one free Key Value instance can be active per workspace. Free Key Value is memory-only and loses data on restart; PostgreSQL remains the required-work source, and the existing reconciliation republishes due jobs into Redis.
- The API and worker share the web instance's memory/CPU and one five-connection pool. Free services can restart at any time. Use this setup for demos with modest data and traffic; the local regression results do not establish free-tier capacity.

## Environment inputs

Provide the web service's `sync: false` inputs through Render's secret/environment UI **after approval**. The inline worker receives the same validated environment, pool, bucket and queue prefix as the API. No secrets belong in Git or `VITE_` variables.

| Input | Required value |
| --- | --- |
| `APP_ORIGIN` | Exact final HTTPS browser origin, such as `https://fieldsync.example.com`; no path. Use the same origin for the UI, cookies, CSRF, microphone permissions and storage CORS. An existing local browser cache belongs to its old origin. |
| `DATABASE_URL` | Blueprint supplies the same-region private PostgreSQL URL. API and inline worker share the pool/database. |
| `POSTGRES_SSL` | `false` in this Blueprint for Render's private internal URL. Render documents self-signed internal certificates, incompatible with this app's verified-TLS option. Public administration must use verified TLS. If encrypted application database transport is required, supply the external verified-certificate URL to the web service, set `POSTGRES_SSL=true`, and restrict its allowlist to the web service's outbound addresses. Do not disable certificate verification or use `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| `REDIS_URL` | Blueprint supplies the private Key Value URL. No public access; `noeviction` protects BullMQ state. Use `rediss://` with verified certificates for any external Redis connection. |
| `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT` | HTTPS API and browser endpoints; normally the same HTTPS storage origin. Endpoint must support the bucket path used by constrained POST uploads. |
| `S3_REGION` / `S3_BUCKET` | Actual signing region and dedicated private deployment bucket. Never share the development/test bucket or another deployment's cleanup namespace. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Restricted service identity with list/read/write/delete only in this bucket. Keep public access blocked, retain encrypted backups, and allow browser POST only from `APP_ORIGIN`. Presigned policies further constrain each upload to its own staging object. |
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

1. Confirm the target free Hobby workspace, repository, resource names, region, origin, compatible free external storage credentials/CORS and recovery destination. Verify all three instances are Free and no payment method is needed. Keep automatic deploys disabled. Creating/linking the Blueprint is itself a gated action.
2. The web service builds with `npm ci --include=dev && npm run build`. Free web services do not support `preDeployCommand`, so its start command is `npm run db:migrate && npm run start --workspace=@fieldsync/server`. Ordered migrations 001–005 run transactionally under the existing migration lock on every start and become no-ops when current. A migration failure prevents both the listener and worker from starting. Application code itself does not migrate automatically.
3. Validate the dedicated bucket before release. Confirm the web logs show both `FieldSync API listening` and `FieldSync inline background worker started`, then verify actual job completion. There is no second service to deploy or restart. Start/restart of the web process starts/restarts the worker too.
4. Check `/api/v1/health`, then perform register/login, tenant isolation, real constrained evidence upload, verification, manual submit/approve, archive, microphone/offline replay and analytics smoke checks. Free services have no Render shell/SSH or one-off jobs: any approved administration or `check:env` must run from a separate trusted machine with appropriately allowlisted, verified-TLS public datastore connections. Health probes PostgreSQL/Redis; it does not replace the S3 check or prove worker liveness. Record actual cloud observations separately from local results.
5. Export and verify encrypted PostgreSQL/object backups from that trusted machine before accepting demo data and well before day 30. Free PostgreSQL does not provide managed backups. Restore into fresh targets following [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Monitor expiration, included usage, job failure/lease ages, storage failures, auth throttling and database/storage capacity; logs omit file bytes, model output and credentials.

On SIGTERM/SIGINT, one idempotent shutdown stops accepting HTTP requests and closes the BullMQ runtime, including its reconciliation timer and Redis connections. In-flight requests and active jobs drain concurrently before shared storage and PostgreSQL close. The complete process has one ten-second deadline; interrupted jobs recover through sixty-second PostgreSQL leases and reconciliation after wake/restart. Listener startup errors use the same cleanup and leave a failing exit code. External AI calls can repeat after a crash; durable completion is fenced, not an exactly-once provider guarantee. Failed provider calls ordinarily settle with a fallback instead of wasting five paid retries.

For rollback, stop the web service, which also stops the inline worker. Prefer a forward fix or restore the coherent database/object backup to new targets; migration 005's down operation deletes AI jobs/reviews/artifacts and is not a routine production rollback. Keep the previous build and backup manifest until the release is accepted. Do not restart an older build whose worker cannot handle `assist_inspection` jobs.

Public references reviewed for this local configuration on 2026-11-18: [Free instances and limits](https://render.com/docs/free), [Blueprint spec](https://render.com/docs/blueprint-spec), [PostgreSQL connections/TLS](https://render.com/docs/postgresql-creating-connecting), and [JSON schema](https://render.com/schema/render.yaml.json). No Render account was accessed to prepare these files.
