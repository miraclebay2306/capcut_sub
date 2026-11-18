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

const THAI_TO_LAO_MAP: Record<number, number> = {
  0x0E01: 0x0E81, 0x0E02: 0x0E82, 0x0E04: 0x0E84, 0x0E07: 0x0E87, 0x0E08: 0x0E88,
  0x0E0A: 0x0E8A, 0x0E0B: 0x0E8A, 0x0E0D: 0x0E8D, 0x0E14: 0x0E94, 0x0E15: 0x0E95,
  0x0E16: 0x0E96, 0x0E17: 0x0E97, 0x0E19: 0x0E99, 0x0E1A: 0x0E9A, 0x0E1B: 0x0E9B,
  0x0E1C: 0x0E9C, 0x0E1D: 0x0E9D, 0x0E1E: 0x0E9E, 0x0E1F: 0x0E9F, 0x0E21: 0x0EA1,
  0x0E22: 0x0EA2, 0x0E23: 0x0EA3, 0x0E25: 0x0EA5, 0x0E27: 0x0EA7, 0x0E2A: 0x0EAA,
  0x0E2B: 0x0EAB, 0x0E2D: 0x0EAD, 0x0E2E: 0x0EAE, 0x0E30: 0x0EB0, 0x0E31: 0x0EB1,
  0x0E32: 0x0EB2, 0x0E33: 0x0EB3, 0x0E34: 0x0EB4, 0x0E35: 0x0EB5, 0x0E36: 0x0EB6,
  0x0E37: 0x0EB7, 0x0E38: 0x0EB8, 0x0E39: 0x0EB9, 0x0E40: 0x0EC0, 0x0E41: 0x0EC1,
  0x0E42: 0x0EC2, 0x0E43: 0x0EC3, 0x0E44: 0x0EC4, 0x0E46: 0x0EC6, 0x0E48: 0x0EC8,
  0x0E49: 0x0EC9, 0x0E4A: 0x0ECA, 0x0E4B: 0x0ECB, 0x0E4C: 0x0ECC,
};

export function normalizeThaiToLaoUnicode(text: string): string {
  if (!text) return "";
  let res = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (THAI_TO_LAO_MAP[code]) {
      res += String.fromCharCode(THAI_TO_LAO_MAP[code]);
    } else {
      res += text[i];
    }
  }
  return res;
}

/**
 * Cleans and normalizes Lao text: converts accidental Thai unicode glyphs,
 * removes accidental spaces before tone marks or vowels, and fixes common spelling slips.
 */
export function cleanLaoText(text: any): string {
  if (text === null || text === undefined) return "";
  let cleaned = typeof text === "string" ? text : String(text);
  cleaned = normalizeThaiToLaoUnicode(cleaned);
  // Collapse multiple spaces/tabs into a single space
  cleaned = cleaned.replace(/[ \t]+/g, " ");
  // Remove accidental spaces before detached Lao vowels or tone marks
  cleaned = cleaned.replace(/\s+([\u0EB0-\u0EBD\u0EC8-\u0ECD])/g, "$1");
  // Fix common AI spelling slips
  cleaned = cleaned
    .replace(/(^|\s)ບໍ(\s|$)/g, "$1ບໍ່$2")
    .replace(/(^|\s)ແນ່ນແລ້ວ(\s|$)/g, "$1ແມ່ນແລ້ວ$2")
    .replace(/(^|\s)ແນ່ນບໍ(\s|$)/g, "$1ແມ່ນບໍ່$2")
    .replace(/(^|\s)ເຈົາ(\s|$)/g, "$1ເຈົ້າ$2")
    .replace(/(^|\s)ຂອບໄຈ(\s|$)/g, "$1ຂອບໃຈ$2")
    .replace(/ໂປໂມຊັນ/g, "ໂປຣໂມຊັ່ນ")
    .replace(/ໂປໂມຊັ່ນ/g, "ໂປຣໂມຊັ່ນ");
  return cleaned.trim();
}

