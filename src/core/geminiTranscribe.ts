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
      ? "Produce a clean, natural transcription in pristine Lao script (ອັກສອນລາວ). Omit vocal hesitations (like um, uh, er, ເອີ, ອ່ະ), but transcribe every spoken sentence completely without skipping any words or meaning."
      : "Produce a strictly verbatim transcription in pristine Lao script (ອັກສອນລາວ). Capture every spoken word accurately.";

  let bilingualInstruction = "";
  if (config.bilingualMode === "lao_vietnamese") {
    bilingualInstruction =
      "BILINGUAL SUBTITLE REQUIREMENT: For every sentence's 'text' field, output TWO lines: Line 1 in native Lao script (ອັກສອນລາວ), followed by a newline (\\n), followed by Line 2 in Vietnamese (Tiếng Việt) natural translation with correct Vietnamese diacritics/accents. Example: 'ສະບາຍດີທຸກຄົນ\\nXin chào mọi người'. In 'words', keep the Lao words and acoustic timestamps.";
  } else if (config.bilingualMode === "lao_english") {
    bilingualInstruction =
      "BILINGUAL SUBTITLE REQUIREMENT: For every sentence's 'text' field, output TWO lines: Line 1 in native Lao script (ອັກສອນລາວ), followed by a newline (\\n), followed by Line 2 in English translation. Example: 'ສະບາຍດີທຸກຄົນ\\nHello everyone'. In 'words', keep the Lao words and acoustic timestamps.";
  }

  const glossaryBlock = config.glossary.trim()
    ? `The following proper nouns, brand names, and technical terms may appear in the audio. Use these exact spellings/casings whenever they occur:\n${config.glossary.trim()}`
    : "";

  return [
    "You are the world's leading native Lao linguist, master transcriber, and subtitle localization specialist.",
    "Listen carefully to the audio file and transcribe ALL spoken speech into 100% authentic, grammatically correct Lao script (ອັກສອນລາວ), sentence by sentence.",
    "",
    "CRITICAL LAO ORTHOGRAPHY & ACCURACY RULES (ຂຽນຄືຄົນລາວແທ້ໆ 100% ຕາມກະຊວງສຶກສາ):",
    "- 100% AUTHENTIC LAO SPELLING: Use proper official Lao orthography (ອັກສອນລາວ).",
    "- NEVER BORROW THAI SPELLING PATTERNS: Never mix Thai orthography or loan patterns (e.g. use 'ບໍ່' NEVER 'ບໍ', 'ແມ່ນ' NEVER 'ແນ່ນ', 'ເຈົ້າ' NEVER 'ເຈົາ', 'ຂອບໃຈ' NEVER 'ຂອບໄຈ', 'ເດີ້'/'ເດີ', 'ຫວາ'/'ບໍ່', 'ແນວໃດ', 'ກໍ'/'ກໍ່').",
    "- ACCURATE TONE MARKS: Accurately place Mai Ek (-່) and Mai Tho (-້) according to actual spoken Lao pitch and consonant classes (High/Mid/Low). Never omit tone marks.",
    "- CONVERSATIONAL ACCURACY: Common spoken Lao idioms and particles ('ສະບາຍດີ', 'ໂດຍ', 'ເຈົ້າ', 'ແມ່ນແລ້ວ', 'ຂອບໃຈຫຼາຍໆ', 'ເນາະ', 'ຊັ້ນເດີ', 'ບາດນີ້', 'ພໍດີ', 'ແທ້ຫວາ', 'ບໍ່ວ່າຈະເປັນ') must be transcribed with pristine Lao spelling.",
    "- NEVER SPLIT COMPOUNDS OR SYLLABLES IN 'words':",
    "  In the 'words' array, every single element MUST be a complete, unbroken word or compound phrase with standalone meaning.",
    "  - NEVER split prefixes from stems: Write 'ການຮັກ' (NEVER 'ກາ ນຮັກ' or 'ການ' + 'ຮັກ'); Write 'ການແນະນຳ' (NEVER 'ກາ ນແນະນຳ' or 'ການ' + 'ແນະນຳ'); Write 'ຄວາມຮັກ' (NEVER 'ຄວາ ມຮັກ'); Write 'ຜູ້ໃຊ້' (NEVER 'ຜູ້' + 'ໃຊ້'); Write 'ບໍ່ແມ່ນ' (NEVER 'ບໍ ແມ່ນ' or 'ບໍແນ່ນ'); Write 'ໄດ້ຍິນ' (NEVER 'ໄດ້' + 'ຍິນ').",
    "  - NEVER split multi-syllable compounds: Write 'ອຸປະກອນ' (NEVER 'ອຸປະ' + 'ກອນ'); Write 'ໂປຣໂມຊັ່ນ' (NEVER 'ໂປ' + 'ໂມ' + 'ຊັ່ນ' or 'ໂປໂມ' + 'ຊັ່ນ'); Write 'ແນະນຳ' (NEVER 'ແນະ' + 'ນຳ'); Write 'ລະບົບ' (NEVER 'ລະ' + 'ບົບ'); Write 'ຮອງຮັບ' (NEVER 'ຮອງ' + 'ຮັບ'); Write 'ໂທລະສັບ' (NEVER 'ໂທລະ' + 'ສັບ'); Write 'ຕິດຕັ້ງ' (NEVER 'ຕິດ' + 'ຕັ້ງ'); Write 'ດາວໂຫຼດ' (NEVER 'ດາວ' + 'ໂຫຼດ'); Write 'ອັບເດດ' (NEVER 'ອັບ' + 'ເດດ'); Write 'ອອນລາຍ' (NEVER 'ອອນ' + 'ລາຍ'); Write 'ສະບາຍດີ' (NEVER 'ສະ' + 'ບາຍດີ'); Write 'ຂອບໃຈ' (NEVER 'ຂອບ' + 'ໃຈ'); Write 'ລູກຄ້າ' (NEVER 'ລູກ' + 'ຄ້າ'); Write 'ບໍລິການ' (NEVER 'ບໍ' + 'ລິການ').",
    "  - In 'text', do NOT put spaces between words within a phrase (ເຊັ່ນ 'ລະບົບເຮົາຮອງຮັບທຸກອຸປະກອນ' NOT 'ລະບົບ ເຮົາ ຮອງຮັບ ທຸກ ອຸປະກອນ'). Only put spaces between major phrases, clauses, or breathing pauses.",
    "",
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

function isServerOverloadedError(errMessage: string): boolean {
  return (
    errMessage.includes("503") ||
    errMessage.includes("500") ||
    errMessage.includes("502") ||
    errMessage.includes("504") ||
    errMessage.includes("overloaded") ||
    errMessage.includes("The model is overloaded") ||
    errMessage.includes("Service Unavailable") ||
    errMessage.includes("Internal error")
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
          .map((m: any) => m.name.replace("models/", ""))
          .filter((name: string) => {
            const lower = name.toLowerCase();
            return (
              !lower.includes("image") &&
              !lower.includes("tts") &&
              !lower.includes("lyria") &&
              !lower.includes("computer-use") &&
              !lower.includes("embedding")
            );
          });
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
    "gemini-3.5-transcribe",
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
        const model = genAI.getGenerativeModel({
          model: currentModelName,
          systemInstruction:
            "You are the world's leading native Lao linguist, master phonetician, and subtitle localization specialist. You transcribe spoken Lao audio with 100% authentic Lao orthography following the Lao Ministry of Education standard. You preserve natural compound words without splitting them, place tone marks accurately according to Lao phonology, and provide precise millisecond-level word timestamps.",
          generationConfig: {
            temperature: 0.1,
          },
        });
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
        } else if (isServerOverloadedError(errMsg)) {
          if (attempt < 2) {
            onStatusUpdate?.(
              `Google Server ຕິດຂັດ (503 Overloaded). ກຳລັງລອງໃໝ່ໃນ 2 ວິນາທີ...`
            );
            await delay(2000);
            continue;
          } else {
            onStatusUpdate?.(
              `Model ${currentModelName} ຕິດ 503 Overload. ກຳລັງສະຫຼັບໄປໃຊ້ Model ສຳຮອງອັດຕະໂນມັດ...`
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
