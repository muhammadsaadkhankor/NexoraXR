-- Carry the signup's name on the magic-link row so account creation can
-- populate display_name without trusting a later client edit.
ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS first_name varchar(40),
  ADD COLUMN IF NOT EXISTS last_name  varchar(40);
