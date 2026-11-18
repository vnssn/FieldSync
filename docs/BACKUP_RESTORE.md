# FieldSync backup and restore

PostgreSQL and private evidence objects are the durable shared record. Redis is scheduling transport: required jobs and outcomes also live in PostgreSQL. A database-only backup loses attachment bytes; a Redis snapshot is insufficient to recover inspection state. Browser-only drafts/recordings are not included in a server backup.

## Backup policy and manifest

Use encrypted daily PostgreSQL logical exports plus a coherent private object snapshot/version backup, retained in a restricted location outside the application environment. A starting policy is 7 daily and 4 weekly recovery points; choose retention and an RPO/RTO for the actual operator before production intake. Paid database PITR is useful but does not coordinate S3 objects automatically. Keep removed-object recovery copies under the agreed sensitive-data retention policy rather than indefinitely.

For a coherent recovery point, briefly pause API mutations and worker processing, let in-flight transactions/promotions settle, then snapshot PostgreSQL and the objects before resuming. Record:

- UTC time, Git revision, Node/PostgreSQL versions, migrations 001–005 and source database/schema/bucket identifiers.
- Encrypted dump/object snapshot locations and checksums, expected table/row totals, and recovery contact.
- Evidence inventory: `organization_id`, `inspection_id`, `id`, `object_key`, `mime_type`, `size`, `sha256` for `status='attached'`.
- Configuration names and secret-manager references; never put passwords, session tokens or provider keys in the manifest.

Preserve exact `org/<organization>/inspections/<inspection>/<evidence>/verified/<UUID>` keys, bytes, Content-Type and SHA-256 metadata. Use the storage provider's snapshot/replication/export that preserves keys and object headers. Do not copy its raw active data directory as if it were a portable S3 backup. Staging objects may be omitted: reservations expire and retained browser queues renew uploads. Keep object and database recovery points paired.

## PostgreSQL commands

Run PostgreSQL 17 client tools with an operator-provided environment/secret manager (`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, password), not a credential-bearing URL in a shell history. External connections require verified TLS. A logical custom-format export is:

```text
pg_dump --format=custom --no-owner --no-privileges --file=/secure/fieldsync.dump
pg_restore --list /secure/fieldsync.dump
```

For a local Compose backup in PowerShell, use Docker file copying to preserve binary bytes; older PowerShell stdout redirection can corrupt a custom-format dump:

```powershell
New-Item -ItemType Directory -Force .local/backup
docker compose exec -T postgres sh -c 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --no-privileges --file=/tmp/fieldsync.dump'
docker compose cp postgres:/tmp/fieldsync.dump .local/backup/fieldsync.dump
Get-FileHash -Algorithm SHA256 .local/backup/fieldsync.dump
```

This local command only exports the database. Back up the matching MinIO verified objects and manifest separately, then encrypt/protect the backup. Do not store backup contents in Git.

## Restore into fresh targets

1. Keep public traffic and workers stopped. Provision a **new empty database**, a **new private bucket** and a **new Redis namespace/instance**; verify their names and credentials before any operation. Keep the existing environment available for diagnosis. Match PostgreSQL major version and restore only the intended schema/database.
2. Restore the custom-format dump, with no destructive `--clean` option. `PGDATABASE` below must name the fresh restore database, never the current application database:

   ```text
   pg_restore --dbname=fieldsync_restore --exit-on-error --no-owner --no-privileges /secure/fieldsync.dump
   ```

3. Restore attached verified objects at exactly the inventory keys. Set `ContentType` from `mime_type`, `Metadata: { sha256 }`, and conditional `IfNoneMatch: '*'` on each PutObject into the new bucket. Verify restored byte count, MIME signature and SHA-256 against PostgreSQL before starting the worker. `createEvidenceStorage().read()` supplies these same checks. Stop on missing/corrupt objects; do not mark evidence ready just to pass submission prerequisites.
4. Configure API/worker for the restored database/bucket and fresh queue prefix, leave AI disabled initially, and inspect `pgmigrations`. Apply only missing migrations explicitly. For a production recovery, revoke restored sessions and rotate affected service credentials before opening access. Retain revisions, audits, mutation receipts, AI originals/reviews and required jobs.
5. Start the worker after the database/object pair is validated. PostgreSQL due jobs republish into empty Redis. Running jobs wait for their lease expiry; exhausted leases settle failure, while current lease tokens fence stale completions. Completed durable jobs do not need Redis entries to retain their outcome. Do not flush another deployment's Redis keys. External provider requests may repeat if a previous run died before its completion committed.
6. Confirm environment checks and dependency health, worker convergence, tenant-scoped reads, inspection/evidence membership and download hashes, source-version AI provenance, human review history, identical receipt replay, report archives and analytics. Sign in afresh and exercise a retained browser outbox with its original owner; offline drafts are not imported from the server backup.
7. Record dump/object checksums, recovered data counts, observed recovery duration and any missing data before changing traffic. Cut over only after that record is reviewed. Delete disposable drill targets only after verifying their explicit names; preserve the original backup and environment until recovery is accepted.

## Repeatable local recovery exercise

```text
node --test tests/m5-restore.test.js
```

This integration test uses Docker's actual `pg_dump`/`pg_restore` against a generated PostgreSQL schema and a new disposable database. It copies immutable MinIO objects into a new private bucket with their headers, validates their bytes and checksum, checks original AI output/confirmed review/source revision/receipt/migration records, and rebuilds a pending report job through actual Redis/BullMQ from restored SQL intent. It cleans only its generated database, schemas, buckets and queue namespaces.

The M5 drill passed locally on 2026-11-17. Actual test output and timing are recorded in [IMPLEMENTATION.md](../IMPLEMENTATION.md). This is recovery evidence for a small local fixture, not a measured production RPO/RTO, continuous backup service or cloud recovery result. A production operator still needs to schedule backups and test a recovery point from the selected storage/database providers after deployment approval.
