(function () {
  if (window.__HelloworkAutoApplyLoaded) return;
  window.__HelloworkAutoApplyLoaded = true;

  // v1.0.4 — Multiapply submit button with scroll support
  const VERSION = "1.0.4";
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

  function canonicalSearchContext(url) {
    try {
      const u = new URL(url, window.location.origin);
      if (!isSearchPage(u.toString())) return "";
      const params = [];
      for (const [k, v] of u.searchParams.entries()) {
        if (k === "p" || k === "page") continue;
        if (k === "k_autocomplete" || k === "l_autocomplete") continue;
        params.push([k, v]);
      }
      params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      return `${u.origin}${u.pathname}${qs ? "?" + qs : ""}`;
    } catch (_err) {
      return "";
    }
  }

  function isSameSearchContext(a, b) {
    const ca = canonicalSearchContext(a);
    const cb = canonicalSearchContext(b);
    return !!ca && ca === cb;
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
    if (reason) log("Session stoppée: " + reason, "warn");
  }

  function textOf(el) {
    return (el?.textContent || "").trim();
  }

  // ── Collect all offer links on a search page ────────────────────────────
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
      links.push({ url: abs, jobId: offerIdFromUrl(abs), title: textOf(a).substring(0, 180) });
    }
    return links;
  }

  // ── Find next page URL on search results ───────────────────────────────
  function findNextPageUrl(currentSearchUrl) {
    for (const sel of ['a[rel="next"]', 'a[aria-label*="Suivant"]', 'a[aria-label*="Next"]']) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (el.offsetParent === null) continue;
        const href = el.getAttribute("href");
        if (href) return normalizeUrl(new URL(href, window.location.origin).toString());
      }
    }
    // Numbered pagination: find page link after currently active one
    const pageLinks = Array.from(document.querySelectorAll('a[href*="p="], a[href*="page="]'));
    for (let i = 0; i < pageLinks.length; i++) {
      const el = pageLinks[i];
      if (el.offsetParent === null) continue;
      const cls = (el.className || "") + (el.getAttribute("aria-current") || "");
      if (/active|current|selected/i.test(cls)) {
        const next = pageLinks[i + 1];
        if (next?.getAttribute("href"))
          return normalizeUrl(new URL(next.getAttribute("href"), window.location.origin).toString());
      }
    }
    // URL fallback: increment p= (or page=) directly
    try {
      const u = new URL(currentSearchUrl, window.location.origin);
      const hasP = u.searchParams.has("p");
      const key = hasP ? "p" : "page";
      const cur = parseInt(u.searchParams.get(key) || "1", 10);
      const next = Number.isFinite(cur) && cur > 0 ? cur + 1 : 2;
      u.searchParams.set(key, String(next));
      return normalizeUrl(u.toString());
    } catch (_err) {
      return "";
    }
  }

  // ── Job info from offer page DOM ───────────────────────────────────────
  function getOfferInfoFromDom() {
    const title =
      textOf(document.querySelector("h1")) ||
      textOf(document.querySelector('[data-testid*="title"]')) ||
      "Offre Hellowork";
    const company =
      textOf(document.querySelector('a[href*="/entreprises/"]')) ||
      textOf(document.querySelector('[class*="company"], [class*="Company"]')) ||
      "";
    return { title, company };
  }

  // ── Simulate a human-like click ────────────────────────────────────────
  async function humanClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(jitter(180, 420));
    el.click();
    await sleep(jitter(250, 700));
    return true;
  }

  function findRecruiterSiteButton() {
    const externalTexts = [
      "postuler sur le site du recruteur",
      "sur le site du recruteur",
      "site du recruteur",
    ];
    for (const el of Array.from(document.querySelectorAll("button, a"))) {
      if (el.offsetParent === null) continue;
      const text = textOf(el).toLowerCase();
      if (!text) continue;
      if (externalTexts.some((t) => text.includes(t))) return el;
    }
    return null;
  }

  function findMultiApplySubmitButton() {
    const exactTexts = [
      "envoyer mes candidatures",
      "envoyer ma candidature",
      "je postule",
      "postuler",
    ];
    let best = null;
    let bestScore = -1;
    for (const el of Array.from(document.querySelectorAll("button, a"))) {
      if (el.offsetParent === null) continue;
      if (el.disabled) continue;
      const text = textOf(el).toLowerCase();
      if (!text) continue;
      if (!exactTexts.some((t) => text.includes(t))) continue;

      let score = 1;
      if (text.includes("envoyer mes candidatures")) score += 20;
      if (text.includes("envoyer ma candidature")) score += 14;
      if (el.tagName === "BUTTON") score += 4;
      if ((el.getAttribute("type") || "").toLowerCase() === "submit") score += 5;
      if ((el.getAttribute("data-action") || "").toLowerCase().includes("multi-apply")) score += 10;
      if (el.className && /btn-primary-candidacy/i.test(el.className)) score += 4;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  async function findMultiApplyButtonWithScroll() {
    for (let i = 0; i < 6; i++) {
      const btn = findMultiApplySubmitButton() || findApplyButton();
      if (btn) return btn;
      window.scrollBy({ top: 700, left: 0, behavior: "smooth" });
      await sleep(jitter(450, 900));
    }
    return findMultiApplySubmitButton() || findApplyButton();
  }

  // ── Find best apply button (scored; can exclude one element) ───────────
  function findApplyButton(opts = {}) {
    const { exclude = null } = opts;
    const wanted = ["postuler", "je postule", "candidater", "envoyer ma candidature", "envoyer mes candidatures", "postuler maintenant"];
    const blocked = [
      "alerte",
      "connexion",
      "se connecter",
      "inscrire",
      "compte",
      "sauvegarder",
      "site du recruteur",
      "sur le site du recruteur",
    ];
    let best = null;
    let bestScore = -1;

    for (const el of Array.from(document.querySelectorAll("button, a"))) {
      if (exclude && el === exclude) continue;
      if (el.offsetParent === null) continue;
      if (el.disabled) continue;
      const text = textOf(el).toLowerCase();
      if (!text) continue;
      if (!wanted.some((w) => text.includes(w))) continue;
      if (blocked.some((b) => text.includes(b))) continue;

      let score = 1;
      if (text === "je postule") score += 12;
      if (text.includes("je postule")) score += 8;
      if (text.includes("postuler maintenant")) score += 6;
      if (text.includes("envoyer ma candidature")) score += 6;
      if (el.tagName === "BUTTON") score += 3;
      if ((el.getAttribute("href") || "").includes("postuler")) score += 2;
      if (el.closest("#postuler, [id*='postuler'], [class*='apply'], [class*='Apply']")) score += 5;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  PAGE HANDLERS — one dedicated function per Hellowork page type
  //
  //  Flow:  search → offer → /bounce/multiapply → /bounce/createalert → search
  //
  //  Each handler either:
  //    a) Lets the page navigate naturally (script dies, next handler picks up)
  //    b) Explicitly sets window.location.href when we need to steer
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // SEARCH PAGE: pick next unvisited offer from the queue
  async function handleSearchPage(session, settings) {
    const currentSearch = normalizeUrl(window.location.href);

    // After applying, Hellowork redirects to a DIFFERENT search (related jobs).
    // If the current URL doesn't match our session search, go back to ours.
    if (session.searchUrl && !isSameSearchContext(session.searchUrl, currentSearch)) {
      log("Page de recherche inattendue (redirect Hellowork) — retour session: " + session.searchUrl);
      window.location.href = session.searchUrl;
      return;
    }

    if (!session.searchUrl) {
      session = await setSession({ searchUrl: currentSearch });
    }

    const visitedOffers = session.visitedOffers || {};
    const externalSiteOffers = session.externalSiteOffers || {};
    const allLinks = collectOfferLinks();
    const queue = allLinks.filter((item) => {
      const key = item.jobId || item.url;
      return !visitedOffers[key] && !externalSiteOffers[key];
    });

    log("Page recherche: " + allLinks.length + " offres, " + queue.length + " non visitées");

    if (queue.length === 0) {
      const nextUrl = findNextPageUrl(currentSearch);
      const seenSearch = session.visitedSearchUrls || [];
      if (!nextUrl || seenSearch.includes(nextUrl)) {
        await endSession("Fin: plus de nouvelles offres à visiter");
        return;
      }
      await setSession({
        currentPage: (session.currentPage || 0) + 1,
        visitedSearchUrls: [...seenSearch, nextUrl],
        // Keep searchUrl pointing to the ORIGINAL search so redirect-guard still works
      });
      log("Page suivante: " + nextUrl);
      window.location.href = nextUrl;
      return;
    }

    const target = queue[0];
    const key = target.jobId || target.url;
    await setSession({
      phase: "offer",
      currentOfferUrl: target.url,
      currentJobTitle: target.title || "",
      currentJobCompany: "",
      visitedOffers: { ...visitedOffers, [key]: true },
    });

    log("Ouverture offre: " + (target.title || target.url));
    await sleep(jitter(600, 1400));
    window.location.href = target.url;
  }

  // OFFER PAGE: click 1st apply button, then 2nd if still on page
  // Hellowork then navigates to /bounce/multiapply — we let it happen.
  async function handleOfferPage(session, settings) {
    const { title, company } = getOfferInfoFromDom();
    const jobId = offerIdFromUrl(window.location.href);
    const offerKey = jobId || normalizeUrl(window.location.href);

    // Save job info so createalert handler can mark it applied correctly
    await setSession({ currentJobTitle: title, currentJobCompany: company, currentOfferUrl: window.location.href });
    log("Offre: " + title + " @ " + company);

    // External flow: "Postuler sur le site du recruteur" should be skipped to avoid leaving Hellowork.
    const recruiterBtn = findRecruiterSiteButton();
    if (recruiterBtn) {
      const refreshedBeforeSkip = await getSession();
      const externalSiteOffers = refreshedBeforeSkip?.externalSiteOffers || {};
      await setSession({
        phase: "search",
        currentOfferUrl: "",
        externalSiteOffers: { ...externalSiteOffers, [offerKey]: true },
      });
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        jobId,
        title,
        url: window.location.href,
        reason: "Postuler sur le site du recruteur",
      });
      log("Offre ignorée (site du recruteur): " + title, "warn");
      const refreshed = await getSession();
      if (refreshed?.searchUrl) {
        await sleep(jitter(1200, 2200));
        window.location.href = refreshed.searchUrl;
      }
      return;
    }

    const firstBtn = findApplyButton();
    if (!firstBtn) {
      log("Ignorée (pas de bouton postuler): " + title, "warn");
      await chrome.runtime.sendMessage({ action: "markSkipped", jobId, title, url: window.location.href, reason: "Bouton postuler introuvable" });
      const refreshed = await getSession();
      if (refreshed?.searchUrl) {
        await setSession({ phase: "search" });
        await sleep(jitter(2000, 4000));
        window.location.href = refreshed.searchUrl;
      }
      return;
    }

    log("1er clic postuler: \"" + textOf(firstBtn).slice(0, 80) + "\"");
    await humanClick(firstBtn);

    // Short wait: if still on offer page, there is a 2nd confirmation button to click
    await sleep(jitter(1500, 2500));
    if (isOfferPage(window.location.href)) {
      const secondBtn = findApplyButton({ exclude: firstBtn });
      if (secondBtn) {
        log("2e clic postuler: \"" + textOf(secondBtn).slice(0, 80) + "\"");
        await humanClick(secondBtn);
      }
    }
    // Page navigates to multiapply → script dies → handleMultiApplyPage continues
  }

  // MULTIAPPLY PAGE: click the "Je postule" / "Postuler" button
  // Hellowork then navigates to /bounce/createalert — we let it happen.
  async function handleMultiApplyPage(session, settings) {
    log("Page multiapply — recherche bouton postuler...");
    await sleep(jitter(700, 1300)); // Let page fully render before scanning DOM

    const btn = await findMultiApplyButtonWithScroll();
    if (btn) {
      log("Clic multiapply: \"" + textOf(btn).slice(0, 80) + "\"");
      await humanClick(btn);
      // Page navigates to createalert → script dies → handleCreateAlertPage continues
      return;
    }

    // No button found — wait for auto-redirect, then go back to search
    log("Aucun bouton sur multiapply — attente redirection (4s)", "warn");
    await sleep(4000);

    if (isMultiApplyPage(window.location.href)) {
      // Still here: count as applied and go back to search
      const refreshed = await getSession();
      const jobId = offerIdFromUrl(window.location.href) || offerIdFromUrl(refreshed?.currentOfferUrl || "");
      await chrome.runtime.sendMessage({
        action: "markApplied", jobId,
        title: refreshed?.currentJobTitle || ("Offre " + (jobId || "Hellowork")),
        company: refreshed?.currentJobCompany || "",
        url: refreshed?.currentOfferUrl || window.location.href,
      });
      if (refreshed?.searchUrl) {
        await setSession({ phase: "search", currentOfferUrl: "" });
        window.location.href = refreshed.searchUrl;
      }
    }
    // Otherwise, page already redirected — next handler will pick up
  }

  // CREATEALERT PAGE: final success — mark applied and go back to session search
  async function handleCreateAlertPage(session, settings) {
    const jobId = offerIdFromUrl(window.location.href) || offerIdFromUrl(session.currentOfferUrl || "");
    const title = session.currentJobTitle || ("Offre " + (jobId || "Hellowork"));
    const company = session.currentJobCompany || "";

    log("Candidature confirmée: " + title, "success");
    await chrome.runtime.sendMessage({
      action: "markApplied", jobId, title, company,
      url: session.currentOfferUrl || window.location.href,
    });

    const refreshed = await getSession();
    if (!refreshed?.active) return;

    if ((refreshed.applied || 0) >= (refreshed.maxJobs || 25)) {
      await endSession("Objectif session atteint");
      return;
    }

    const backUrl = refreshed.searchUrl;
    if (!backUrl) { await endSession("Pas d'URL de recherche en session"); return; }

    await setSession({ phase: "search", currentOfferUrl: "" });

    const delay = Math.max(settings.delayBetweenJobs?.min ?? 3000, 2000);
    await sleep(delay);

    log("Retour recherche pour prochaine offre: " + backUrl);
    window.location.href = backUrl;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  MAIN SESSION RUNNER — dispatches to per-page handler
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async function runAutoApplySession() {
    if (isRunning) return;
    isRunning = true;
    try {
      const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
      const settings = {
        autoSubmit: true,
        delayBetweenJobs: { min: 4000, max: 10000 },
        ...autoApplySettings,
      };

      const session = await getSession();
      if (!session?.active) { isRunning = false; return; }
      if (shouldStop) { await endSession("Arrêt demandé"); isRunning = false; return; }
      if ((session.applied || 0) >= (session.maxJobs || 25)) {
        await endSession("Objectif session atteint"); isRunning = false; return;
      }

      const url = window.location.href;
      log("[v" + VERSION + "] Page: " + new URL(url).pathname);

      if (isSearchPage(url))           await handleSearchPage(session, settings);
      else if (isOfferPage(url))       await handleOfferPage(session, settings);
      else if (isMultiApplyPage(url))  await handleMultiApplyPage(session, settings);
      else if (isCreateAlertPage(url)) await handleCreateAlertPage(session, settings);
      else log("Page non gérée: " + new URL(url).pathname, "warn");

    } catch (err) {
      log("Erreur session: " + err.message, "error");
      await chrome.runtime.sendMessage({ action: "markError", error: err.message });
    } finally {
      isRunning = false;
    }
  }

  // Single-job manual apply from popup
  async function applySingleJob() {
    if (!isOfferPage()) { log("Ouvrir une fiche offre Hellowork d'abord", "warn"); return; }
    const session = (await getSession()) || { active: true, currentOfferUrl: window.location.href, searchUrl: "", maxJobs: 1 };
    const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
    await handleOfferPage(session, { autoSubmit: true, ...autoApplySettings });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "startAutoApply") {
      runAutoApplySession().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.action === "stopAutoApply") { shouldStop = true; sendResponse({ ok: true }); return; }
    if (msg.action === "applySingleJob") { applySingleJob().then(() => sendResponse({ ok: true })); return true; }
    if (msg.action === "getContentStatus") { sendResponse({ isRunning, shouldStop, url: window.location.href }); return; }
  });

  // Auto-resume when page loads during an active session
  setTimeout(() => {
    getSession().then((session) => { if (session?.active) runAutoApplySession(); });
  }, 1000);
})();
