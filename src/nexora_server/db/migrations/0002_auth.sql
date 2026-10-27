-- 0002_auth — registered users, magic-link tokens, opaque auth sessions,
-- and server-issued guest credentials.
--
-- Email is normalized to lowercase at the application layer; the UNIQUE
-- constraint then enforces case-insensitive uniqueness (pg-mem compatible —
-- no citext extension or functional index required).

CREATE TYPE user_role AS ENUM ('SUPER_ADMIN','INSTRUCTOR','STUDENT');

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  display_name  varchar(80) NOT NULL,
  role          user_role NOT NULL DEFAULT 'STUDENT',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Single-use login links. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id          uuid PRIMARY KEY,
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_link_tokens_email ON magic_link_tokens (email);
CREATE INDEX IF NOT EXISTS magic_link_tokens_expires ON magic_link_tokens (expires_at);

-- Opaque DB sessions: revocation = revoked_at; deactivation is enforced by
-- joining users.is_active on every session lookup.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions (expires_at);

-- Server-issued guest credentials for unauthenticated classroom participants.
-- pid is always 'gst_<uuid>' so guest identities can never collide with a
-- registered users.id.
CREATE TABLE IF NOT EXISTS guest_tokens (
  id             uuid PRIMARY KEY,
  participant_id varchar(64) NOT NULL UNIQUE,
  token_hash     text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guest_tokens_expires ON guest_tokens (expires_at);
