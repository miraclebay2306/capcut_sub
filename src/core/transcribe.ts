import {
  TranscriptionConfig,
  TranscribedSentence,
} from "./types";
import { transcribeWithGemini } from "./geminiTranscribe";

export interface TranscriptionResult {
  sentences: TranscribedSentence[];
}

export async function transcribeLao(
  apiKey: string,
  audioPath: string,
  config: TranscriptionConfig,
  onStatusUpdate?: (msg: string) => void,
): Promise<TranscriptionResult> {
  onStatusUpdate?.("ກຳລັງຖອດຂໍ້ຄວາມດ້ວຍ Google Gemini AI...");
  const result = await transcribeWithGemini(apiKey, audioPath, config, onStatusUpdate);
  return { sentences: result.sentences };
}
