const EXT_VERSION = "1.0.20";

// ── Mistral AI Configuration ────────────────────────────────────────────────
const MISTRAL_MODEL = "mistral-large-latest";
const MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_MISTRAL_API_KEY = "uwqtlWhrRDIdE0QAHYkIhMFkLTbkDYIb";

const DEFAULT_PROFILE = {
  fullName: "",
  civility: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  location: "",
  postalCode: "",
  birthDate: "",
  title: "",
  experience: "",
  stack: "",
  languages: "",
  availability: "",
  salaryExpectation: "",
  cvText: "",
};

const DEFAULT_SETTINGS = {
  maxJobsPerSession: 25,
  delayBetweenJobs: { min: 6000, max: 14000 },
  delayBetweenSteps: { min: 700, max: 1600 },
  autoSubmit: true,
  onlyEasyApply: true,
  maxConsecutiveNoApplyPages: 20,
};

// ── Mistral API Call ───────────────────────────────────────────────────────
async function getMistralApiKey() {
  const result = await chrome.storage.local.get(["mistralApiKey"]);
  return result.mistralApiKey || DEFAULT_MISTRAL_API_KEY;
}

async function askMistral(systemPrompt, userPrompt, maxTokens = 300) {
  const apiKey = await getMistralApiKey();
  if (!apiKey) {
    console.warn("[HelloworkAutoApply] No Mistral API key");
    return null;
  }
  try {
    const response = await fetch(MISTRAL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });
    if (response.status === 429) {
      console.warn("[HelloworkAutoApply] Mistral rate limit");
      return null;
    }
    if (!response.ok) {
      const text = await response.text();
      console.error("[HelloworkAutoApply] Mistral error:", response.status, text);
      return null;
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error("[HelloworkAutoApply] Mistral fetch error:", err);
    return null;
  }
}

async function getProfileData() {
  const result = await chrome.storage.local.get(["profile"]);
  return result.profile || { ...DEFAULT_PROFILE };
}

async function getState() {
  const data = await chrome.storage.local.get([
    "enabled",
    "stats",
    "log",
    "session",
    "profile",
    "autoApplySettings",
    "appliedJobs",
    "skippedJobs",
    "mistralApiKey",
  ]);

  return {
    enabled: data.enabled !== false,
    stats: data.stats || { applied: 0, skipped: 0, errors: 0, lastRun: null },
    log: data.log || [],
    session: data.session || null,
    profile: data.profile || { ...DEFAULT_PROFILE },
    autoApplySettings: data.autoApplySettings || { ...DEFAULT_SETTINGS },
    appliedJobs: data.appliedJobs || {},
    skippedJobs: data.skippedJobs || {},
    mistralApiKey: data.mistralApiKey || DEFAULT_MISTRAL_API_KEY,
  };
}

async function appendLog(message, level = "info") {
  const { log = [] } = await chrome.storage.local.get(["log"]);
  const ts = new Date().toLocaleTimeString("fr-FR", { hour12: false });
  const icon = level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "success" ? "✅" : "ℹ️";
  log.push(`[${ts}] ${icon} ${message}`);
  if (log.length > 800) log.splice(0, log.length - 800);
  await chrome.storage.local.set({ log });
  console.log(`[HelloworkAutoApply] ${icon} ${message}`);
}

