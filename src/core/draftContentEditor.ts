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

function utf16LEByteLen(s: string): number {
  return s.length * 2;
}

export interface LoadedDraft {
  path: string;
  json: any;
  backupPath: string;
}

export interface SavedDraftVerification {
  textTracks: number;
  textSegments: number;
  textMaterials: number;
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

function collectMaterialIdsFromTracks(tracks: any[], type: "text"): Set<string> {
  const ids = new Set<string>();
  for (const track of tracks ?? []) {
    if (track?.type !== type) continue;
    for (const segment of track.segments ?? []) {
      if (segment?.material_id) ids.add(segment.material_id);
    }
  }
  return ids;
}

function removeTextKeyframesForSegments(json: any, textTracks: any[]): void {
  const keyframeIds = new Set<string>();
  for (const track of textTracks ?? []) {
    for (const segment of track.segments ?? []) {
      for (const keyframeId of segment.keyframe_refs ?? []) {
        if (keyframeId) keyframeIds.add(keyframeId);
      }
    }
  }

  if (keyframeIds.size > 0 && Array.isArray(json.keyframes?.texts)) {
    json.keyframes.texts = json.keyframes.texts.filter((kf: any) => !keyframeIds.has(kf.id));
  }
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

function resolveKaraokeHighlightHex(colorHex: string): string {
  return colorHex.toUpperCase() === "#FFFFFFFF" ? "#FFD400FF" : colorHex;
}

function makeContentStyle(
  fontId: string,
  fontName: string,
  fontPath: string,
  fontSizePx: number,
  rgb: [number, number, number],
  range: [number, number],
  strokeRgb: [number, number, number],
  strokeWidth: number,
  strokeWidthVal: number,
  alpha = 1.0
): any {
  return {
    fill: buildFill(rgb, alpha),
    font: {
      id: fontId,
      path: fontPath,
      name: fontName,
      title: fontName,
    },
    size: fontSizePx,
    range,
    strokes:
      strokeWidth > 0
        ? [
            {
              alpha: 1.0,
              color: strokeRgb,
              width: strokeWidthVal,
            },
          ]
        : [],
  };
}

function buildStyledTextContent(
  cue: SubtitleCue,
  style: PipelineConfig["subtitleStyle"],
  fontId: string,
  fontName: string,
  fontPath: string,
  fontSizePx: number,
  colorHex: string,
  strokeRgb: [number, number, number],
  strokeWidthVal: number
): { text: string; styles: any[] } {
  const hasHighlightRuns = cue.runs.some((run) => run.highlighted !== undefined);
  const highlightHex = hasHighlightRuns ? resolveKaraokeHighlightHex(colorHex) : colorHex;
  const highlightRgb = hexToRgbFloat(highlightHex);
  const baseRgb = hasHighlightRuns ? hexToRgbFloat("#FFFFFF") : hexToRgbFloat(colorHex);
  const styles: any[] = [];
  let text = "";

  const isLao = (str: string) => /[\u0E80-\u0EFF]/.test(str);

  for (let i = 0; i < cue.runs.length; i++) {
    const rawRunText = cleanLaoText(cue.runs[i].text);
    if (!rawRunText) continue;

    let renderedRunText = rawRunText;
    if (text.length > 0) {
      const prevChar = text[text.length - 1];
      const nextChar = rawRunText[0];
      if (!(isLao(prevChar) && isLao(nextChar))) {
        renderedRunText = " " + renderedRunText;
      }
    }

    const start = utf16LEByteLen(text);
    text += renderedRunText;
    const end = utf16LEByteLen(text);
    const rgb = cue.runs[i].highlighted ? highlightRgb : baseRgb;
    const alpha = hasHighlightRuns && !cue.runs[i].highlighted ? 0.62 : 1.0;

    styles.push(
      makeContentStyle(
        fontId,
        fontName,
        fontPath,
        fontSizePx,
        rgb,
        [start, end],
        strokeRgb,
        style.strokeWidth,
        strokeWidthVal,
        alpha
      )
    );
  }

  if (styles.length === 0) {
    const fallbackText = joinLaoWords(cue.runs.map((r) => r.text));
    styles.push(
      makeContentStyle(
        fontId,
        fontName,
        fontPath,
        fontSizePx,
        hexToRgbFloat(colorHex),
        [0, utf16LEByteLen(fallbackText)],
        strokeRgb,
        style.strokeWidth,
        strokeWidthVal
      )
    );
    return { text: fallbackText, styles };
  }

  return { text, styles };
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

function getStaticLaoFontPath(): string {
  const localAppData = process.env.LOCALAPPDATA || "";
  const winDir = process.env.WINDIR || "C:/Windows";

  const fontFilenames = [
    "NotoSansLao-VariableFont_wdth,wght.ttf",
    "NotoSansLao-Regular.ttf",
    "NotoSansLao.ttf",
  ];

  const assetFontDir = path.resolve(__dirname, "../../assets/fonts");

  const targetFontDirs = [
    path.join(localAppData, "Microsoft/Windows/Fonts"),
    path.join(localAppData, "CapCut/User Data/Resources/Font/SystemFont"),
  ];

  // Also check CapCut Apps folders (e.g. CapCut/Apps/9.x.x/Resources/Font/SystemFont)
  const capcutAppsDir = path.join(localAppData, "CapCut/Apps");
  if (fs.existsSync(capcutAppsDir)) {
    try {
      const appVersions = fs.readdirSync(capcutAppsDir);
      for (const ver of appVersions) {
        const sysFontDir = path.join(capcutAppsDir, ver, "Resources/Font/SystemFont");
        if (fs.existsSync(sysFontDir)) {
          targetFontDirs.push(sysFontDir);
        }
      }
    } catch (e) {
      console.warn("Could not scan CapCut Apps directory:", e);
    }
  }

  // Ensure target directories exist & auto-copy all bundled font variations into them
  for (const filename of fontFilenames) {
    const srcAsset = path.join(assetFontDir, filename);
    if (!fs.existsSync(srcAsset)) continue;

    for (const dir of targetFontDirs) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const dstFont = path.join(dir, filename);
        if (!fs.existsSync(dstFont)) {
          fs.copyFileSync(srcAsset, dstFont);
        }
      } catch (e) {
        console.warn(`Could not copy font ${filename} to ${dir}:`, e);
      }
    }
  }

  // Build candidate paths in order of preference (checking variable font first, then regular font)
  const searchDirs = [
    path.join(localAppData, "Microsoft/Windows/Fonts"),
    path.join(localAppData, "CapCut/User Data/Resources/Font/SystemFont"),
    path.join(winDir, "Fonts"),
    assetFontDir,
  ];

  for (const dir of searchDirs) {
    for (const filename of fontFilenames) {
      const p = path.join(dir, filename);
      if (fs.existsSync(p)) {
        return p.replace(/\\/g, "/");
      }
    }
  }

  const fallback = path.join(searchDirs[0], fontFilenames[0]);
  return fallback.replace(/\\/g, "/");
}

function resolveFontInfo(fontFamilyOrPath?: string): { fontName: string; fontPath: string } {
  const defaultFontName = "Noto Sans Lao Regular";
  const defaultFontPath = getStaticLaoFontPath();

  let fontName = defaultFontName;
  let fontPath = defaultFontPath;

  if (fontFamilyOrPath && fontFamilyOrPath.trim().length > 0) {
    const trimmed = fontFamilyOrPath.trim();
    if (trimmed.endsWith(".ttf") || trimmed.endsWith(".otf") || trimmed.includes("/") || trimmed.includes("\\")) {
      fontPath = trimmed.replace(/\\/g, "/");
      fontName = path.basename(trimmed, path.extname(trimmed));
    } else {
      fontName = trimmed;
    }
  }

  return { fontName, fontPath: fontPath.replace(/\\/g, "/") };
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
      resource_id: fontName,
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

function writeTextFileDurably(filePath: string, content: string): void {
  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function touchProjectFiles(projectDir: string, paths: string[]): void {
  const now = new Date();
  for (const p of paths) {
    try {
      fs.utimesSync(p, now, now);
    } catch {}
  }
  try {
    fs.utimesSync(projectDir, now, now);
  } catch {}
}

export function insertLaoSubtitles(
  json: any,
  cues: SubtitleCue[],
  config: PipelineConfig
): number {
  const style = config.subtitleStyle;
  json.materials.texts = json.materials.texts ?? [];

  // Remove existing text tracks and their text materials so CapCut's project
  // index does not keep pointing at stale subtitle material ids across re-runs.
  const existingTextTracks = findTracksByType(json, "text");
  const existingTextMaterialIds = collectMaterialIdsFromTracks(existingTextTracks, "text");
  removeTextKeyframesForSegments(json, existingTextTracks);
  json.tracks = (json.tracks ?? []).filter((t: any) => t.type !== "text");
  json.materials.texts = (json.materials.texts ?? []).filter(
    (text: any) => !existingTextMaterialIds.has(text.id)
  );

  const textTrack: any = {
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
  const strokeWidthVal = strokeWidthToCapCut(style.strokeWidth);
  const strokeRgb = hexToRgbFloat(style.strokeColor || "#000000");
  const { fontName, fontPath } = resolveFontInfo(style.fontFamily);
  const fontId = ensureFontMaterial(json, fontName, fontPath);

  let count = 0;
  for (const cue of cues) {

    const startUs = mapMediaTimeToTimelineUs(cue.startSec, videoTracks);
    const endUs = mapMediaTimeToTimelineUs(cue.endSec, videoTracks);
    const durationUs = Math.max(100_000, endUs - startUs);
    if (durationUs <= 0) continue;

    const materialId = randomUUID();
    const content = buildStyledTextContent(
      cue,
      style,
      fontId,
      fontName,
      fontPath,
      fontSizePx,
      colorHex,
      strokeRgb,
      strokeWidthVal
    );
    const combinedText = content.text;

    json.materials.texts.push({
      id: materialId,
      type: "text",
      sub_type: 0,
      add_type: 0,
      name: combinedText,
      content: JSON.stringify({
        styles: content.styles,
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
      source_timerange: { start: 0, duration: durationUs },
      speed: 1.0,
      volume: 1.0,
      visible: true,
      clip: {
        alpha: 1.0,
        flip: { horizontal: false, vertical: false },
        rotation: 0.0,
        scale: { x: 1.0, y: 1.0 },
        transform: resolveTransform(style.position),
      },
      enable_adjust: true,
      enable_color_curves: true,
      enable_color_wheels: true,
      enable_lut: true,
      enable_smart_color_adjust: false,
      responsive_layout: {
        enable: false,
        horizontal_pos_type: 0,
        target_follow_material_id: "",
        vertical_pos_type: 0,
      },
      keyframe_refs: [keyframeId],
      extra_material_refs: [] as string[],
      render_index: 0,
    };

    // extra_material_refs is for text animation/effect materials, not video segments
    textTrack.segments.push(segment);
    count++;
  }

  sanitizeTrackSegments(textTrack.segments);
  json.tracks.push(textTrack);
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
            import_time_ms: Date.now(),
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

        const now = new Date();
        try { fs.utimesSync(outPath, now, now); } catch {}
        try { fs.utimesSync(metaPath, now, now); } catch {}
      } catch (e) {
        console.warn("Could not update draft_meta_info.json:", e);
      }
    }
  }

  const now = new Date();
  try { fs.utimesSync(outPath, now, now); } catch {}

  return outPath;
}
