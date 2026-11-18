import * as fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { TranscriptionConfig, TranscribedSentence } from "./types";
import { cleanLaoText } from "./subtitleBuilder";

export interface GeminiTranscriptionResult {
  sentences: TranscribedSentence[];
}

function buildPrompt(config: TranscriptionConfig): string {
  const styleInstruction =
    config.speechStyle === "polished"
      ? "Produce a clean transcription in Lao script (ອັກສອນລາວ). Omit vocal hesitations (like um, uh, er, ເອີ, ອ່ະ), but transcribe every spoken sentence completely without skipping any words or phrases."
      : "Produce a strictly verbatim transcription in Lao script (ອັກສອນລາວ). Capture every spoken word accurately.";

  let bilingualInstruction = "";
  if (config.bilingualMode === "lao_thai") {
    bilingualInstruction =
      "BILINGUAL SUBTITLE REQUIREMENT: For every sentence's 'text' field, output TWO lines: Line 1 in Lao script (ອັກສອນລາວ), followed by a newline (\\n), followed by Line 2 in Thai script (ภาษาไทย) natural translation. Example: 'ສະບາຍດີທຸກຄົນ\\nสวัสดีทุกคน'. In 'words', keep the Lao words and acoustic timestamps.";
  } else if (config.bilingualMode === "lao_english") {
    bilingualInstruction =
      "BILINGUAL SUBTITLE REQUIREMENT: For every sentence's 'text' field, output TWO lines: Line 1 in Lao script (ອັກສອນລາວ), followed by a newline (\\n), followed by Line 2 in English translation. Example: 'ສະບາຍດີທຸກຄົນ\\nHello everyone'. In 'words', keep the Lao words and acoustic timestamps.";
  }

  const glossaryBlock = config.glossary.trim()
    ? `The following proper nouns, brand names, and technical terms may appear in the audio. Use these exact spellings/casings whenever they occur:\n${config.glossary.trim()}`
    : "";

  return [
    "You are an expert Lao audio transcriptionist.",
    "Listen carefully to the audio file and transcribe ALL spoken speech into Lao script (ອັກສອນລາວ), sentence by sentence.",
    "CRITICAL FOR TIMING & AUDIO SYNCHRONIZATION:",
    "1. You MUST listen carefully at high temporal resolution and provide precise millisecond-level word timestamps (startSec and endSec) for EVERY single word in 'words'.",
    "2. Each word's startSec MUST be the exact acoustic onset (the exact millisecond the speaker starts saying that specific word in audio).",
    "3. Each word's endSec MUST be the exact acoustic offset (the exact millisecond the speaker finishes saying that specific word in audio).",
    "4. Ensure word timestamps strictly progress chronologically: startSec < endSec for every word without overlapping or skipping.",
    styleInstruction,
    bilingualInstruction,
    glossaryBlock,
    "",
    "Return ONLY valid JSON (no markdown fences, no commentary) matching this exact shape:",
    `{
  "sentences": [
    {
      "text": "<lao sentence>",
      "startSec": 0.0,
      "endSec": 0.0,
      "words": [
        { "word": "<lao word>", "startSec": 0.0, "endSec": 0.0 }
      ]
    }
  ]
}`,
    "",
    "Rules:",
    "- Transcribe ALL spoken sentences from the beginning to the end of the audio. Do NOT summarize or skip any sentence.",
    "- Timestamps (startSec and endSec) must accurately reflect when each sentence and word is spoken in seconds relative to the start of the audio file.",
    "- Group spoken words into complete, natural sentences (aim for complete thoughts of around 8 to 15 words; do NOT split unnaturally into short 2-3 word fragments unless there is a long pause).",
  ]
    .filter(Boolean)
    .join("\n");
}

function mimeTypeFor(filePath: string): string {
  if (filePath.endsWith(".wav")) return "audio/wav";
  if (filePath.endsWith(".mp3")) return "audio/mp3";
  if (filePath.endsWith(".m4a")) return "audio/mp4";
  return "audio/wav";
}

