import * as fs from "fs";
import * as path from "path";
import { extractAudioForTranscription, tempWavPathFor } from "./ffmpegSilence";
import { transcribeLao } from "./transcribe";
import { buildCues } from "./subtitleBuilder";
import { loadDraft, insertLaoSubtitles, saveDraft } from "./draftContentEditor";
import { PipelineConfig, PipelineProgress, PipelineResult } from "./types";

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

function closeCapCutPC(): void {
  const exes = [
    "CapCut.exe",
    "CapCutPC.exe",
    "CapCutMain.exe",
    "CapCut_Main.exe",
    "CapCutHelper.exe",
    "CapCutRender.exe",
    "JianyingPro.exe",
    "JianyingProMain.exe",
  ];
  for (const exe of exes) {
    try {
      execSync(`taskkill /F /IM "${exe}" /T`, { stdio: "ignore" });
    } catch {}
  }
}


export async function runPipeline(
  config: PipelineConfig,
  onProgress: (p: PipelineProgress) => void,
): Promise<PipelineResult> {
  let tempWav: string | null = null;
  try {
    closeCapCutPC();
    const sourceMedia = findPrimarySourceMedia(config.projectDir);

    onProgress({
      stage: "extracting_audio",
      message: "ກຳລັງແຍກສຽງເພື່ອຖອດຂໍ້ຄວາມ...",
      percent: 10,
    });
    tempWav = tempWavPathFor(sourceMedia);
    await extractAudioForTranscription(sourceMedia, tempWav);

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
