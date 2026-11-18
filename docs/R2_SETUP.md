# Cloudflare R2 evidence storage

FieldSync uploads raw photo/audio Blobs with presigned SigV4 **PUT** requests. R2 does not support presigned HTML form POST uploads. The API still uses `POST /inspections/:id/evidence/:evidenceId/upload` to authorize and issue a descriptor containing `url`, `method: PUT`, strict `headers`, `size` and `expiresAt`. Browser storage requests send `Content-Type` and `x-amz-meta-sha256`, without application cookies or the storage secret. The browser automatically supplies the signed Content-Length from the Blob.

## Create the R2 resources yourself

1. Enable R2 in your intended Cloudflare account and review subscription/billing requirements. Standard storage has included free usage, with charges above the allowances; R2 is not a guarantee of cardless hosting. No Cloudflare or Render account was accessed for this change.
2. Create a dedicated **Standard** bucket for this deployment. Use a 3–63-character name with lowercase letters/digits/dots/hyphens, starting/ending with a letter or digit. Do not share a development/test bucket or another deployment's cleanup namespace.
3. Leave **Public Development URL / r2.dev disabled** and do not connect a public custom domain. Staging and verified objects must remain private. No public-read ACL, Cloudflare Worker or custom upload gateway is needed.
4. Under R2 account details, open **Manage API Tokens**, then create an R2 Account API token (or User API token if account tokens are unavailable). Choose **Object Read & Write**, scoped to this bucket only. The app needs upload/read/list/delete for promotion, downloads and cleanup, without bucket administration. Save the generated S3 **Access Key ID** and **Secret Access Key** securely; the secret is displayed once. Use these S3 credentials, rather than a generic Cloudflare API token or Global API Key. Configure token expiry/rotation appropriately. Any IP restrictions must permit the field workers' browser IPs too, because their presigned PUTs go directly to R2.
5. Copy the actual bucket **S3 API endpoint**. Ordinary buckets use the account's `r2.cloudflarestorage.com` host; jurisdictional buckets require their matching jurisdiction endpoint. Copy it exactly, without bucket name, object path, query or a custom domain.
6. Open the bucket's **Settings → CORS Policy → Add CORS policy → JSON**. Create a JSON array containing one object with the fields below. Use the real final `APP_ORIGIN` (scheme/host/port, no path/trailing slash). CORS permits browser requests; it does not make the bucket public or replace signatures/tenant authorization.

| CORS field | Value |
| --- | --- |
| `AllowedOrigins` | Array containing the actual `APP_ORIGIN` string; no `*`. Add a local origin only for deliberate testing against this bucket. |
| `AllowedMethods` | `["PUT"]` |
| `AllowedHeaders` | `["Content-Type", "x-amz-meta-sha256"]` |
| `MaxAgeSeconds` | `300` |

Do not add POST or OPTIONS; R2 handles preflight. JavaScript must not set the browser-controlled Content-Length header. ExposeHeaders is unnecessary because ETag is not used as proof of SHA-256. Downloads pass through the authenticated FieldSync API, so this flow needs no browser GET/HEAD/DELETE permission.

This **local read-only** command prints exact CORS JSON from an already configured real `APP_ORIGIN`. It applies nothing and changes no settings:

```powershell
node --input-type=module -e "import { env } from './apps/server/src/config/env.js'; console.log(JSON.stringify([{ AllowedOrigins: [env.APP_ORIGIN], AllowedMethods: ['PUT'], AllowedHeaders: ['Content-Type', 'x-amz-meta-sha256'], MaxAgeSeconds: 300 }], null, 2));"
```

Check the printed origin before copying it. If local `.env` still uses localhost, enter the actual deployed origin in the R2 JSON editor yourself instead.

## Render web-service environment inputs

Set these existing **server-only** variables yourself using actual account values when you choose to configure/deploy. This task did not change your Render account, local `.env`, Blueprint environment values or secret settings.

