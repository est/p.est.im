-- Migration to refine schema: switch to WITHOUT ROWID and ensure case sensitivity
CREATE TABLE pastes_new (
    id TEXT PRIMARY KEY,
    content BLOB NOT NULL,
    uploader_info TEXT NOT NULL,
    counters TEXT NOT NULL,
    system_info TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

INSERT INTO pastes_new (id, content, uploader_info, counters, system_info, expires_at, created_at)
SELECT id, content, uploader_info, counters, system_info, expires_at, created_at FROM pastes;

DROP TABLE pastes;
ALTER TABLE pastes_new RENAME TO pastes;
