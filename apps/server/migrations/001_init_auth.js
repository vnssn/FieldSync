export function up(pgm) {
  pgm.sql(`
    CREATE TABLE organizations (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE users (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'worker')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, email),
      CHECK (email = lower(btrim(email)))
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id UUID NOT NULL,
      organization_id UUID NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id) ON DELETE CASCADE
    );
    CREATE INDEX sessions_user_idx ON sessions(organization_id, user_id);
    CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
  `);
}

export function down(pgm) {
  pgm.dropTable('sessions');
  pgm.dropTable('users');
  pgm.dropTable('organizations');
}
