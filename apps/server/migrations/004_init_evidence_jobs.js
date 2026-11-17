export function up(pgm) {
  pgm.sql(`
    ALTER TABLE inspections ADD COLUMN evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array');
    ALTER TABLE inspection_events DROP CONSTRAINT inspection_events_event_type_check;
    ALTER TABLE inspection_events ADD CHECK (event_type IN ('created','saved','submitted','changes_requested','approved','reassigned','cancelled','evidence_attached','evidence_removed'));
    CREATE TABLE evidence (
      id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      inspection_id UUID NOT NULL, created_by UUID NOT NULL,
      name TEXT NOT NULL, mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','audio/mpeg','audio/wav','audio/ogg','audio/webm')),
      size INT NOT NULL CHECK (size > 0 AND size <= 26214400 AND (mime_type NOT LIKE 'image/%' OR size <= 10485760)),
      sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      staging_key TEXT NOT NULL, object_key TEXT,
      status TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','attached','removed')),
      processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending','ready','failed')),
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), removed_at TIMESTAMPTZ,
      UNIQUE (organization_id, id), UNIQUE (organization_id, inspection_id, id),
      UNIQUE (organization_id, staging_key), UNIQUE (organization_id, object_key),
      FOREIGN KEY (organization_id, inspection_id) REFERENCES inspections(organization_id,id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id,id),
      CHECK (status <> 'attached' OR object_key IS NOT NULL),
      CHECK (staging_key LIKE 'org/' || organization_id::text || '/inspections/' || inspection_id::text || '/' || id::text || '/staging/%'),
      CHECK (object_key IS NULL OR object_key LIKE 'org/' || organization_id::text || '/inspections/' || inspection_id::text || '/' || id::text || '/verified/%')
    );
    CREATE INDEX evidence_inspection_idx ON evidence(organization_id, inspection_id, status);
    CREATE INDEX evidence_creator_idx ON evidence(organization_id, created_by);
    CREATE TABLE background_jobs (
      id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      inspection_id UUID NOT NULL, evidence_id UUID,
      kind TEXT NOT NULL CHECK (kind IN ('verify_evidence','cleanup_stage','cleanup_evidence','prepare_report')),
      dedupe_key TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry','completed','failed')),
      attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      run_after TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), lease_token UUID, lease_until TIMESTAMPTZ,
      result JSONB, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (organization_id, id), UNIQUE (organization_id, dedupe_key),
      FOREIGN KEY (organization_id, inspection_id) REFERENCES inspections(organization_id,id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, inspection_id, evidence_id) REFERENCES evidence(organization_id,inspection_id,id) ON DELETE CASCADE,
      CHECK ((kind = 'prepare_report' AND evidence_id IS NULL) OR (kind <> 'prepare_report' AND evidence_id IS NOT NULL))
    );
    CREATE INDEX jobs_due_idx ON background_jobs(status, run_after, lease_until);
    CREATE INDEX jobs_inspection_idx ON background_jobs(organization_id, inspection_id, created_at);
    CREATE INDEX jobs_evidence_idx ON background_jobs(organization_id, evidence_id);
  `);
}
export function down(pgm) {
  pgm.sql(`DROP TABLE background_jobs; DROP TABLE evidence; ALTER TABLE inspections DROP COLUMN evidence;
    ALTER TABLE inspection_events DROP CONSTRAINT inspection_events_event_type_check;
    ALTER TABLE inspection_events ADD CHECK (event_type IN ('created','saved','submitted','changes_requested','approved','reassigned','cancelled'));`);
}
