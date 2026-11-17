# FieldSync

An offline-first field inspection application built as a JavaScript modular monolith.

This repository implements M0-M4: local infrastructure, shared contracts, sessions, tenant-isolated teams/assets, templates, offline worker checklists, admin review, private photo/audio uploads and durable background jobs. Inspection changes have version checks, audit/revision snapshots and mutation receipts. Worker drafts/files use isolated Dexie databases, automatic replay and explicit conflict merging. Human-reviewed AI remains M5.

- Read [CONTEXT.md](CONTEXT.md) for engineering invariants and architecture.
- Read [EGM.md](EGM.md) for the current modules, schema and runtime contracts.
- Read [IMPLEMENTATION.md](IMPLEMENTATION.md) for setup, milestone status and actual verification.

## Quick start

Use Node.js >=22.12 and Docker Desktop with Linux containers. In PowerShell:

    Copy-Item .env.example .env
    npm install
    npm run infra:up
    npm run db:migrate
    npm run check:env
    npm run dev

Open http://localhost:5173 and create your organization. Use the organization ID shown in the app shell, email, and password to sign in. Admins create worker accounts from Team; share their credentials and organization ID directly. APP_ORIGIN must match the frontend origin for state-changing requests.

Run `npm run worker` in a second foreground terminal for evidence verification, cleanup and printable report archives. Files upload before submission, which waits for verified evidence. MinIO CORS must match APP_ORIGIN and S3_PUBLIC_ENDPOINT must be browser-reachable.

Everything required for M0-M4 runs locally. AI is disabled. There is no email verification, Mailpit, maintenance-task module or ZIP recovery feature.

## Quality checks

    npm test
    npm run build

npm run infra:down preserves named data volumes.

The 80 tests include 57 PostgreSQL integration cases, including 23 M4 cases using real MinIO and Redis/BullMQ with controlled failure injection. All three local services must be running; test credentials must permit isolated schema/bucket creation and cleanup. Tests close temporary listeners/pools/workers and remove only their generated schemas, buckets and queues.

`npm run test:m3:browser` and `npm run test:m4:browser` exercise built assets with actual IndexedDB using existing local Playwright. Build first. The M4 harness uses the configured local APP_ORIGIN port for MinIO CORS; that port must be free. Prerequisites and recorded results are in [IMPLEMENTATION.md](IMPLEMENTATION.md).

Open assigned work online before going into the field. Worker edits are saved on this device and synchronized on reconnect, focus or interval. Conflicts retain local work for review; expired sessions pause sync until sign-in. A previously cached production shell supports offline browser reopening on HTTPS or loopback; development mode does not install a service worker. Assets and admin operations remain online.
