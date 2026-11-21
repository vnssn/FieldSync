# FieldSync

An offline-first field inspection application built as a JavaScript modular monolith.

This repository implements M0-M5: local infrastructure, sessions, tenant-isolated teams/assets, templates, offline checklists/voice/evidence, manager review, durable jobs, reviewed AI assistance and inspection/asset analytics. Inspection changes have version checks, audit/revision snapshots and mutation receipts. Worker drafts/files use isolated Dexie databases, automatic replay and explicit conflict merging.

- Read [CONTEXT.md](CONTEXT.md) for engineering invariants and architecture.
- Read [EGM.md](EGM.md) for the current modules, schema and runtime contracts.
- Read [IMPLEMENTATION.md](IMPLEMENTATION.md) for setup, milestone status and actual verification.
- Read [INTERVIEW.md](INTERVIEW.md) for the implementation study guide.
- Operating guides: [deployment](docs/DEPLOYMENT.md), [Cloudflare R2 setup](docs/R2_SETUP.md), [security](docs/SECURITY.md), [backup/restore](docs/BACKUP_RESTORE.md).

## Free local demo and quick start

You can demo the complete project locally without cloud accounts. Docker Compose runs PostgreSQL, Redis, and MinIO; AI is disabled by default. The frontend is deployed at https://fieldsync-six.vercel.app and uses the existing Render API through a native Vercel rewrite. Render origin setup and live browser acceptance are pending; its original frontend remains available. The Render blueprint retains Cloudinary for private evidence storage with authenticated server uploads and downloads. Neon retains pooled application connections and direct migration connections. See [deployment](docs/DEPLOYMENT.md) and [Cloudinary setup](docs/CLOUDINARY_SETUP.md). The S3 adapter remains available for local MinIO and existing S3 deployments.

Use Node.js >=22.12 and Docker Desktop with Linux containers. In PowerShell:

    Copy-Item .env.example .env
    npm install
    npm run infra:up
    npm run db:migrate
    npm run check:env
    npm run dev

Open http://localhost:5173 and create your organization. Use the organization ID shown in the app shell, email, and password to sign in. Admins create worker accounts from Team; share their credentials and organization ID directly. APP_ORIGIN must match the frontend origin for state-changing requests.

Run `npm run worker` in a second foreground terminal for evidence verification, cleanup, AI requests and printable report archives. Files upload before submission, which waits for verified evidence. MinIO CORS must match APP_ORIGIN and S3_PUBLIC_ENDPOINT must be browser-reachable.

All M0-M5 workflows run locally. AI_ENABLED defaults to false: image/voice requests show labeled manual fallbacks and report drafts summarize recorded checks. The existing **Draft report** button supports a direct Groq API call. To enable it, set these server/worker settings in the root `.env`, then restart the API and worker:

    AI_ENABLED=true
    AI_REPORT_PROVIDER=groq
    GROQ_API_KEY=<your Groq API key>
    GROQ_MODEL=openai/gpt-oss-20b

Keep the key in the ignored `.env`, never in frontend code or a `VITE_` variable. Report drafting sends the saved asset/checklist/notes to Groq Chat Completions, validates the returned JSON, and stores an editable suggestion with model/request provenance. A worker must review/edit/confirm it before inspection content changes. Managers still review submitted reports. Missing keys, timeouts and provider failures produce labeled manual drafts.

Photo/voice assistance uses the optional server-only OPENAI_API_KEY. Set AI_REPORT_PROVIDER=openai to use the existing OpenAI report adapter; this is also the default when the setting is absent. Models and timeout are configurable. Groq contract tests simulate its HTTP responses and do not establish live account access or model accuracy.

The Dashboard shows current inspection statuses, failed checks, submission timing, daily activity and up to 50 asset summaries for 7/30/90 UTC days. Admins see the organization; workers see current assignments. Record voice notes offline in a supported HTTPS/localhost browser, then attach them before leaving the page. Attached recordings use the existing durable file queue and upload on reconnect.

Email verification/password reset, Mailpit, maintenance tasks, generated PDFs and ZIP recovery are outside this implementation.

## Quality checks

    npm test
    npm run build

npm run infra:down preserves named data volumes.

The automated tests include real PostgreSQL/MinIO/Redis/BullMQ integration, pure offline transitions and clearly labeled local provider HTTP simulations. M5 adds 30 tests, including a real pg_dump/pg_restore plus object/job recovery exercise; later checks cover inline-worker lifecycle and R2-compatible PUT contracts. All three local services must be running; credentials must permit isolated schema/bucket creation and cleanup, and the restore drill needs local Compose PostgreSQL with permission to create a disposable database. Tests close temporary listeners/pools/workers and remove only their generated targets.

`npm run test:m3:browser`, `npm run test:m4:browser` and `npm run test:m5:browser` exercise built assets with actual IndexedDB using existing local Playwright. Build first. M4/M5 use the configured local APP_ORIGIN port for MinIO CORS; that port must be free. Prerequisites and recorded results are in [IMPLEMENTATION.md](IMPLEMENTATION.md). `npm run test:m5` runs the M5 suite alone; `node --test tests/m5-restore.test.js` repeats the disposable recovery drill.

Open assigned work online before going into the field. Worker edits are saved on this device and synchronized on reconnect, focus or interval. Conflicts retain local work for review; expired sessions pause sync until sign-in. A previously cached production shell supports offline browser reopening on HTTPS or loopback; development mode does not install a service worker. Assets and admin operations remain online.

## Hosted deployment

Optional Render keep-alive should call `/api/v1/live`, which returns process status without database/Redis queries. The Blueprint uses this path for platform health checks. The inline worker wakes on committed job intent, waits for known job deadlines, and uses thirty-minute recovery when idle so Neon can suspend between work. Dependency readiness remains `/api/v1/health`. See the [idle compute and scheduler setup](docs/DEPLOYMENT.md#render-keep-alive-and-neon-idle-compute); these local changes require an approved rollout before enabling cron.

[render.yaml](render.yaml) describes the existing API and Redis topology. Update the existing Render service during cutover; importing a new Blueprint can create duplicate resources. The Vercel frontend is live, while the Render origin update and live browser acceptance await refreshed Render access. Keep Render frontend serving enabled until Vercel login, evidence and offline checks pass. Local tests do not establish live Cloudinary capabilities or browser session persistence.

Cloudinary regressions: `npm run test:cloudinary` and, after building with the existing local browser prerequisites, `npm run test:cloudinary:browser`. The provider is simulated; tests do not upload to a live Cloudinary account.

See [Vercel/Render deployment](docs/VERCEL_RENDER_SETUP.md) for monorepo configuration, first-party session routing, exact-origin CORS, cutover acceptance and current deployment status. `npm run test:hosting` runs the local routing/auth/CORS/Cloudinary origin regressions.
