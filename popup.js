const $ = (id) => document.getElementById(id);

async function sendToBackground(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (_err) {
    return null;
  }
}

async function sendToContent(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (_err) {
    return null;
  }
}

function buildSearchUrl(keywords, location, contract) {
  const p = new URLSearchParams();
  p.set("k", keywords || "");
  if (location) p.set("l", location);
  if (contract) p.set("c", contract);
  return `https://www.hellowork.com/fr-fr/emploi/recherche.html?${p.toString()}`;
}

async function refresh() {
  const state = await sendToBackground({ action: "getState" });
  if (!state) return;

  $("enabled").checked = state.enabled;
  $("applied").textContent = state.stats?.applied || 0;
  $("skipped").textContent = state.stats?.skipped || 0;
  $("errors").textContent = state.stats?.errors || 0;

  $("maxJobs").value = state.autoApplySettings?.maxJobsPerSession || 25;

  const session = state.session;
  const statusEl = $("status");
  if (session?.active) {
    statusEl.textContent = `Etat: session active | page ${1 + (session.currentPage || 0)} | ${session.applied || 0}/${session.maxJobs || 25}`;
    statusEl.style.background = "#dcfce7";
  } else {
    statusEl.textContent = "Etat: inactif";
    statusEl.style.background = "#f3f4f6";
  }

  const lines = state.log || [];
  $("log").textContent = lines.slice(-80).join("\n") || "Aucun log";
  $("log").scrollTop = $("log").scrollHeight;
}

$("enabled").addEventListener("change", async (e) => {
  await sendToBackground({ action: "setEnabled", enabled: e.target.checked });
  await refresh();
});

$("startBtn").addEventListener("click", async () => {
  const keywords = $("keywords").value.trim();
  const location = $("location").value.trim();
  const contract = $("contract").value.trim();
  const maxJobs = parseInt($("maxJobs").value, 10) || 25;

  if (!keywords) {
    $("status").textContent = "Etat: mets un mot-cle avant de demarrer";
    return;
  }

  const searchUrl = buildSearchUrl(keywords, location, contract);
  await chrome.storage.local.set({
    lastKeywords: keywords,
    lastLocation: location,
    lastContract: contract,
  });

  await sendToBackground({
    action: "startSession",
    keywords,
    location,
    contract,
    maxJobs,
    searchUrl,
  });

  const settings = (await chrome.storage.local.get(["autoApplySettings"]))?.autoApplySettings || {};
  settings.maxJobsPerSession = maxJobs;
  await chrome.storage.local.set({ autoApplySettings: settings });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: searchUrl });
  } else {
    await chrome.tabs.create({ url: searchUrl });
  }

  window.close();
});

$("stopBtn").addEventListener("click", async () => {
  await sendToContent({ action: "stopAutoApply" });
  await sendToBackground({ action: "endSession" });
  await refresh();
});

$("singleBtn").addEventListener("click", async () => {
  await sendToContent({ action: "applySingleJob" });
  await refresh();
});

$("optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("downloadLog").addEventListener("click", async () => {
  await sendToBackground({ action: "downloadDebugLog" });
});

$("clearLog").addEventListener("click", async () => {
  await sendToBackground({ action: "clearLog" });
  await refresh();
});

$("resetStats").addEventListener("click", async () => {
  await sendToBackground({ action: "clearApplied" });
  await sendToBackground({ action: "endSession" });
  await refresh();
});

(async function init() {
  const last = await chrome.storage.local.get(["lastKeywords", "lastLocation", "lastContract"]);
  $("keywords").value = last.lastKeywords || "";
  $("location").value = last.lastLocation || "";
  $("contract").value = last.lastContract || "";
  await refresh();
  setInterval(refresh, 2000);
})();
