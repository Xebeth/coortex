export interface CodexProfileConfig {
  name: string;
  host: "codex";
  modelInstructionsFile: string;
  notes: string;
}

export interface CodexConfigInstallation {
  configPath: string;
  modelInstructionsFile: string;
}

export interface CodexSkillPackInstallation {
  skillsRoot: string;
  managedSkills: string[];
}
