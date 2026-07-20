import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { PipelineConfig, SubtitlePosition } from "./types";
import {
  SubtitleCue,
  resolveFontSizePx,
  resolveTextColorHex,
  cleanLaoText,
  joinLaoWords,
} from "./subtitleBuilder";

const ALL_TIME_UNIT_US = 1_000_000; // CapCut timerange values are in microseconds

/** CapCut/JianYing text-style `range` values are UTF-16 LE byte offsets, NOT UTF-8 byte
 *  offsets. JS strings are already UTF-16 internally, so `.length` is the UTF-16 *code unit*
 *  count — multiply by 2 to get the byte offset CapCut expects. Lao characters (U+0E80-U+0EFF)
 *  sit in the BMP (1 code unit = 2 bytes), so using UTF-8 byte length (3 bytes/char) here was
 *  producing wrong ranges and misaligned/ignored per-word styling. */
function utf16LEByteLen(s: string): number {
  return s.length * 2;
}

function buildUtf16RunRanges(
  runs: { text: string }[]
): { combinedText: string; ranges: { startByte: number; endByte: number }[] } {
  const isLao = (str: string) => /[\u0E80-\u0EFF]/.test(str);
  const ranges: { startByte: number; endByte: number }[] = [];

  let combinedText = "";
  let currentByteOffset = 0;

  for (let i = 0; i < runs.length; i++) {
    const rawText = cleanLaoText(runs[i].text);
    if (!rawText) continue;

    let prefix = "";
    if (i > 0 && combinedText.length > 0) {
      const prevChar = combinedText[combinedText.length - 1];
      if (isLao(prevChar) && isLao(rawText[0])) {
        prefix = "";
      } else {
        prefix = " ";
      }
    }

    combinedText += prefix;
    currentByteOffset += utf16LEByteLen(prefix);

    const startByte = currentByteOffset;
    combinedText += rawText;
    const runBytes = utf16LEByteLen(rawText);
    const endByte = startByte + runBytes;

    ranges.push({ startByte, endByte });
    currentByteOffset = endByte;
  }

  return { combinedText: cleanLaoText(combinedText), ranges };
}

export interface LoadedDraft {
  path: string;
  json: any;
  backupPath: string;
}

/** Loads draft_content.json and writes a timestamped .bak copy for safety. */
export function loadDraft(projectDir: string): LoadedDraft {
  const draftPath = path.join(projectDir, "draft_content.json");
  if (!fs.existsSync(draftPath)) {
    throw new Error(
      `draft_content.json not found in "${projectDir}". Point the directory picker at the CapCut project folder itself, not a parent folder.`
    );
  }

  const raw = fs.readFileSync(draftPath, "utf8");
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`draft_content.json is not valid JSON: ${(e as Error).message}`);
  }

  validateSchemaAssumptions(json);

  const backupPath = path.join(
    projectDir,
    `draft_content.backup.${Date.now()}.json`
  );
  fs.writeFileSync(backupPath, raw, "utf8");

  return { path: draftPath, json, backupPath };
}

/** Fails loudly and early if the project doesn't look like the schema this module expects. */
function validateSchemaAssumptions(json: any): void {
  const missing: string[] = [];
  if (!Array.isArray(json?.tracks)) missing.push("tracks[]");
  if (typeof json?.duration !== "number") missing.push("duration");
  if (!json?.materials || typeof json.materials !== "object") missing.push("materials{}");

  if (missing.length > 0) {
    throw new Error(
      `draft_content.json does not match the expected CapCut schema (missing: ${missing.join(
        ", "
      )}).`
    );
  }
}

function findTracksByType(json: any, type: "video" | "audio" | "text"): any[] {
  return (json.tracks ?? []).filter((t: any) => t.type === type);
}

function toRgbaHex(hex: string): string {
  if (!hex) return "#FFFFFFFF";
  let clean = hex.replace("#", "");
  if (clean.length === 6) clean += "FF";
  return `#${clean.toUpperCase()}`;
}

