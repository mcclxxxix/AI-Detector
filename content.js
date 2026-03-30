// AI Content Detector - Content Script v2.0
// Pure local heuristics — no API required

(() => {
  const BLOCK_SELECTORS =
    "p, article, section, blockquote, .post-content, .entry-content, .article-body, li, td, h1, h2, h3, h4, h5, h6, figcaption, dd, dt";
  const MIN_TEXT_LENGTH = 80;
  const MAX_BLOCKS_PER_BATCH = 50;

  let isScanning = false;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "scan") {
      if (isScanning) { sendResponse({ status: "already_scanning" }); return; }
      scanPage();
      sendResponse({ status: "started" });
    }
    if (msg.action === "clear") {
      clearHighlights();
      sendResponse({ status: "cleared" });
    }
  });

  // ────────────────────────────────────────────────────────────────
  //  HEURISTICS ENGINE
  // ────────────────────────────────────────────────────────────────

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

  const DEFAULT_THRESH_HIGH = 5.5;
  const DEFAULT_THRESH_MED  = 3.2;

  const FORMULAIC_TRANSITIONS = [
    /\b(moreover|furthermore|additionally|in addition|consequently|therefore|thus|hence|nevertheless|nonetheless|however|on the contrary|in contrast|conversely|in conclusion|to summarize|in summary|to sum up|as a result|as mentioned|as noted|it is worth noting|it is important to note|it should be noted|building on this|with this in mind|in light of this)\b/gi,
  ];

  const HEDGING_PHRASES = [
    /\bit(?:'s| is) (?:important|worth|crucial|essential|vital) to (?:note|understand|consider|remember|acknowledge|recognize)\b/gi,
    /\bwhile there (?:are|is) (?:many|several|various|numerous) (?:factors|aspects|considerations|reasons|ways)\b/gi,
    /\bit (?:is|can be) (?:argued|suggested|posited|contended|noted) that\b/gi,
    /\bthis (?:is|can be) (?:a|an) (?:complex|nuanced|multifaceted|challenging)\b/gi,
    /\bdepending on (?:the|your|various|a number of)\b/gi,
    /\bin (?:many|some|certain|most) (?:cases|situations|contexts|instances|scenarios)\b/gi,
  ];

  const GENERIC_OPENERS = [
    /^in today['']?s (?:fast[\s-]paced|modern|digital|rapidly changing|ever[\s-]changing)/i,
    /^in recent years[,.]/i,
    /^(?:the|our) world (?:is|has|we live)/i,
    /^(?:as|with) (?:technology|ai|the internet|social media) (?:continues|advances|evolves|shapes)/i,
    /^(?:have you ever|did you know|imagine a world)/i,
    /^(?:understanding|exploring|navigating|mastering|unlocking) (?:the|your|this)/i,
    /^when it comes to/i,
    /^one of the (?:most|key|primary|main|greatest|biggest) (?:important|significant|critical|crucial|essential)/i,
  ];

  const BALANCED_STRUCTURE = [
    /\bon (?:the |)one hand\b[\s\S]{0,200}\bon (?:the |)other hand\b/i,
    /\bpros and cons\b/i,
    /\b(?:advantages|benefits)\b[\s\S]{0,120}\b(?:disadvantages|drawbacks|challenges|limitations)\b/i,
  ];

  function countMatches(text, patterns) {
    let n = 0;
    patterns.forEach((p) => { const m = text.match(p); if (m) n += m.length; });
    return n;
  }

  function wordCount(text) {
    return (text.match(/\b\w+\b/g) || []).length;
  }

  function sentences(text) {
    return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 5);
  }

  function variance(arr) {
    if (arr.length < 2) return 999;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((acc, v) => acc + (v - mean) ** 2, 0) / arr.length;
  }

  function scoreBlock(text, weights) {
    const wc = wordCount(text);
    if (wc < 15) return { score: 0, signals: {} };

    const sents    = sentences(text);
    const sentLens = sents.map((s) => wordCount(s));
    const sentVar  = variance(sentLens);
    const signals  = {};

    // 1. Formulaic transitions
    const transitions = countMatches(text, FORMULAIC_TRANSITIONS);
    signals.formulaicTransitions = Math.min(1, (transitions / wc) * 100 / 2.5);

    // 2. Hedging language
    const hedges = countMatches(text, HEDGING_PHRASES);
    signals.hedgingLanguage = Math.min(1, hedges / 2);

    // 3. Generic openers
    const firstLine = text.slice(0, 120);
    signals.genericOpeners = GENERIC_OPENERS.some((p) => p.test(firstLine)) ? 1 : 0;

    // 4. Balanced structure
    const balanced = countMatches(text, BALANCED_STRUCTURE);
    signals.balancedStructure = Math.min(1, balanced / 1.5);

    // 5. Low sentence length variance (AI is suspiciously uniform)
    if (sents.length >= 3) {
      const normVar = Math.min(sentVar, 80) / 80;
      signals.lowSentenceVariance = 1 - normVar;
    } else {
      signals.lowSentenceVariance = 0;
    }

    // 6. Adverb density (-ly words)
    const adverbs = (text.match(/\b\w+ly\b/g) || []).length;
    signals.adverbDensity = Math.min(1, (adverbs / wc) * 100 / 8);

    // 7. Passive voice
    const passive = (text.match(/\b(?:is|are|was|were|been|being)\s+\w+ed\b/gi) || []).length;
    signals.passiveVoice = Math.min(1, (passive / wc) * 100 / 5);

    // 8. Uniform paragraph lengths
    const paras = text.split(/\n\s*\n/).filter((p) => p.trim().length > 20);
    if (paras.length >= 3) {
      const paraVar = variance(paras.map((p) => wordCount(p)));
      signals.uniformParagraphs = paraVar < 50 ? 1 - paraVar / 50 : 0;
    } else {
      signals.uniformParagraphs = 0;
    }

    // 9. Repetitive sentence starters
    if (sents.length >= 4) {
      const starters = sents.map((s) => s.split(/\s+/)[0]?.toLowerCase() || "");
      const freq = {};
      starters.forEach((w) => { freq[w] = (freq[w] || 0) + 1; });
      const maxFreq = Math.max(...Object.values(freq));
      signals.repetitiveStarters = maxFreq / sents.length >= 0.3 ? 0.8 : 0;
    } else {
      signals.repetitiveStarters = 0;
    }

    // 10. Lack of contractions
    const contractions = (text.match(/\b\w+['']\w+\b/g) || []).length;
    signals.lackOfContractions = contractions === 0 && wc > 50 ? 0.9 : 0;

    // 11. Excessive formal punctuation
    const formalPunct = (text.match(/[:;]/g) || []).length;
    signals.excessivePunctuation = Math.min(1, (formalPunct / wc) * 100 / 6);

    // Weighted total → 0–10 scale
    let score = 0, totalWeight = 0;
    Object.entries(signals).forEach(([key, val]) => {
      const w = weights[key] ?? DEFAULT_WEIGHTS[key] ?? 1;
      score       += val * w;
      totalWeight += w;
    });
    const normalised = totalWeight > 0 ? (score / totalWeight) * 10 : 0;

    return { score: normalised, signals };
  }

  function classifyBlock(text, weights, threshHigh, threshMed) {
    const { score, signals } = scoreBlock(text, weights);
    if (score >= threshHigh) return { ai: true,  confidence: "high",   score, signals };
    if (score >= threshMed)  return { ai: true,  confidence: "medium", score, signals };
    return                          { ai: false, confidence: "low",    score, signals };
  }

  // ────────────────────────────────────────────────────────────────
  //  PAGE SCANNING
  // ────────────────────────────────────────────────────────────────

  function showToast(text, spinner = false) {
    let toast = document.querySelector(".ai-detector-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "ai-detector-toast";
      document.body.appendChild(toast);
    }
    toast.innerHTML = spinner
      ? `<div class="ai-detector-toast-spinner"></div><span>${text}</span>`
      : `<div class="ai-detector-toast-icon">✓</div><span>${text}</span>`;
    requestAnimationFrame(() => toast.classList.add("visible"));
    if (!spinner) {
      setTimeout(() => {
        toast.classList.remove("visible");
        setTimeout(() => toast.remove(), 400);
      }, 4000);
    }
    return toast;
  }

  function clearHighlights() {
    document.querySelectorAll(".ai-detector-highlight").forEach((el) => {
      el.classList.remove(
        "ai-detector-highlight",
        "ai-detector-confidence-high",
        "ai-detector-confidence-medium",
        "ai-detector-scanning"
      );
      el.style.removeProperty("position");
      const badge = el.querySelector(".ai-detector-badge");
      if (badge) badge.remove();
    });
    const toast = document.querySelector(".ai-detector-toast");
    if (toast) toast.remove();
  }

  function getContentBlocks() {
    const elements = document.querySelectorAll(BLOCK_SELECTORS);
    const blocks = [], seen = new Set();
    elements.forEach((el) => {
      if (
        el.offsetParent === null ||
        el.closest("nav, footer, header, aside, script, style, noscript, .ai-detector-toast")
      ) return;
      const text = getDirectText(el).trim();
      if (text.length < MIN_TEXT_LENGTH) return;
      const sig = text.slice(0, 120);
      if (seen.has(sig)) return;
      seen.add(sig);
      blocks.push({ element: el, text });
    });
    return blocks;
  }

  function getDirectText(el) {
    const INLINE = new Set(["a","span","strong","b","em","i","u","code","mark","small","sub","sup","abbr"]);
    let text = "";
    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
      else if (node.nodeType === Node.ELEMENT_NODE && INLINE.has(node.tagName.toLowerCase()))
        text += node.textContent;
    });
    return text;
  }

  async function scanPage() {
    isScanning = true;
    clearHighlights();

    const blocks = getContentBlocks();
    if (blocks.length === 0) {
      showToast("No scannable content found on this page.");
      isScanning = false;
      return;
    }

    const toast = showToast(`Scanning ${blocks.length} content blocks…`, true);

    const { modelConfig } = await chrome.storage.local.get("modelConfig");
    const weights    = { ...DEFAULT_WEIGHTS, ...(modelConfig?.weights || {}) };
    const threshHigh = modelConfig?.thresholdHigh ?? DEFAULT_THRESH_HIGH;
    const threshMed  = modelConfig?.thresholdMed  ?? DEFAULT_THRESH_MED;

    let totalAI = 0;
    blocks.forEach((b) => b.element.classList.add("ai-detector-scanning"));

    for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_BATCH) {
      const batch = blocks.slice(i, i + MAX_BLOCKS_PER_BATCH);
      batch.forEach((block) => {
        block.element.classList.remove("ai-detector-scanning");
        const result = classifyBlock(block.text, weights, threshHigh, threshMed);
        if (result.ai) {
          totalAI++;
          applyHighlight(block.element, result.confidence, block.text, result.score, result.signals);
        }
      });
      if (i + MAX_BLOCKS_PER_BATCH < blocks.length) await new Promise((r) => setTimeout(r, 0));
      if (toast) {
        const scanned = Math.min(i + MAX_BLOCKS_PER_BATCH, blocks.length);
        toast.querySelector("span").textContent =
          `Scanned ${scanned}/${blocks.length} blocks… (${totalAI} AI detected)`;
      }
    }

    if (toast) toast.remove();
    showToast(
      totalAI > 0
        ? `Done — ${totalAI} AI-generated section${totalAI > 1 ? "s" : ""} detected.`
        : "Done — no AI-generated content detected."
    );
    isScanning = false;
  }

  // ── Badge ────────────────────────────────────────────────────────

  function applyHighlight(element, confidence, blockText, score, signals) {
    element.classList.add("ai-detector-highlight");
    element.classList.add(confidence === "high" ? "ai-detector-confidence-high" : "ai-detector-confidence-medium");
    if (getComputedStyle(element).position === "static") element.style.position = "relative";

    const badge = document.createElement("div");
    badge.className = "ai-detector-badge";

    const label = document.createElement("span");
    label.className = "ai-detector-badge-label";
    label.textContent = confidence === "high" ? "AI Generated" : "Likely AI";

    const scoreChip = document.createElement("span");
    scoreChip.className = "ai-detector-badge-score";
    scoreChip.textContent = score.toFixed(1);
    scoreChip.title = buildSignalTooltip(signals);

    const divider = document.createElement("span");
    divider.className = "ai-detector-badge-divider";
    divider.textContent = "|";

    const thumbUp = document.createElement("button");
    thumbUp.className = "ai-detector-thumb";
    thumbUp.textContent = "👍";
    thumbUp.title = "Correct — this IS AI-generated";
    thumbUp.addEventListener("click", (e) => {
      e.stopPropagation(); e.preventDefault();
      sendFeedback(blockText, confidence, score, signals, "correct", badge);
    });

    const thumbDown = document.createElement("button");
    thumbDown.className = "ai-detector-thumb";
    thumbDown.textContent = "👎";
    thumbDown.title = "Incorrect — this is NOT AI-generated";
    thumbDown.addEventListener("click", (e) => {
      e.stopPropagation(); e.preventDefault();
      sendFeedback(blockText, confidence, score, signals, "incorrect", badge);
    });

    badge.append(label, scoreChip, divider, thumbUp, thumbDown);
    element.appendChild(badge);
  }

  function buildSignalTooltip(signals) {
    return Object.entries(signals)
      .filter(([, v]) => v > 0.05)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}: ${(v * 100).toFixed(0)}%`)
      .join("\n");
  }

  function sendFeedback(blockText, confidence, score, signals, feedback, badge) {
    badge.classList.add("ai-detector-badge-voted");
    badge.querySelector(".ai-detector-badge-label").textContent =
      feedback === "correct" ? "✓ Confirmed AI" : "✗ Not AI";
    badge.querySelectorAll(".ai-detector-thumb").forEach((b) => (b.disabled = true));

    chrome.runtime.sendMessage(
      { action: "saveFeedback", data: { blockText, confidence, score, signals, feedback } },
      (response) => {
        if (chrome.runtime.lastError || !response) return;
        if (response.error) { console.warn("Feedback error:", response.error); return; }
        showToast(
          response.untilUpdate > 0
            ? `Feedback saved — ${response.untilUpdate} more until weight recalibration.`
            : "Feedback saved — recalibrating weights…"
        );
      }
    );
  }
})();
