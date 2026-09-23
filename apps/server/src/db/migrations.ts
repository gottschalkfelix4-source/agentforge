// Append-only list of schema migrations; index + 1 = PRAGMA user_version after applying.
// Never edit an existing entry once released — add a new one.

export const migrations: string[] = [
  /* v1: core */ `
  CREATE TABLE admin (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    pw_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT,
    ip TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE secrets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT,
    secret_id TEXT REFERENCES secrets(id) ON DELETE SET NULL,
    models_json TEXT NOT NULL DEFAULT '[]',
    default_model TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    agent_kind TEXT NOT NULL,
    name TEXT NOT NULL,
    auth_mode TEXT NOT NULL,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    model TEXT,
    extra_args_json TEXT NOT NULL DEFAULT '[]',
    env_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    git_url TEXT,
    default_branch TEXT,
    created_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    container_id TEXT,
    image TEXT NOT NULL,
    status TEXT NOT NULL,
    status_message TEXT,
    cpu_limit REAL,
    mem_limit_mb INTEGER,
    last_seen_at TEXT
  );

  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    meta_json TEXT
  );
  `,

  /* v2: agent sessions, GitHub, project management */ `
  ALTER TABLE projects ADD COLUMN repo_owner TEXT;
  ALTER TABLE projects ADD COLUMN repo_name TEXT;

  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
    transport TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    status_message TEXT,
    external_id TEXT,
    cwd TEXT NOT NULL DEFAULT '.',
    task_run_id TEXT,
    current_model TEXT,
    current_mode TEXT,
    last_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX agent_sessions_project ON agent_sessions(project_id, updated_at);

  CREATE TABLE session_events (
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  CREATE TABLE sync_cursors (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    resource TEXT NOT NULL,
    etag TEXT,
    since TEXT,
    last_polled_at TEXT,
    PRIMARY KEY (project_id, resource)
  );

  CREATE TABLE milestones (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_on TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    gh_number INTEGER,
    gh_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE labels (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '888888',
    UNIQUE (project_id, name)
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    col TEXT NOT NULL DEFAULT 'backlog',
    rank TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
    assignee_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
    gh_issue_number INTEGER,
    gh_url TEXT,
    gh_updated_at TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project ON tasks(project_id, col, rank);

  CREATE TABLE task_labels (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
  );

  CREATE TABLE task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    auto_pr INTEGER NOT NULL DEFAULT 1,
    pr_number INTEGER,
    pr_url TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sync_log (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    direction TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    message TEXT NOT NULL
  );
  `,

  /* v3: task runs remember their base (PR base branch, change detection) */ `
  ALTER TABLE task_runs ADD COLUMN base_branch TEXT;
  ALTER TABLE task_runs ADD COLUMN base_sha TEXT;
  ALTER TABLE task_runs ADD COLUMN profile_id TEXT;
  `,
];
