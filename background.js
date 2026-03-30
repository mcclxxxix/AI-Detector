// AI Content Detector - Background Service Worker v2.0
// No Anthropic API — pure local heuristics + GitHub feedback log
// Model calibration is statistical, not LLM-based

const FEEDBACK_THRESHOLD = 5;

chrome.runtime.onInstalled.addListener(() => {
  console.log("AI Content Detector v2.0 installed.");
  syncModelConfig();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "saveFeedback") {
    handleFeedback(msg.data, sender.tab)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.action === "syncModelConfig") {
    syncModelConfig().then(sendResponse).catch(() => sendResponse({ error: "sync failed" }));
    return true;
  }
});

/* ── GitHub helpers ──────────────────────────────────────────── */

async function getGitHubConfig() {
  const { githubToken, githubRepo, githubFilePath } = await chrome.storage.local.get([
    "githubToken", "githubRepo", "githubFilePath",
  ]);
  if (!githubToken || !githubRepo) throw new Error("GitHub not configured");
  const parts = githubRepo.split("/");
  if (parts.length !== 2) throw new Error("Invalid repo — use owner/repo format");
  const [owner, repo] = parts;
  const filePath = githubFilePath?.trim() || "ai-confidence-log.json";
  return { token: githubToken, owner, repo, filePath };
}

async function ghRequest(config, path, options = {}) {
  return fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function fetchLogFile(config) {
  const res = await ghRequest(config, config.filePath);
  if (res.status === 404) return { data: { entries: [], modelConfig: null }, sha: null };
  if (!res.ok) throw new Error(`GitHub read error ${res.status}`);
  const json = await res.json();
  const decoded = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ""))));
  return { data: JSON.parse(decoded), sha: json.sha };
}