/**
 * Joins tokens naturally according to native Lao orthography:
 * Adjacent Lao words inside the same phrase have NO space between them.
 * Spaces are only inserted between Lao and English/numbers, or between English words.
 */
export function joinLaoWordsSmart(tokens: string[]): string {
  if (!tokens || tokens.length === 0) return "";
  const isLaoChar = (ch: string) => /[\u0E80-\u0EFF]/.test(ch);

  let result = "";
  for (const rawToken of tokens) {
    const token = cleanLaoText(rawToken);
    if (!token) continue;
    if (result.length === 0) {
      result = token;
      continue;
    }
    const lastChar = result[result.length - 1];
    const firstChar = token[0];

    // If both adjacent characters are Lao: join without space!
    if (isLaoChar(lastChar) && isLaoChar(firstChar)) {
      result += token;
    } else {
      // Between Lao and English/Numbers or English and English: insert single space
      result += " " + token;
    }
  }
  return result;
}

/**
 * Backward compatibility wrapper for joinLaoWords
 */
export function joinLaoWords(words: any[]): string {
  if (!Array.isArray(words)) return "";
  return joinLaoWordsSmart(words.map((w) => String(w || "")));
}

export const LAO_COMPOUND_PAIRS: [string, string, string][] = [
  ["ອຸປະ", "ກອນ", "ອຸປະກອນ"],
  ["ໂປ", "ໂມຊັ່ນ", "ໂປຣໂມຊັ່ນ"],
  ["ໂປໂມ", "ຊັ່ນ", "ໂປຣໂມຊັ່ນ"],
  ["ໂປຣ", "ໂມຊັ່ນ", "ໂປຣໂມຊັ່ນ"],
  ["ໂປຣໂມ", "ຊັ່ນ", "ໂປຣໂມຊັ່ນ"],
  ["ແນະ", "ນຳ", "ແນະນຳ"],
  ["ລະ", "ບົບ", "ລະບົບ"],
  ["ຮອງ", "ຮັບ", "ຮອງຮັບ"],
  ["ໂທລະ", "ສັບ", "ໂທລະສັບ"],
  ["ຕິດ", "ຕັ້ງ", "ຕິດຕັ້ງ"],
  ["ຕິດ", "ຕໍ່", "ຕິດຕໍ່"],
  ["ຕິດ", "ຕາມ", "ຕິດຕາມ"],
  ["ດາວ", "ໂຫຼດ", "ດາວໂຫຼດ"],
  ["ອັບ", "ເດດ", "ອັບເດດ"],
  ["ອອນ", "ລາຍ", "ອອນລາຍ"],
  ["ຄອມ", "ພິວເຕີ", "ຄອມພິວເຕີ"],
  ["ສະ", "ບາຍດີ", "ສະບາຍດີ"],
  ["ສະບາຍ", "ດີ", "ສະບາຍດີ"],
  ["ຂອບ", "ໃຈ", "ຂອບໃຈ"],
  ["ລູກ", "ຄ້າ", "ລູກຄ້າ"],
  ["ພົວ", "ພັນ", "ພົວພັນ"],
  ["ພັດ", "ທະນາ", "ພັດທະນາ"],
  ["ບໍ", "ລິການ", "ບໍລິການ"],
  ["ບໍລິ", "ການ", "ບໍລິການ"],
  ["ໂຄ", "ສະນາ", "ໂຄສະນາ"],
  ["ຕະ", "ຫຼາດ", "ຕະຫຼາດ"],
  ["ຊອບ", "ແວ", "ຊອບແວ"],
  ["ຟັງ", "ຊັ່ນ", "ຟັງຊັ່ນ"],
  ["ວິດີ", "ໂອ", "ວິດີໂອ"],
  ["ວິ", "ດີໂອ", "ວິດີໂອ"],
  ["ຮູບ", "ພາບ", "ຮູບພາບ"],
  ["ຂໍ້", "ມູນ", "ຂໍ້ມູນ"],
  ["ຂໍ້", "ຄວາມ", "ຂໍ້ຄວາມ"],
  ["ຊັບ", "ໄຕເຕີ້ນ", "ຊັບໄຕເຕີ້ນ"],
  ["ຊັບ", "ໄຕເຕິລ", "ຊັບໄຕເຕີ້ນ"],
  ["ໂປ", "ແກຣມ", "ໂປຣແກຣມ"],
  ["ໂປຣ", "ແກຣມ", "ໂປຣແກຣມ"],
  ["ເວັບ", "ໄຊ", "ເວັບໄຊ"],
  ["ເວັບ", "ໄຊທ໌", "ເວັບໄຊ"],
  ["ອັດ", "ຕະໂນມັດ", "ອັດຕະໂນມັດ"],
  ["ອັດຕະ", "ໂນມັດ", "ອັດຕະໂນມັດ"],
  ["ປະ", "ໂຫຍກ", "ປະໂຫຍກ"],
  ["ທຸ", "ລະກິດ", "ທຸລະກິດ"],
  ["ທຸລະ", "ກິດ", "ທຸລະກິດ"],
  ["ລາຍ", "ລະອຽດ", "ລາຍລະອຽດ"],
  ["ງ່າຍ", "ດາຍ", "ງ່າຍດາຍ"],
  ["ສະ", "ດວກ", "ສະດວກ"],
  ["ວ່ອງ", "ໄວ", "ວ່ອງໄວ"],
  ["ທຸກ", "ອຸປະກອນ", "ທຸກອຸປະກອນ"],
  ["ຖື", "ວ່າ", "ຖືວ່າ"],
  ["ຖືວ່າ", "ເປັນ", "ຖືວ່າເປັນ"],
  ["ເປັນ", "ການ", "ເປັນການ"],
  ["ໂດຍ", "ສະເພາະ", "ໂດຍສະເພາະ"],
  ["ຍິນ", "ດີ", "ຍິນດີ"],
  ["ຍິນດີ", "ຕ້ອນຮັບ", "ຍິນດີຕ້ອນຮັບ"],
];