function hexToRgbFloat(hex: string): [number, number, number] {
  let clean = hex.replace("#", "");
  // Support 8-digit RRGGBBAA hex — strip the alpha suffix
  if (clean.length === 8) clean = clean.slice(0, 6);
  const num = parseInt(clean, 16);
  if (isNaN(num)) return [1.0, 1.0, 1.0];
  const r = Number((((num >> 16) & 255) / 255).toFixed(4));
  const g = Number((((num >> 8) & 255) / 255).toFixed(4));
  const b = Number(((num & 255) / 255).toFixed(4));
  return [r, g, b];
}

/** CapCut's real text-style fill schema nests the RGB solid color three levels deep
 *  (fill.content.solid.color). The previous `{ alpha, color }` shape put color where
 *  CapCut's parser never looks, so it silently fell back to default white for every
 *  animation mode — this was the root cause of "color is always white no matter what
 *  I send". */
function buildFill(rgb: [number, number, number], alpha = 1.0): any {
  return {
    alpha,
    content: {
      render_type: "solid",
      solid: { alpha, color: rgb },
    },
  };
}

function strokeWidthToCapCut(strokeWidth: number): number {
  if (!strokeWidth || strokeWidth <= 0) return 0;
  return strokeWidth >= 1 ? Number((strokeWidth * 0.02).toFixed(3)) : strokeWidth;
}

/**
 * Inserts a new text track containing the generated Lao subtitle cues, styled
 * per SubtitleStyleConfig, as native editable CapCut text segments/materials.
 * If `linkToClip` is set, each subtitle segment's extra_material_refs will
 * reference the id of the video segment it temporally overlaps, which is how
 * CapCut groups clips so they move together in the editor.
 */
function resolveTransform(position: SubtitlePosition): { x: number; y: number } {
  switch (position) {
    case "center_screen":
      return { x: 0.0, y: 0.0 };
    case "lower_center":
      return { x: 0.0, y: -0.35 };
    case "bottom_center":
    default:
      return { x: 0.0, y: -0.75 };
  }
}

const LAO_FONT_FILE_PATH = "C:/Users/SPCOM14400FF/AppData/Local/Microsoft/Windows/Fonts/NotoSansLao-VariableFont_wdth,wght.ttf";
function resolveFontInfo(fontFamilyOrPath?: string): { fontName: string; fontPath: string } {
  const defaultFontName = "Noto Sans Lao Regular";
  const defaultFontPath = LAO_FONT_FILE_PATH;

  let fontName = defaultFontName;
  let fontPath = defaultFontPath;

  if (fontFamilyOrPath) {
    if (fontFamilyOrPath.endsWith(".ttf") || fontFamilyOrPath.endsWith(".otf") || fontFamilyOrPath.includes("/") || fontFamilyOrPath.includes("\\")) {
      fontPath = fontFamilyOrPath;
      fontName = "Noto Sans Lao Regular";
    } else {
      fontName = fontFamilyOrPath;
    }
  }

  return { fontName, fontPath };
}

function ensureFontMaterial(json: any, fontName: string, fontPath: string): string {
  json.materials = json.materials ?? {};
  json.materials.fonts = json.materials.fonts ?? [];

  let fontMat = json.materials.fonts.find(
    (f: any) => f.name === fontName || f.title === fontName
  );

  if (!fontMat) {
    const fontId = randomUUID();
    fontMat = {
      id: fontId,
      name: fontName,
      path: fontPath,
      resource_id: "",
      title: fontName,
      type: "font",
    };
    json.materials.fonts.push(fontMat);
  } else if (fontPath && fontMat.path !== fontPath) {
    fontMat.path = fontPath;
  }

  return fontMat.id;
}

function buildTextMaterialFields(
  fontId: string,
  fontName: string,
  fontPath: string,
  fontSizePx: number,
  colorHex: string,
  strokeColorHex: string,
  strokeWidthVal: number,
  backgroundEnabled: boolean
): any {
  return {
    font_id: fontId,
    font_name: fontName,
    font_path: fontPath,
    font_title: fontName,
    font_size: fontSizePx,
    text_color: toRgbaHex(colorHex),
    border_color: toRgbaHex(strokeColorHex || "#000000"),
    border_width: strokeWidthVal,
    has_shadow: true,
    shadow_color: "#000000FF",
    shadow_distance: 8.0,
    background_color: backgroundEnabled ? "#000000CC" : "#00000000",
    text_alignment: 1, // 0=left, 1=centre, 2=right
    vertical: false,
  };
}

