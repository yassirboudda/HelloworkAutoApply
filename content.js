(function () {
  if (window.__HelloworkAutoApplyLoaded) return;
  window.__HelloworkAutoApplyLoaded = true;

  const VERSION = "1.0.0";
  let isRunning = false;
  let shouldStop = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const jitter = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function log(message, level = "info") {
    const icon = level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "success" ? "✅" : "ℹ️";
    console.log(`[HelloworkAutoApply v${VERSION}] ${icon} ${message}`);
    chrome.runtime.sendMessage({ action: "addLog", message, level }).catch(() => {});
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      u.hash = "";
      return u.toString();
    } catch (_err) {
      return url;
    }
  }

  function isSearchPage(url = window.location.href) {
    return /\/fr-fr\/emploi\/recherche\.html/i.test(url);
  }

  function isOfferPage(url = window.location.href) {
    return /\/fr-fr\/emplois\/\d+\.html/i.test(url);
  }

  function isMultiApplyPage(url = window.location.href) {
    return /\/fr-fr\/bounce\/multiapply/i.test(url);
  }

  function isCreateAlertPage(url = window.location.href) {
    return /\/fr-fr\/bounce\/createalert/i.test(url);
  }

  function offerIdFromUrl(url = window.location.href) {
    const m1 = url.match(/\/emplois\/(\d+)\.html/i);
    if (m1) return m1[1];
    const m2 = url.match(/[?&]offerId=(\d+)/i);
    if (m2) return m2[1];
    return "";
  }

  async function getSession() {
    const { session = null } = await chrome.storage.local.get(["session"]);
    return session;
  }

  async function setSession(updates) {
    const session = await getSession();
    if (!session) return null;
    const next = { ...session, ...updates };
    await chrome.storage.local.set({ session: next });
    return next;
  }

  async function endSession(reason) {
    await chrome.runtime.sendMessage({ action: "endSession" });
    if (reason) {
      log(`Session stoppée: ${reason}`, "warn");
    }
  }

  function textOf(el) {
    return (el?.textContent || "").trim();
  }

  function collectOfferLinks() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/fr-fr/emplois/"]'));
    const links = [];
    const seen = new Set();

    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const abs = normalizeUrl(new URL(href, window.location.origin).toString());
      if (!isOfferPage(abs)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);

      const title = textOf(a).substring(0, 180);
      links.push({
        url: abs,
        jobId: offerIdFromUrl(abs),
        title,
      });
    }

    return links;
  }

  function findNextPageUrl() {
    const selectors = [
      'a[rel="next"]',
      'a[aria-label*="Suivant"]',
      'a[aria-label*="Next"]',
      'a[href*="page="]',
    ];

    for (const sel of selectors) {
      const candidates = Array.from(document.querySelectorAll(sel));
      for (const el of candidates) {
        if (el.offsetParent === null) continue;
        const txt = textOf(el).toLowerCase();
        const href = el.getAttribute("href");
        if (!href) continue;

        if (sel === 'a[href*="page="]' && !(txt.includes("suivant") || txt.includes("next") || txt === ">")) {
          continue;
        }

        return normalizeUrl(new URL(href, window.location.origin).toString());
      }
    }

    return "";
  }

  function getOfferInfoFromDom() {
    const title =
      textOf(document.querySelector("h1")) ||
      textOf(document.querySelector('[data-testid*="title"]')) ||
      "Offre Hellowork";

    let company = textOf(document.querySelector('a[href*="/entreprises/"]'));
    if (!company) {
      company = textOf(document.querySelector('[class*="company"], [class*="Company"]'));
    }

    return { title, company };
  }

  async function humanClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(jitter(180, 420));
    el.click();
    await sleep(jitter(250, 700));
    return true;
  }

  function findApplyButton() {
    const clickables = Array.from(document.querySelectorAll("button, a"));
    const wanted = ["postuler", "je postule", "candidater", "envoyer ma candidature", "postuler maintenant"];
    const blocked = ["alerte", "connexion", "se connecter", "inscrire", "compte"];

    for (const el of clickables) {
      if (el.offsetParent === null) continue;
      if (el.disabled) continue;
      const text = textOf(el).toLowerCase();
      if (!text) continue;

      if (wanted.some((w) => text.includes(w)) && !blocked.some((b) => text.includes(b))) {
        return el;
      }
    }

    return null;
  }

  async function waitForApplyOutcome(timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const url = window.location.href;
      if (isMultiApplyPage(url)) {
        return { outcome: "applied", url };
      }
      if (isCreateAlertPage(url)) {
        return { outcome: "applied_or_followup", url };
      }

      const errNode = document.querySelector('[role="alert"], [class*="error"], [class*="Error"]');
      const errText = textOf(errNode).toLowerCase();
      if (errText.includes("erreur") || errText.includes("error")) {
        return { outcome: "error", error: errText.substring(0, 200) };
      }

      await sleep(500);
    }

    return { outcome: "timeout" };
  }

  async function applyOnOfferPage(session, settings) {
    const { title, company } = getOfferInfoFromDom();
    const jobId = offerIdFromUrl(window.location.href) || offerIdFromUrl(session.currentOfferUrl || "");

    const applyButton = findApplyButton();
    if (!applyButton) {
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        jobId,
        title,
        url: window.location.href,
        reason: "Bouton postuler introuvable",
      });
      log(`Offre ignorée (pas de bouton): ${title}`, "warn");
      return { applied: false, reason: "no_apply_button" };
    }

    if (settings.autoSubmit === false) {
      log(`Mode manuel: bouton trouvé sur ${title}`, "warn");
      return { applied: false, reason: "manual_mode" };
    }

    await humanClick(applyButton);
    const outcome = await waitForApplyOutcome();

    if (outcome.outcome === "applied" || outcome.outcome === "applied_or_followup") {
      await chrome.runtime.sendMessage({
        action: "markApplied",
        jobId,
        title,
        company,
        url: window.location.href,
      });
      log(`Candidature envoyée: ${title}`, "success");
      return { applied: true };
    }

    if (outcome.outcome === "error") {
      await chrome.runtime.sendMessage({
        action: "markError",
        title,
        error: outcome.error || "Erreur après clic postuler",
      });
      return { applied: false, reason: "apply_error" };
    }

    await chrome.runtime.sendMessage({
      action: "markSkipped",
      jobId,
      title,
      url: window.location.href,
      reason: "Timeout après clic postuler",
    });
    return { applied: false, reason: "timeout" };
  }

  async function handleSearchPage(session, settings) {
    if (!session.searchUrl) {
      session = await setSession({ searchUrl: normalizeUrl(window.location.href) });
    }

    const currentSearch = normalizeUrl(window.location.href);
    if (session.searchUrl !== currentSearch) {
      session = await setSession({
        searchUrl: currentSearch,
        queue: [],
        queueIndex: 0,
      });
    }

    const allLinks = collectOfferLinks();
    const visitedOffers = session.visitedOffers || {};
    const queue = allLinks.filter((item) => !visitedOffers[item.jobId || item.url]);

    if (queue.length === 0) {
      const noApplyPages = (session.noApplyPages || 0) + 1;
      const updates = { noApplyPages };
      session = await setSession(updates);
      log(`Aucune nouvelle offre sur cette page (${noApplyPages})`, "warn");

      const maxNoApply = settings.maxConsecutiveNoApplyPages || 1;
      if (noApplyPages >= maxNoApply) {
        await endSession(`Arrêt sécurité: ${noApplyPages} page(s) sans candidature`);
        return;
      }

      const nextUrl = findNextPageUrl();
      if (!nextUrl) {
        await endSession("Fin: plus de page suivante");
        return;
      }

      const seenSearch = session.visitedSearchUrls || [];
      if (seenSearch.includes(nextUrl)) {
        await endSession("Arrêt sécurité: page suivante déjà visitée");
        return;
      }

      await setSession({
        currentPage: (session.currentPage || 0) + 1,
        searchUrl: nextUrl,
        visitedSearchUrls: [...seenSearch, nextUrl],
      });
      log(`Navigation page suivante: ${nextUrl}`);
      window.location.href = nextUrl;
      return;
    }

    const target = queue[0];
    const key = target.jobId || target.url;
    const nextVisited = { ...(session.visitedOffers || {}), [key]: true };

    await setSession({
      phase: "offer",
      currentOfferUrl: target.url,
      visitedOffers: nextVisited,
      noApplyPages: 0,
    });

    log(`Ouverture offre: ${target.title || target.url}`);
    await sleep(jitter(600, 1400));
    window.location.href = target.url;
  }

  async function handleOfferLikePage(session, settings) {
    let result = { applied: false, reason: "unknown" };

    if (isOfferPage(window.location.href)) {
      result = await applyOnOfferPage(session, settings);
    } else if (isMultiApplyPage(window.location.href) || isCreateAlertPage(window.location.href)) {
      // Some flows land directly on bounce pages after automatic click/navigation.
      const jobId = offerIdFromUrl(window.location.href) || offerIdFromUrl(session.currentOfferUrl || "");
      await chrome.runtime.sendMessage({
        action: "markApplied",
        jobId,
        title: `Offre ${jobId || "Hellowork"}`,
        company: "",
        url: window.location.href,
      });
      result = { applied: true };
      log("Succès détecté via page bounce/multiapply", "success");
    }

    const refreshed = await getSession();
    if (!refreshed?.active) return;

    if ((refreshed.applied || 0) >= (refreshed.maxJobs || 25)) {
      await endSession("Objectif session atteint");
      return;
    }

    const backUrl = refreshed.searchUrl || "https://www.hellowork.com/fr-fr/emploi/recherche.html";
    await setSession({ phase: "search", currentOfferUrl: "" });

    const minDelay = settings.delayBetweenJobs?.min ?? 6000;
    const maxDelay = settings.delayBetweenJobs?.max ?? 12000;
    await sleep(jitter(minDelay, maxDelay));

    log(`Retour à la recherche (${result.applied ? "appliquée" : result.reason})`);
    window.location.href = backUrl;
  }

  async function runAutoApplySession() {
    if (isRunning) return;
    isRunning = true;

    try {
      const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
      const settings = {
        maxConsecutiveNoApplyPages: 1,
        autoSubmit: true,
        delayBetweenJobs: { min: 6000, max: 14000 },
        ...autoApplySettings,
      };

      const session = await getSession();
      if (!session?.active) {
        isRunning = false;
        return;
      }

      if (shouldStop) {
        await endSession("Arrêt demandé");
        isRunning = false;
        return;
      }

      if ((session.applied || 0) >= (session.maxJobs || 25)) {
        await endSession("Objectif session atteint");
        isRunning = false;
        return;
      }

      if (isSearchPage()) {
        await handleSearchPage(session, settings);
      } else if (isOfferPage() || isMultiApplyPage() || isCreateAlertPage()) {
        await handleOfferLikePage(session, settings);
      } else {
        log("Page non gérée pour cette session", "warn");
      }
    } catch (err) {
      log(`Erreur session: ${err.message}`, "error");
      await chrome.runtime.sendMessage({ action: "markError", error: err.message });
    } finally {
      isRunning = false;
    }
  }

  async function applySingleJob() {
    if (!isOfferPage()) {
      log("Apply single: ouvrir une fiche offre Hellowork d'abord", "warn");
      return;
    }
    const session = (await getSession()) || { active: true, currentOfferUrl: window.location.href, searchUrl: "" };
    const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
    await applyOnOfferPage(session, { autoSubmit: true, ...autoApplySettings });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "startAutoApply") {
      runAutoApplySession().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.action === "stopAutoApply") {
      shouldStop = true;
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "applySingleJob") {
      applySingleJob().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.action === "getContentStatus") {
      sendResponse({ isRunning, shouldStop, url: window.location.href });
      return;
    }
  });

  // Resume automatically after navigation when a session is active.
  setTimeout(() => {
    getSession().then((session) => {
      if (session?.active) {
        runAutoApplySession();
      }
    });
  }, 1000);
})();
