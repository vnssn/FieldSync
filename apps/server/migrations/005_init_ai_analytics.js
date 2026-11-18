export function up(pgm) {
  pgm.sql(`
    ALTER TABLE inspections ADD COLUMN ai_sources JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ai_sources) = 'array');
    ALTER TABLE inspection_events DROP CONSTRAINT inspection_events_event_type_check;
    ALTER TABLE inspection_events ADD CHECK (event_type IN ('created','saved','submitted','changes_requested','approved','reassigned','cancelled','evidence_attached','evidence_removed','ai_applied'));
    CREATE TABLE ai_artifacts (
      id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      inspection_id UUID NOT NULL, evidence_id UUID, source_version INT NOT NULL CHECK (source_version > 0 AND source_version < 2147483647),
      kind TEXT NOT NULL CHECK (kind IN ('image','voice','report')), requested_by UUID NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','ready','failed')),
      provider TEXT, model TEXT, mode TEXT CHECK (mode IN ('provider','fallback')),
      fallback_reason TEXT CHECK (fallback_reason IN ('disabled','missing_key','provider_error')),
      prompt_version TEXT NOT NULL DEFAULT 'm5-v1', provider_request_id TEXT,
      original_output JSONB CHECK (jsonb_typeof(original_output) = 'object'), raw_output TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), completed_at TIMESTAMPTZ,
      UNIQUE (organization_id, inspection_id, id),
      UNIQUE NULLS NOT DISTINCT (organization_id, inspection_id, source_version, kind, evidence_id),
      FOREIGN KEY (organization_id, inspection_id, source_version) REFERENCES inspection_revisions(organization_id,inspection_id,version) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, inspection_id, evidence_id) REFERENCES evidence(organization_id,inspection_id,id),
      FOREIGN KEY (organization_id, requested_by) REFERENCES users(organization_id,id),
      CHECK ((kind='report' AND evidence_id IS NULL) OR (kind<>'report' AND evidence_id IS NOT NULL)),
      CHECK (status<>'ready' OR (original_output IS NOT NULL AND raw_output IS NOT NULL AND provider IS NOT NULL AND model IS NOT NULL AND mode IS NOT NULL AND completed_at IS NOT NULL)),
      CHECK ((mode='fallback' AND fallback_reason IS NOT NULL) OR (mode IS DISTINCT FROM 'fallback' AND fallback_reason IS NULL))
    );
    CREATE INDEX ai_artifacts_requester_idx ON ai_artifacts(organization_id,requested_by,created_at);
    CREATE INDEX ai_artifacts_evidence_idx ON ai_artifacts(organization_id,inspection_id,evidence_id);
    CREATE TABLE ai_reviews (
      id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      inspection_id UUID NOT NULL, artifact_id UUID NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('apply','reject')), confirmed_output JSONB,
      reviewed_by UUID NOT NULL, applied_version INT, reviewed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (organization_id,inspection_id,artifact_id),
      FOREIGN KEY (organization_id,inspection_id,artifact_id) REFERENCES ai_artifacts(organization_id,inspection_id,id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id,reviewed_by) REFERENCES users(organization_id,id),
      FOREIGN KEY (organization_id,inspection_id,applied_version) REFERENCES inspection_revisions(organization_id,inspection_id,version),
      CHECK ((decision='apply' AND applied_version IS NOT NULL AND applied_version>0 AND confirmed_output IS NOT NULL AND jsonb_typeof(confirmed_output)='object')
        OR (decision='reject' AND applied_version IS NULL AND confirmed_output IS NULL))
    );
    CREATE INDEX ai_reviews_reviewer_idx ON ai_reviews(organization_id,reviewed_by);
    CREATE INDEX ai_reviews_version_idx ON ai_reviews(organization_id,inspection_id,applied_version);
    CREATE INDEX inspections_analytics_idx ON inspections(organization_id,created_at,id);
    ALTER TABLE background_jobs ADD COLUMN ai_artifact_id UUID;
    ALTER TABLE background_jobs ADD FOREIGN KEY (organization_id,inspection_id,ai_artifact_id)
      REFERENCES ai_artifacts(organization_id,inspection_id,id) ON DELETE CASCADE;
    CREATE INDEX jobs_ai_artifact_idx ON background_jobs(organization_id,inspection_id,ai_artifact_id);
    ALTER TABLE background_jobs DROP CONSTRAINT background_jobs_kind_check;
    ALTER TABLE background_jobs ADD CHECK (kind IN ('verify_evidence','cleanup_stage','cleanup_evidence','prepare_report','assist_inspection'));
    ALTER TABLE background_jobs DROP CONSTRAINT background_jobs_check;
    ALTER TABLE background_jobs ADD CHECK (
      (kind='assist_inspection' AND ai_artifact_id IS NOT NULL) OR
      (kind='prepare_report' AND ai_artifact_id IS NULL AND evidence_id IS NULL) OR
      (kind IN ('verify_evidence','cleanup_stage','cleanup_evidence') AND ai_artifact_id IS NULL AND evidence_id IS NOT NULL));
    CREATE FUNCTION guard_ai_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status <> 'queued' OR
        (NEW.id,NEW.organization_id,NEW.inspection_id,NEW.evidence_id,NEW.source_version,NEW.kind,NEW.requested_by,NEW.created_at,NEW.prompt_version)
        IS DISTINCT FROM
        (OLD.id,OLD.organization_id,OLD.inspection_id,OLD.evidence_id,OLD.source_version,OLD.kind,OLD.requested_by,OLD.created_at,OLD.prompt_version) THEN
        RAISE EXCEPTION 'AI source and completed output are immutable';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ai_artifacts_immutable BEFORE UPDATE ON ai_artifacts FOR EACH ROW EXECUTE FUNCTION guard_ai_artifact();
  `);
}
export function down(pgm) {
  pgm.sql(`
    DELETE FROM background_jobs WHERE kind='assist_inspection';
    ALTER TABLE background_jobs DROP CONSTRAINT background_jobs_kind_check;
    ALTER TABLE background_jobs DROP CONSTRAINT background_jobs_check;
    ALTER TABLE background_jobs DROP COLUMN ai_artifact_id;
    ALTER TABLE background_jobs ADD CHECK (kind IN ('verify_evidence','cleanup_stage','cleanup_evidence','prepare_report'));
    ALTER TABLE background_jobs ADD CHECK ((kind='prepare_report' AND evidence_id IS NULL) OR (kind<>'prepare_report' AND evidence_id IS NOT NULL));
    DROP TABLE ai_reviews; DROP TABLE ai_artifacts; DROP FUNCTION guard_ai_artifact();
    DROP INDEX inspections_analytics_idx; ALTER TABLE inspections DROP COLUMN ai_sources;
    DELETE FROM inspection_events WHERE event_type='ai_applied';
    ALTER TABLE inspection_events DROP CONSTRAINT inspection_events_event_type_check;
    ALTER TABLE inspection_events ADD CHECK (event_type IN ('created','saved','submitted','changes_requested','approved','reassigned','cancelled','evidence_attached','evidence_removed'));
  `);
}
