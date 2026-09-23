import type { Auth } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Orchestrator } from './docker/orchestrator.js';
import type { SecretStore } from './secrets.js';
import type { WorkspaceManager } from './workspaces/manager.js';

export interface AppContext {
  cfg: Config;
  db: Db;
  auth: Auth;
  secrets: SecretStore;
  orch: Orchestrator;
  workspaces: WorkspaceManager;
}
