export interface SessionState {
  worktree: string;
  path: string;
  branch: string;
  status: "active" | "completed" | "stopped";
  task: string;
  template?: string;
  started_at: string;
  stopped_at?: string;
}

export interface FleetTemplate {
  name: string;
  prompt_prefix: string;
  permissions?: string[];
}
