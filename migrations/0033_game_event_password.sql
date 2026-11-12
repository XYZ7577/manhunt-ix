ALTER TABLE game_event_config ADD COLUMN password_salt TEXT;
ALTER TABLE game_event_config ADD COLUMN password_hash TEXT;
