import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

function resolveFfmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let ffmpegStatic = require("ffmpeg-static") as string;
    if (typeof ffmpegStatic === "string" && ffmpegStatic) {
      ffmpegStatic = ffmpegStatic.replace("app.asar", "app.asar.unpacked");
      if (fs.existsSync(ffmpegStatic)) return ffmpegStatic;
    }
  } catch {
    /* ignore, fall through to PATH lookup */
  }
  return "ffmpeg";
}

/**
 * Extracts the audio track of a media file to a temp WAV for transcription.
 * 16kHz mono is the sweet spot for speech models and keeps upload size small.
 */
export function extractAudioForTranscription(
  mediaPath: string,
  outWavPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
    const args = [
      "-y",
      "-i",
      mediaPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outWavPath,
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outWavPath)) {
        resolve(outWavPath);
      } else {
        reject(new Error(`ffmpeg audio extraction failed (code ${code}): ${stderr.slice(-500)}`));
      }
    });
  });
}

export interface TimelineAudioSegment {
  mediaPath: string;
  sourceStartSec: number;
  sourceDurSec: number;
  targetStartSec: number;
  targetDurSec: number;
  speed: number;
}

/**
 * Extracts and stitches together the audio of ALL video/audio segments on the CapCut timeline
 * into a single unified 16kHz mono WAV file representing the full project timeline.
 */
export async function extractTimelineAudio(
  segments: TimelineAudioSegment[],
  totalDurationSec: number,
  outWavPath: string
): Promise<string> {
  const ffmpegPath = resolveFfmpegPath();
  const tempFiles: string[] = [];

  try {
    if (segments.length === 0) {
      throw new Error("No media segments found on timeline to extract audio.");
    }

    // If only 1 segment starting at 0s, simple single-file extraction
    if (
      segments.length === 1 &&
      segments[0].targetStartSec <= 0.05 &&
      segments[0].sourceStartSec <= 0.05
    ) {
      return await extractAudioForTranscription(segments[0].mediaPath, outWavPath);
    }

    const extractedClips: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const clipWav = path.join(
        require("os").tmpdir(),
        `capcut-seg-${i}-${Date.now()}.wav`
      );
      tempFiles.push(clipWav);

      const args = [
        "-y",
        "-ss",
        seg.sourceStartSec.toFixed(3),
        "-i",
        seg.mediaPath,
        "-t",
        seg.sourceDurSec.toFixed(3),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
      ];

      if (
        Math.abs(seg.speed - 1.0) > 0.01 &&
        seg.speed > 0.1 &&
        seg.speed < 10.0
      ) {
        args.push("-filter:a", `atempo=${seg.speed.toFixed(2)}`);
      }

      args.push(clipWav);

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpegPath, args, { windowsHide: true });
        let stderr = "";
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error(`FFmpeg timed out extracting clip ${i}`));
        }, 15000);

        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(clipWav)) resolve();
          else
            reject(
              new Error(
                `FFmpeg segment extraction failed for clip ${i}: ${stderr.slice(
                  -300
                )}`
              )
            );
        });
      });

      extractedClips.push(clipWav);
    }

    if (extractedClips.length === 1) {
      fs.copyFileSync(extractedClips[0], outWavPath);
      return outWavPath;
    }

    // Fast concatenation using FFmpeg concat demuxer
    const concatTxtPath = path.join(
      require("os").tmpdir(),
      `capcut-concat-${Date.now()}.txt`
    );
    tempFiles.push(concatTxtPath);

    const concatContent = extractedClips
      .map((filePath) => `file '${filePath.replace(/\\/g, "/")}'`)
      .join("\n");
    fs.writeFileSync(concatTxtPath, concatContent, "utf8");

    const concatArgs = [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatTxtPath,
      "-c",
      "copy",
      outWavPath,
    ];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, concatArgs, { windowsHide: true });
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("FFmpeg timed out joining timeline audio"));
      }, 15000);

      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outWavPath)) resolve();
        else
          reject(
            new Error(
              `FFmpeg concat failed: ${stderr.slice(-300)}`
            )
          );
      });
    });

    return outWavPath;
  } finally {
    tempFiles.forEach((f) => {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
    });
  }
}

export function tempWavPathFor(mediaPath: string): string {
  const base = path.basename(mediaPath, path.extname(mediaPath));
  return path.join(require("os").tmpdir(), `capcut-lao-${base}-${Date.now()}.wav`);
}
