-- Las sesiones online usan tokens opacos: solo se guarda su hash SHA-256.
-- Identidad global; la autorización de sucursal sigue en RLS y en cada operación.
CREATE TABLE auth_sessions (
 token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid NOT NULL REFERENCES users(id),
 auth_version integer NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 CHECK (expires_at > issued_at)
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
