import { SubtitleStyleConfig, TranscribedSentence } from "./types";

/**
 * A style-agnostic, CapCut-agnostic representation of one subtitle "cue" on
 * the timeline. draftContentEditor.ts is responsible for turning these into
 * actual CapCut text-segment JSON. Keeping this layer in between means the
 * animation-mode logic (sentence / word-by-word / karaoke) lives in one place
 * and doesn't leak into the draft-file writer.
 */
export interface SubtitleCue {
  startSec: number;
  endSec: number;
  /** Rich-text runs; karaoke mode uses one run per word so each can be
   *  individually colored/highlighted, others use a single run. */
  runs: { text: string; highlightAt?: { startSec: number; endSec: number } }[];
}

const FONT_SIZE_PX: Record<SubtitleStyleConfig["fontSize"], number> = {
  small: 20,
  medium: 28,
  large: 36,
  xl: 44,
};

const TEXT_COLOR_HEX: Record<SubtitleStyleConfig["textColor"], string> = {
  white: "#FFFFFFFF",
  yellow: "#FFD400FF",
  neon_green: "#39FF14FF",
};

export function resolveFontSizePx(style: SubtitleStyleConfig): number {
  return FONT_SIZE_PX[style.fontSize];
}

export function resolveTextColorHex(style: SubtitleStyleConfig): string {
  return TEXT_COLOR_HEX[style.textColor];
}

/**
 * Splits/reshapes sentences into cues according to the selected animation mode.
 */
export function buildCues(
  sentences: TranscribedSentence[],
  style: SubtitleStyleConfig
): SubtitleCue[] {
  let rawCues: SubtitleCue[];
  switch (style.animationMode) {
    case "word_by_word":
      rawCues = buildWordByWordCues(sentences);
      break;
    case "karaoke":
      rawCues = buildKaraokeCues(sentences);
      break;
    case "sentence":
    default:
      rawCues = buildSentenceCues(sentences);
      break;
  }
  return sanitizeCues(rawCues);
}

/**
 * Ensures cues are strictly ordered, non-overlapping, and have positive duration.
 */
export function sanitizeCues(cues: SubtitleCue[]): SubtitleCue[] {
  if (cues.length === 0) return [];

  const valid = cues.filter(
    (c) => c.runs && c.runs.length > 0 && c.runs.some((r) => r.text.trim().length > 0)
  );
  if (valid.length === 0) return [];

  const sorted = [...valid].sort((a, b) => a.startSec - b.startSec);
  const result: SubtitleCue[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = { ...sorted[i], runs: sorted[i].runs.map((r) => ({ ...r })) };

    if (current.endSec <= current.startSec) {
      current.endSec = current.startSec + 0.15;
    }

    if (result.length > 0) {
      const prev = result[result.length - 1];
      if (prev.endSec > current.startSec) {
        if (current.startSec >= prev.startSec + 0.08) {
          prev.endSec = current.startSec;
        } else {
          current.startSec = prev.endSec;
          if (current.endSec <= current.startSec) {
            current.endSec = current.startSec + 0.15;
          }
        }
      }
    }
    result.push(current);
  }

  return result;
}

/**
 * Removes unnecessary spaces between Lao characters/words while keeping spaces
 * between English words or numbers (e.g. "ການ ອັດສຽງ ຄັ້ງ" -> "ການອັດສຽງຄັ້ງ").
 */
export function cleanLaoText(text: string): string {
  if (!text) return "";
  let cleaned = text;
  let prev = "";
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned.replace(/([\u0E80-\u0EFF])\s+([\u0E80-\u0EFF])/g, "$1$2");
  }
  return cleaned.trim();
}

/**
 * Joins an array of words/runs together intelligently.
 * Lao words placed consecutively will be joined without spaces.
 * English words or numbers will have spaces preserved/added as appropriate.
 */
export function joinLaoWords(words: string[]): string {
  const cleaned = words.map((w) => w.trim()).filter((w) => w.length > 0);
  if (cleaned.length === 0) return "";

  const isLao = (str: string) => /[\u0E80-\u0EFF]/.test(str);

  let result = cleaned[0];
  for (let i = 1; i < cleaned.length; i++) {
    const prevStr = cleaned[i - 1];
    const currStr = cleaned[i];

    if (isLao(prevStr[prevStr.length - 1]) && isLao(currStr[0])) {
      result += currStr;
    } else {
      result += " " + currStr;
    }
  }

  return cleanLaoText(result);
}

function splitSentenceIntoCompactChunks(
  text: string,
  startSec: number,
  endSec: number,
  maxChars = 50
): SubtitleCue[] {
  const cleanedText = cleanLaoText(text);
  const words = cleanedText.split(/\s+/).filter((w) => w.trim().length > 0);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let currentWords: string[] = [];

  for (const w of words) {
    const candidate = joinLaoWords([...currentWords, w]);
    if (candidate.length > maxChars && currentWords.length > 0) {
      chunks.push(joinLaoWords(currentWords));
      currentWords = [w];
    } else {
      currentWords.push(w);
    }
  }
  if (currentWords.length > 0) {
    chunks.push(joinLaoWords(currentWords));
  }

  const totalDur = Math.max(0.4, endSec - startSec);
  const chunkDur = totalDur / chunks.length;

  const result: SubtitleCue[] = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const sTime = startSec + idx * chunkDur;
    const eTime = idx === chunks.length - 1 ? endSec : sTime + chunkDur;
    result.push({
      startSec: sTime,
      endSec: Math.max(eTime, sTime + 0.2),
      runs: [{ text: chunks[idx] }],
    });
  }

  return sanitizeCues(result);
}

