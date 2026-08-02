import * as fs from "fs";
import * as path from "path";
import {
  extractAudioForTranscription,
  extractTimelineAudio,
  tempWavPathFor,
  TimelineAudioSegment,
} from "./ffmpegSilence";
import { transcribeLao } from "./transcribe";
import { buildCues } from "./subtitleBuilder";
import { loadDraft, insertLaoSubtitles, saveDraft } from "./draftContentEditor";
import { PipelineConfig, PipelineProgress, PipelineResult } from "./types";

function parseTimelineSegments(projectDir: string): {
  segments: TimelineAudioSegment[];
  totalDurationSec: number;
} {
  const draftPath = path.join(projectDir, "draft_content.json");
  if (!fs.existsSync(draftPath)) {
    throw new Error("draft_content.json not found in project directory.");
  }

  const raw = fs.readFileSync(draftPath, "utf8");
  const draft = JSON.parse(raw);

  const totalDurationSec = (draft.duration ?? 0) / 1_000_000;
  const segments: TimelineAudioSegment[] = [];

  const videoTracks = (draft.tracks ?? []).filter((t: any) => t.type === "video");

  const videosMap = new Map<string, string>();
  for (const v of draft.materials?.videos ?? []) {
    const p = v.path || v.file_path || v.original_path;
    if (p) videosMap.set(v.id, p);
  }
  for (const a of draft.materials?.audios ?? []) {
    const p = a.path || a.file_path || a.original_path;
    if (p) videosMap.set(a.id, p);
  }

  for (const track of videoTracks) {
    for (const seg of track.segments ?? []) {
      if (seg.visible === false) continue;

      const rawPath = videosMap.get(seg.material_id);
      if (!rawPath) continue;

      const mediaPath = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(projectDir, rawPath);
      if (!fs.existsSync(mediaPath)) continue;

      const sourceStartSec = (seg.source_timerange?.start ?? 0) / 1_000_000;
      const sourceDurSec =
        (seg.source_timerange?.duration ?? seg.target_timerange?.duration ?? 0) /
        1_000_000;
      const targetStartSec = (seg.target_timerange?.start ?? 0) / 1_000_000;
      const targetDurSec = (seg.target_timerange?.duration ?? 0) / 1_000_000;
      const speed = seg.speed ?? 1.0;

      if (targetDurSec > 0 && sourceDurSec > 0) {
        segments.push({
          mediaPath,
          sourceStartSec,
          sourceDurSec,
          targetStartSec,
          targetDurSec,
          speed,
        });
      }
    }
  }

  segments.sort((a, b) => a.targetStartSec - b.targetStartSec);
  return { segments, totalDurationSec };
}

/**
 * Finds the primary source media file for the project. CapCut stores original
 * source clips either alongside draft_content.json or inside a "Resources" /
 * media cache subfolder depending on version. This picks the largest video
 * file found by extension as a pragmatic default — cross-check against
 * materials.videos[].path in draft_content.json for a fully robust lookup.
 */
