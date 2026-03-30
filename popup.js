// AI Content Detector - Popup Script v2.0

const scanBtn        = document.getElementById("scanBtn");
const clearBtn       = document.getElementById("clearBtn");
const githubSection  = document.getElementById("githubSection");
const githubToggle   = document.getElementById("githubToggle");
const githubToken    = document.getElementById("githubToken");
const ghStatusDot    = document.getElementById("ghStatusDot");
const githubRepo     = document.getElementById("githubRepo");
const githubFilePath = document.getElementById("githubFilePath");
const modelStatus    = document.getElementById("modelStatus");
const modelStatusText= document.getElementById("modelStatusText");
const syncBtn        = document.getElementById("syncBtn");

/* ── Load stored settings ──────────────────────────────────── */

chrome.storage.local.get(
  ["githubToken", "githubRepo", "githubFilePath", "modelConfig", "githubExpanded"],
  ({ githubToken: ghTok, githubRepo: ghRepo, githubFilePath: ghFile, modelConfig, githubExpanded }) => {
    if (ghTok)  { githubToken.value = ghTok; githubToken.classList.add("saved"); ghStatusDot.classList.add("active"); }
    if (ghRepo)  githubRepo.value  = ghRepo;
    if (ghFile)  githubFilePath.value = ghFile;
    if (githubExpanded) githubSection.classList.remove("collapsed");
    if (modelConfig) showModelStatus(modelConfig);
  }
);

/* ── Persist GitHub fields ─────────────────────────────────── */

debounceInput(githubToken, (val) => {
  if (val) {
    chrome.storage.local.set({ githubToken: val });
    githubToken.classList.add("saved");
    ghStatusDot.classList.add("active");
  } else {
    chrome.storage.local.remove("githubToken");
    githubToken.classList.remove("saved");
    ghStatusDot.classList.remove("active");
  }
});

debounceInput(githubRepo, (val) =>
  val ? chrome.storage.local.set({ githubRepo: val }) : chrome.storage.local.remove("githubRepo")
);

debounceInput(githubFilePath, (val) =>
  val ? chrome.storage.local.set({ githubFilePath: val }) : chrome.storage.local.remove("githubFilePath")
);

/* ── GitHub toggle ─────────────────────────────────────────── */

githubToggle.addEventListener("click", () => {
  const collapsed = githubSection.classList.toggle("collapsed");
  chrome.storage.local.set({ githubExpanded: !collapsed });
});

/* ── Model status ──────────────────────────────────────────── */

function showModelStatus(cfg) {
  if (!cfg) return;
  modelStatus.style.display = "flex";
  const date = cfg.updatedAt
    ? new Date(cfg.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "—";
  modelStatusText.innerHTML =
    `<strong>Weights v${cfg.version}</strong> · ${date} · ` +
    `fp=${(cfg.lastFpRate * 100).toFixed(0)}% · ` +
    `thresholds ${cfg.thresholdHigh?.toFixed(1)}/${cfg.thresholdMed?.toFixed(1)}`;
}

syncBtn.addEventListener("click", () => {
  syncBtn.textContent = "↻ …";
  syncBtn.disabled = true;
  chrome.runtime.sendMessage({ action: "syncModelConfig" }, (res) => {
    syncBtn.textContent = "↻ Sync";
    syncBtn.disabled = false;
    if (res?.modelConfig) showModelStatus(res.modelConfig);
    else { syncBtn.textContent = "✗ Error"; setTimeout(() => { syncBtn.textContent = "↻ Sync"; }, 2000); }
  });
});

/* ── Scan button ───────────────────────────────────────────── */

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  scanBtn.innerHTML = '<span class="spinner"></span> Scanning…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: "scan" });
  } catch {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.tabs.sendMessage(tab.id, { action: "scan" });
    } catch (e) { console.error("Inject error:", e); }
  }

  setTimeout(() => {
    scanBtn.disabled = false;
    scanBtn.innerHTML = "<span>⚡</span> Scan Page";
  }, 2000);
});

/* ── Clear button ──────────────────────────────────────────── */

clearBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: "clear" });
  } catch (e) { console.error("Clear error:", e); }
});

/* ── Utility ───────────────────────────────────────────────── */

function debounceInput(input, callback, delay = 400) {
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(input.value.trim()), delay);
  });
}
