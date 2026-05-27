const $ = (id) => document.getElementById(id);

function playBeep(type = "stop") {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    const gainNode = audioCtx.createGain();
    gainNode.connect(audioCtx.destination);
    gainNode.gain.value = 0.6;

    if (type === "stop") {
      [0, 220].forEach((delay, idx) => {
        const osc = audioCtx.createOscillator();
        osc.connect(gainNode);
        osc.type = "sine";
        osc.frequency.value = idx === 0 ? 760 : 560;
        osc.start(audioCtx.currentTime + delay / 1000);
        osc.stop(audioCtx.currentTime + delay / 1000 + 0.18);
      });
      setTimeout(() => audioCtx.close(), 1200);
      return;
    }

    if (type === "error") {
      [0, 350].forEach((delay) => {
        const osc = audioCtx.createOscillator();
        osc.connect(gainNode);
        osc.type = "sine";
        osc.frequency.value = 440;
        osc.start(audioCtx.currentTime + delay / 1000);
        osc.stop(audioCtx.currentTime + delay / 1000 + 0.2);
      });
      setTimeout(() => audioCtx.close(), 1500);
    } else {
      const osc = audioCtx.createOscillator();
      osc.connect(gainNode);
      osc.type = "sine";
      osc.frequency.value = 660;
      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
      setTimeout(() => audioCtx.close(), 1000);
    }
  } catch (e) { /* ignore */ }
}

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

  $("applied").textContent = state.stats?.applied || 0;
  $("skipped").textContent = state.stats?.skipped || 0;
  $("errors").textContent = state.stats?.errors || 0;

  $("maxJobs").value = state.autoApplySettings?.maxJobsPerSession || 25;

  const session = state.session;
  const lastSession = state.lastSession;
  const statusEl = $("status");
  const stopBtn = $("stopBtn");
  const startBtn = $("startBtn");
  const resumeBtn = $("resumeBtn");

  if (session?.active) {
    statusEl.textContent = `Etat: session active | page ${1 + (session.currentPage || 0)} | ${session.applied || 0}/${session.maxJobs || 25}`;
    statusEl.style.background = "#dcfce7";
    stopBtn.disabled = false;
    stopBtn.textContent = "Arreter (actif)";
    startBtn.disabled = true;
    startBtn.textContent = "Session active";
    resumeBtn.disabled = true;
    resumeBtn.textContent = "Reprendre derniere session";
  } else {
    statusEl.textContent = "Etat: inactif";
    statusEl.style.background = "#f3f4f6";
    stopBtn.disabled = true;
    stopBtn.textContent = "Arrete";
    startBtn.disabled = false;
    startBtn.textContent = "Demarrer session";

    const hasLastSession = !!(lastSession && lastSession.searchUrl);
    resumeBtn.disabled = !hasLastSession;
    if (hasLastSession) {
      const fromOffer = lastSession.phase === "offer" && !!lastSession.currentOfferUrl;
      const page = 1 + (lastSession.currentPage || 0);
      resumeBtn.textContent = fromOffer
        ? `Reprendre: derniere offre (page ${page})`
        : `Reprendre: page ${page}`;
    } else {
      resumeBtn.textContent = "Reprendre derniere session";
    }
  }

  const lines = state.log || [];
  $("log").textContent = lines.slice(-80).join("\n") || "Aucun log";
  $("log").scrollTop = $("log").scrollHeight;
}

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
  playBeep("stop");
  await sendToContent({ action: "stopAutoApply" });
  await sendToBackground({ action: "endSession" });
  await refresh();
});

$("resumeBtn").addEventListener("click", async () => {
  const resumed = await sendToBackground({ action: "resumeLastSession" });
  if (!resumed?.ok || !resumed.targetUrl) {
    const reason = resumed?.reason === "no_last_session"
      ? "Etat: aucune session precedente a reprendre"
      : "Etat: reprise impossible pour le moment";
    $("status").textContent = reason;
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: resumed.targetUrl });
  } else {
    await chrome.tabs.create({ url: resumed.targetUrl });
  }

  window.close();
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
