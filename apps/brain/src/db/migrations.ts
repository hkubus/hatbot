// Append only. Each entry runs once, in order, inside a transaction.
export const migrations: string[] = [
  /* 1: auth, settings */ `
  CREATE TABLE owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    totp_secret TEXT NOT NULL,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    last_used_at TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  /* 2: chat thread, spend */ `
  CREATE TABLE episodes (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    last_activity_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    summarized INTEGER NOT NULL DEFAULT 0
  );
  -- The episode's API conversation, exactly as sent and received. Append-only (PLAN.md §5.3).
  CREATE TABLE episode_turns (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE INDEX episode_turns_episode ON episode_turns (episode_id, id);
  -- What the thread shows.
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER REFERENCES episodes(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('streaming', 'done', 'error')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TABLE spend_ledger (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    episode_id INTEGER,
    task_id INTEGER,
    input_tokens INTEGER NOT NULL,
    cache_write_5m_tokens INTEGER NOT NULL,
    cache_write_1h_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL
  );
  CREATE INDEX spend_ledger_created ON spend_ledger (created_at);
  `,
  /* 3: tasks, approvals, cards in the thread */ `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    success_criteria TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL CHECK (origin IN ('chat', 'schedule', 'webhook', 'alert')),
    lane TEXT NOT NULL CHECK (lane IN ('screen', 'background')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'waiting_takeover', 'done', 'failed', 'cancelled')),
    tainted INTEGER NOT NULL DEFAULT 0,
    injection_suspected INTEGER NOT NULL DEFAULT 0,
    -- Raised from the task's card when it hits its limit (PLAN.md §6.3).
    budget_usd REAL NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    started_at TEXT,
    finished_at TEXT,
    -- When the chat thread was told how it ended.
    reported_at TEXT
  );
  CREATE INDEX tasks_status ON tasks (status);
  -- The task's API conversation. Append-only, like episode_turns.
  CREATE TABLE task_turns (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE INDEX task_turns_task ON task_turns (task_id, id);
  -- The timeline you see (PLAN.md §2, Logs).
  CREATE TABLE task_steps (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    screenshot TEXT,
    url TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  );
  CREATE INDEX task_steps_task ON task_steps (task_id, id);
  CREATE TABLE approvals (
    id INTEGER PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id),
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    sources TEXT NOT NULL DEFAULT '[]',
    screenshot_step_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
    decided_via TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    expires_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX approvals_status ON approvals (status);
  ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'task', 'approval'));
  ALTER TABLE messages ADD COLUMN task_id INTEGER REFERENCES tasks(id);
  ALTER TABLE messages ADD COLUMN approval_id INTEGER REFERENCES approvals(id);
  `,
  /* 4: chat moved from Sonnet 5.5 to Opus 5.5 at low effort */ `
  UPDATE settings SET value = json_set(value, '$.chatEffort', 'low') WHERE key = 'app';
  `,
  /* 5: schedules and triggers (PLAN.md §5.6) */ `
  CREATE TABLE schedules (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    cron TEXT,
    run_at TEXT,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_via TEXT NOT NULL CHECK (created_via IN ('chat', 'owner')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    next_run_at TEXT,
    last_run_at TEXT,
    CHECK ((cron IS NULL) != (run_at IS NULL))
  );
  CREATE TABLE triggers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('webhook', 'kuma')),
    -- Plain, because HMAC needs it. It never leaves the brain after it's first shown.
    secret TEXT NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    last_fired_at TEXT
  );
  ALTER TABLE tasks ADD COLUMN schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN trigger_id INTEGER REFERENCES triggers(id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id);
  -- The schedule's or trigger's name when it ran.
  ALTER TABLE tasks ADD COLUMN source TEXT;
  -- One run at a time per schedule, trigger, or Uptime Kuma monitor.
  ALTER TABLE tasks ADD COLUMN run_key TEXT;
  ALTER TABLE tasks ADD COLUMN payload TEXT;
  CREATE INDEX tasks_run_key ON tasks (run_key, status);

  -- messages again, for schedule cards: kind loses its CHECK so new card kinds don't need this.
  CREATE TABLE messages_new (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER REFERENCES episodes(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('streaming', 'done', 'error')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    kind TEXT NOT NULL DEFAULT 'text',
    task_id INTEGER REFERENCES tasks(id),
    approval_id INTEGER REFERENCES approvals(id),
    schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL
  );
  INSERT INTO messages_new (id, episode_id, role, text, status, created_at, kind, task_id, approval_id)
    SELECT id, episode_id, role, text, status, created_at, kind, task_id, approval_id FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_new RENAME TO messages;
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  `,
];
