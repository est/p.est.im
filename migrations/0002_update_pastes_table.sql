-- Migration to create the pastes table with granular metadata
DROP TABLE IF EXISTS pastes;
CREATE TABLE pastes (
    id TEXT PRIMARY KEY,
    content BLOB NOT NULL,
    uploader_info TEXT NOT NULL, -- JSON: IP, User-Agent, etc.
    counters TEXT NOT NULL,      -- JSON: views, etc.
    system_info TEXT NOT NULL,   -- JSON: mime, delete_token, etc.
    expires_at INTEGER NOT NULL, -- Unix timestamp
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
