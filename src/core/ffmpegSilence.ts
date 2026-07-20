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

export function tempWavPathFor(mediaPath: string): string {
  const base = path.basename(mediaPath, path.extname(mediaPath));
  return path.join(require("os").tmpdir(), `capcut-lao-${base}-${Date.now()}.wav`);
}
