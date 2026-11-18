# Cloudinary evidence storage

FieldSync's Render Blueprint selects Cloudinary. Keep the existing Neon pooled `DATABASE_URL` and direct `MIGRATIONS_DATABASE_URL`; storage changes do not require new database credentials, a new Neon project or schema migrations. This code change does not deploy or change a Cloudinary account.

Set these values in Render's server environment UI before production startup:

| Variable | Value |
| --- | --- |
| `EVIDENCE_STORAGE_PROVIDER` | `cloudinary` |
| `APP_ORIGIN` | Final HTTPS browser origin, without trailing slash, credentials, path, query or fragment. |
| `CLOUDINARY_CLOUD_NAME` | Cloud name from the selected Cloudinary product environment. |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Server credentials from that environment. Never commit, print or expose through `VITE_` variables. |
| `CLOUDINARY_FOLDER` | Unique namespace per deployment, such as `fieldsync-production`. Required format: `fieldsync-[a-z0-9][a-z0-9_-]{0,50}`. |

Do not configure public/unsigned upload presets or a browser Cloudinary SDK. S3 endpoints/credentials are ignored for Cloudinary; stale R2 settings can be removed from Render. `.env.example` still defaults to S3 for local Compose. Build does not require `APP_ORIGIN`; production startup does. An invalid/missing production origin is never bypassed.

The API validates the session, CSRF Origin, assignment, creator, editable state, reservation generation, MIME, exact size, SHA-256 and media signature before provider writes. Transfers are bounded by the reservation (10 MiB photos, 25 MiB audio) and a deadline. Authorization is rechecked under locks after receiving bytes. The browser receives an API PUT descriptor with `transport=server` and sends same-origin cookies. Cloudinary stores signed `raw/authenticated` staging and verified assets with `overwrite=false`. Retries read/verify existing bytes; promotion writes a fresh verified UUID from the checked buffer. Cloudinary never transforms evidence. Original filenames remain PostgreSQL metadata, not provider IDs.

Downloads remain the authorized API endpoint with `Cache-Control: no-store`. The server uses a short-lived private download API URL internally and verifies bytes again; it never redirects the browser to Cloudinary or returns provider URLs. Removal preserves version checks, immediately attempts deletion with invalidation and persists cleanup intent. Generation-specific cleanup and the age-based sweeper list only authenticated raw assets in the configured namespace. Never share namespaces: reconciliation deletes old unreferenced assets.

Before hosted evidence intake, verify PNG and recorded audio uploads, worker verification, downloads and removal using a disposable inspection. Verify anonymous unsigned `raw/upload` and `raw/authenticated` URLs cannot retrieve staging or verified bytes, and cross-tenant/unassigned-worker API requests fail. Confirm deletion. `npm run check:env` checks authenticated Admin API listing, not privacy or upload capacity. If authenticated raw assets/private downloads/listing are unavailable on the account, fail the release; never fall back to public assets or unsigned uploads. Review current raw-file size, storage, bandwidth and Admin API rate limits (audio can be 25 MiB). The sweeper may use several Admin API requests per minute; monitor quotas and cleanup failures. Regression tests simulate Cloudinary with real PostgreSQL/Redis; they do not establish live account capabilities.

Changing providers or `CLOUDINARY_FOLDER` does not migrate bytes. For existing S3 evidence, pause mutations/workers, back up PostgreSQL/private objects, copy each verified key to `<folder>/<existing key>` as authenticated raw with overwrite disabled and verify size/signature/hash against its evidence row. Preserve exact UUID keys and bytes. Omit expired staging uploads and let retained browser queues renew them. Run downloads, worker, tenant checks and recovery validation before switching traffic. Keep coherent encrypted backups; see [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

For the Vercel frontend/Render API split, the browser uses Vercel same-origin API rewrites. Cloudinary descriptors bind to the validated requesting application Origin, so both explicitly approved hosts can upload during acceptance. Never redirect browser uploads/downloads to Cloudinary or copy provider credentials to Vercel. See [VERCEL_RENDER_SETUP.md](VERCEL_RENDER_SETUP.md).