| Variable | Value to set |
| --- | --- |
| `S3_ENDPOINT` | The exact R2 S3 API endpoint copied above. |
| `S3_PUBLIC_ENDPOINT` | The **same R2 S3 API endpoint**. “Public” means browser-reachable, not public object access. |
| `S3_REGION` | `auto` |
| `S3_BUCKET` | Your actual dedicated R2 bucket name. |
| `S3_ACCESS_KEY_ID` | The scoped token's generated S3 Access Key ID. |
| `S3_SECRET_ACCESS_KEY` | That token's generated S3 Secret Access Key, stored in Render's secret UI. |
| `S3_FORCE_PATH_STYLE` | `true` |
| `APP_ORIGIN` | The actual final HTTPS browser origin, identical to AllowedOrigins. |

Keep `SERVE_WEB=true` and `RUN_INLINE_WORKER=true` for the existing single-service setup so uploads get verified, with database/Redis inputs as documented in [DEPLOYMENT.md](DEPLOYMENT.md). No `VITE_` storage variable, browser credential, Cloudflare account-ID environment variable or additional R2 secret is required. AI can remain disabled.

## Preserved guarantees and limits

Each URL signs **only PUT to one tenant-prefixed staging key**, exact content type, Content-Length and SHA-256 metadata. It expires after at most ten minutes and never outlives the twenty-minute reservation. A signed URL is a bearer capability: avoid sharing/logging it. It can overwrite its staging object until expiration, but never authorizes reads/deletes or writes to a verified key.

R2 has no POST-policy content-length-range and differs from AWS checksum support. The exact length is signed, and the browser rejects mismatched Blobs before sending. The server independently verifies HEAD size/type, bounded GET length, media signature and SHA-256 against the reserved metadata. Optional AWS SDK checksum/trailer combinations are disabled. Successful PUT alone does not attach evidence or prove its integrity.

Promotion verifies and writes the **checked buffer** to a fresh server-controlled verified UUID key with `If-None-Match: *`; R2 documents atomic conditional PutObject support. There is no CopyObject from mutable staging or unconditional-write fallback. This is application immutability, not a retention lock: the server identity can delete evidence for explicit removal/cleanup. Avoid retention locks or lifecycle rules that block cleanup or delete live verified objects.

Offline replay first checks for a prior attachment commit, then obtains a fresh descriptor when needed. Interrupted PUTs, lost responses and CORS failures retain the Blob and frozen mutation IDs/body. Expiration renewal rotates the staging key; old cleanup jobs cannot delete the new upload. R2 expired-URL errors may omit CORS response headers and appear as a browser network error, so retries do not depend on parsing their bodies. Dexie/outbox state needs no schema migration.

Presigned URLs require the R2 **S3 API domain**, including any required jurisdiction endpoint. They cannot use r2.dev/custom CDN domains; altering a signed host/path invalidates the signature. Keep the two endpoint variables equal for R2. Reservation, descriptor and attachment still enforce current tenant, assignment, editable state, versions and receipt replay.

Before switching an existing bucket/provider, back up and copy verified objects with exact keys, bytes, Content-Type and SHA-256 metadata coordinated with PostgreSQL, following [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Changing variables does not move existing MinIO objects. Later roll out the API and matching client build together and refresh old browser tabs without deleting IndexedDB. Account configuration, object migration and deployment remain your tasks.

## Live R2 checks you must perform

Local verification uses actual MinIO/PostgreSQL/Redis and browser uploads. Signing-only fixtures use a synthetic R2 endpoint without contacting Cloudflare. Live R2 permissions, CORS, billing and production uploads remain unverified.

After your authorized rollout, upload a photo and audio recording from the real HTTPS origin. Confirm PUT succeeds, the worker marks evidence ready, and authorized downloads match the original bytes. Check anonymous reads stay denied, offline reload/reconnect completes upload, and removal cleans storage. `/api/v1/health` probes database/Redis, not R2; check storage separately from a trusted environment. Keep signed URLs and credentials out of logs/support messages.

References reviewed 2026-11-18: [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/), [R2 tokens](https://developers.cloudflare.com/r2/api/tokens/), [CORS](https://developers.cloudflare.com/r2/buckets/cors/) and [pricing](https://developers.cloudflare.com/r2/pricing/).
