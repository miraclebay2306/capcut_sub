/**
 * Shared types for the CapCut Lao Subtitler pipeline.
 * Times are always expressed in microseconds (CapCut's native unit)
 * unless a field is explicitly named *Seconds or *Ms.
 */

export type FontSize = "small" | "medium" | "large" | "xl";
export type TextColor = "white" | "yellow" | "neon_green";
export type SubtitlePosition = "bottom_center" | "center_screen" | "lower_center";
export type AnimationMode = "sentence" | "word_by_word";
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
}

export interface TranscriptionConfig {
  engine: TranscriptionEngine;
  model: string; // model name for Gemini
  speechStyle: SpeechStyle;
  glossary: string; // free-text list of proper nouns / tech terms
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
  error?: string;
}
