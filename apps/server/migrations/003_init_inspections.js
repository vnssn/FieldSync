export function up(pgm) {
  pgm.sql(`
    CREATE TABLE inspection_templates (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      items JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 50),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      version INT NOT NULL DEFAULT 1 CHECK (version > 0),
      created_by UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id)
    );
    CREATE TABLE inspections (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      asset_id UUID NOT NULL,
      template_id UUID NOT NULL,
      assigned_to UUID NOT NULL,
      asset_snapshot JSONB NOT NULL,
      template_snapshot JSONB NOT NULL,
      worker_snapshot JSONB NOT NULL,
      answers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(answers) = 'array'),
      report_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'draft', 'submitted', 'changes_requested', 'approved', 'cancelled')),
      version INT NOT NULL DEFAULT 1 CHECK (version > 0),
      review_note TEXT NOT NULL DEFAULT '',
      submitted_at TIMESTAMPTZ,
      approved_at TIMESTAMPTZ,
      approved_by UUID,
      created_by UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id),
      FOREIGN KEY (organization_id, template_id) REFERENCES inspection_templates(organization_id, id),
      FOREIGN KEY (organization_id, assigned_to) REFERENCES users(organization_id, id),
      FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id),
      FOREIGN KEY (organization_id, approved_by) REFERENCES users(organization_id, id),
      CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL))
    );
    CREATE TABLE template_events (
      id UUID PRIMARY KEY, organization_id UUID NOT NULL, template_id UUID NOT NULL,
      actor_user_id UUID NOT NULL, event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated')),
      version INT NOT NULL CHECK (version > 0), details JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (organization_id, template_id) REFERENCES inspection_templates(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, actor_user_id) REFERENCES users(organization_id, id)
    );
    CREATE TABLE inspection_events (
      id UUID PRIMARY KEY, organization_id UUID NOT NULL, inspection_id UUID NOT NULL,
      actor_user_id UUID NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('created', 'saved', 'submitted', 'changes_requested', 'approved', 'reassigned', 'cancelled')),
      version INT NOT NULL CHECK (version > 0), details JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (organization_id, inspection_id) REFERENCES inspections(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, actor_user_id) REFERENCES users(organization_id, id)
    );
    CREATE TABLE inspection_revisions (
      id UUID PRIMARY KEY, organization_id UUID NOT NULL, inspection_id UUID NOT NULL,
      version INT NOT NULL CHECK (version > 0), snapshot JSONB NOT NULL, created_by UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (organization_id, inspection_id, version),
      FOREIGN KEY (organization_id, inspection_id) REFERENCES inspections(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id)
    );
    CREATE TABLE mutation_receipts (
      organization_id UUID NOT NULL, user_id UUID NOT NULL, mutation_id UUID NOT NULL,
      request_hash TEXT NOT NULL, outcome JSONB NOT NULL,
      template_id UUID, inspection_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (organization_id, user_id, mutation_id),
      FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, template_id) REFERENCES inspection_templates(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, inspection_id) REFERENCES inspections(organization_id, id) ON DELETE CASCADE,
      CHECK (template_id IS NULL OR inspection_id IS NULL)
    );
    CREATE INDEX templates_directory_idx ON inspection_templates(organization_id, status, name, id);
    CREATE INDEX templates_creator_idx ON inspection_templates(organization_id, created_by);
    CREATE INDEX inspections_directory_idx ON inspections(organization_id, status, created_at, id);
    CREATE INDEX inspections_worker_idx ON inspections(organization_id, assigned_to, status);
    CREATE INDEX inspections_asset_idx ON inspections(organization_id, asset_id);
    CREATE INDEX inspections_template_idx ON inspections(organization_id, template_id);
    CREATE INDEX inspections_creator_idx ON inspections(organization_id, created_by);
    CREATE INDEX inspections_approver_idx ON inspections(organization_id, approved_by);
    CREATE INDEX template_events_history_idx ON template_events(organization_id, template_id, version);
    CREATE INDEX template_events_actor_idx ON template_events(organization_id, actor_user_id);
    CREATE INDEX inspection_events_history_idx ON inspection_events(organization_id, inspection_id, version);
    CREATE INDEX inspection_events_actor_idx ON inspection_events(organization_id, actor_user_id);
    CREATE INDEX inspection_revisions_creator_idx ON inspection_revisions(organization_id, created_by);
    CREATE INDEX receipts_template_idx ON mutation_receipts(organization_id, template_id);
    CREATE INDEX receipts_inspection_idx ON mutation_receipts(organization_id, inspection_id);
  `);
}

export function down(pgm) {
  for (const table of ['mutation_receipts', 'inspection_revisions', 'inspection_events', 'template_events', 'inspections', 'inspection_templates']) {
    pgm.dropTable(table);
  }
}