// ── Message Handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "getState") {
    (async () => {
      sendResponse(await getState());
    })();
    return true;
  }

  if (msg.action === "startSession") {
    (async () => {
      const session = {
        active: true,
        searchUrl: msg.searchUrl || "",
        resumeSearchUrl: msg.searchUrl || "",
        currentOfferUrl: "",
        currentJobTitle: "",
        currentJobCompany: "",
        phase: "search",
        applied: 0,
        skipped: 0,
        errors: 0,
        visitedOffers: {},
        externalSiteOffers: {},
        visitedSearchUrls: [],
        noNewOfferPages: 0,
        maxJobs: msg.maxJobs || 25,
      };
      await chrome.storage.local.set({ session, enabled: true });
      await appendLog(`Session démarrée: ${msg.searchUrl}`, "success");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "endSession") {
    (async () => {
      const { session = null, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } =
        await chrome.storage.local.get(["session", "stats"]);
      if (session?.active) {
        stats.applied = (stats.applied || 0) + (session.applied || 0);
        stats.skipped = (stats.skipped || 0) + (session.skipped || 0);
        stats.errors = (stats.errors || 0) + (session.errors || 0);
        stats.lastRun = new Date().toISOString();
      }
      await chrome.storage.local.set({ session: null, stats, enabled: false });
      await appendLog(`Session terminée`, "info");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "updateSession") {
    (async () => {
      const { session = null } = await chrome.storage.local.get(["session"]);
      if (session) {
        Object.assign(session, msg.updates || {});
        await chrome.storage.local.set({ session });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "getProfile") {
    (async () => {
      const profile = await getProfileData();
      sendResponse(profile);
    })();
    return true;
  }

  if (msg.action === "askMistral") {
    (async () => {
      const answer = await askMistral(msg.systemPrompt || "", msg.userPrompt || "", msg.maxTokens || 300);
      sendResponse({ answer });
    })();
    return true;
  }

  if (msg.action === "markApplied") {
    (async () => {
      const { appliedJobs = {}, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null }, session = null } =
        await chrome.storage.local.get(["appliedJobs", "stats", "session"]);
      const key = msg.jobId || `job_${Date.now()}`;
      appliedJobs[key] = {
        title: msg.title || "",
        company: msg.company || "",
        url: msg.url || "",
        ts: new Date().toISOString(),
      };
      stats.applied = (stats.applied || 0) + 1;
      stats.lastRun = new Date().toISOString();
      if (session?.active) {
        session.applied = (session.applied || 0) + 1;
      }
      await chrome.storage.local.set({ appliedJobs, stats, session });
      await appendLog(`Candidature envoyée: ${msg.title || msg.jobId}`, "success");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "markSkipped") {
    (async () => {
      const { skippedJobs = {}, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null }, session = null } =
        await chrome.storage.local.get(["skippedJobs", "stats", "session"]);
      const key = msg.jobId || `skip_${Date.now()}`;
      skippedJobs[key] = {
        title: msg.title || "",
        reason: msg.reason || "",
        url: msg.url || "",
        ts: new Date().toISOString(),
      };
      stats.skipped = (stats.skipped || 0) + 1;
      if (session?.active) {
        session.skipped = (session.skipped || 0) + 1;
      }
      await chrome.storage.local.set({ skippedJobs, stats, session });
      await appendLog(`Ignorée: ${msg.title} (${msg.reason})`, "warn");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "markError") {
    (async () => {
      const { stats = { applied: 0, skipped: 0, errors: 0, lastRun: null }, session = null } =
        await chrome.storage.local.get(["stats", "session"]);
      stats.errors = (stats.errors || 0) + 1;
      if (session?.active) {
        session.errors = (session.errors || 0) + 1;
      }
      await chrome.storage.local.set({ stats, session });
      await appendLog(`Erreur: ${msg.error}`, "error");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "addLog") {
    (async () => {
      await appendLog(msg.message, msg.level);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "clearLog") {
    (async () => {
      await chrome.storage.local.set({ log: [] });
      await appendLog("Debug log cleared", "info");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "downloadDebugLog") {
    (async () => {
      const { log = [] } = await chrome.storage.local.get(["log"]);
      const content = `=== Hellowork AutoApply Debug Log ===\nVersion: ${EXT_VERSION}\nGenerated: ${new Date().toISOString()}\n\n${log.join("\n")}\n`;
      const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(content);
      chrome.downloads.download(
        {
          url: dataUrl,
          filename: "hellowork-autoapply-debug.log",
          saveAs: false,
          conflictAction: "overwrite",
        },
        () => sendResponse({ ok: true })
      );
    })();
    return true;
  }

  sendResponse({ ok: false, message: "unknown_action" });
  return false;
});

// ── Initialize on Install ──────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["profile", "autoApplySettings", "mistralApiKey", "enabled"]);
  if (!existing.profile) {
    await chrome.storage.local.set({ profile: { ...DEFAULT_PROFILE } });
  }
  if (!existing.autoApplySettings) {
    await chrome.storage.local.set({ autoApplySettings: { ...DEFAULT_SETTINGS } });
  }
  if (!existing.mistralApiKey) {
    await chrome.storage.local.set({ mistralApiKey: DEFAULT_MISTRAL_API_KEY });
  }
  if (typeof existing.enabled !== "boolean") {
    await chrome.storage.local.set({ enabled: true });
  }
  await appendLog(`Extension installée v${EXT_VERSION}`, "success");
});
