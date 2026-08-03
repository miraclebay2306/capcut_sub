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
};

const KARAOKE_CHUNK_LIMITS: Record<
  SubtitleStyleConfig["fontSize"],
  { maxWords: number; maxChars: number }
> = {
  small: { maxWords: 5, maxChars: 24 },
  medium: { maxWords: 4, maxChars: 20 },
  large: { maxWords: 3, maxChars: 16 },
  xl: { maxWords: 2, maxChars: 13 },
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
 * Removes unnecessary spaces between Lao characters/words while keeping spaces
 * between English words or numbers (e.g. "ການ ອັດສຽງ ຄັ້ງ" -> "ການອັດສຽງຄັ້ງ").
 */
export function cleanLaoText(text: any): string {
  if (text === null || text === undefined) return "";
  let cleaned = typeof text === "string" ? text : String(text);
  let prev = "";
  while (typeof cleaned === "string" && cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned.replace(/([\u0E80-\u0EFF])\s+([\u0E80-\u0EFF])/g, "$1$2");
  }
  return typeof cleaned === "string" ? cleaned.trim() : String(cleaned).trim();
}

/**
 * Joins an array of words/runs together intelligently.
 * Lao words placed consecutively will be joined without spaces.
 * English words or numbers will have spaces preserved/added as appropriate.
 */
export function joinLaoWords(words: any[]): string {
  if (!Array.isArray(words)) return "";
  const cleaned = words
    .map((w) => (w === null || w === undefined ? "" : String(w).trim()))
    .filter((w) => w.length > 0);
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

function splitSentenceIntoCompactChunks(
  text: string,
  startSec: number,
  endSec: number,
  maxChars = 50
): SubtitleCue[] {
  const words = splitTextIntoWords(text);
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

/**
 * Word-by-word captions: each cue shows only 1-2 short words so the text
 * appears truly incrementally — visually distinct from sentence mode.
 *
 * Uses both a word-count limit (maxWords = 2) AND a character-length limit
 * (maxChars = 10) so that even after Lao words are joined without spaces the
 * resulting cue stays short.
 */
function buildWordByWordCues(sentences: TranscribedSentence[]): SubtitleCue[] {
  const WBW_MAX_WORDS = 2;
  const WBW_MAX_CHARS = 10;

  let allWords: { word: string; startSec: number; endSec: number }[] = [];

  for (const s of sentences) {
    if (!s.words || s.words.length === 0) {
      if (s.text) {
        const dummyWords = splitTextIntoWords(s.text);
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

  allWords = splitMixedTimedWords(allWords);
  // Split any single token that already exceeds the char limit
  allWords = splitOverlongTimedWords(allWords, WBW_MAX_CHARS);
  if (allWords.length === 0) return [];

  // --- Character-aware chunking (like karaoke but without highlight runs) ---
  const chunks: { word: string; startSec: number; endSec: number }[][] = [];
  let currentChunk: { word: string; startSec: number; endSec: number }[] = [];

  for (const word of allWords) {
    const candidateText = joinLaoWords([...currentChunk.map((w) => w.word), word.word]);
    if (
      currentChunk.length > 0 &&
      (currentChunk.length >= WBW_MAX_WORDS || candidateText.length > WBW_MAX_CHARS)
    ) {
      chunks.push(currentChunk);
      currentChunk = [word];
    } else {
      currentChunk.push(word);
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  // Avoid a single-word orphan at the end by merging it into the previous chunk
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last.length === 1 && prev.length > 1) {
      last.unshift(prev.pop()!);
    }
  }

  // --- Build cues ---
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const nextChunk = i < chunks.length - 1 ? chunks[i + 1] : null;
    const startSec = chunk[0].startSec;
    let endSec = chunk[chunk.length - 1].endSec;

    // Extend to fill small gaps so there's no flicker between cues
    if (nextChunk && nextChunk[0].startSec > startSec) {
      const gap = nextChunk[0].startSec - endSec;
      if (gap >= 0 && gap < 0.6) {
        endSec = nextChunk[0].startSec;
      }
    }

    cues.push({
      startSec,
      endSec: Math.max(endSec, startSec + 0.25),
      runs: [{ text: joinLaoWords(chunk.map((w) => w.word)) }],
    });
  }

  return sanitizeCues(cues);
}

/** Full phrase stays visible while the spoken portion changes color progressively. */
function buildKaraokeCues(
  sentences: TranscribedSentence[],
  style: SubtitleStyleConfig
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const limits = KARAOKE_CHUNK_LIMITS[style.fontSize];

  for (const sentence of sentences) {
    let words: { word: string; startSec: number; endSec: number }[] = [];

    if (sentence.words && sentence.words.length > 0) {
      words = sentence.words
        .map((w) => ({
          word: cleanLaoText(w.word),
          startSec: w.startSec,
          endSec: w.endSec,
        }))
        .filter((w) => w.word.trim().length > 0);
    } else if (sentence.text) {
      const fallbackWords = splitTextIntoWords(sentence.text);
      const duration = Math.max(0.4, sentence.endSec - sentence.startSec);
      const wordDuration = duration / Math.max(1, fallbackWords.length);
      words = fallbackWords.map((word, index) => ({
        word,
        startSec: sentence.startSec + index * wordDuration,
        endSec: sentence.startSec + (index + 1) * wordDuration,
      }));
    }

    if (words.length === 0) continue;
    words = splitMixedTimedWords(words);
    words = splitOverlongTimedWords(words, limits.maxChars);

    const chunks: { word: string; startSec: number; endSec: number }[][] = [];
    let currentChunk: { word: string; startSec: number; endSec: number }[] = [];

    for (const word of words) {
      const candidateText = joinLaoWords([...currentChunk.map((w) => w.word), word.word]);
      if (
        currentChunk.length > 0 &&
        (currentChunk.length >= limits.maxWords || candidateText.length > limits.maxChars)
      ) {
        chunks.push(currentChunk);
        currentChunk = [word];
      } else {
        currentChunk.push(word);
      }
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const current = chunk[i];
        const next = i < chunk.length - 1 ? chunk[i + 1] : null;
        let endSec = current.endSec;

        if (next && next.startSec > current.startSec) {
          endSec = next.startSec;
        }
        if (endSec - current.startSec < 0.08) {
          endSec = current.startSec + 0.08;
        }

        cues.push({
          startSec: current.startSec,
          endSec,
          runs: chunk.map((w, runIndex) => ({
            text: w.word,
            highlighted: runIndex <= i,
          })),
        });
      }
    }
  }

  return sanitizeCues(cues);
}