async function writeLogFile(config, data, sha, commitMessage) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const body = { message: commitMessage, content: encoded };
  if (sha) body.sha = sha;
  const res = await ghRequest(config, config.filePath, { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub write error ${res.status}`);
  }
  return res.json();
}

async function uploadScreenshot(config, dataUrl, timestamp) {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const path = `screenshots/feedback-${timestamp}.png`;
  const res = await ghRequest(config, path, {
    method: "PUT",
    body: JSON.stringify({ message: `Screenshot for feedback ${timestamp}`, content: base64 }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.content?.html_url || null;
}

/* ── Handle one feedback entry ───────────────────────────────── */

async function handleFeedback(data, tab) {
  const config = await getGitHubConfig();
  const timestamp = Date.now();

  let screenshotUrl = null;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    screenshotUrl = await uploadScreenshot(config, dataUrl, timestamp);
  } catch (e) {
    console.warn("Screenshot failed:", e.message);
  }

  const entry = {
    id: `fb-${timestamp}`,
    timestamp: new Date(timestamp).toISOString(),
    url: tab.url,
    pageTitle: tab.title || "",
    blockText: data.blockText.slice(0, 400),
    confidence: data.confidence,
    score: data.score,
    signals: data.signals,          // raw signal values — used for weight tuning
    feedback: data.feedback,        // "correct" | "incorrect"
    screenshotUrl,
    usedForUpdate: false,
  };

  const { data: logData, sha } = await fetchLogFile(config);
  logData.entries = logData.entries || [];
  logData.entries.push(entry);

  const symbol = data.feedback === "correct" ? "✓" : "✗";
  const hostname = (() => { try { return new URL(tab.url).hostname; } catch { return tab.url; } })();
  await writeLogFile(config, logData, sha,
    `[${symbol}] ${data.confidence} confidence feedback on ${hostname}`);

  const pending = logData.entries.filter((e) => !e.usedForUpdate);
  const untilUpdate = Math.max(0, FEEDBACK_THRESHOLD - pending.length);

  if (untilUpdate === 0) {
    recalibrateWeights(config).catch((e) => console.error("Recalibration failed:", e));
  }

  return { success: true, totalEntries: logData.entries.length, untilUpdate };
}

/* ── Statistical weight recalibration (no LLM needed) ────────── */
//
// Logic:
//   For each signal S, look at all pending entries:
//   - If feedback === "correct"  (true positive):  signal fired correctly → reinforce weight
//   - If feedback === "incorrect" (false positive): signal fired wrongly   → reduce weight
//
// The adjustment is small (+/- 10%) so it converges gradually.

async function recalibrateWeights(config) {
  const { data: logData, sha } = await fetchLogFile(config);
  const pending = (logData.entries || [])
    .filter((e) => !e.usedForUpdate)
    .slice(0, FEEDBACK_THRESHOLD);

  if (pending.length < FEEDBACK_THRESHOLD) return;

  // Load current weights from local storage (or use defaults)
  const { modelConfig } = await chrome.storage.local.get("modelConfig");
  const currentWeights = { ...DEFAULT_WEIGHTS, ...(modelConfig?.weights || {}) };

  const SIGNAL_KEYS = Object.keys(currentWeights);
  const adjustment = {};

  SIGNAL_KEYS.forEach((key) => {
    let delta = 0;
    let count = 0;
    pending.forEach((entry) => {
      const signalVal = entry.signals?.[key] ?? 0;
      if (signalVal < 0.1) return; // signal wasn't active for this block
      count++;
      if (entry.feedback === "correct") {
        delta += 0.10; // signal contributed to a correct detection → boost
      } else {
        delta -= 0.12; // signal contributed to a false positive → reduce
      }
    });
    adjustment[key] = count > 0 ? delta / count : 0;
  });

  // Apply adjustments, clamp weights to [0.2, 4.0]
  const newWeights = {};
  SIGNAL_KEYS.forEach((key) => {
    newWeights[key] = Math.min(4.0, Math.max(0.2,
      (currentWeights[key] ?? 1) + adjustment[key]
    ));
  });

  // Adjust thresholds: too many false positives → raise thresholds
  const fpRate = pending.filter((e) => e.feedback === "incorrect").length / pending.length;
  const fnRate = pending.filter((e) => e.feedback === "correct" && e.score < 4).length / pending.length;

  const prevHigh = modelConfig?.thresholdHigh ?? DEFAULT_THRESH_HIGH;
  const prevMed  = modelConfig?.thresholdMed  ?? DEFAULT_THRESH_MED;

  let thresholdHigh = prevHigh;
  let thresholdMed  = prevMed;

  if (fpRate > 0.5) {
    thresholdHigh = Math.min(8.5, prevHigh + 0.3);
    thresholdMed  = Math.min(6.0, prevMed  + 0.2);
  } else if (fnRate > 0.5) {
    thresholdHigh = Math.max(3.0, prevHigh - 0.3);
    thresholdMed  = Math.max(1.5, prevMed  - 0.2);
  }

  // Mark entries as used
  const usedIds = new Set(pending.map((e) => e.id));
  logData.entries = logData.entries.map((e) =>
    usedIds.has(e.id) ? { ...e, usedForUpdate: true } : e
  );

  const version = (logData.modelConfig?.version || 0) + 1;
  const newModelConfig = {
    version,
    updatedAt: new Date().toISOString(),
    weights: newWeights,
    thresholdHigh,
    thresholdMed,
    basedOnEntries: pending.length,
    totalEntries: logData.entries.length,
    lastFpRate: fpRate.toFixed(2),
    lastFnRate: fnRate.toFixed(2),
  };

  logData.modelConfig = newModelConfig;

  const { sha: freshSha } = await fetchLogFile(config);
  await writeLogFile(config, logData, freshSha,
    `🧠 Weight recalibration v${version} (fp=${(fpRate * 100).toFixed(0)}%, fn=${(fnRate * 100).toFixed(0)}%)`
  );

  await chrome.storage.local.set({ modelConfig: newModelConfig });
  console.log(`AI Detector: weights recalibrated to v${version}`);
}

async function syncModelConfig() {
  try {
    const config = await getGitHubConfig();
    const { data } = await fetchLogFile(config);
    if (data.modelConfig) {
      await chrome.storage.local.set({ modelConfig: data.modelConfig });
    }
    const pending = (data.entries || []).filter((e) => !e.usedForUpdate).length;
    return { modelConfig: data.modelConfig, totalEntries: data.entries?.length || 0, pending };
  } catch (e) {
    if (!e.message.includes("not configured")) console.warn("Sync failed:", e.message);
    return null;
  }
}

const DEFAULT_WEIGHTS = {
  formulaicTransitions : 2.2,
  hedgingLanguage      : 2.0,
  genericOpeners       : 1.8,
  balancedStructure    : 1.6,
  lowSentenceVariance  : 1.5,
  adverbDensity        : 1.3,
  passiveVoice         : 1.1,
  uniformParagraphs    : 1.0,
  repetitiveStarters   : 1.2,
  lackOfContractions   : 0.8,
  excessivePunctuation : 0.7,
};