export function insertLaoSubtitles(
  json: any,
  cues: SubtitleCue[],
  config: PipelineConfig
): number {
  const style = config.subtitleStyle;
  json.materials.texts = json.materials.texts ?? [];

  // Remove existing text tracks to avoid accumulating duplicate track rows on re-runs
  json.tracks = (json.tracks ?? []).filter((t: any) => t.type !== "text");

  // Base text track – shows all words in the base color for the full cue duration
  const textTrack: any = {
    id: randomUUID(),
    type: "text",
    attribute: 0,
    flag: 0,
    is_main_track: false,
    segments: [],
  };

  // Highlight text track – overlaid on top; carries yellow word highlight segments
  // Pushed to json.tracks BEFORE textTrack so CapCut renders it on top in timeline UI & video render
  const highlightTrack: any = {
    id: randomUUID(),
    type: "text",
    attribute: 0,
    flag: 0,
    is_main_track: false,
    segments: [],
  };

  const videoTracks = findTracksByType(json, "video");
  const fontSizePx = resolveFontSizePx(style);
  const colorHex = resolveTextColorHex(style);
  const baseRgb = hexToRgbFloat(colorHex);

  // Dynamic highlight color contrasting with base text color:
  // White base text -> Yellow highlight (#FFD400)
  // Yellow base text -> Neon Green highlight (#39FF14)
  // Neon Green base text -> Yellow highlight (#FFD400)
  let highlightHex = "#FFD400";
  if (style.textColor === "yellow") {
    highlightHex = "#39FF14";
  } else if (style.textColor === "neon_green") {
    highlightHex = "#FFD400";
  } else {
    highlightHex = "#FFD400";
  }
  const highlightRgb = hexToRgbFloat(highlightHex);
  const strokeWidthVal = strokeWidthToCapCut(style.strokeWidth);
  const strokeRgb = hexToRgbFloat(style.strokeColor || "#000000");
  const { fontName, fontPath } = resolveFontInfo(style.fontFamily);
  const fontId = ensureFontMaterial(json, fontName, fontPath);

  let count = 0;
  for (const cue of cues) {
    if (cue.runs.some((r) => r.highlightAt)) {
      const added = insertKaraokeSubSegments(
        json,
        textTrack,
        highlightTrack,
        videoTracks,
        cue,
        style,
        fontSizePx,
        baseRgb,
        colorHex,
        highlightHex,
        highlightRgb,
        config.timeline.linkSubtitleToClip
      );
      count += added;
    } else {
      const startUs = mapMediaTimeToTimelineUs(cue.startSec, videoTracks);
      const endUs = mapMediaTimeToTimelineUs(cue.endSec, videoTracks);
      const durationUs = Math.max(100_000, endUs - startUs);
      if (durationUs <= 0) continue;

      const materialId = randomUUID();
      const combinedText = joinLaoWords(cue.runs.map((r) => r.text));

      json.materials.texts.push({
        id: materialId,
        type: "text",
        sub_type: 0,
        add_type: 0,
        name: combinedText,
        content: JSON.stringify({
          styles: [
            {
              fill: buildFill(baseRgb),
              font: {
                id: fontId,
                path: fontPath,
                name: fontName,
                title: fontName,
              },
              size: fontSizePx,
              range: [0, utf16LEByteLen(combinedText)],
              strokes:
                style.strokeWidth > 0
                  ? [
                      {
                        alpha: 1.0,
                        color: strokeRgb,
                        width: strokeWidthVal,
                      },
                    ]
                  : [],
            },
          ],
          text: combinedText,
        }),
        ...buildTextMaterialFields(
          fontId,
          fontName,
          fontPath,
          fontSizePx,
          colorHex,
          style.strokeColor,
          strokeWidthVal,
          style.backgroundBanner
        ),
      });

      json.keyframes = json.keyframes ?? {};
      json.keyframes.texts = json.keyframes.texts ?? [];

      const keyframeId = randomUUID();
      json.keyframes.texts.push({
        id: keyframeId,
        keyframe_list: [
          {
            id: randomUUID(),
            property_type: "scale",
            time_offset: 0,
            values: [1.0, 1.0],
          },
        ],
        property_type: "scale",
      });

      const segment: any = {
        id: randomUUID(),
        material_id: materialId,
        target_timerange: { start: startUs, duration: durationUs },
        clip: {
          alpha: 1.0,
          flip: { horizontal: false, vertical: false },
          rotation: 0.0,
          scale: { x: 1.0, y: 1.0 },
          transform: resolveTransform(style.position),
        },
        keyframe_refs: [keyframeId],
        extra_material_refs: [] as string[],
        render_index: 0,
      };

      if (config.timeline.linkSubtitleToClip) {
        const overlappingClip = findOverlappingVideoSegment(videoTracks, startUs, startUs + durationUs);
        if (overlappingClip) {
          segment.extra_material_refs.push(overlappingClip.id);
        }
      }

      textTrack.segments.push(segment);
      count++;
    }
  }

  // Sanitize both tracks to strictly prevent segment overlap in timeline microseconds.
  // Overlapping segments on a single track cause CapCut to auto-create extra stacked text tracks.
  sanitizeTrackSegments(textTrack.segments);
  if (highlightTrack.segments.length > 0) {
    sanitizeTrackSegments(highlightTrack.segments);
  }

  // In CapCut's track array, lower index tracks appear at the top of the timeline UI list
  // and render on top. Push highlightTrack first so it renders on top of textTrack.
  json.tracks.push(textTrack);
  if (highlightTrack.segments.length > 0) {
    json.tracks.push(highlightTrack);
  }
  return count;
}

