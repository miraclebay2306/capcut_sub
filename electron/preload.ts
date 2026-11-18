import { contextBridge, ipcRenderer } from "electron";
import {
  PipelineConfig,
  PipelineProgress,
  PipelineResult,
  ProjectValidationResult,
} from "../src/core/types";

contextBridge.exposeInMainWorld("capcutLao", {
  selectProjectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("select-project-directory"),

  saveApiKey: (apiKey: string): Promise<boolean> => ipcRenderer.invoke("save-api-key", apiKey),
  loadApiKey: (): Promise<string | null> => ipcRenderer.invoke("load-api-key"),
  clearApiKey: (): Promise<boolean> => ipcRenderer.invoke("clear-api-key"),

  runPipeline: (config: PipelineConfig): Promise<PipelineResult> =>
    ipcRenderer.invoke("run-pipeline", config),

  validateProject: (projectDir: string): Promise<ProjectValidationResult> =>
    ipcRenderer.invoke("validate-project", projectDir),

  getRecentProjects: () =>
    ipcRenderer.invoke("get-recent-projects"),

  restoreProjectBackup: (projectDir: string) =>
    ipcRenderer.invoke("restore-project-backup", projectDir),

  extractSubtitles: (projectDir: string) =>
    ipcRenderer.invoke("extract-subtitles", projectDir),

  applyEditedSubtitles: (
    projectDir: string,
    subtitles: any[],
    config: PipelineConfig
  ) =>
    ipcRenderer.invoke("apply-edited-subtitles", projectDir, subtitles, config),

  exportSubtitlesFile: (
    defaultFileName: string,
    content: string,
    extension: "srt" | "txt"
  ) =>
    ipcRenderer.invoke("export-subtitles-file", defaultFileName, content, extension),

  openCapCut: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("open-capcut"),

  onProgress: (callback: (p: PipelineProgress) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: PipelineProgress) => callback(p);
    ipcRenderer.on("pipeline-progress", listener);
    return () => ipcRenderer.removeListener("pipeline-progress", listener);
  },
});