function buildSentenceCues(sentences: TranscribedSentence[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const s of sentences) {
    if (!s.words || s.words.length === 0) {
      if (s.text) {
        cues.push(...splitSentenceIntoCompactChunks(cleanLaoText(s.text), s.startSec, s.endSec, 50));
      }
      continue;
    }

    const chunkSize = 12;
    for (let i = 0; i < s.words.length; i += chunkSize) {
      const chunk = s.words.slice(i, i + chunkSize);
      const chunkStart = chunk[0].startSec;
      const chunkEnd = chunk[chunk.length - 1].endSec;
      const chunkText = joinLaoWords(chunk.map((w) => cleanLaoText(w.word)));
      if (chunkText.length > 50) {
        cues.push(...splitSentenceIntoCompactChunks(chunkText, chunkStart, chunkEnd, 50));
      } else {
        cues.push({
          startSec: chunkStart,
          endSec: Math.max(chunkEnd, chunkStart + 0.3),
          runs: [{ text: chunkText }],
        });
      }
    }
  }
  return sanitizeCues(cues);
}

/** One cue per word, each shown continuously while spoken with smooth transitions. */
function buildWordByWordCues(sentences: TranscribedSentence[]): SubtitleCue[] {
  const allWords: { word: string; startSec: number; endSec: number }[] = [];

  for (const s of sentences) {
    if (!s.words || s.words.length === 0) {
      if (s.text) {
        const dummyWords = cleanLaoText(s.text).split(/\s+/).filter((w) => w.trim().length > 0);
        const dur = Math.max(0.4, s.endSec - s.startSec);
        const wDur = dur / Math.max(1, dummyWords.length);
        dummyWords.forEach((dw, idx) => {
          allWords.push({
            word: dw,
            startSec: s.startSec + idx * wDur,
            endSec: s.startSec + (idx + 1) * wDur,
          });
        });
      }
      continue;
    }
    for (const w of s.words) {
      const cleaned = cleanLaoText(w.word);
      if (cleaned && cleaned.trim().length > 0) {
        allWords.push({ word: cleaned.trim(), startSec: w.startSec, endSec: w.endSec });
      }
    }
  }

  if (allWords.length === 0) return [];

  const cues: SubtitleCue[] = [];
  for (let i = 0; i < allWords.length; i++) {
    const curr = allWords[i];
    let startSec = curr.startSec;
    let endSec = curr.endSec;

    const next = i < allWords.length - 1 ? allWords[i + 1] : null;

    if (next && next.startSec > startSec) {
      const gap = next.startSec - endSec;
      if (gap > 0 && gap < 0.6) {
        endSec = next.startSec;
      } else if (gap <= 0) {
        endSec = next.startSec;
      }
    }

    if (endSec - startSec < 0.2) {
      endSec = startSec + 0.2;
    }

    if (next && next.startSec > startSec && endSec > next.startSec) {
      endSec = next.startSec;
    }

    if (endSec <= startSec) {
      endSec = startSec + 0.1;
    }

    cues.push({
      startSec,
      endSec,
      runs: [{ text: curr.word }],
    });
  }

  return sanitizeCues(cues);
}

/**
 * Fast-paced social media style karaoke cues:
 * Groups words into 1-2 word chunks per cue.
 */
function buildKaraokeCues(sentences: TranscribedSentence[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const chunkSize = 2;

  for (const s of sentences) {
    if (!s.words || s.words.length === 0) {
      if (s.text) {
        cues.push(...splitSentenceIntoCompactChunks(cleanLaoText(s.text), s.startSec, s.endSec));
      }
      continue;
    }

    for (let i = 0; i < s.words.length; i += chunkSize) {
      const chunk = s.words.slice(i, i + chunkSize);
      let chunkStart = chunk[0].startSec;
      let chunkEnd = chunk[chunk.length - 1].endSec;

      if (i + chunkSize < s.words.length) {
        const nextWord = s.words[i + chunkSize];
        if (nextWord.startSec > chunkStart && nextWord.startSec - chunkEnd < 0.35) {
          chunkEnd = nextWord.startSec;
        }
      }

      if (chunkEnd - chunkStart < 0.3) {
        chunkEnd = chunkStart + 0.3;
      }

      cues.push({
        startSec: chunkStart,
        endSec: chunkEnd,
        runs: chunk.map((w) => ({
          text: cleanLaoText(w.word),
          highlightAt: { startSec: w.startSec, endSec: w.endSec },
        })),
      });
    }
  }

  return sanitizeCues(cues);
}

