export interface BQConfig {
  main_repo: string;
  workspace: string;
  default_scheme: string;
  default_test_scheme: string;
  default_test_plan: string;
  default_destination: string;
  backend: "mcp" | "xcodebuild";
  xcodebuild_fallback: boolean;
  git_restore_mtime: boolean;
}

export interface Job {
  id: string;
  action: "build" | "test";
  branch?: string;
  snapshot_sha?: string;
  scheme: string;
  test_plan?: string;
  only_testing?: string[];
  destination?: string;
  backend: "mcp" | "xcodebuild";
  submitted_at: string;
  submitted_by: string;
}

export interface JobResult {
  id: string;
  status: "passed" | "failed" | "error";
  duration_seconds: number;
  summary: string;
  failures: string[];
  build_errors: string[];
  warnings: string[];
  log_path: string;
}

export const DEFAULT_CONFIG: BQConfig = {
  main_repo: "",
  workspace: "",
  default_scheme: "",
  default_test_scheme: "",
  default_test_plan: "",
  default_destination: "platform=iOS Simulator,name=iPhone 16",
  backend: "mcp",
  xcodebuild_fallback: true,
  git_restore_mtime: true,
};