/**
 * Ensures that all segments on a single CapCut track are strictly non-overlapping
 * in timeline microseconds (target_timerange.start and target_timerange.duration).
 * If two segments overlap on the same track, CapCut automatically creates extra
 * text tracks in the UI, causing subtitles to stack across multiple track rows.
 */
function sanitizeTrackSegments(segments: any[]): void {
  if (segments.length <= 1) return;

  // Sort segments by start time
  segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);

  for (let i = 0; i < segments.length - 1; i++) {
    const current = segments[i];
    const next = segments[i + 1];

    const curStart = current.target_timerange.start;
    const curEnd = curStart + current.target_timerange.duration;
    const nextStart = next.target_timerange.start;

    // If current segment overlaps into next segment's start time
    if (curEnd > nextStart) {
      if (nextStart > curStart + 50_000) {
        // Clamp current segment's duration so it ends right when next starts
        current.target_timerange.duration = nextStart - curStart;
      } else {
        // Next segment starts at or almost at curStart, shift next segment forward
        next.target_timerange.start = curEnd;
      }
    }

    // Ensure minimum duration of 50ms (50,000 us) per segment
    if (current.target_timerange.duration < 50_000) {
      current.target_timerange.duration = 50_000;
    }
  }

  // Ensure last segment has min duration
  const last = segments[segments.length - 1];
  if (last.target_timerange.duration < 50_000) {
    last.target_timerange.duration = 50_000;
  }
}

interface KaraokeSlice {
  startSec: number;
  endSec: number;
  activeRunIndex: number;
}