const LAO_PREFIXES = ["ການ", "ຄວາມ", "ຜູ້", "ບໍ່", "ທີ່", "ໄດ້", "ຈະ", "ເປັນການ", "ຖືວ່າເປັນ"];

export function isHangingLaoPrefix(text: string): boolean {
  const t = cleanLaoText(text);
  return LAO_PREFIXES.includes(t) || ["ຖືວ່າ", "ໃນ", "ສຳລັບ"].includes(t);
}

/**
 * Glues detached codas, syllables, and known compound words back into single cohesive tokens.
 * Specifically fixes:
 *  - 'ກາ' + 'ນຮັກ' -> 'ການຮັກ'
 *  - 'ອຸປະ' + 'ກອນ' -> 'ອຸປະກອນ'
 *  - 'ໂປໂມ' + 'ຊັ່ນ' -> 'ໂປຣໂມຊັ່ນ'
 *  - 'ການ' + 'ຮັກ' -> 'ການຮັກ'
 *  - Single coda consonants: 'ກາ' + 'ນ' -> 'ການ'
 */
export function stitchLaoWordsAndTokens(
  words: { word: string; startSec: number; endSec: number }[]
): { word: string; startSec: number; endSec: number }[] {
  if (!words || words.length === 0) return [];
  const valid = words
    .map((w) => ({
      word: cleanLaoText(w.word),
      startSec: w.startSec,
      endSec: w.endSec,
    }))
    .filter((w) => w.word.length > 0);

  if (valid.length === 0) return [];

  const merged: { word: string; startSec: number; endSec: number }[] = [];

  for (let i = 0; i < valid.length; i++) {
    const curr = { ...valid[i] };
    if (merged.length === 0) {
      merged.push(curr);
      continue;
    }

    const prev = merged[merged.length - 1];

    // Check Case 1: Floating vowel/tone mark
    if (/^[\u0EB0-\u0EBD\u0EC8-\u0ECD]/.test(curr.word)) {
      prev.word = cleanLaoText(prev.word + curr.word);
      prev.endSec = Math.max(prev.endSec, curr.endSec);
      continue;
    }

    // Check Case 2: Floating leading vowel
    if (/^[\u0EC0-\u0EC4]$/.test(prev.word)) {
      prev.word = cleanLaoText(prev.word + curr.word);
      prev.endSec = Math.max(prev.endSec, curr.endSec);
      continue;
    }

    // Check Case 3: Detached single coda consonant: [ງນຍດບມວກສຕ]
    if (/^[ງນຍດບມວກສຕ]$/.test(curr.word) && /[າິີຶືຸູະັຽຳ]/.test(prev.word[prev.word.length - 1])) {
      prev.word = cleanLaoText(prev.word + curr.word);
      prev.endSec = Math.max(prev.endSec, curr.endSec);
      continue;
    }

    // Check Case 4: Coda attached to next syllable (e.g. prev="ກາ", curr="ນຮັກ" -> "ການຮັກ")
    if (/[າິີຶືຸູະັຽຳ]$/.test(prev.word) && /^[ງນຍດບມວ][ຮນມຄພຕຈສກຂປຝ]/.test(curr.word)) {
      prev.word = cleanLaoText(prev.word + curr.word);
      prev.endSec = Math.max(prev.endSec, curr.endSec);
      continue;
    }

    // Check Case 5: Known compound pairs
    let matchedCompound = false;
    for (const [p1, p2, target] of LAO_COMPOUND_PAIRS) {
      if (prev.word === p1 && curr.word === p2) {
        prev.word = target;
        prev.endSec = Math.max(prev.endSec, curr.endSec);
        matchedCompound = true;
        break;
      }
    }
    if (matchedCompound) continue;

    // Check Case 6: Bound grammatical prefixes (ການ, ຄວາມ, ຜູ້, ບໍ່, ທີ່)
    if (
      (prev.word === "ການ" || prev.word === "ຄວາມ" || prev.word === "ຜູ້" || prev.word === "ບໍ່" || prev.word === "ທີ່") &&
      /[\u0E80-\u0EFF]/.test(curr.word) &&
      curr.word.length <= 8
    ) {
      prev.word = cleanLaoText(prev.word + curr.word);
      prev.endSec = Math.max(prev.endSec, curr.endSec);
      continue;
    }

    merged.push(curr);
  }

  return merged;
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
  const cues: SubtitleCue[] = [];
  for (const s of sentences) {
    const rawText = (s.text || "").trim();
    if (!rawText) continue;

    // Split lines in case of bilingual (Lao \n Translation)
    const lines = rawText.split("\n");
    const laoLine = cleanLaoText(lines[0] || "");
    const translationLine = lines[1] ? lines[1].trim() : "";

    // If within safe line length (<= 42 chars) or bilingual, display full sentence
    if (laoLine.length <= 42 || translationLine || !s.words || s.words.length === 0) {
      const fullText = translationLine ? `${laoLine}\n${translationLine}` : laoLine;
      cues.push({
        startSec: s.startSec,
        endSec: s.endSec,
        runs: [{ text: fullText }],
      });
    } else {
      // Very long monolingual sentence (> 42 chars): use stitched words with generous sentence boundary (~38 chars)
      const validWords = s.words
        .map((w) => ({
          word: cleanLaoText(w.word),
          startSec: w.startSec,
          endSec: w.endSec,
        }))
        .filter((w) => w.word.length > 0);

      if (validWords.length > 0) {
        cues.push(...buildCuesFromWords(validWords, 38));
      } else {
        cues.push(...splitSentenceTextByPhrases(laoLine, s.startSec, s.endSec, 38));
      }
    }
  }

  // Extend endSec of each cue to fill small gaps (< 0.4s) to eliminate subtitle flicker
  for (let i = 0; i < cues.length - 1; i++) {
    const nextStart = cues[i + 1].startSec;
    if (nextStart > cues[i].startSec) {
      const gap = nextStart - cues[i].endSec;
      if (gap >= 0 && gap < 0.4) {
        cues[i].endSec = nextStart;
      }
    }
  }

  return sanitizeCues(cues);
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
  rawWords: { word: string; startSec: number; endSec: number }[],
  targetMaxChars: number
): SubtitleCue[] {
  // 1. Stitch words so no fragmented codas, prefixes or broken compounds exist
  const words = stitchLaoWordsAndTokens(rawWords);
  if (words.length === 0) return [];

  const cues: SubtitleCue[] = [];
  let currentChunk: { word: string; startSec: number; endSec: number }[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (currentChunk.length === 0) {
      currentChunk.push(w);
      continue;
    }

    const prevWord = currentChunk[currentChunk.length - 1];
    const acousticGap = w.startSec - prevWord.endSec;
    const candidateWords = [...currentChunk, w];
    const candidateText = joinLaoWordsSmart(candidateWords.map((cw) => cw.word));

    // Natural breaks:
    // 1) Acoustic breath pause (> 0.35s)
    const isAcousticPause = acousticGap > 0.35;
    // 2) Character limit exceeded
    const exceedsCharLimit = candidateText.length > targetMaxChars;

    if (isAcousticPause || exceedsCharLimit) {
      let hangingPrefix: { word: string; startSec: number; endSec: number } | null = null;
      if (currentChunk.length > 1 && isHangingLaoPrefix(prevWord.word)) {
        hangingPrefix = currentChunk.pop()!;
      }

      cues.push({
        startSec: currentChunk[0].startSec,
        endSec: currentChunk[currentChunk.length - 1].endSec,
        runs: [{ text: joinLaoWordsSmart(currentChunk.map((cw) => cw.word)) }],
      });

      currentChunk = hangingPrefix ? [hangingPrefix, w] : [w];
    } else {
      currentChunk.push(w);
    }
  }

  if (currentChunk.length > 0) {
    cues.push({
      startSec: currentChunk[0].startSec,
      endSec: currentChunk[currentChunk.length - 1].endSec,
      runs: [{ text: joinLaoWordsSmart(currentChunk.map((cw) => cw.word)) }],
    });
  }

  // Extend endSec of each cue to fill small gaps (< 0.4s) to eliminate subtitle flicker
  for (let i = 0; i < cues.length - 1; i++) {
    const nextStart = cues[i + 1].startSec;
    if (nextStart > cues[i].startSec) {
      const gap = nextStart - cues[i].endSec;
      if (gap >= 0 && gap < 0.4) {
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

  for (const w of words) {
    const candidate = joinLaoWordsSmart([...currentChunk, w]);
    if (currentChunk.length > 0 && candidate.length > targetMaxChars) {
      let hangingPrefix = "";
      if (currentChunk.length > 1 && isHangingLaoPrefix(currentChunk[currentChunk.length - 1])) {
        hangingPrefix = currentChunk.pop()!;
      }
      chunks.push(joinLaoWordsSmart(currentChunk));
      currentChunk = hangingPrefix ? [hangingPrefix, w] : [w];
    } else {
      currentChunk.push(w);
    }
  }
  if (currentChunk.length > 0) {
    chunks.push(joinLaoWordsSmart(currentChunk));
  }

  const totalDur = Math.max(0.4, endSec - startSec);
  const chunkDur = totalDur / chunks.length;

  return chunks.map((chunk, idx) => ({
    startSec: startSec + idx * chunkDur,
    endSec: idx === chunks.length - 1 ? endSec : startSec + (idx + 1) * chunkDur,
    runs: [{ text: chunk }],
  }));
}





