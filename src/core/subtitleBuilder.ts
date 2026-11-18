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
  runs: { text: string; highlighted?: boolean }[];
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
  hot_pink: "#FF2A85FF",
  cyan: "#00F0FFFF",
};

const KARAOKE_CHUNK_LIMITS: Record<
  SubtitleStyleConfig["fontSize"],
  { maxWords: number; maxChars: number }
> = {
  small: { maxWords: 5, maxChars: 22 },
  medium: { maxWords: 4, maxChars: 18 },
  large: { maxWords: 3, maxChars: 15 },
  xl: { maxWords: 2, maxChars: 12 },
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
    case "karaoke":
      rawCues = buildKaraokeCues(sentences, style);
      break;
    case "word_by_word":
      rawCues = buildWordByWordCues(sentences);
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
 * Cleans and normalizes Lao text while strictly preserving legitimate spaces
 * between phrases, clauses, and English/number words.
 */
export function cleanLaoText(text: any): string {
  if (text === null || text === undefined) return "";
  let cleaned = typeof text === "string" ? text : String(text);
  // Collapse multiple spaces/tabs into a single space
  cleaned = cleaned.replace(/[ \t]+/g, " ");
  // Remove accidental spaces before detached Lao vowels or tone marks
  cleaned = cleaned.replace(/\s+([\u0EB0-\u0EBD\u0EC8-\u0ECD])/g, "$1");
  return cleaned.trim();
}

/**
 * Joins an array of words/runs together into natural spoken Lao subtitles.
 */
export function joinLaoWords(words: any[]): string {
  if (!Array.isArray(words)) return "";
  const cleaned = words
    .map((w) => (w === null || w === undefined ? "" : String(w).trim()))
    .filter((w) => w.length > 0);
  if (cleaned.length === 0) return "";
  return cleanLaoText(cleaned.join(" "));
}

function splitTextIntoWords(text: any): string[] {
  if (text === null || text === undefined) return [];
  const normalized = cleanLaoText(String(text));
  const tokens = normalized
    .split(/\s+/)
    .flatMap((word) => tokenizeMixedText(word))
    .filter((word) => word.trim().length > 0);
  return tokens.length > 0 ? tokens : [cleanLaoText(text)].filter(Boolean);
}

function tokenizeMixedText(text: any): string[] {
  const cleaned = cleanLaoText(text);
  if (!cleaned) return [];

  const tokenPattern = /[\u0E80-\u0EFF]+|\d+(?:[.,:/-]\d+)*|[A-Za-z]+(?:['-][A-Za-z]+)*/g;
  const matches = cleaned.match(tokenPattern);
  return matches && matches.length > 0 ? matches : [cleaned];
}

function splitMixedTimedWords(
  words: { word: string; startSec: number; endSec: number }[]
): { word: string; startSec: number; endSec: number }[] {
  const result: { word: string; startSec: number; endSec: number }[] = [];

  for (const word of words) {
    const parts = tokenizeMixedText(word.word);
    if (parts.length <= 1) {
      const cleaned = cleanLaoText(word.word);
      if (cleaned) result.push({ ...word, word: cleaned });
      continue;
    }

    const duration = Math.max(0.08, word.endSec - word.startSec);
    const totalChars = Math.max(1, parts.reduce((sum, part) => sum + part.length, 0));
    let cursorSec = word.startSec;

    for (let i = 0; i < parts.length; i++) {
      const partDuration =
        i === parts.length - 1
          ? word.endSec - cursorSec
          : duration * (parts[i].length / totalChars);
      const endSec = i === parts.length - 1 ? word.endSec : cursorSec + partDuration;
      result.push({
        word: parts[i],
        startSec: cursorSec,
        endSec: Math.max(endSec, cursorSec + 0.06),
      });
      cursorSec = endSec;
    }
  }

  return mergeDetachedLaoMarks(result);
}

function isDetachedLaoPrefix(text: string): boolean {
  return /^[\u0EC0-\u0EC4]+$/.test(text);
}

function isDetachedLaoSuffixOrMark(text: string): boolean {
  return /^[\u0EB0-\u0EBD\u0EC8-\u0ECD]+$/.test(text);
}

function mergeDetachedLaoMarks(
  words: { word: string; startSec: number; endSec: number }[]
): { word: string; startSec: number; endSec: number }[] {
  const merged: { word: string; startSec: number; endSec: number }[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const cleaned = cleanLaoText(word.word);
    if (!cleaned) continue;

    if (isDetachedLaoPrefix(cleaned)) {
      const next = words[i + 1];
      if (next && /[\u0E80-\u0EFF]/.test(next.word)) {
        next.word = cleanLaoText(cleaned + next.word);
        next.startSec = Math.min(word.startSec, next.startSec);
        continue;
      }
    }

    if (isDetachedLaoSuffixOrMark(cleaned) && merged.length > 0) {
      const previous = merged[merged.length - 1];
      if (/[\u0E80-\u0EFF]/.test(previous.word)) {
        previous.word = cleanLaoText(previous.word + cleaned);
        previous.endSec = Math.max(previous.endSec, word.endSec);
        continue;
      }
    }

    merged.push({ ...word, word: cleaned });
  }

  return merged;
}

function chunkTimedWords(
  words: { word: string; startSec: number; endSec: number }[],
  maxWords = 3
): { word: string; startSec: number; endSec: number }[][] {
  const chunks: { word: string; startSec: number; endSec: number }[][] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords));
  }

  const last = chunks[chunks.length - 1];
  const previous = chunks[chunks.length - 2];
  if (last && previous && last.length === 1 && previous.length > 2) {
    last.unshift(previous.pop()!);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function splitOverlongTimedWords(
  words: { word: string; startSec: number; endSec: number }[],
  maxChars: number
): { word: string; startSec: number; endSec: number }[] {
  const result: { word: string; startSec: number; endSec: number }[] = [];

  for (const word of words) {
    if (word.word.length <= maxChars || maxChars <= 1) {
      result.push(word);
      continue;
    }

    const parts: string[] = [];
    for (let i = 0; i < word.word.length; i += maxChars) {
      parts.push(word.word.slice(i, i + maxChars));
    }

    const duration = Math.max(0.08, word.endSec - word.startSec);
    const totalChars = Math.max(1, word.word.length);
    let cursorSec = word.startSec;

    for (let i = 0; i < parts.length; i++) {
      const partDuration =
        i === parts.length - 1
          ? word.endSec - cursorSec
          : duration * (parts[i].length / totalChars);
      const endSec = i === parts.length - 1 ? word.endSec : cursorSec + partDuration;
      result.push({
        word: parts[i],
        startSec: cursorSec,
        endSec: Math.max(endSec, cursorSec + 0.08),
      });
      cursorSec = endSec;
    }
  }

  return result;
}

// TikTok / Reels 9:16 safe line limit: 22 chars prevents text from running into right-side like/comment buttons
const TIKTOK_SAFE_MAX_CHARS = 22;

function splitSentenceIntoCompactChunks(
  text: string,
  startSec: number,
  endSec: number,
  maxChars = TIKTOK_SAFE_MAX_CHARS
): SubtitleCue[] {
  const rawWords = splitTextIntoWords(text);
  if (rawWords.length === 0) return [];

  // If a Lao phrase has no spaces and exceeds maxChars, split safely without breaking tone marks
  const words: string[] = [];
  for (const rw of rawWords) {
    if (rw.length > maxChars) {
      let cursor = 0;
      while (cursor < rw.length) {
        let take = Math.min(maxChars, rw.length - cursor);
        while (cursor + take < rw.length && isDetachedLaoSuffixOrMark(rw[cursor + take])) {
          take++;
        }
        words.push(rw.slice(cursor, cursor + take));
        cursor += take;
      }
    } else {
      words.push(rw);
    }
  }

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
  return buildCuesWithLimits(sentences, 34);
}

function buildWordByWordCues(sentences: TranscribedSentence[]): SubtitleCue[] {
  return buildCuesWithLimits(sentences, 22);
}

function buildKaraokeCues(
  sentences: TranscribedSentence[],
  _style: SubtitleStyleConfig
): SubtitleCue[] {
  return buildCuesWithLimits(sentences, 24);
}

function buildCuesWithLimits(
  sentences: TranscribedSentence[],
  targetMaxChars: number
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];

  for (const s of sentences) {
    if (!s.words || s.words.length === 0) {
      if (s.text) {
        cues.push(...splitSentenceTextByPhrases(cleanLaoText(s.text), s.startSec, s.endSec, targetMaxChars));
      }
      continue;
    }

    const validWords = s.words
      .map((w) => ({
        word: cleanLaoText(w.word),
        startSec: w.startSec,
        endSec: w.endSec,
      }))
      .filter((w) => w.word.length > 0);

    if (validWords.length === 0) {
      if (s.text) {
        cues.push(...splitSentenceTextByPhrases(cleanLaoText(s.text), s.startSec, s.endSec, targetMaxChars));
      }
      continue;
    }

    cues.push(...buildCuesFromWords(validWords, targetMaxChars));
  }

  return sanitizeCues(cues);
}

function buildCuesFromWords(
  words: { word: string; startSec: number; endSec: number }[],
  targetMaxChars: number
): SubtitleCue[] {
  if (words.length === 0) return [];
  const cues: SubtitleCue[] = [];
  let currentChunk: { word: string; startSec: number; endSec: number }[] = [];
  let currentLen = 0;

  for (const w of words) {
    const wText = w.word;
    const addLen = currentChunk.length === 0 ? wText.length : wText.length + 1;

    // Break ONLY at whole word boundary: NEVER slice a word in half
    if (currentChunk.length > 0 && (currentLen + addLen > targetMaxChars || currentChunk.length >= 5)) {
      cues.push({
        startSec: currentChunk[0].startSec,
        endSec: currentChunk[currentChunk.length - 1].endSec,
        runs: [{ text: currentChunk.map((cw) => cw.word).join(" ") }],
      });
      currentChunk = [w];
      currentLen = wText.length;
    } else {
      currentChunk.push(w);
      currentLen += addLen;
    }
  }

  if (currentChunk.length > 0) {
    cues.push({
      startSec: currentChunk[0].startSec,
      endSec: currentChunk[currentChunk.length - 1].endSec,
      runs: [{ text: currentChunk.map((cw) => cw.word).join(" ") }],
    });
  }

  // Extend endSec of each cue to fill small gaps (< 0.5s) to eliminate subtitle flicker
  for (let i = 0; i < cues.length - 1; i++) {
    const nextStart = cues[i + 1].startSec;
    if (nextStart > cues[i].startSec) {
      const gap = nextStart - cues[i].endSec;
      if (gap >= 0 && gap < 0.5) {
        cues[i].endSec = nextStart;
      }
    }
  }

  return cues;
}

function splitSentenceTextByPhrases(
  text: string,
  startSec: number,
  endSec: number,
  targetMaxChars: number
): SubtitleCue[] {
  const cleaned = cleanLaoText(text);
  if (!cleaned) return [];
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentLen = 0;

  for (const w of words) {
    const addLen = currentChunk.length === 0 ? w.length : w.length + 1;
    if (currentChunk.length > 0 && (currentLen + addLen > targetMaxChars || currentChunk.length >= 5)) {
      chunks.push(currentChunk.join(" "));
      currentChunk = [w];
      currentLen = w.length;
    } else {
      currentChunk.push(w);
      currentLen += addLen;
    }
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(" "));
  }

  const totalDur = Math.max(0.4, endSec - startSec);
  const chunkDur = totalDur / chunks.length;

  return chunks.map((chunk, idx) => ({
    startSec: startSec + idx * chunkDur,
    endSec: idx === chunks.length - 1 ? endSec : startSec + (idx + 1) * chunkDur,
    runs: [{ text: chunk }],
  }));
}