function findPrimarySourceMedia(projectDir: string): string {
  const mediaExts = [
    ".mp4",
    ".mov",
    ".mkv",
    ".avi",
    ".webm",
    ".flv",
    ".wmv",
    ".m4v",
    ".ts",
    ".mts",
    ".m2ts",
    ".3gp",
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
    ".flac",
    ".ogg",
  ];
  const candidates: { file: string; size: number }[] = [];

  // 1. Try reading draft_content.json to extract media paths referenced by CapCut
  const draftPath = path.join(projectDir, "draft_content.json");
  if (fs.existsSync(draftPath)) {
    try {
      const draftContent = JSON.parse(fs.readFileSync(draftPath, "utf8"));
      const materialsList = [
        ...(draftContent.materials?.videos || []),
        ...(draftContent.materials?.audios || []),
      ];

      for (const mat of materialsList) {
        const targetPath = mat.path || mat.file_path || mat.original_path;
        if (targetPath && typeof targetPath === "string") {
          const resolved = path.isAbsolute(targetPath)
            ? targetPath
            : path.resolve(projectDir, targetPath);
          if (fs.existsSync(resolved)) {
            try {
              const stat = fs.statSync(resolved);
              if (stat.isFile() && stat.size > 0) {
                candidates.push({ file: resolved, size: stat.size });
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  // 2. If no valid files found from draft_content.json, scan projectDir recursively
  if (candidates.length === 0) {
    const walk = (dir: string, depth: number) => {
      if (depth > 6) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
          } else if (
            mediaExts.includes(path.extname(entry.name).toLowerCase())
          ) {
            try {
              const stat = fs.statSync(full);
              if (stat.isFile() && stat.size > 0) {
                candidates.push({ file: full, size: stat.size });
              }
            } catch {}
          }
        }
      } catch {}
    };
    walk(projectDir, 0);
  }

  if (candidates.length === 0) {
    throw new Error("ບໍ່ພົບໄຟລ໌ວິດີໂອຕົ້ນສະບັບໃນໂຟນເດີໂຄງການ.");
  }
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0].file;
}

import { execSync } from "child_process";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeCapCutPC(): void {
  const exes = [
    "CapCut.exe",
    "CapCutPC.exe",
    "CapCutMain.exe",
    "CapCut_Main.exe",
    "CapCutHelper.exe",
    "CapCutRender.exe",
    "CapCutWorker.exe",
    "CapCutService.exe",
    "JianyingPro.exe",
    "JianyingProMain.exe",
  ];
  for (const exe of exes) {
    try {
      execSync(`taskkill /F /IM "${exe}" /T`, { stdio: "ignore" });
    } catch {}
  }
  try {
    execSync(
      `powershell -NoProfile -Command "Get-Process | Where-Object { $_.Name -like '*CapCut*' -or $_.Name -like '*Jianying*' } | Stop-Process -Force"`,
      { stdio: "ignore" }
    );
  } catch {}
}


export async function runPipeline(
  config: PipelineConfig,
  onProgress: (p: PipelineProgress) => void,
): Promise<PipelineResult> {
  let tempWav: string | null = null;
  try {
    closeCapCutPC();
    await delay(300);

    onProgress({
      stage: "extracting_audio",
      message: "ກຳລັງແຍກສຽງ ແລະ ສັງເຄາະໄທມ໌ໄລນ໌...",
      percent: 10,
    });

    let timelineWavCreated = false;
    tempWav = path.join(
      require("os").tmpdir(),
      `capcut-lao-timeline-${Date.now()}.wav`
    );

    try {
      const { segments, totalDurationSec } = parseTimelineSegments(
        config.projectDir
      );
      if (segments.length > 0) {
        await extractTimelineAudio(segments, totalDurationSec, tempWav);
        timelineWavCreated = true;
      }
    } catch (e) {
      console.warn(
        "Could not extract multi-segment timeline audio, falling back to primary media:",
        e
      );
    }

    if (!timelineWavCreated) {
      const sourceMedia = findPrimarySourceMedia(config.projectDir);
      tempWav = tempWavPathFor(sourceMedia);
      await extractAudioForTranscription(sourceMedia, tempWav);
    }

    onProgress({
      stage: "transcribing",
      message: "ກຳລັງຖອດຂໍ້ຄວາມ...",
      percent: 35,
    });
    const { sentences } = await transcribeLao(
      config.apiKey,
      tempWav,
      config.transcription,
      (statusMsg) => {
        onProgress({ stage: "transcribing", message: statusMsg, percent: 35 });
      },
    );

    if (!sentences || sentences.length === 0) {
      throw new Error("ບໍ່ພົບສຽງເວົ້າໃນວິດີໂອ ຫຼື AI ຖອດຂໍ້ຄວາມບໍ່ໄດ້ (ไม่พบเสียงพูดในวิดีโอ หรือ AI ถอดข้อความไม่ได้)");
    }

    onProgress({
      stage: "building_subtitles",
      message: "ກຳລັງສ້າງຊັບໄຕເຕີ້ນເທິງໄທມ໌ໄລນ໌...",
      percent: 65,
    });
    closeCapCutPC();
    await delay(300);
    const draft = loadDraft(config.projectDir);
    const cues = buildCues(sentences, config.subtitleStyle);
    if (!cues || cues.length === 0) {
      throw new Error("ບໍ່ສາມາດສ້າງซັບໄຕເຕີ້ນໄດ້ (ไม่สามารถสร้างข้อความซับไตเติ้ลได้)");
    }
    const subtitlesGenerated = insertLaoSubtitles(draft.json, cues, config);

    onProgress({
      stage: "writing_draft",
      message: "ກຳລັງບັນທຶກ draft_content.json...",
      percent: 95,
    });
    closeCapCutPC();
    await delay(300);
    const outputPath = saveDraft(
      draft,
      config.projectDir,
      config.timeline.saveMode,
    );

    onProgress({ stage: "done", message: "ສຳເລັດແລ້ວ.", percent: 100 });
    return { ok: true, outputPath, subtitlesGenerated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ stage: "error", message, percent: 0 });
    return { ok: false, error: message };
  } finally {
    if (tempWav && fs.existsSync(tempWav)) {
      fs.unlinkSync(tempWav);
    }
  }
}
