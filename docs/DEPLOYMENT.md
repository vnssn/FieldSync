# FieldSync deployment guide

The M5 deployment deliverable is the local [render.yaml](../render.yaml) and this guide. No Render service, account connection, deployment or production environment has been created or verified. **Before any Render account-linked action, stop and ask the user to switch their active account and authorize continuation.** Importing a Blueprint can create resources and start an initial deployment; `autoDeployTrigger: "off"` only disables subsequent automatic deploys.

## Proposed topology

The Blueprint defines one Node API serving the built React application, one BullMQ worker, paid PostgreSQL 17 and private Key Value. All use Singapore; change every region together before applying if another region is preferred. Plan IDs are small paid instances, not a throughput guarantee. Review names against existing resources before import because Render can link matching names. Review costs in the selected account after authorization.

The private S3-compatible evidence bucket is provisioned separately. Use an externally reachable HTTPS MinIO-compatible service supporting path-style SigV4 POST policies, conditional PutObject, Head/Get/DeleteObject and ListObjectsV2. Render's ephemeral application filesystem cannot store evidence or databases. Never expose the local Compose services to the internet.

## Environment inputs

Provide the API's `sync: false` inputs through Render's secret/environment UI **after approval**. The worker references the API's storage and provider configuration; do not give it a different bucket or queue prefix. No secrets belong in Git or `VITE_` variables.

| Input | Required value |
| --- | --- |
| `APP_ORIGIN` | Exact final HTTPS browser origin, such as `https://fieldsync.example.com`; no path. Use the same origin for the UI, cookies, CSRF, microphone permissions and storage CORS. An existing local browser cache belongs to its old origin. |
| `DATABASE_URL` | Blueprint supplies the same-region private PostgreSQL URL. API and worker use the same database. |
| `POSTGRES_SSL` | `false` in this Blueprint for Render's private internal URL. Render documents self-signed internal certificates, incompatible with this app's verified-TLS option. Public administration must use verified TLS. If encrypted application database transport is required, supply the external verified-certificate URL to **both** services, set `POSTGRES_SSL=true`, and restrict its allowlist to their outbound addresses. Do not disable certificate verification or use `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| `REDIS_URL` | Blueprint supplies the private Key Value URL. No public access; `noeviction` protects BullMQ state. Use `rediss://` with verified certificates for any external Redis connection. |
| `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT` | HTTPS API and browser endpoints; normally the same HTTPS storage origin. Endpoint must support the bucket path used by constrained POST uploads. |
| `S3_REGION` / `S3_BUCKET` | Actual signing region and dedicated private deployment bucket. Never share the development/test bucket or another deployment's cleanup namespace. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Restricted service identity with list/read/write/delete only in this bucket. Keep public access blocked, retain encrypted backups, and allow browser POST only from `APP_ORIGIN`. Presigned policies further constrain each upload to its own staging object. |
| `AI_ENABLED` / `OPENAI_API_KEY` | Defaults are `false` and empty. Optional opt-in sends selected evidence/checklist content to OpenAI; verify consent and provider settings first. Set both services consistently if enabling. Missing keys or provider failures produce labeled deterministic/manual fallbacks. |
| `OPENAI_MODEL` / `OPENAI_TRANSCRIPTION_MODEL` | Defaults `gpt-5-mini` / `gpt-transcribe`. Set models available to the chosen provider account; a local contract simulation does not verify live account access or model quality. |

Other defaults: Node major 22, `API_HOST=0.0.0.0`, `API_PORT=10000`, `SERVE_WEB=true`, `TRUST_PROXY_HOPS=1`, 168-hour sessions, auth bursts 60/minute, AI bursts 10/minute, durable AI requests 20/hour/actor and a 30-second provider timeout. One trusted proxy hop is appropriate for Render's ingress only; local/direct hosting keeps it at zero. PostgreSQL pools allow five connections per process. Match provider credentials and infrastructure policy to the [security review](SECURITY.md).

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

1. Confirm the target account/workspace, repository, resource names, region, costs, origin, storage credentials/CORS and recovery destination. Keep automatic deploys disabled. Creating/linking the Blueprint is itself a gated action.
2. The API builds with `npm ci --include=dev && npm run build`; its paid-service pre-deploy command runs `npm run db:migrate` once before starting. Do not put migrations in every process's start command. Migration 005 is additive; ordered migrations 001–005 run transactionally under the existing migration lock.
3. Start/restart the worker only after migration success and bucket validation. Blueprint references coordinate configuration, not a guarantee that schema migrations finish before a worker starts. If initial creation starts the worker early, redeploy/restart it after API migration success and confirm reconciliation succeeds before opening traffic.
4. Run `check:env` in the deployed environment, check `/api/v1/health`, then perform register/login, tenant isolation, real constrained evidence upload, verification, manual submit/approve, archive, microphone/offline replay and analytics smoke checks. Health probes PostgreSQL/Redis; it does not replace the S3 check or prove worker liveness. Record actual cloud observations separately from local results.
5. Take and verify the first encrypted PostgreSQL/object backup before accepting real field data. Restore into fresh targets following [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Monitor job failure/lease ages, storage failures, auth throttling, database/storage capacity and provider cost; logs omit file bytes, model output and credentials.

API shutdown allows ten seconds for in-flight requests. Worker shutdown also has a ten-second deadline; work that is interrupted recovers through sixty-second PostgreSQL leases and reconciliation. External AI calls can repeat after a crash; durable completion is fenced, not an exactly-once provider guarantee. Failed provider calls ordinarily settle with a fallback instead of wasting five paid retries.

For rollback, pause traffic and worker first. Prefer a forward fix or restore the coherent database/object backup to new targets; migration 005's down operation deletes AI jobs/reviews/artifacts and is not a routine production rollback. Keep the previous build and backup manifest until the release is accepted. Do not restart an older worker that cannot handle `assist_inspection` jobs.

Public references reviewed for this local configuration: [Blueprint spec](https://render.com/docs/blueprint-spec), [PostgreSQL connections/TLS](https://render.com/docs/postgresql-creating-connecting), and [JSON schema](https://render.com/schema/render.yaml.json). No Render account was accessed to prepare these files.