function buildKaraokeSlices(cue: SubtitleCue): KaraokeSlice[] {
  const slices: KaraokeSlice[] = [];
  const validRuns = cue.runs.filter((r) => r.highlightAt);

  if (validRuns.length === 0) {
    if (cue.endSec > cue.startSec) {
      slices.push({
        startSec: cue.startSec,
        endSec: cue.endSec,
        activeRunIndex: -1,
      });
    }
    return slices;
  }

  let currentSec = cue.startSec;

  for (let i = 0; i < validRuns.length; i++) {
    const run = validRuns[i];
    const hStart = Math.max(cue.startSec, run.highlightAt!.startSec);

    if (hStart > currentSec + 0.02) {
      slices.push({
        startSec: currentSec,
        endSec: hStart,
        activeRunIndex: i > 0 ? i - 1 : -1,
      });
      currentSec = hStart;
    }

    let hEnd = run.highlightAt!.endSec;
    if (i < validRuns.length - 1) {
      const nextStart = validRuns[i + 1].highlightAt!.startSec;
      if (nextStart > hStart) {
        hEnd = nextStart;
      }
    } else {
      hEnd = Math.max(hEnd, cue.endSec);
    }

    hEnd = Math.min(cue.endSec, hEnd);

    if (hEnd > currentSec + 0.02) {
      slices.push({
        startSec: currentSec,
        endSec: hEnd,
        activeRunIndex: i,
      });
      currentSec = hEnd;
    }
  }

  if (cue.endSec > currentSec + 0.02) {
    slices.push({
      startSec: currentSec,
      endSec: cue.endSec,
      activeRunIndex: validRuns.length - 1,
    });
  }

  return slices;
}

function mapMediaTimeToTimelineUs(mediaTimeSec: number, videoTracks: any[]): number {
  const mediaTimeUs = Math.round(mediaTimeSec * ALL_TIME_UNIT_US);
  for (const track of videoTracks) {
    for (const seg of track.segments ?? []) {
      if (seg.source_timerange && seg.target_timerange) {
        const srcStart = seg.source_timerange.start ?? 0;
        const srcDur = seg.source_timerange.duration ?? seg.target_timerange.duration;
        const srcEnd = srcStart + srcDur;

        if (mediaTimeUs >= srcStart && mediaTimeUs <= srcEnd) {
          const offsetUs = mediaTimeUs - srcStart;
          return (seg.target_timerange.start ?? 0) + offsetUs;
        }
      }
    }
  }
  return mediaTimeUs;
}

function buildStylesForActiveRun(
  runRanges: { startByte: number; endByte: number }[],
  combinedByteLen: number,
  activeRunIndex: number,
  fontId: string,
  fontName: string,
  fontPath: string,
  fontSizePx: number,
  baseRgb: [number, number, number],
  highlightRgb: [number, number, number],
  strokes: any[]
): any[] {
  const styles: any[] = [];
  let pos = 0;

  for (let i = 0; i < runRanges.length; i++) {
    const range = runRanges[i];

    // Inter-word gaps / spaces before word i
    if (range.startByte > pos) {
      styles.push({
        fill: buildFill(baseRgb),
        font: { id: fontId, path: fontPath, name: fontName, title: fontName },
        size: fontSizePx,
        bold: false,
        range: [pos, range.startByte - pos],
        strokes,
      });
    }

    const isHighlight = i === activeRunIndex;
    styles.push({
      fill: buildFill(isHighlight ? highlightRgb : baseRgb),
      font: { id: fontId, path: fontPath, name: fontName, title: fontName },
      size: fontSizePx,
      bold: false,
      range: [range.startByte, range.endByte - range.startByte],
      strokes,
    });

    pos = range.endByte;
  }

  // Inter-word gaps / spaces after the last word
  if (pos < combinedByteLen) {
    styles.push({
      fill: buildFill(baseRgb),
      font: { id: fontId, path: fontPath, name: fontName, title: fontName },
      size: fontSizePx,
      bold: false,
      range: [pos, combinedByteLen - pos],
      strokes,
    });
  }

  return styles;
}

