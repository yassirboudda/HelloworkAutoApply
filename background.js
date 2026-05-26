const EXT_VERSION = "1.0.4";

const DEFAULT_PROFILE = {
  fullName: "",
  email: "",
  phone: "",
  location: "",
};

const DEFAULT_SETTINGS = {
  maxJobsPerSession: 25,
  delayBetweenJobs: { min: 6000, max: 14000 },
  delayBetweenSteps: { min: 700, max: 1600 },
  autoSubmit: true,
  onlyEasyApply: true,
  maxConsecutiveNoApplyPages: 1,
};

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

async function triggerContent(tabId) {
  try {
    const status = await chrome.tabs.sendMessage(tabId, { action: "getContentStatus" });
    if (status?.isRunning) {
      return;
    }
  } catch (_err) {
    // Content script may not be ready yet. Continue.
  }

  for (let i = 0; i < 3; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: "startAutoApply" });
      return;
    } catch (_err) {
      if (i < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  if (!tab.url.includes("hellowork.com/fr-fr/")) return;

  const { enabled = true, session = null } = await chrome.storage.local.get(["enabled", "session"]);
  if (!enabled || !session?.active) return;

  await appendLog(`Page chargée: ${new URL(tab.url).pathname}`);

  // Small delay to avoid race on SPA re-renders.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const { session: latestSession = null } = await chrome.storage.local.get(["session"]);
  if (!latestSession?.active) return;

  await triggerContent(tabId);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "getState") {
    getState().then(sendResponse);
    return true;
  }

  if (msg.action === "setEnabled") {
    chrome.storage.local.set({ enabled: !!msg.enabled }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "addLog") {
    appendLog(msg.message || "", msg.level || "info").then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "clearLog") {
    chrome.storage.local.set({ log: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "clearApplied") {
    chrome.storage.local
      .set({
        appliedJobs: {},
        skippedJobs: {},
        stats: { applied: 0, skipped: 0, errors: 0, lastRun: null },
      })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "saveProfile") {
    chrome.storage.local.set({ profile: msg.profile || { ...DEFAULT_PROFILE } }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "startSession") {
    (async () => {
      const session = {
        active: true,
        phase: "search",
        keywords: msg.keywords || "",
        location: msg.location || "",
        contract: msg.contract || "",
        currentPage: 0,
        searchUrl: msg.searchUrl || "",
        queue: [],
        queueIndex: 0,
        currentOfferUrl: "",
        visitedOffers: {},
        visitedSearchUrls: msg.searchUrl ? [msg.searchUrl] : [],
        noApplyPages: 0,
        applied: 0,
        skipped: 0,
        errors: 0,
        maxJobs: msg.maxJobs || 25,
        startedAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({ session });
      await appendLog(`Session démarrée: ${session.keywords} (${session.location || "sans lieu"})`);
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (msg.action === "updateSession") {
    (async () => {
      const { session = null } = await chrome.storage.local.get(["session"]);
      if (!session) {
        sendResponse({ ok: false });
        return;
      }
      const updated = { ...session, ...(msg.updates || {}) };
      await chrome.storage.local.set({ session: updated });
      sendResponse({ ok: true, session: updated });
    })();
    return true;
  }

  if (msg.action === "endSession") {
    (async () => {
      const { session = null } = await chrome.storage.local.get(["session"]);
      if (session) {
        session.active = false;
        session.endedAt = new Date().toISOString();
        await chrome.storage.local.set({ session });
      }
      await appendLog("Session terminée", "success");
      sendResponse({ ok: true });
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
      await appendLog(`Candidature envoyée: ${msg.title || msg.jobId || "offre"}`, "success");
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
      await appendLog(`Ignorée: ${msg.title || msg.jobId || "offre"} (${msg.reason || "raison inconnue"})`, "warn");
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
      await appendLog(`Erreur: ${msg.error || "inconnue"}`, "error");
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

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["autoApplySettings", "profile", "enabled"]);
  if (!data.autoApplySettings) {
    await chrome.storage.local.set({ autoApplySettings: { ...DEFAULT_SETTINGS } });
  }
  if (!data.profile) {
    await chrome.storage.local.set({ profile: { ...DEFAULT_PROFILE } });
  }
  if (typeof data.enabled !== "boolean") {
    await chrome.storage.local.set({ enabled: true });
  }
  await appendLog(`Extension installée v${EXT_VERSION}`);
});
