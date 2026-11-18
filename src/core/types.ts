/**
 * Shared types for the CapCut Lao Subtitler pipeline.
 * Times are always expressed in microseconds (CapCut's native unit)
 * unless a field is explicitly named *Seconds or *Ms.
 */

export type FontSize = "small" | "medium" | "large" | "xl";
export type TextColor = "white" | "yellow" | "neon_green" | "hot_pink" | "cyan";
export type SubtitlePosition = "bottom_center" | "center_screen" | "lower_center";
export type AnimationMode = "sentence" | "word_by_word" | "karaoke";
export type EntranceEffect = "pop_bounce" | "zoom_in" | "none";
export type BilingualMode = "off" | "lao_vietnamese" | "lao_english";
export type SpeechStyle = "polished" | "verbatim";
export type SaveMode = "copy" | "overwrite";
export type TranscriptionEngine = "gemini";

export interface SubtitleStyleConfig {
  fontSize: FontSize;
  textColor: TextColor;
  position: SubtitlePosition;
  strokeColor: string; // hex
  strokeWidth: number; // px, 0 = no stroke
  backgroundBanner: boolean;
  fontFamily: string; // e.g. "Noto Sans Lao"
  animationMode: AnimationMode;
  entranceEffect?: EntranceEffect;
  autoAccentKeywords?: boolean;
}

export interface TranscriptionConfig {
  engine: TranscriptionEngine;
  model: string; // model name for Gemini
  speechStyle: SpeechStyle;
  glossary: string; // free-text list of proper nouns / tech terms
  bilingualMode?: BilingualMode;
}

export interface TimelineConfig {
  linkSubtitleToClip: boolean;
  saveMode: SaveMode;
}

export interface PipelineConfig {
  projectDir: string;
  apiKey: string;
  subtitleStyle: SubtitleStyleConfig;
  transcription: TranscriptionConfig;
  timeline: TimelineConfig;
}

/** A single transcribed word with word-level timing, in seconds relative to audio. */
export interface TranscribedWord {
  word: string; // Lao script
  startSec: number;
  endSec: number;
}

export interface TranscribedSentence {
  text: string; // full Lao sentence
  startSec: number;
  endSec: number;
  words: TranscribedWord[];
}

export interface PipelineProgress {
  stage:
    | "extracting_audio"
    | "transcribing"
    | "building_subtitles"
    | "writing_draft"
    | "done"
    | "error";
  message: string;
  percent: number; // 0-100
}

export interface PipelineResult {
  ok: boolean;
  outputPath?: string;
  subtitlesGenerated?: number;
  verification?: SavedDraftVerification;
  srtContent?: string;
  error?: string;
}

export interface SavedDraftVerification {
  textTracks: number;
  textSegments: number;
  textMaterials: number;
  linkedTextSegments: number;
}

export interface ExtractedSubtitle {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  text: string;
}

export interface ExtractionResult {
  ok: boolean;
  count: number;
  subtitles: ExtractedSubtitle[];
  srtContent: string;
  txtContent: string;
  error?: string;
}

export interface ProjectValidationResult {
  ok: boolean;
  projectDir: string;
  draftContentPath: string;
  draftMetaPath: string;
  hasDraftContent: boolean;
  hasDraftMeta: boolean;
  durationSec: number;
  videoTracks: number;
  audioTracks: number;
  textTracks: number;
  videoSegments: number;
  audioSegments: number;
  textSegments: number;
  mediaMaterials: number;
  existingTextMaterials: number;
  missingMediaFiles: string[];
  warnings: string[];
  error?: string;
}

export interface RecentProject {
  name: string;
  path: string;
  modifiedMs: number;
}

export interface BackupRestoreResult {
  ok: boolean;
  restoredFrom?: string;
  error?: string;
}
