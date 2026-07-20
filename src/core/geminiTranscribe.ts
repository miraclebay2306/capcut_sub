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

function stripCodeFences(text: string): string {
  if (text.startsWith("```")) {
    return text.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  }
  return text;
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

  const primaryModel = config.model || "gemini-3.1-flash-lite";
  const fallbacks = [
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.5-flash",
  ].filter((m) => m !== primaryModel);
  const modelsToTry = [primaryModel, ...fallbacks];

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
        const jsonText = stripCodeFences(raw);
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
          if (s.text) s.text = cleanLaoText(s.text);
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
