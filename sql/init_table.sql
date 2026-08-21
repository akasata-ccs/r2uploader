CREATE TABLE title (
    group_name TEXT PRIMARY KEY DEFAULT (LOWER(HEX(RANDOMBLOB(8)))),
    group_title TEXT NOT NULL DEFAULT 'archive',
    expire_date INTEGER NOT NULL DEFAULT (
        strftime('%s', date('now', '+60 days'), '23:59:59')
    )
);

CREATE TABLE images (
    file_name TEXT NOT NULL,
    orig_name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    upload_at INTEGER DEFAULT (strftime('%s', date('now'))),
    length INTEGER NOT NULL
);