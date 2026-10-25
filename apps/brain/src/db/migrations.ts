/** Marks a migration that rebuilds a table: it runs with foreign keys off (db/index.ts). */
export const REBUILD = "-- rebuilds a table";

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
  /* 5: schedules and triggers */ `
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
  /* 6: an episode is bound to the system prompt, tools and model it started with */ `
  ALTER TABLE episodes ADD COLUMN prefix TEXT;
  `,
  /* 7: plugins: background tasks from the chat, and untrusted content in the chat */ `
  ALTER TABLE tasks ADD COLUMN effort TEXT CHECK (effort IN ('low', 'medium', 'high'));
  -- The episode has read untrusted content; tasks it starts begin tainted.
  ALTER TABLE episodes ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0;
  `,
  /* 8: a schedule the chat made or changed after reading untrusted content runs tainted */ `
  ALTER TABLE schedules ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0;
  `,
  /* 9: teach-by-showing: recordings, their drafts, and the skills they became */ `
  CREATE TABLE teach_sessions (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('recording', 'drafting', 'draft', 'failed', 'saved', 'discarded')),
    started_at TEXT NOT NULL,
    stopped_at TEXT,
    -- The recorded steps as JSON, written when the recording stops.
    events TEXT,
    name TEXT,
    draft TEXT,
    error TEXT
  );
  -- Mirrors skills/*.md in the memory repo, which is the source of truth.
  CREATE TABLE skills_index (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE tasks ADD COLUMN skill TEXT;
  `,
  /* 10: a finished conversation's recap, shown where it's folded up in the chat */ `
  ALTER TABLE episodes ADD COLUMN recap TEXT;
  `,
  /* 11: what the owner said when they started a task from the chat, for the approval check */ `
  ALTER TABLE tasks ADD COLUMN request TEXT;
  `,
  /* 12: an Uptime Kuma trigger can wait out a monitor's next checks before acting on a down alert */ `
  ALTER TABLE triggers ADD COLUMN confirm_checks INTEGER NOT NULL DEFAULT 0 CHECK (confirm_checks BETWEEN 0 AND 2);
  -- Down alerts waiting for those checks; one whose monitor comes back up in time is dropped.
  CREATE TABLE kuma_waiting (
    run_key TEXT PRIMARY KEY,
    trigger_id INTEGER NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
    due_at TEXT NOT NULL,
    name TEXT NOT NULL,
    alert TEXT NOT NULL
  );
  `,
  /* 13: what the owner told the task along with their decision on an approval */ `
  ALTER TABLE approvals ADD COLUMN note TEXT;
  `,
  /* 14: when a task's result changed a message, and when you last saw each message (unread) */ `
  ALTER TABLE messages ADD COLUMN edited_at TEXT;
  ALTER TABLE messages ADD COLUMN seen_at TEXT;
  UPDATE messages SET edited_at = (SELECT t.finished_at FROM tasks t WHERE t.id = messages.task_id)
    WHERE kind IN ('text', 'task')
    AND (SELECT t.finished_at FROM tasks t WHERE t.id = messages.task_id) > created_at;
  -- Everything from before counts as seen.
  UPDATE messages SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ');
  `,
  /* 15: what first tainted a task, a conversation or a schedule, for the owner to see */ `
  ALTER TABLE tasks ADD COLUMN tainted_by TEXT;
  ALTER TABLE episodes ADD COLUMN tainted_by TEXT;
  ALTER TABLE schedules ADD COLUMN tainted_by TEXT;
  `,
  /* 16: approvals no longer show as chat messages; they wait above the composer instead */ `
  DELETE FROM messages WHERE kind = 'approval';
  `,
  /* 17: files in the chat, yours and Hatbot's; the bytes live in the archive */ `
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id),
    task_id INTEGER REFERENCES tasks(id),
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    sender TEXT NOT NULL CHECK (sender IN ('owner', 'hatbot')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX attachments_message ON attachments(message_id);
  CREATE INDEX attachments_task ON attachments(task_id);
  `,
  /* 18: a conversation you started with /new carries nothing over from before it */ `
  ALTER TABLE episodes ADD COLUMN fresh INTEGER NOT NULL DEFAULT 0;
  `,
  /* 19: incognito: a conversation that sees no history and is deleted when it ends */ `
  ALTER TABLE episodes ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0;
  -- Kept out of the search index, so nothing of it is left there.
  DROP TRIGGER messages_ai;
  DROP TRIGGER messages_ad;
  DROP TRIGGER messages_au;
  CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.incognito = 0 BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages WHEN old.incognito = 0 BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages WHEN new.incognito = 0 BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  `,
  /* 20: more than one bot: bots, their conversations, and who each thing belongs to */ `
  CREATE TABLE bots (
    -- Fixed when it's made: its memory folder (bots/<id>/) and browser profile go by it.
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    -- Its role, in the owner's words; part of its system prompt.
    instructions TEXT NOT NULL DEFAULT '',
    -- Null: what Settings say.
    chat_model TEXT,
    chat_effort TEXT,
    -- The plugin ids it may use, as JSON; null: every plugin that's on.
    plugins TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    deleted_at TEXT
  );
  INSERT INTO bots (id, name) VALUES ('hatbot', 'Hatbot');
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
    title TEXT,
    -- The rolling summary of its earlier episodes (PLAN.md §5.3).
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    deleted_at TEXT
  );
  CREATE TABLE conversation_bots (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    bot_id TEXT NOT NULL REFERENCES bots(id),
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, bot_id)
  );
  INSERT INTO conversations (id, kind, summary)
    VALUES (1, 'direct', coalesce((SELECT value FROM settings WHERE key = 'thread_summary'), ''));
  INSERT INTO conversation_bots (conversation_id, bot_id) VALUES (1, 'hatbot');
  DELETE FROM settings WHERE key = 'thread_summary';

  -- No REFERENCES on these two: SQLite won't add one with a non-null default to a table that has rows.
  ALTER TABLE episodes ADD COLUMN conversation_id INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX episodes_conversation ON episodes (conversation_id, incognito, id);
  -- In a group each bot keeps its own turns: its own prompt, tools and cache.
  ALTER TABLE episode_turns ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'hatbot';
  ALTER TABLE messages ADD COLUMN conversation_id INTEGER NOT NULL DEFAULT 1;
  -- Who wrote it; null for the owner's.
  ALTER TABLE messages ADD COLUMN bot_id TEXT;
  UPDATE messages SET bot_id = 'hatbot' WHERE role = 'assistant';
  CREATE INDEX messages_conversation ON messages (conversation_id, incognito, id);
  ALTER TABLE tasks ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'hatbot';
  -- Where its news goes.
  ALTER TABLE tasks ADD COLUMN conversation_id INTEGER REFERENCES conversations(id);
  UPDATE tasks SET conversation_id = 1;
  -- The bot that handed it over with ask_bot, and hears how it ended.
  ALTER TABLE tasks ADD COLUMN requested_by TEXT;
  ALTER TABLE approvals ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'hatbot';
  ALTER TABLE approvals ADD COLUMN conversation_id INTEGER REFERENCES conversations(id);
  UPDATE approvals SET conversation_id = 1 WHERE task_id IS NULL;
  ALTER TABLE schedules ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'hatbot';
  ALTER TABLE triggers ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'hatbot';
  ALTER TABLE spend_ledger ADD COLUMN bot_id TEXT;
  UPDATE spend_ledger SET bot_id = 'hatbot';
  `,
  /* 21: a bot's icon and colour */ `
  ALTER TABLE bots ADD COLUMN icon TEXT NOT NULL DEFAULT 'hat';
  ALTER TABLE bots ADD COLUMN color TEXT NOT NULL DEFAULT 'amber';
  `,
  /* 22: an ended task's result in its reply's place */ `
  -- A reply's task that ended now has its bot write the reply again. Before, the task's result hid the
  -- reply and the bot answered in a message of its own: the result takes the hidden text's place.
  UPDATE messages SET text = (
    SELECT CASE t.status WHEN 'failed' THEN trim('**Didn''t finish.** ' || coalesce(t.summary, ''))
      ELSE coalesce(nullif(t.summary, ''), 'Done.') END
    FROM tasks t WHERE t.id = messages.task_id)
  WHERE kind IN ('text', 'command') AND task_id IN (SELECT id FROM tasks WHERE status IN ('done', 'failed'));
  `,
  /* 23: files a task hands the bot in the chat */ `
  ALTER TABLE attachments ADD COLUMN for_chat INTEGER NOT NULL DEFAULT 0;
  `,
  /* 24: watchers, which look at a page or a plugin's value and wake a bot only when it changes */ `
  ${REBUILD}
  CREATE TABLE watchers (
    id INTEGER PRIMARY KEY,
    bot_id TEXT NOT NULL DEFAULT 'hatbot',
    name TEXT NOT NULL,
    -- JSON: where the value comes from and how it's picked out (WatchSource).
    source TEXT NOT NULL,
    -- JSON: when a new value counts (WatchCondition).
    condition TEXT NOT NULL,
    -- What a bot does when it counts; empty: you're only told.
    prompt TEXT NOT NULL DEFAULT '',
    every_minutes INTEGER NOT NULL,
    -- Switches itself off after the first time it counts.
    once INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_via TEXT NOT NULL CHECK (created_via IN ('chat', 'owner')),
    tainted INTEGER NOT NULL DEFAULT 0,
    tainted_by TEXT,
    created_at TEXT NOT NULL,
    next_check_at TEXT,
    last_checked_at TEXT,
    last_value TEXT,
    last_changed_at TEXT,
    last_fired_at TEXT,
    last_error TEXT,
    -- Failed checks in a row; you're told once when it reaches five.
    errors INTEGER NOT NULL DEFAULT 0
  );
  -- Each value it saw that differed from the one before.
  CREATE TABLE watcher_values (
    id INTEGER PRIMARY KEY,
    watcher_id INTEGER NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX watcher_values_watcher ON watcher_values (watcher_id, id);

  -- tasks again: origin loses its CHECK, so watchers and the heartbeat can start tasks.
  CREATE TABLE tasks_new (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    success_criteria TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL,
    lane TEXT NOT NULL CHECK (lane IN ('screen', 'background')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'waiting_takeover', 'done', 'failed', 'cancelled')),
    tainted INTEGER NOT NULL DEFAULT 0,
    injection_suspected INTEGER NOT NULL DEFAULT 0,
    budget_usd REAL NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    started_at TEXT,
    finished_at TEXT,
    reported_at TEXT,
    schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
    trigger_id INTEGER REFERENCES triggers(id) ON DELETE SET NULL,
    parent_id INTEGER REFERENCES tasks(id),
    source TEXT,
    run_key TEXT,
    payload TEXT,
    effort TEXT CHECK (effort IN ('low', 'medium', 'high')),
    skill TEXT,
    request TEXT,
    tainted_by TEXT,
    bot_id TEXT NOT NULL DEFAULT 'hatbot',
    conversation_id INTEGER REFERENCES conversations(id),
    requested_by TEXT,
    watcher_id INTEGER REFERENCES watchers(id) ON DELETE SET NULL
  );
  INSERT INTO tasks_new (id, title, goal, success_criteria, origin, lane, model, status, tainted,
    injection_suspected, budget_usd, summary, created_at, started_at, finished_at, reported_at,
    schedule_id, trigger_id, parent_id, source, run_key, payload, effort, skill, request, tainted_by,
    bot_id, conversation_id, requested_by)
  SELECT id, title, goal, success_criteria, origin, lane, model, status, tainted,
    injection_suspected, budget_usd, summary, created_at, started_at, finished_at, reported_at,
    schedule_id, trigger_id, parent_id, source, run_key, payload, effort, skill, request, tainted_by,
    bot_id, conversation_id, requested_by FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  CREATE INDEX tasks_status ON tasks (status);
  CREATE INDEX tasks_run_key ON tasks (run_key, status);
  CREATE INDEX tasks_watcher ON tasks (watcher_id);
  `,
  /* 25: proposals: memory tidy-ups and skill fixes, as diffs for you to apply or dismiss */ `
  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('tidy', 'skill')),
    title TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    -- [{path, before, after}]: null before is a new file, null after deletes it.
    changes TEXT NOT NULL,
    skill TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'stale')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX proposals_status ON proposals (status, id);
  `,
  /* 26: indexes for per-task and per-run lookups; webhook deliveries already seen */ `
  CREATE INDEX IF NOT EXISTS spend_ledger_task ON spend_ledger (task_id);
  CREATE INDEX IF NOT EXISTS messages_task ON messages (task_id);
  CREATE INDEX IF NOT EXISTS messages_episode ON messages (episode_id);
  CREATE INDEX IF NOT EXISTS tasks_schedule ON tasks (schedule_id);
  CREATE INDEX IF NOT EXISTS tasks_trigger ON tasks (trigger_id);
  CREATE INDEX IF NOT EXISTS tasks_skill ON tasks (skill);
  CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_id);
  -- A signed delivery's MAC or delivery id, so a replay is refused across restarts; kept 30 days.
  CREATE TABLE hook_deliveries (
    key TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL
  );
  CREATE INDEX hook_deliveries_seen ON hook_deliveries (seen_at);
  `,
  /* 27: negotiation: wants, negotiations and their messages */ `
  CREATE TABLE wants (
    id INTEGER PRIMARY KEY,
    bot_id TEXT NOT NULL,
    text TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'agreed', 'dropped')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE negotiations (
    id INTEGER PRIMARY KEY,
    want_id INTEGER NOT NULL REFERENCES wants(id),
    bot_id TEXT NOT NULL,
    -- The chat it was started from, where its card is.
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('buy', 'sell')),
    -- <Marketplace>:<listingId>, as Scout gives it.
    listing_key TEXT NOT NULL,
    listing_url TEXT NOT NULL,
    title TEXT NOT NULL,
    asking REAL,
    -- {currency, opening, target, limit, delivery, expiresAt, allow}
    mandate TEXT NOT NULL,
    appraisal TEXT,
    conversation_url TEXT,
    conversation_ref TEXT,
    -- {max, otherOffers, timing, other}: what it has told the seller about our side.
    claims TEXT NOT NULL DEFAULT '{"max":null,"otherOffers":null,"timing":null,"other":[]}',
    status TEXT NOT NULL CHECK (status IN ('awaiting_mandate', 'open', 'agreed', 'lost', 'abandoned', 'expired', 'paid', 'received')),
    agreed_price REAL,
    approval_id INTEGER REFERENCES approvals(id),
    next_follow_up_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX negotiations_want ON negotiations (want_id);
  CREATE INDEX negotiations_status ON negotiations (status);
  CREATE TABLE negotiation_messages (
    id INTEGER PRIMARY KEY,
    negotiation_id INTEGER NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    text TEXT NOT NULL,
    offer REAL,
    agree INTEGER NOT NULL DEFAULT 0,
    stated TEXT,
    status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'unconfirmed', 'failed', 'received')),
    -- The marketplace's id for it, once an inbox read gives one (N3): dedupes reads.
    market_id TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX negotiation_messages_negotiation ON negotiation_messages (negotiation_id, id);
  CREATE UNIQUE INDEX negotiation_messages_market ON negotiation_messages (negotiation_id, market_id)
    WHERE market_id IS NOT NULL;
  -- The desktop tasks that read a negotiation's conversation, or send one message in it (message_id).
  CREATE TABLE negotiation_tasks (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id),
    negotiation_id INTEGER NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES negotiation_messages(id)
  );
  CREATE INDEX negotiation_tasks_message ON negotiation_tasks (message_id);
  ALTER TABLE messages ADD COLUMN negotiation_id INTEGER REFERENCES negotiations(id) ON DELETE SET NULL;
  `,
  /* 28: the model a desktop task started on, when it carried on on another */ `
  ALTER TABLE tasks ADD COLUMN escalated_from TEXT;
  `,
  /* 29: memory files by section, for ranked search; refilled at startup and on every commit */ `
  CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, line UNINDEXED, text, tokenize='porter unicode61');
  `,
  /* 30: proposals of a third kind: writes to skills and indexes from tainted work */ `
  ${REBUILD}
  CREATE TABLE proposals_new (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('tidy', 'skill', 'write')),
    title TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    -- [{path, before, after}]: null before is a new file, null after deletes it.
    changes TEXT NOT NULL,
    skill TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'stale')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  INSERT INTO proposals_new SELECT * FROM proposals;
  DROP TABLE proposals;
  ALTER TABLE proposals_new RENAME TO proposals;
  CREATE INDEX proposals_status ON proposals (status, id);
  `,
  /* 31: research tasks and their reports; the pages a reply cites */ `
  ALTER TABLE tasks ADD COLUMN research INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN report_path TEXT;
  ALTER TABLE messages ADD COLUMN sources TEXT;
  `,
  /* 32: what tainted a note in the chat; what in a conversation looks like a prompt injection */ `
  ALTER TABLE messages ADD COLUMN tainted_by TEXT;
  ALTER TABLE episodes ADD COLUMN injection_suspected TEXT;
  `,
  /* 33: the ledger by conversation, which the chat reads before each request */ `
  CREATE INDEX IF NOT EXISTS spend_ledger_episode ON spend_ledger (episode_id, id);
  `,
  /* 34: an attachment's id is never given out again: a browser may still have the deleted file's */ `
  ${REBUILD}
  CREATE TABLE attachments_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER REFERENCES messages(id),
    task_id INTEGER REFERENCES tasks(id),
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    sender TEXT NOT NULL CHECK (sender IN ('owner', 'hatbot')),
    created_at TEXT NOT NULL,
    for_chat INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO attachments_new SELECT * FROM attachments;
  DROP TABLE attachments;
  ALTER TABLE attachments_new RENAME TO attachments;
  CREATE INDEX attachments_message ON attachments(message_id);
  CREATE INDEX attachments_task ON attachments(task_id);
  -- Ids deleted from the top before now were given out once already: in a database that has been
  -- set up, new ones start well past them, even with no messages left (incognito's go when it ends).
  DELETE FROM sqlite_sequence WHERE name = 'attachments';
  INSERT INTO sqlite_sequence (name, seq)
    SELECT 'attachments', coalesce((SELECT max(id) FROM attachments), 0) + 1000
    WHERE EXISTS (SELECT 1 FROM owner) OR EXISTS (SELECT 1 FROM messages);
  `,
  /* 35: a watcher that counts too often in a day is switched off; switching it on starts the count again */ `
  ALTER TABLE watchers ADD COLUMN counting_since TEXT;
  `,
  /* 36: chat search finds words in any form ("runs" finds "run"); incognito stays out of it */ `
  DROP TABLE messages_fts;
  CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
  INSERT INTO messages_fts (rowid, text) SELECT id, text FROM messages WHERE incognito = 0;
  `,
  /*
   * 37: what a conversation read itself, apart from what came with the summary: only that taints the
   * running summary, so deleting the conversation clears it
   */ `
  ALTER TABLE episodes ADD COLUMN read_untrusted TEXT;
  ALTER TABLE episodes ADD COLUMN read_suspected TEXT;
  -- Before, only what came with the summary can be told apart.
  UPDATE episodes SET read_untrusted = coalesce(tainted_by, 'Untrusted content')
    WHERE tainted = 1 AND coalesce(tainted_by, '') NOT LIKE 'The summary of earlier conversations%';
  UPDATE episodes SET read_suspected = injection_suspected
    WHERE injection_suspected NOT LIKE 'The summary of earlier conversations%'
    AND injection_suspected NOT LIKE '%, which couldn''t be checked';
  `,
  /* 38: questions a task waits on; tasks' status gains waiting_answer */ `
  ${REBUILD}
  CREATE TABLE tasks_new (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    success_criteria TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL,
    lane TEXT NOT NULL CHECK (lane IN ('screen', 'background')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'waiting_takeover', 'waiting_answer', 'done', 'failed', 'cancelled')),
    tainted INTEGER NOT NULL DEFAULT 0,
    injection_suspected INTEGER NOT NULL DEFAULT 0,
    budget_usd REAL NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    started_at TEXT,
    finished_at TEXT,
    reported_at TEXT,
    schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
    trigger_id INTEGER REFERENCES triggers(id) ON DELETE SET NULL,
    parent_id INTEGER REFERENCES tasks(id),
    source TEXT,
    run_key TEXT,
    payload TEXT,
    effort TEXT CHECK (effort IN ('low', 'medium', 'high')),
    skill TEXT,
    request TEXT,
    tainted_by TEXT,
    bot_id TEXT NOT NULL DEFAULT 'hatbot',
    conversation_id INTEGER REFERENCES conversations(id),
    requested_by TEXT,
    watcher_id INTEGER REFERENCES watchers(id) ON DELETE SET NULL,
    escalated_from TEXT,
    research INTEGER NOT NULL DEFAULT 0,
    report_path TEXT
  );
  INSERT INTO tasks_new (id, title, goal, success_criteria, origin, lane, model, status, tainted, injection_suspected, budget_usd, summary, created_at, started_at, finished_at, reported_at, schedule_id, trigger_id, parent_id, source, run_key, payload, effort, skill, request, tainted_by, bot_id, conversation_id, requested_by, watcher_id, escalated_from, research, report_path)
  SELECT id, title, goal, success_criteria, origin, lane, model, status, tainted, injection_suspected, budget_usd, summary, created_at, started_at, finished_at, reported_at, schedule_id, trigger_id, parent_id, source, run_key, payload, effort, skill, request, tainted_by, bot_id, conversation_id, requested_by, watcher_id, escalated_from, research, report_path FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  CREATE INDEX tasks_status ON tasks (status);
  CREATE INDEX tasks_run_key ON tasks (run_key, status);
  CREATE INDEX tasks_watcher ON tasks (watcher_id);
  CREATE INDEX tasks_schedule ON tasks (schedule_id);
  CREATE INDEX tasks_trigger ON tasks (trigger_id);
  CREATE INDEX tasks_skill ON tasks (skill);
  CREATE INDEX tasks_parent ON tasks (parent_id);

  CREATE TABLE questions (
    id INTEGER PRIMARY KEY,
    bot_id TEXT NOT NULL,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    conversation_id INTEGER REFERENCES conversations(id),
    question TEXT NOT NULL,
    -- JSON array of strings
    choices TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'expired', 'cancelled')),
    answer TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    answered_at TEXT
  );
  CREATE INDEX questions_status ON questions (status, id);
  CREATE INDEX questions_task ON questions (task_id);

  ALTER TABLE messages ADD COLUMN choices TEXT;
  `,
  // 39: what a task had read when it asked you, as approvals keep.
  `ALTER TABLE questions ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';`,
  // 40: the to-do item a task works on.
  `ALTER TABLE tasks ADD COLUMN todo TEXT;`,
  // 41: boxes, their versions and what their pages keep.
  `
  CREATE TABLE boxes (
    id INTEGER PRIMARY KEY,
    bot_id TEXT NOT NULL,
    conversation_id INTEGER REFERENCES conversations(id),
    title TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE box_versions (
    box_id INTEGER NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    title TEXT NOT NULL,
    html TEXT NOT NULL,
    message_id INTEGER,
    tainted_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (box_id, n)
  );
  CREATE TABLE box_store (
    box_id INTEGER NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (box_id, key)
  );
  ALTER TABLE messages ADD COLUMN box_id INTEGER;
  `,
  // 42: box files and schedules. A box's number isn't given out again once it's deleted: the guest
  // keeps a backend's data under it.
  `
  CREATE TABLE box_files (
    box_id INTEGER NOT NULL,
    n INTEGER NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (box_id, n, path),
    FOREIGN KEY (box_id, n) REFERENCES box_versions(box_id, n) ON DELETE CASCADE
  );
  ALTER TABLE boxes ADD COLUMN ran_at TEXT;
  CREATE TABLE box_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
  INSERT INTO sqlite_sequence (name, seq) SELECT 'box_ids', COALESCE(MAX(id), 0) FROM boxes;
  `,
  // 43: boxes' feeds.
  `
  CREATE TABLE box_feeds (
    id INTEGER PRIMARY KEY,
    box_id INTEGER NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    -- The bot that added it: it runs with that bot's tools, and stops once the bot is deleted.
    bot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    every_minutes INTEGER NOT NULL,
    -- The latest result, as JSON, and when it came.
    value TEXT,
    value_at TEXT,
    error TEXT,
    -- NULL once it stopped: its tool is gone, or its bot.
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (box_id, name)
  );
  CREATE INDEX box_feeds_due ON box_feeds (next_run_at);
  `,
  // 44: what boxes' backends notified you of.
  `
  CREATE TABLE box_notices (
    id INTEGER PRIMARY KEY,
    box_id INTEGER NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    message_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX box_notices_box ON box_notices (box_id, created_at);
  `,
  // 45: hand-offs answered in the other bot's chat; a task keeps the hand-off whose answer asked for
  // it, so hand-offs through chats nest 3 deep too.
  `
  ALTER TABLE messages ADD COLUMN link_conversation_id INTEGER;
  ALTER TABLE messages ADD COLUMN link_message_id INTEGER;
  ALTER TABLE tasks ADD COLUMN asked_in INTEGER;
  `,
  // 46: a Claude Code box job, as JSON ({request, box?, title?}).
  `
  ALTER TABLE tasks ADD COLUMN box_job TEXT;
  `,
  // 47: approvals for the rest of a task or conversation, or always for one exact call.
  `
  ALTER TABLE approvals ADD COLUMN tool TEXT;
  ALTER TABLE approvals ADD COLUMN input TEXT;
  ALTER TABLE approvals ADD COLUMN target TEXT;
  ALTER TABLE approvals ADD COLUMN episode_id INTEGER;
  ALTER TABLE approvals ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE approvals ADD COLUMN scope TEXT;
  CREATE TABLE approval_rules (
    id INTEGER PRIMARY KEY,
    bot_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (bot_id, tool, input)
  );
  `,
  // 48: unread messages. Its condition is UNREAD in agent/chats.ts, word for word: SQLite only uses
  // a partial index for a query that says so.
  `
  CREATE INDEX messages_unread ON messages (conversation_id, id) WHERE role = 'assistant'
    AND status != 'streaming' AND incognito = 0 AND (seen_at IS NULL OR seen_at < coalesce(edited_at, created_at));
  `,
  // 49: pictures of boxes for the boxes list, one per version and theme.
  `
  CREATE TABLE box_previews (
    box_id INTEGER NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    dark INTEGER NOT NULL,
    png BLOB NOT NULL,
    PRIMARY KEY (box_id, n, dark)
  );
  `,
  // 50: T3 Code in place of Claude Code: bots that had the one have the other.
  `
  UPDATE bots SET plugins = replace(plugins, '"claude"', '"t3"') WHERE plugins LIKE '%"claude"%';
  DELETE FROM settings WHERE key = 'plugin:claude';
  `,
  // 51: flips Scout marked ready to list, one row per marketplace. A row's task posts it, and its gate
  // comes from the row.
  `
  CREATE TABLE flip_listings (
    id INTEGER PRIMARY KEY,
    flip_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    -- Scout's revision of the draft when it was asked about: a newer one is asked about again.
    flip_updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    -- The flip as the owner approved it (JSON): what's posted, whatever Scout says later.
    draft TEXT NOT NULL,
    approval_id INTEGER,
    task_id INTEGER,
    -- desktop-agent's stage for the task's photos, and their names there (JSON), in order.
    stage TEXT,
    photos TEXT,
    published_at TEXT,
    url TEXT,
    error TEXT,
    -- When Scout was told how it ended.
    reported_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (flip_id, channel)
  );
  CREATE INDEX flip_listings_task ON flip_listings (task_id);
  CREATE INDEX flip_listings_approval ON flip_listings (approval_id);
  `,
  // 52: why a negotiation is held for the owner ('scam' or 'stalled'; none is a scam, as before), and the
  // seller's message a stall was asked at, since only rounds after it count towards another.
  `
  ALTER TABLE negotiations ADD COLUMN hold TEXT;
  ALTER TABLE negotiations ADD COLUMN stalled_at INTEGER;
  `,
];
