-- Initial schema for pastes table
CREATE TABLE pastes (
    id TEXT PRIMARY KEY,
    content BLOB NOT NULL,
    uploader_info TEXT NOT NULL,
    counters TEXT NOT NULL,
    system_info TEXT NOT NULL,
    ctime INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    etime INTEGER NOT NULL,
    atime INTEGER
) WITHOUT ROWID;