function insertKaraokeSubSegments(
  json: any,
  textTrack: any,
  highlightTrack: any,
  videoTracks: any[],
  cue: SubtitleCue,
  style: any,
  fontSizePx: number,
  baseRgb: [number, number, number],
  colorHex: string,
  highlightHex: string,
  highlightRgb: [number, number, number],
  linkSubtitleToClip: boolean
): number {
  const { combinedText, ranges: runRanges } = buildUtf16RunRanges(cue.runs);
  const combinedByteLen = utf16LEByteLen(combinedText);
  const { fontName, fontPath } = resolveFontInfo(style.fontFamily);
  const fontId = ensureFontMaterial(json, fontName, fontPath);
  const strokeWidthVal = strokeWidthToCapCut(style.strokeWidth);
  const strokeRgb = hexToRgbFloat(style.strokeColor || "#000000");

  const strokes =
    style.strokeWidth > 0
      ? [
          {
            alpha: 1.0,
            color: strokeRgb,
            width: strokeWidthVal,
          },
        ]
      : [];

  json.keyframes = json.keyframes ?? {};
  json.keyframes.texts = json.keyframes.texts ?? [];

  let addedCount = 0;

  // --- Base segment (full cue, all words, Base Color chosen by user) ---
  const cueStartUs = mapMediaTimeToTimelineUs(cue.startSec, videoTracks);
  const cueEndUs   = mapMediaTimeToTimelineUs(cue.endSec, videoTracks);
  const cueDurUs   = Math.max(100_000, cueEndUs - cueStartUs);

  const baseMaterialId = randomUUID();
  json.materials.texts.push({
    id: baseMaterialId,
    type: "text", sub_type: 0, add_type: 0,
    name: combinedText,
    content: JSON.stringify({
      styles: [{
        fill: buildFill(baseRgb),
        font: { id: fontId, path: fontPath, name: fontName, title: fontName },
        size: fontSizePx,
        bold: false,
        range: [0, combinedByteLen],
        strokes,
      }],
      text: combinedText,
    }),
    ...buildTextMaterialFields(
      fontId,
      fontName,
      fontPath,
      fontSizePx,
      colorHex,
      style.strokeColor,
      strokeWidthVal,
      style.backgroundBanner
    ),
  });

  const baseKfId = randomUUID();
  json.keyframes.texts.push({
    id: baseKfId,
    keyframe_list: [{ id: randomUUID(), property_type: "scale", time_offset: 0, values: [1.0, 1.0] }],
    property_type: "scale",
  });

  const baseSegment: any = {
    id: randomUUID(),
    material_id: baseMaterialId,
    target_timerange: { start: cueStartUs, duration: cueDurUs },
    clip: {
      alpha: 1.0,
      flip: { horizontal: false, vertical: false },
      rotation: 0.0,
      scale: { x: 1.0, y: 1.0 },
      transform: resolveTransform(style.position),
    },
    keyframe_refs: [baseKfId],
    extra_material_refs: [] as string[],
    render_index: 0,
  };
  if (linkSubtitleToClip) {
    const overlappingClip = findOverlappingVideoSegment(videoTracks, cueStartUs, cueStartUs + cueDurUs);
    if (overlappingClip) baseSegment.extra_material_refs.push(overlappingClip.id);
  }
  textTrack.segments.push(baseSegment);
  addedCount++;

  // --- Highlight segments (Highlight clip per word on highlightTrack) ---
  for (let wi = 0; wi < cue.runs.length; wi++) {
    const run = cue.runs[wi];
    if (!run.highlightAt) continue;

    const wordStartUs = mapMediaTimeToTimelineUs(run.highlightAt.startSec, videoTracks);
    let wordEndUs: number;
    if (wi < cue.runs.length - 1 && cue.runs[wi + 1].highlightAt) {
      wordEndUs = mapMediaTimeToTimelineUs(cue.runs[wi + 1].highlightAt!.startSec, videoTracks);
    } else {
      wordEndUs = cueEndUs;
    }
    const wordDurUs = Math.max(80_000, wordEndUs - wordStartUs);
    const wordText = run.text;

    const activeStyles = buildStylesForActiveRun(
      runRanges,
      combinedByteLen,
      wi,
      fontId,
      fontName,
      fontPath,
      fontSizePx,
      baseRgb,
      highlightRgb,
      strokes
    );

    const hlMaterialId = randomUUID();
    json.materials.texts.push({
      id: hlMaterialId,
      type: "text", sub_type: 0, add_type: 0,
      name: wordText,
      content: JSON.stringify({
        styles: activeStyles,
        text: combinedText,
      }),
      ...buildTextMaterialFields(
        fontId,
        fontName,
        fontPath,
        fontSizePx,
        highlightHex,
        style.strokeColor,
        strokeWidthVal,
        false
      ),
    });

    const hlKfId = randomUUID();
    json.keyframes.texts.push({
      id: hlKfId,
      keyframe_list: [{ id: randomUUID(), property_type: "scale", time_offset: 0, values: [1.0, 1.0] }],
      property_type: "scale",
    });

    const hlSegment: any = {
      id: randomUUID(),
      material_id: hlMaterialId,
      target_timerange: { start: wordStartUs, duration: wordDurUs },
      clip: {
        alpha: 1.0,
        flip: { horizontal: false, vertical: false },
        rotation: 0.0,
        scale: { x: 1.0, y: 1.0 },
        transform: resolveTransform(style.position),
      },
      keyframe_refs: [hlKfId],
      extra_material_refs: [] as string[],
      render_index: 0,
    };
    if (linkSubtitleToClip) {
      const overlappingClip = findOverlappingVideoSegment(videoTracks, wordStartUs, wordStartUs + wordDurUs);
      if (overlappingClip) hlSegment.extra_material_refs.push(overlappingClip.id);
    }
    highlightTrack.segments.push(hlSegment);
    addedCount++;
  }

  return addedCount;
}

