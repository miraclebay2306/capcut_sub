import { PipelineConfig, PipelineProgress, PipelineResult } from "./core/types";

export interface CapcutLaoBridge {
  selectProjectDirectory(): Promise<string | null>;
  saveApiKey(apiKey: string): Promise<boolean>;
  loadApiKey(): Promise<string | null>;
  clearApiKey(): Promise<boolean>;
  runPipeline(config: PipelineConfig): Promise<PipelineResult>;
  onProgress(callback: (p: PipelineProgress) => void): () => void;
}

declare global {
  interface Window {
    capcutLao: CapcutLaoBridge;
  }
}
