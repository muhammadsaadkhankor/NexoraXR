-- Password sign-in: users get argon2id hashes; pending registrations carry the
-- hash on the magic-link row so account creation completes at verify time.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE magic_link_tokens ADD COLUMN IF NOT EXISTS password_hash text;