function findOverlappingVideoSegment(videoTracks: any[], startUs: number, endUs: number): any | null {
  for (const track of videoTracks) {
    for (const seg of track.segments ?? []) {
      const segStart = seg.target_timerange.start;
      const segEnd = segStart + seg.target_timerange.duration;
      if (startUs < segEnd && endUs > segStart) return seg;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Writes the modified draft back to disk, honoring Save as Copy vs Overwrite.
 * Save as Copy writes draft_content_edited.json alongside the original and
 * leaves draft_content.json untouched. Overwrite replaces draft_content.json
 * directly (a timestamped .backup file was already written by loadDraft()).
 */
export function saveDraft(loaded: LoadedDraft, projectDir: string, saveMode: "copy" | "overwrite"): string {
  const outPath =
    saveMode === "overwrite"
      ? loaded.path
      : path.join(projectDir, "draft_content_edited.json");

  fs.writeFileSync(outPath, JSON.stringify(loaded.json, null, 2), "utf8");

  if (saveMode === "overwrite") {
    const metaPath = path.join(projectDir, "draft_meta_info.json");
    if (fs.existsSync(metaPath)) {
      try {
        const metaRaw = fs.readFileSync(metaPath, "utf8");
        const metaJson = JSON.parse(metaRaw);
        const nowUs = Date.now() * 1000;
        if (typeof loaded.json.duration === "number") {
          metaJson.tm_duration = loaded.json.duration;
        }

        // Sync text materials into draft_meta_info.json so CapCut PC index knows texts exist
        if (Array.isArray(metaJson.draft_materials)) {
          const textMaterials = (loaded.json.materials?.texts || []).map((t: any) => ({
            ai_group_type: "",
            create_time: Math.floor(Date.now() / 1000),
            duration: 0,
            enter_from: 0,
            extra_info: t.name || "",
            file_Path: "",
            height: 0,
            id: t.id,
            import_time: Math.floor(Date.now() / 1000),
            import_time_ms: Date.now() * 1000,
            item_source: 0,
            material_color_tag: "",
            md5: "",
            metetype: "text",
            roughcut_time_range: { duration: 0, start: 0 },
            sub_time_range: { duration: -1, start: -1 },
            type: 2,
            width: 0,
          }));

          let t2 = metaJson.draft_materials.find((m: any) => m.type === 2);
          if (!t2) {
            t2 = { type: 2, value: [] };
            metaJson.draft_materials.push(t2);
          }
          t2.value = textMaterials;
        }

        metaJson.tm_draft_modified = nowUs;
        metaJson.tm_draft_cloud_modified = nowUs;
        metaJson.draft_timeline_materials_size_ = fs.statSync(outPath).size;
        fs.writeFileSync(metaPath, JSON.stringify(metaJson, null, 2), "utf8");
      } catch (e) {
        console.warn("Could not update draft_meta_info.json:", e);
      }
    }
  }

  return outPath;
}
