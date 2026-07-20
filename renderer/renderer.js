// Renderer process script. No Node/Electron APIs here directly — everything
// goes through the `window.capcutLao` bridge exposed by electron/preload.ts.

(function buildWaveformSignature() {
  const el = document.getElementById("waveform-signature");
  if (!el) return;
  const bars = [];
  const n = 28;
  for (let i = 0; i < n; i++) {
    // A gap in the middle represents the "Dead Air" this app detects & cuts.
    const inGap = i >= 12 && i <= 15;
    const h = inGap ? 3 : 6 + Math.round(14 * Math.abs(Math.sin(i * 0.7)));
    const color = inGap ? "#3A3C46" : i % 5 === 0 ? "#F2C641" : "#4FD1C540";
    bars.push(
      `<rect x="${i * 7}" y="${16 - h / 2}" width="3.5" height="${h}" rx="1.5" fill="${color}"></rect>`,
    );
  }
  el.innerHTML = `<svg width="${n * 7}" height="32" viewBox="0 0 ${n * 7} 32">${bars.join("")}</svg>`;
})();

let selectedAnimationMode = "karaoke";

function updateSubtitlePreview() {
  const previewEl = document.getElementById("subtitlePreviewText");
  if (!previewEl) return;

  const fontSizes = {
    small: "16px",
    medium: "20px",
    large: "24px",
    xl: "28px",
  };
  const textColors = {
    white: "#FFFFFF",
    yellow: "#F2C641",
    neon_green: "#39FF14",
  };

  const size = document.getElementById("fontSize").value;
  const colorKey = document.getElementById("textColor").value;
  const strokeColor = document.getElementById("strokeColor").value;
  const strokeWidth = document.getElementById("strokeWidth").value;
  const banner = document.getElementById("backgroundBanner").checked;
  const fontFamily =
    document.getElementById("fontFamily").value || "Noto Sans Lao Regular";

  previewEl.style.fontSize = fontSizes[size] || "16px";
  previewEl.style.color = textColors[colorKey] || "#FFFFFF";
  previewEl.style.fontFamily = `"${fontFamily}", "Noto Sans Lao", sans-serif`;
  previewEl.style.webkitTextStroke =
    strokeWidth > 0 ? `${strokeWidth}px ${strokeColor}` : "none";
  previewEl.style.background = banner ? "rgba(0, 0, 0, 0.75)" : "transparent";
  previewEl.style.boxShadow = banner ? "0 2px 8px rgba(0,0,0,0.5)" : "none";

  const highlightColor = colorKey === "yellow" ? "#39FF14" : "#F2C641";

  if (selectedAnimationMode === "karaoke") {
    previewEl.innerHTML = `<span style="font-size: 1.2em; font-weight: 700; color: ${highlightColor}; text-shadow: 0 0 10px ${highlightColor}66;">ສະບາຍດີ!</span> <span>ຍິນດີຕ້ອນຮັບ</span>`;
  } else if (selectedAnimationMode === "word_by_word") {
    previewEl.innerHTML = `<span>ສະບາຍດີ!</span>`;
  } else {
    previewEl.innerHTML = `<span>ສະບາຍດີ! ຍິນດີຕ້ອນຮັບເຂົ້າสู่ CapCut Lao Subtitler</span>`;
  }
}

const SETTINGS_STORAGE_KEY = "capcut_lao_subtitler_user_settings";

function saveUserSettings() {
  try {
    const speechStyleEl = document.querySelector('input[name="speechStyle"]:checked');
    const settings = {
      fontSize: document.getElementById("fontSize")?.value || "medium",
      textColor: document.getElementById("textColor")?.value || "white",
      position: document.getElementById("position")?.value || "lower_center",
      strokeColor: document.getElementById("strokeColor")?.value || "#000000",
      strokeWidth: document.getElementById("strokeWidth")?.value || "3",
      backgroundBanner: document.getElementById("backgroundBanner")?.checked || false,
      fontFamily: document.getElementById("fontFamily")?.value || "Noto Sans Lao Regular",
      selectedAnimationMode: selectedAnimationMode || "word_by_word",
      transcriptionEngine: document.getElementById("transcriptionEngine")?.value || "gemini",
      transcriptionModel: document.getElementById("transcriptionModel")?.value || "gemini-3.5-flash",
      speechStyle: speechStyleEl ? speechStyleEl.value : "verbatim",
      glossary: document.getElementById("glossary")?.value || "",
    };
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn("Could not save user settings:", err);
  }
}

function loadUserSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const settings = JSON.parse(raw);

    if (settings.fontSize && document.getElementById("fontSize")) {
      document.getElementById("fontSize").value = settings.fontSize;
    }
    if (settings.textColor && document.getElementById("textColor")) {
      document.getElementById("textColor").value = settings.textColor;
    }
    if (settings.position && document.getElementById("position")) {
      document.getElementById("position").value = settings.position;
    }
    if (settings.strokeColor && document.getElementById("strokeColor")) {
      document.getElementById("strokeColor").value = settings.strokeColor;
    }
    if (settings.strokeWidth && document.getElementById("strokeWidth")) {
      document.getElementById("strokeWidth").value = settings.strokeWidth;
    }
    if (typeof settings.backgroundBanner === "boolean" && document.getElementById("backgroundBanner")) {
      document.getElementById("backgroundBanner").checked = settings.backgroundBanner;
    }
    if (settings.fontFamily && document.getElementById("fontFamily")) {
      document.getElementById("fontFamily").value = settings.fontFamily;
    }

    if (settings.selectedAnimationMode) {
      selectedAnimationMode = settings.selectedAnimationMode;
      document.querySelectorAll(".mode-card").forEach((card) => {
        if (card.dataset.mode === selectedAnimationMode) {
          card.classList.add("is-selected");
        } else {
          card.classList.remove("is-selected");
        }
      });
    }

    if (settings.speechStyle) {
      const radio = document.querySelector(`input[name="speechStyle"][value="${settings.speechStyle}"]`);
      if (radio) radio.checked = true;
    }

    if (settings.glossary !== undefined && document.getElementById("glossary")) {
      document.getElementById("glossary").value = settings.glossary;
    }
  } catch (err) {
    console.warn("Could not load user settings:", err);
  }
}

document.querySelectorAll(".mode-card").forEach((card) => {
  card.addEventListener("click", () => {
    document
      .querySelectorAll(".mode-card")
      .forEach((c) => c.classList.remove("is-selected"));
    card.classList.add("is-selected");
    selectedAnimationMode = card.dataset.mode;
    updateSubtitlePreview();
    saveUserSettings();
  });
});

[
  "fontSize",
  "textColor",
  "position",
  "strokeColor",
  "strokeWidth",
  "backgroundBanner",
  "fontFamily",
  "glossary",
  "transcriptionEngine",
  "transcriptionModel",
].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("input", () => {
      updateSubtitlePreview();
      saveUserSettings();
    });
    el.addEventListener("change", () => {
      updateSubtitlePreview();
      saveUserSettings();
    });
  }
});

document.querySelectorAll('input[name="speechStyle"]').forEach((radio) => {
  radio.addEventListener("change", saveUserSettings);
});

// Load stored settings on start
loadUserSettings();
setTimeout(updateSubtitlePreview, 100);

const apiKeyInput = document.getElementById("apiKey");
const toggleKeyVisibility = document.getElementById("toggleKeyVisibility");
toggleKeyVisibility.addEventListener("click", () => {
  const isPw = apiKeyInput.type === "password";
  apiKeyInput.type = isPw ? "text" : "password";
  toggleKeyVisibility.textContent = isPw ? "ຊ່ອນ" : "ສະແດງ";
});

const rememberKeyCheckbox = document.getElementById("rememberKey");
const projectDirInput = document.getElementById("projectDir");
const browseDirBtn = document.getElementById("browseDir");
const transcriptionEngineSelect = document.getElementById(
  "transcriptionEngine",
);
const transcriptionModelSelect = document.getElementById("transcriptionModel");

