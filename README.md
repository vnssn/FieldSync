# FieldSync

An offline-first field inspection application built as a JavaScript modular monolith.

This repository implements M0 and M1: local infrastructure, shared runtime contracts, health checks, organization registration and sessions, tenant-isolated team management, and an asset directory with version-checked edits and audit history. Inspection and offline workflows are planned, not implemented yet.

- Read [CONTEXT.md](CONTEXT.md) for engineering invariants and architecture.
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

Everything required for M0/M1 runs locally. AI is disabled. There is no email verification, Mailpit, maintenance-task module or ZIP recovery feature.

## Quality checks

    npm test
    npm run build

npm run infra:down preserves named data volumes.

The 23 tests include 14 real PostgreSQL M1 integration tests. PostgreSQL must be running; the database role must be able to create/drop isolated test schemas. Tests close their temporary HTTP listeners and database pools and remove their own schemas. No development server is required for the test suite.
