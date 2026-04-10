export interface RuntimeConfig {
  version: 1;
  sessionId: string;
  adapter: string;
  host: string;
  rootPath: string;
  createdAt: string;
  codexDangerouslyBypassApprovalsAndSandbox?: boolean;
}
