-- 0005_settings: tiny key-value store (Stage 10). First key: owner_room_id —
-- the owner's last-seen Webex roomId, previously in-memory only, so a daemon
-- restart silently skipped finish/rotation notices (and would break
-- /api/v1/deliver) until the next inbound message. Written on every authorized
-- inbound, read at startup. Additive only (ADR 0004): new table, nothing touched.

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO schema_version (version, applied_at) VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
