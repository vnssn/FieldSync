# Vercel frontend and existing Render API

Production frontend: **https://fieldsync-six.vercel.app**. Existing backend: **https://fieldsync-api-t5kg.onrender.com**. The Vercel project is `innova15/fieldsync`, on the existing Hobby workspace, connected to `vnssn/FieldSync` with production branch `main`. There is one backend, one Neon database and the existing Render Redis/Cloudinary configuration. No infrastructure secrets are needed in Vercel.

## Current cutover status

Live browser acceptance on 2026-11-21 now verifies Vercel login with a host-only HttpOnly/Secure/Lax cookie, reload and full browser restart, Groq report generation/review/application, offline checklist/notes reload and replay, worker submission, admin approval, printable archive jobs and logout. The 390px layout has no horizontal overflow and shell caches contain no private API responses. The corrected Cloudinary secret is now deployed. Live API checks pass real PNG/WAV upload and verification, exact-byte private downloads, anonymous provider denial, cross-tenant denial and removal with no remaining provider resources. The hosted offline-file browser harness has not been rerun since the repair; local offline-file tests pass. Keep the legacy Render shell for retained drafts. The older rollout notes below record the earlier verification state.

The Vercel production deployment is live. HTTP checks passed for the shell, `/login`, an inspection deep link, JavaScript service worker, missing-asset 404 and proxied `/api/v1/health`. Direct and proxied API health report PostgreSQL/Redis up. An unauthenticated `/api/v1/auth/me` returns JSON 401 without being cached or rewritten to HTML.

The existing Free API is live at `6d5cf00` with Groq enabled and the corrected Cloudinary credential. Direct/proxied liveness and dependency health pass with PostgreSQL/Redis up. Platform probes use `/api/v1/live`, and inline idle recovery is thirty minutes. Browser session persistence and offline checklist replay are verified separately from the passing real evidence API checks. Optional external cron and retiring the legacy Render shell are operational choices; its shell remains available for retained drafts.

## Monorepo configuration

| Vercel setting | Value |
| --- | --- |
| Root Directory | Repository root `.`; do not select `apps/web`. |
| Framework | Vite |
| Install Command | `npm ci --include=dev` |
| Build Command | `npm run build` |
| Output Directory | `apps/web/dist` |
| Node setting | `22.x`; repository engine constraints and platform selection also apply. |
| Public API target | `https://fieldsync-api-t5kg.onrender.com` in root `vercel.json`. |
| Frontend environment | No secrets or environment variables required. |

The root command builds the web workspace with its shared contracts. `vercel.json` routes `/api/:path*` to the existing Render `/api/:path*`, and applies SPA fallback to application pages. API paths, static assets, `sw.js` and the favicon do not fall through to the HTML shell. This is a native external CDN rewrite, not another backend, database, serverless function or paid service.

The frontend's API client, media downloads and archives continue to use same-origin `/api/v1` paths. Keep that behavior; do not point browser fetches or media URLs directly at `onrender.com`. Only the public Render API URL appears in the Vercel rewrite configuration. Do not copy `DATABASE_URL`, `MIGRATIONS_DATABASE_URL`, Redis credentials, Cloudinary credentials or AI keys into Vercel, `VITE_*` variables, source control or logs. `.vercelignore` excludes local secret/configuration files and `.local`; the CLI's local `.env.local` authentication file is ignored as well.

## Sessions, CORS and privacy

`vercel.app` and `onrender.com` are different sites. Direct browser calls would require cross-origin credentials and cross-site cookies; successful CORS does not override third-party cookie blocking. The rewrite keeps the browser on its Vercel origin while Vercel forwards requests to Render. Host-only `fieldsync_sid` cookies returned through the rewrite belong to the Vercel host. They retain `HttpOnly`, `Secure` in production, `SameSite=Lax`, `/` path and the existing expiry. Do not set a cookie Domain or weaken SameSite to mask a failed integration.

Render validates the actual Origin against `APP_ORIGIN` plus exact, comma-separated `ADDITIONAL_APP_ORIGINS` (at most five extra origins). Production origins must be HTTPS without credentials, trailing slash, path, query, fragment or wildcard. Credentialed CORS echoes only an approved exact Origin, adds `Vary: Origin`, handles preflight before auth, permits only the API methods and `Accept`, `Content-Type`, `x-amz-meta-sha256` headers, and exposes `X-Request-Id`. Missing/foreign mutation Origins still fail CSRF checks. Do not allow arbitrary `*.vercel.app` previews or replace the browser Origin in the proxy. Preview aliases remain unauthorized unless explicitly added.

