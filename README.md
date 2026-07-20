# CapCut Lao Subtitler

Electron + TypeScript desktop app that generates Lao subtitles using OpenAI Whisper
and writes them into `draft_content.json` so the timeline remains editable in CapCut.
in place, so everything stays 100% editable inside CapCut afterward.

## Project layout

```
electron/
  main.ts          Window creation, directory picker, secure key storage, IPC
  preload.ts        contextBridge — safe API surface exposed to the renderer
src/core/
  types.ts                 Shared config / result types
  ffmpegSilence.ts          Dead Air detection (ffmpeg silencedetect) + audio extraction
  subtitleBuilder.ts        Sentence / word-by-word / karaoke cue construction
  draftContentEditor.ts     Reads, trims, and writes draft_content.json
  pipeline.ts                Orchestrates the full run end-to-end
renderer/
  index.html / styles.css / renderer.js   The UI (Tailwind via CDN for this scaffold)
```

## Setup

```bash
npm install
npm run dev        # compiles TS and launches the Electron window
```

Requires Node 18+. FFmpeg is bundled via `ffmpeg-static`, so a system install
isn't required, but if `ffmpeg-static` fails to download (e.g. restricted
network), install FFmpeg system-wide and it will be picked up from PATH as a
fallback (`src/core/ffmpegSilence.ts` → `resolveFfmpegPath()`).

## Building the Windows .exe

```bash
npm run dist
```

This runs `electron-builder` with the `nsis` target for Windows, producing an
installer under `release/`. Drop a real `.ico` into `build/icon.ico` before
shipping — a placeholder isn't included here (a missing icon only prints a
warning and falls back to the default Electron icon, it won't fail the build).

**If the build fails with `Cannot create symbolic link: A required privilege
is not held by the client`** (extracting `winCodeSign`): this is a Windows
permissions issue, not a project bug. `electron-builder` tries to download a
code-signing toolkit that contains macOS `.dylib` files packed as symlinks,
and normal Windows user accounts can't create symlinks by default. The `dist`
script already sets `CSC_IDENTITY_AUTO_DISCOVERY=false` (via `cross-env`) to
skip that lookup entirely, which is the standard fix. If it still happens on
your machine, either:

- Run the terminal as Administrator, or
- Turn on Windows Developer Mode (Settings → Privacy & security → For
  developers → Developer Mode), which grants symlink creation to your normal
  account permanently — useful since other native-module installs can hit the
  same wall.

## ⚠️ Before you rely on this in production

**1. The `draft_content.json` schema is assumed, not confirmed.**
CapCut's project format isn't publicly documented and has changed across app
versions. `src/core/draftContentEditor.ts` has a full disclaimer at the top
describing the exact shape it assumes (`tracks[].segments[].target_timerange`,
`materials.texts[]`, etc.), based on structure widely reverse-engineered by
the CapCut scripting community. Before running this against real projects:

- Open a `draft_content.json` from the CapCut version you're targeting and
  diff its field names against the comment block in `draftContentEditor.ts`.
- `loadDraft()` runs a schema sanity check and throws a clear error if the
  basic shape (`tracks`, `duration`, `materials`) is missing — but it can't
  catch subtler field-name drift (e.g. if `target_timerange` was renamed).
- Every run writes a timestamped `draft_content.backup.<ts>.json` before
  touching anything, regardless of Save Mode, as a safety net.

**2. API key storage.** The spec mentioned `localStorage`, which isn't a safe
place to keep a secret at rest — it's an unencrypted file. This scaffold uses
Electron's `safeStorage` API instead (OS-level encryption — DPAPI on Windows)
behind the same "Remember Key" toggle UX, no extra native dependencies (e.g.
`keytar`) required.

**3. Transcription/trim ordering.** The pipeline currently: detects silence →
trims the CapCut timeline → extracts audio from the _original_ source file →
transcribes → writes subtitles using timestamps relative to that original
(untrimmed) audio, converted straight into `target_timerange` on a new text
track laid over the _trimmed_ video. If your Dead Air cuts are non-trivial in
number, subtitle timing will drift from the trimmed video because it isn't
re-mapped through the same cut list yet. The cut list computed in
`applyDeadAirCuts()` (as `SilenceSegment[]`) needs to also be applied to the
transcription timestamps before building cues — that re-mapping step is the
next thing to implement in `pipeline.ts` (search `TODO` once you add it).

**4. Locating the source video.** `findPrimarySourceMedia()` currently just
picks the largest video file in the project folder by file size. For
robustness, prefer resolving the path directly from
`draft.json.materials.videos[0].path` once the real schema is confirmed.

## Design

The UI uses a dark editor-tool palette (`#14151A` background, `#F2C641` gold
accent nodding to Lao gold-leaf ornamentation, `#4FD1C5` teal reserved for
karaoke-mode word highlighting) with Space Grotesk for headers, Inter for UI
text, and JetBrains Mono for paths/technical fields. The repeating bar pattern
between sections is a waveform-with-a-gap motif — a literal depiction of the
Dead Air this tool detects and cuts, used as the section divider throughout
instead of a plain hairline.