const modelOptionsByEngine = {
  gemini: [
    { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (โควต้าเยอะ 500 RPD - แนะนำ)" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash (รวดเร็ว & แม่นยำสูง)" },
    { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (โควต้าว่าง)" },
    { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash (โควต้าเต็ม 20 RPD)" },
  ],
};

function updateTranscriptionModelOptions() {
  if (!transcriptionEngineSelect || !transcriptionModelSelect) return;
  const engine = transcriptionEngineSelect.value;
  const options = modelOptionsByEngine[engine] || [];
  transcriptionModelSelect.innerHTML = "";
  for (const opt of options) {
    const optionEl = document.createElement("option");
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    transcriptionModelSelect.appendChild(optionEl);
  }
}

transcriptionEngineSelect?.addEventListener(
  "change",
  updateTranscriptionModelOptions,
);
updateTranscriptionModelOptions();

// Restore a remembered key on load, if present.
window.capcutLao.loadApiKey().then((key) => {
  if (key) {
    apiKeyInput.value = key;
    rememberKeyCheckbox.checked = true;
  }
});

apiKeyInput.addEventListener("change", async () => {
  if (rememberKeyCheckbox.checked && apiKeyInput.value) {
    await window.capcutLao.saveApiKey(apiKeyInput.value);
  }
});

rememberKeyCheckbox.addEventListener("change", async () => {
  if (rememberKeyCheckbox.checked && apiKeyInput.value) {
    await window.capcutLao.saveApiKey(apiKeyInput.value);
  } else if (!rememberKeyCheckbox.checked) {
    await window.capcutLao.clearApiKey();
  }
});

browseDirBtn.addEventListener("click", async () => {
  const dir = await window.capcutLao.selectProjectDirectory();
  if (dir) {
    projectDirInput.value = dir;
    saveUserSettings();
  }
});

// ---------------------------------------------------------------------------
// Run pipeline
// ---------------------------------------------------------------------------
const runBtn = document.getElementById("runBtn");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
const progressPercent = document.getElementById("progressPercent");
const statusMessage = document.getElementById("statusMessage");

function collectConfig() {
  return {
    projectDir: projectDirInput.value,
    apiKey: apiKeyInput.value,
    subtitleStyle: {
      fontSize: document.getElementById("fontSize").value,
      textColor: document.getElementById("textColor").value,
      position: document.getElementById("position").value,
      strokeColor: document.getElementById("strokeColor").value,
      strokeWidth: parseInt(document.getElementById("strokeWidth").value, 10),
      backgroundBanner: document.getElementById("backgroundBanner").checked,
      fontFamily: document.getElementById("fontFamily").value,
      animationMode: selectedAnimationMode,
    },
    transcription: {
      engine: document.getElementById("transcriptionEngine").value,
      model: document.getElementById("transcriptionModel").value,
      speechStyle: document.querySelector('input[name="speechStyle"]:checked')
        .value,
      glossary: document.getElementById("glossary").value,
    },
    timeline: {
      linkSubtitleToClip: true,
      saveMode: "overwrite",
    },
  };
}

function validateConfig(cfg) {
  if (!cfg.projectDir) return "ກະລຸນາເລືອກໂຟນເດີໂຄງການ CapCut ກ່ອນ.";
  if (!cfg.apiKey) return "ກະລຸນາປ້ອນ API key.";
  if (!cfg.transcription.engine) return "ກະລຸນາເລືອກ transcription engine.";
  if (!cfg.transcription.model) return "ກະລຸນາເລືອກ model.";
  return null;
}

window.capcutLao.onProgress((p) => {
  progressWrap.classList.remove("hidden");
  progressBar.style.width = `${p.percent}%`;
  progressPercent.textContent = `${p.percent}%`;
  progressLabel.textContent = p.message;
  if (p.stage === "error") {
    statusMessage.textContent = `ຂໍ້ຜິດພາດ: ${p.message}`;
    statusMessage.classList.add("text-danger");
  }
});

runBtn.addEventListener("click", async () => {
  saveUserSettings();
  const config = collectConfig();
  const error = validateConfig(config);
  if (error) {
    statusMessage.textContent = error;
    statusMessage.classList.add("text-danger");
    return;
  }

  statusMessage.classList.remove("text-danger");
  statusMessage.textContent = "";
  runBtn.disabled = true;
  progressWrap.classList.remove("hidden");

  const result = await window.capcutLao.runPipeline(config);

  runBtn.disabled = false;
  if (result.ok) {
    statusMessage.textContent = `ສຳເລັດແລ້ວ — ສ້າງຊັບໄຕເຕີ້ນ ${result.subtitlesGenerated} ຂໍ້ຄວາມ → ${result.outputPath}`;
  } else {
    statusMessage.textContent = `ລົ້ມເຫຼວ: ${result.error}`;
    statusMessage.classList.add("text-danger");
  }
});