Cloudinary binary uploads remain authenticated and bounded, with tenant/assignment/creator/state/generation/size/media-signature/SHA-256 checks. Upload descriptors now use the validated requesting Origin, allowing the Vercel frontend and retained Render shell to work during cutover. Reads/deletions remain server-authorized and provider URLs stay server-side. Neon pooled application and direct migration URLs, TLS, Redis job intent and Cloudinary credentials/namespace remain unchanged.

Vercel supplies CSP and security headers for the static shell. `/api/*` uses private/no-store browser and CDN policies and explicitly disables external rewrite caching. `sw.js` revalidates on network access. The existing service worker caches only the shell/static files and bypasses `/api/*`; auth, private evidence, mutation responses and provider responses never enter shell caches.

Offline IndexedDB/session metadata and caches belong to their browser origin. Existing offline drafts on Render do not automatically move to Vercel. Keep the Render shell accessible, reconnect/synchronize retained work there, then sign in separately on Vercel. Do not clear old site data or copy session tokens between hosts.

## Complete the existing-service cutover

1. Refresh the existing Render CLI login, then select the existing service by its exact URL/name. Do not import a Blueprint or create replacement services. Preserve all Neon, Redis and Cloudinary environment values.
2. Deploy tested `main` to that service. During acceptance, retain its existing `APP_ORIGIN` and add `https://fieldsync-six.vercel.app` to `ADDITIONAL_APP_ORIGINS`. Keep `SERVE_WEB=true`, the existing build/start commands and inline worker. Update individual public environment variables instead of replacing the whole environment. Environment changes require deployment to take effect.
3. Check direct and Vercel-proxied `/api/v1/health`. Check actual CORS preflights from the exact production Origin and ensure a foreign origin is denied. Confirm API responses remain no-store and Vercel does not cache them.
4. In a real browser with default cookie protections, use the Vercel production URL: sign in, inspect that the session cookie is host-only/HttpOnly/Secure/Lax, reload and reopen the browser, and confirm `/auth/me` still authenticates. A CORS response, Node cookie jar, local simulation or cached identity alone is not proof. Verify logout revokes/clears the same cookie. If the actual proxy does not preserve cookies, inspect the cookie rejection reason; do not disable browser protections. A frontend/API pair under subdomains of an existing shared custom domain is an alternative if necessary, but no custom domain or paid service has been added or shown necessary.
5. With an assigned worker, create a disposable inspection and test real PNG/audio evidence upload, verification, authorized download with matching original SHA-256, and removal with confirmed Cloudinary deletion. Verify wrong tenant/worker access fails. Test actual raw-file sizes against Vercel's native proxy and Cloudinary limits; do not introduce a function body-size limit or silently shrink evidence limits.
6. Test offline file/draft persistence, reload while offline, reconnect replay and removal/submission ordering on the Vercel origin. Confirm shell caches contain no API/auth/evidence responses. Verify original Render drafts are safely synced before retiring that shell.
7. Only after acceptance, change `APP_ORIGIN` to the Vercel production URL and `SERVE_WEB=false` on the existing API, remove unnecessary legacy origins, and update `render.yaml` to match. The API build can then install dependencies without building the retired Render web shell; retain migration-before-start and the inline worker. Recheck health/login/evidence after that deployment. This final removal has not been performed yet.

For local verification, use the existing loopback Docker services with private test-only schemas/buckets/queue prefixes: `npm test`, `npm run test:hosting`, `npm run build`, and the existing M3/M4/M5/Cloudinary browser suites. Local tests never establish live cookie behavior or Cloudinary account deletion. Follow [Cloudinary setup](CLOUDINARY_SETUP.md) and [backup/restore](BACKUP_RESTORE.md) for private storage and recovery.

The final 2026-11-18 build and full test run passed (139/139 tests). Local M3 offline and Cloudinary built-UI browser suites also passed. Both deployment configuration schemas and private-value scans passed; existing `.env` values were unchanged. Recorded results and the limits of these checks are in [IMPLEMENTATION.md](../IMPLEMENTATION.md).

References: [Vercel rewrites](https://vercel.com/docs/routing/rewrites), [external rewrite caching change](https://vercel.com/changelog/vercels-cdn-now-respects-cache-control-headers-from-external-origins-by-default), [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json), [Render environment updates](https://api-docs.render.com/reference/update-env-var), [Render deploy API](https://api-docs.render.com/reference/create-deploy).
