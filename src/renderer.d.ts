import {
  PipelineConfig,
  PipelineProgress,
  PipelineResult,
  ProjectValidationResult,
  ExtractionResult,
  ExtractedSubtitle,
  RecentProject,
  BackupRestoreResult,
} from "./core/types";

export interface CapcutLaoBridge {
  selectProjectDirectory(): Promise<string | null>;
  saveApiKey(apiKey: string): Promise<boolean>;
  loadApiKey(): Promise<string | null>;
  clearApiKey(): Promise<boolean>;
  runPipeline(config: PipelineConfig): Promise<PipelineResult>;
  validateProject(projectDir: string): Promise<ProjectValidationResult>;
  extractSubtitles(projectDir: string): Promise<ExtractionResult>;
  getRecentProjects(): Promise<RecentProject[]>;
  restoreProjectBackup(projectDir: string): Promise<BackupRestoreResult>;
  applyEditedSubtitles(
    projectDir: string,
    subtitles: ExtractedSubtitle[],
    config: PipelineConfig
  ): Promise<PipelineResult>;
  exportSubtitlesFile(
    defaultFileName: string,
    content: string,
    extension: "srt" | "txt"
  ): Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  onProgress(callback: (p: PipelineProgress) => void): () => void;
  openCapCut(): Promise<{ success: boolean; error?: string }>;
}

declare global {
  interface Window {
    capcutLao: CapcutLaoBridge;
  }
}
