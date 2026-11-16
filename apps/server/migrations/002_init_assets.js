export function up(pgm) {
  pgm.sql(`
    CREATE TABLE assets (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      location TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      version INT NOT NULL DEFAULT 1 CHECK (version > 0),
      created_by UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, code),
      FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id)
    );
    CREATE TABLE asset_events (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL,
      asset_id UUID NOT NULL,
      actor_user_id UUID NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'archived', 'restored')),
      changes JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, actor_user_id) REFERENCES users(organization_id, id)
    );
    CREATE INDEX assets_directory_idx ON assets(organization_id, status, code);
    CREATE INDEX asset_events_history_idx ON asset_events(organization_id, asset_id, created_at, id);
    CREATE INDEX asset_events_actor_idx ON asset_events(organization_id, actor_user_id);
    CREATE INDEX assets_creator_idx ON assets(organization_id, created_by);
  `);
}

export function down(pgm) {
  pgm.dropTable('asset_events');
  pgm.dropTable('assets');
}