function parseRetryDelay(errMessage: string): number {
  const secMatch =
    errMessage.match(/retryDelay["\s:]+["']?(\d+(?:\.\d+)?)s/i) ||
    errMessage.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (secMatch) {
    const sec = Math.ceil(parseFloat(secMatch[1]));
    return Math.max(sec, 5);
  }
  return 15;
}

function isQuotaOrRateLimitError(errMessage: string): boolean {
  return (
    errMessage.includes("429") ||
    errMessage.includes("Too Many Requests") ||
    errMessage.includes("Quota exceeded") ||
    errMessage.includes("RESOURCE_EXHAUSTED")
  );
}

function isNotFoundError(errMessage: string): boolean {
  return errMessage.includes("404") || errMessage.includes("is not found");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJsonText(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return cleaned.substring(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

export async function queryAvailableGeminiModels(apiKey: string): Promise<string[]> {
  if (!apiKey) return [];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const data: any = await res.json();
      if (Array.isArray(data.models)) {
        return data.models
          .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
          .map((m: any) => m.name.replace("models/", ""));
      }
    }
  } catch {}
  return [];
}

export async function transcribeWithGemini(
  apiKey: string,
  audioPath: string,
  config: TranscriptionConfig,
  onStatusUpdate?: (msg: string) => void
): Promise<GeminiTranscriptionResult> {
  if (!apiKey) throw new Error("Missing API key.");
  if (!fs.existsSync(audioPath))
    throw new Error(`Audio file not found: ${audioPath}`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const audioBytes = fs.readFileSync(audioPath);
  const audioBase64 = audioBytes.toString("base64");
  const prompt = buildPrompt(config);

  const primaryModel = config.model || "gemini-3.5-flash";

  // Check models supported in real-time by the user's specific API key
  const dynamicModels = await queryAvailableGeminiModels(apiKey);

  const defaultFallbacks = [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.5-pro",
    "gemini-3.0-flash",
    "gemini-3.0-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
  ];

  const pool = dynamicModels.length > 0 ? dynamicModels : defaultFallbacks;

  const modelsToTry: string[] = [];
  if (primaryModel && pool.includes(primaryModel)) {
    modelsToTry.push(primaryModel);
  } else if (primaryModel) {
    // If not sure, still give primaryModel a try first
    modelsToTry.push(primaryModel);
  }

  for (const m of pool) {
    if (!modelsToTry.includes(m) && (m.includes("flash") || m.includes("pro"))) {
      modelsToTry.push(m);
    }
  }

  if (modelsToTry.length === 0) {
    modelsToTry.push(...defaultFallbacks);
  }

  let lastError: Error | null = null;

  for (const currentModelName of modelsToTry) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (currentModelName !== primaryModel && attempt === 1) {
          onStatusUpdate?.(`ກຳລັງລອງໃຊ້ Model ສຳຮອງ (${currentModelName})...`);
        }
        const model = genAI.getGenerativeModel({ model: currentModelName });
        const result = await model.generateContent([
          { text: prompt },
          {
            inlineData: {
              mimeType: mimeTypeFor(audioPath),
              data: audioBase64,
            },
          },
        ]);

        const raw = result.response.text().trim();
        const jsonText = extractJsonText(raw);
        let parsed: any;
        try {
          parsed = JSON.parse(jsonText);
        } catch (e) {
          throw new Error(
            `Gemini returned non-JSON output. First 300 chars: ${jsonText.slice(0, 300)}`
          );
        }

        if (!Array.isArray(parsed.sentences)) {
          throw new Error("Gemini response missing 'sentences' array.");
        }

        for (const s of parsed.sentences) {
          if (s.text) {
            if (config.bilingualMode && config.bilingualMode !== "off") {
              const lines = s.text.split("\n");
              s.text = lines
                .map((line: string, idx: number) => (idx === 0 ? cleanLaoText(line) : line.trim()))
                .filter(Boolean)
                .join("\n");
            } else {
              s.text = cleanLaoText(s.text);
            }
          }
          if (Array.isArray(s.words)) {
            for (const w of s.words) {
              if (w.word) w.word = cleanLaoText(w.word);
            }
          }
        }

        return { sentences: parsed.sentences };
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        lastError = err instanceof Error ? err : new Error(errMsg);

        if (isQuotaOrRateLimitError(errMsg)) {
          if (attempt < maxAttempts) {
            const waitSec = parseRetryDelay(errMsg);
            onStatusUpdate?.(
              `ເກີນໂຄຕ້າ API (${currentModelName}), ກຳລັງຖ້າ ${waitSec} ວິນາທີກ່ອນລອງໃໝ່ (ຄັ້ງທີ ${attempt}/${maxAttempts})...`
            );
            await delay(waitSec * 1000);
            continue;
          } else {
            onStatusUpdate?.(
              `Model ${currentModelName} ເກີນໂຄຕ້າ API. ກຳລັງປ່ຽນໄປໃຊ້ Model ສຳຮອງ...`
            );
            break;
          }
        } else if (isNotFoundError(errMsg)) {
          onStatusUpdate?.(
            `Model ${currentModelName} ບໍ່ພົບໃນລະບົບ API (404). ກຳລັງລອງ Model ອື່ນ...`
          );
          break;
        } else {
          throw lastError;
        }
      }
    }
  }

  if (lastError && isQuotaOrRateLimitError(lastError.message)) {
    throw new Error(
      `Gemini API ຂໍ້ຈຳກັດ (Quota 429) ເຕັມ: ທ່ານໄດ້ໃຊ້ Quota ໃນ Free Tier ຄົບແລ້ວ ຫຼື ໃຊ້ຖີ່ເກີນໄປ. ກະລຸນາລອງໃໝ່ຫຼັງຈາກ 1-2 ນາທີ, ຫຼື ອັບເກຣດ Gemini API Key ເປັນ Paid Billing Plan.`
    );
  }

  throw lastError || new Error("Failed to transcribe audio with Gemini.");
}
