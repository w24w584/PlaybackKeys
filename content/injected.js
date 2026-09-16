// PlaybackKeys MAIN-world script.
// Runs in the page's own JS context so it can manipulate <video> elements
// and short-circuit hostile players (e.g. Udemy's syncPlayStateToPlayer).

(() => {
  const TAG = "playbackkeys";
  const REQ = `${TAG}:req`;
  const RES = `${TAG}:res`;
  const PRESENCE = `${TAG}:presence`;
  const I18N = `${TAG}:i18n`;

  if (window.__playbackkeysInstalled) return;
  window.__playbackkeysInstalled = true;

  // ---------- Video discovery ----------

  function videoScore(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) return 0;
    if (r.bottom < 0 || r.right < 0) return 0;
    if (r.top > (window.innerHeight || 1e6)) return 0;
    if (r.left > (window.innerWidth || 1e6)) return 0;
    if (el.readyState < 1 && !el.currentSrc && !el.src) return 0;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return 0;
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    return (!el.paused && el.readyState > 1 ? area * 2 : area);
  }

  function pickBestVideo() {
    let best = null;
    let bestScore = 0;
    for (const video of document.querySelectorAll("video")) {
      const score = videoScore(video);
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
    if (best) return best;
    return pickPipVideo();
  }

  // ---------- Picture-in-Picture support ----------
  // Sites like Bilibili move the whole player — including its <video> — into
  // a Document Picture-in-Picture window, leaving the page with no playable
  // video of its own. The PiP window is same-origin with the opener, so its
  // <video> can be found and controlled directly from this MAIN-world script.
  //
  // Native video PiP (document.pictureInPictureElement) keeps the element in
  // this document, even when the site hides or un-sizes it while popped out.

  function getPipWindow() {
    try {
      const api = window.documentPictureInPicture;
      if (!api || !api.window || !api.window.document) return null;
      return api.window;
    } catch {
      return null;
    }
  }

  function pickPipVideo() {
    try {
      const pipEl = document.pictureInPictureElement;
      if (pipEl && pipEl.tagName === "VIDEO") return pipEl;
    } catch { /* ignore */ }

    const pipWin = getPipWindow();
    if (!pipWin) return null;
    let best = null;
    for (const video of pipWin.document.querySelectorAll("video")) {
      if (video.readyState < 1 && !video.currentSrc && !video.src) continue;
      if (!best) { best = video; continue; }
      if (!video.paused && best.paused) { best = video; continue; }
      if (video.paused && !best.paused) continue;
      const a = video.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      if (a.width * a.height > b.width * b.height) best = video;
    }
    return best;
  }

  function watchPipWindow(win) {
    if (!win) return;
    try {
      if (win.__pkPipWatched) return;
      win.__pkPipWatched = true;
    } catch { /* ignore */ }
    // The player moves back to this page when the PiP window closes.
    win.addEventListener("pagehide", () => {
      setTimeout(() => {
        scanVideos();
        const v = pickBestVideo();
        if (v) announce(v.paused ? "paused" : "playing");
      }, 0);
    });
  }

  // ---------- Anti-fightback (per-instance, narrow blast radius) ----------
  // Hostile players (Udemy React, YouTube preference restore) reset
  // playbackRate on us. Defend by patching the SPECIFIC <video> instance
  // we're controlling, not the prototype. For pause: hostile players sometimes
  // fire play() right after a pause; defend with a short-lived play-event
  // listener that re-pauses, instead of overriding HTMLMediaElement.prototype.play.

  let desiredRate = null;
  let desiredRateUntil = 0;

  const rateDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "playbackRate");

  function ensureRatePatch(video) {
    if (video.__pkRatePatched) return;
    if (!rateDesc || !rateDesc.configurable) return;
    try {
      Object.defineProperty(video, "playbackRate", {
        configurable: true,
        enumerable: true,
        get() { return rateDesc.get.call(video); },
        set(v) {
          if (Date.now() < desiredRateUntil && desiredRate != null && v !== desiredRate) {
            rateDesc.set.call(video, desiredRate);
            return;
          }
          rateDesc.set.call(video, v);
        },
      });
      video.__pkRatePatched = true;
    } catch { /* ignore */ }
  }

  function applyRate(video, rate) {
    ensureRatePatch(video);
    // Use the native setter directly so the interval re-assert is robust even
    // if the page later mutates HTMLMediaElement.prototype.
    if (rateDesc && rateDesc.set) {
      try { rateDesc.set.call(video, rate); return; } catch { /* fall through */ }
    }
    try { video.playbackRate = rate; } catch { /* ignore */ }
  }

  function readRate(video) {
    if (rateDesc && rateDesc.get) {
      try { return rateDesc.get.call(video); } catch { /* fall through */ }
    }
    return video.playbackRate;
  }

  function userPauseWithDefense(video) {
    video.__pkUserPaused = true;
    const suppressUntil = Date.now() + 1500;
    const onPlay = () => {
      if (Date.now() < suppressUntil && video.__pkUserPaused) {
        try { video.pause(); } catch { /* ignore */ }
      }
    };
    video.addEventListener("play", onPlay);
    setTimeout(() => video.removeEventListener("play", onPlay), 1700);
    try { video.pause(); } catch { /* ignore */ }
  }

  function userPlay(video) {
    video.__pkUserPaused = false;
    try { video.play().catch(() => {}); } catch { /* ignore */ }
  }

  let activeRateInterval = null;

  function setRate(video, rate) {
    desiredRate = rate;
    desiredRateUntil = Date.now() + 5000;
    // Kill any previous fightback loop; otherwise it races against this new one,
    // re-asserting an outdated rate via the native-setter bypass.
    if (activeRateInterval) {
      clearInterval(activeRateInterval);
      activeRateInterval = null;
    }
    applyRate(video, rate);
    let ticks = 0;
    activeRateInterval = setInterval(() => {
      if (++ticks > 24 || Date.now() > desiredRateUntil) {
        clearInterval(activeRateInterval);
        activeRateInterval = null;
        updateBadge();
        return;
      }
      if (readRate(video) !== rate) applyRate(video, rate);
    }, 250);
    updateBadge();
  }

  function resetRate(video) {
    setRate(video, 1);
  }

  function fmtSpeed(r) { return `${(Math.round(r * 100) / 100).toFixed(2)}×`; }

  // ---------- In-page UI (Shadow DOM) ----------
  // Toast (bottom-right) and persistent speed badge (bottom-left), both
  // styled as glass surfaces and rendered inside an attached Shadow root so
  // host CSS cannot bleed in. Anchored at `bottom: 62px` to clear the player
  // chrome on YouTube / Vimeo / Udemy / Coursera.

  let pkHostEl = null;
  let pkRoot = null;
  let toastEl = null;
  let toastIcEl = null;
  let toastNameEl = null;
  let toastDetEl = null;
  let badgeEl = null;
  let badgeValEl = null;
  let toastTimer = null;
  let badgePrefShown = true;
  let toastPrefShown = true;
  let toastDurationMs = 1500;
  let themeMode = "system";
  let toastHasShown = false;
  const themeMedia = typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : null;
  let messages = {
    clickToResetTo1x: "Click to reset to 1×",
    reset: "reset",
    toastPlay: "Play",
    toastPlaying: "Playing",
    toastPaused: "Paused",
    toastResetTo1x: "Reset to 1×",
    statusControlling: "Controlling",
  };

  function msg(key) {
    return messages[key] || key;
  }

  function applyI18nMessages(nextMessages) {
    if (!nextMessages || typeof nextMessages !== "object") return;
    messages = { ...messages, ...nextMessages };
    if (badgeEl) {
      badgeEl.title = msg("clickToResetTo1x");
      const resetEl = badgeEl.querySelector(".reset");
      if (resetEl) resetEl.textContent = `↺ ${msg("reset")}`;
    }
    if (toastNameEl && !toastHasShown) {
      toastNameEl.textContent = msg("toastPlay");
    }
  }

  function normalizeThemeMode(mode) {
    return mode === "light" || mode === "dark" || mode === "system" ? mode : "system";
  }

  function effectiveTheme() {
    if (themeMode === "light" || themeMode === "dark") return themeMode;
    return themeMedia && themeMedia.matches ? "dark" : "light";
  }

  function applyThemeMode(nextMode) {
    themeMode = normalizeThemeMode(nextMode);
    if (pkHostEl) pkHostEl.setAttribute("data-theme", effectiveTheme());
  }

  if (themeMedia) {
    const onThemeChange = () => {
      if (themeMode === "system") applyThemeMode(themeMode);
    };
    if (typeof themeMedia.addEventListener === "function") {
      themeMedia.addEventListener("change", onThemeChange);
    } else if (typeof themeMedia.addListener === "function") {
      themeMedia.addListener(onThemeChange);
    }
  }

  const SHADOW_CSS = `
    :host {
      all: initial;
      --pk-ui-fg: #ececee;
      --pk-ui-muted: #8a8a92;
      --pk-ui-bg: rgba(14, 14, 16, 0.86);
      --pk-ui-badge-bg: rgba(14, 14, 16, 0.78);
      --pk-ui-border: rgba(255, 255, 255, 0.08);
      --pk-ui-border-hover: rgba(255, 255, 255, 0.18);
      --pk-ui-reset-border: rgba(255, 255, 255, 0.08);
      --pk-ui-shadow: rgba(0, 0, 0, 0.55);
    }
    :host([data-theme="light"]) {
      --pk-ui-fg: #1a1a1d;
      --pk-ui-muted: #6c6c74;
      --pk-ui-bg: rgba(255, 255, 255, 0.92);
      --pk-ui-badge-bg: rgba(255, 255, 255, 0.88);
      --pk-ui-border: rgba(20, 20, 24, 0.12);
      --pk-ui-border-hover: rgba(20, 20, 24, 0.24);
      --pk-ui-reset-border: rgba(20, 20, 24, 0.12);
      --pk-ui-shadow: rgba(20, 20, 24, 0.22);
    }
    .pk-toast, .pk-badge {
      position: fixed;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      color: var(--pk-ui-fg);
      box-sizing: border-box;
      pointer-events: none;
    }
    .pk-toast {
      right: 18px; bottom: 62px;
      background: var(--pk-ui-bg);
      backdrop-filter: blur(12px) saturate(140%);
      -webkit-backdrop-filter: blur(12px) saturate(140%);
      border: 1px solid var(--pk-ui-border);
      border-radius: 10px;
      padding: 10px 14px 10px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12.5px;
      box-shadow: 0 12px 32px -8px var(--pk-ui-shadow);
      min-width: 160px;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity .18s ease, transform .18s ease;
    }
    .pk-toast.on { opacity: 1; transform: translateY(0); }
    .pk-toast .ic {
      width: 20px; height: 20px;
      border-radius: 6px;
      background: #F4B23E;
      color: #1a1208;
      display: grid; place-items: center;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 11px; font-weight: 700;
      flex-shrink: 0;
    }
    .pk-toast .body { display: flex; flex-direction: column; line-height: 1.3; min-width: 0; }
    .pk-toast .body .name { font-weight: 500; }
    .pk-toast .body .det {
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 10.5px;
      color: var(--pk-ui-muted);
      margin-top: 1px;
    }

    .pk-badge {
      left: 18px; bottom: 62px;
      background: var(--pk-ui-badge-bg);
      backdrop-filter: blur(12px) saturate(140%);
      -webkit-backdrop-filter: blur(12px) saturate(140%);
      border: 1px solid var(--pk-ui-border);
      border-radius: 8px;
      padding: 6px 10px 6px 8px;
      display: none;
      align-items: center;
      gap: 8px;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 12px;
      box-shadow: 0 8px 24px -8px var(--pk-ui-shadow);
      pointer-events: auto;
      cursor: pointer;
      user-select: none;
      transition: transform .15s, border-color .15s;
    }
    .pk-badge:hover { border-color: var(--pk-ui-border-hover); transform: translateY(-1px); }
    .pk-badge.show { display: inline-flex; }
    .pk-badge .dot { width: 6px; height: 6px; border-radius: 50%; background: #F4B23E; }
    .pk-badge .v {
      color: #F4B23E;
      font-variant-numeric: tabular-nums;
      font-weight: 500;
      letter-spacing: -0.01em;
    }
    .pk-badge .reset {
      color: var(--pk-ui-muted);
      font-size: 10px;
      margin-left: 2px;
      border-left: 1px solid var(--pk-ui-reset-border);
      padding-left: 8px;
    }
  `;

  // Build elements via createElement instead of innerHTML so strict
  // Trusted Types CSPs (e.g. YouTube's) don't reject the assignment.
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    for (const c of children) if (c) node.appendChild(c);
    return node;
  }

  function ensureShadow() {
    if (pkRoot) return;
    pkHostEl = document.createElement("div");
    pkHostEl.setAttribute("data-playbackkeys", "");
    pkHostEl.setAttribute("data-theme", effectiveTheme());
    pkHostEl.style.cssText = "all:initial;";
    pkRoot = pkHostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = SHADOW_CSS;
    pkRoot.appendChild(style);

    // Toast: <div class="pk-toast"><span class="ic">▶</span><div class="body"><span class="name">…</span><span class="det">…</span></div></div>
    toastIcEl   = el("span", { class: "ic",   text: "▶" });
    toastNameEl = el("span", { class: "name", text: msg("toastPlay") });
    toastDetEl  = el("span", { class: "det" });
    toastEl = el("div", { class: "pk-toast" },
      toastIcEl,
      el("div", { class: "body" }, toastNameEl, toastDetEl)
    );
    pkRoot.appendChild(toastEl);

    // Badge: <div class="pk-badge"><span class="dot"></span><span class="v">1.00×</span><span class="reset">↺ reset</span></div>
    badgeValEl = el("span", { class: "v", text: "1.00×" });
    badgeEl = el("div", { class: "pk-badge", title: msg("clickToResetTo1x") },
      el("span", { class: "dot" }),
      badgeValEl,
      el("span", { class: "reset", text: `↺ ${msg("reset")}` })
    );
    badgeEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = pickBestVideo();
      if (v) {
        resetRate(v);
        showToast({ ic: "↺", name: msg("toastResetTo1x"), det: "" });
      }
    });
    pkRoot.appendChild(badgeEl);
  }

  function attachShadowHost() {
    ensureShadow();
    if (pkHostEl.isConnected) return;
    // When a Document PiP window is open the user watches that window, so
    // anchor the toast / badge there instead of the (hidden) opener page.
    const pipWin = getPipWindow();
    const hostDoc = pipWin ? pipWin.document : document;
    const host = hostDoc.body || hostDoc.documentElement;
    if (host) host.appendChild(pkHostEl);
  }

  function showToast(payload) {
    if (!toastPrefShown) return;
    if (!payload) return;
    attachShadowHost();
    if (toastDurationMs === 0) return; // user disabled toast via "off" duration
    toastHasShown = true;
    toastIcEl.textContent   = payload.ic   || "•";
    toastNameEl.textContent = payload.name || "";
    toastDetEl.textContent  = payload.det  || "";
    const targetWin = getPipWindow() || window;
    targetWin.requestAnimationFrame(() => toastEl.classList.add("on"));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("on"), toastDurationMs);
  }

  function updateBadge() {
    const v = pickBestVideo();
    const rate = v ? readRate(v) : 1;
    const off = !v || Math.abs(rate - 1) < 0.005 || !badgePrefShown;
    if (off) {
      if (badgeEl) badgeEl.classList.remove("show");
      return;
    }
    attachShadowHost();
    badgeValEl.textContent = fmtSpeed(rate);
    badgeEl.classList.add("show");
  }

  // ---------- Command handler ----------

  function handle(payload) {
    const video = pickBestVideo();
    if (!video) return { handled: false };

    switch (payload?.action) {
      case "toggle": {
        if (video.paused) {
          userPlay(video);
          return { handled: true, toast: { ic: "▶", name: msg("toastPlaying"), det: "" } };
        } else {
          userPauseWithDefense(video);
          return { handled: true, toast: { ic: "❚❚", name: msg("toastPaused"), det: "" } };
        }
      }
      case "seek": {
        // Live streams report duration = Infinity and may have no seekable
        // ranges; restricted media can throw on currentTime assignment.
        const dur = video.duration;
        const seekable = video.seekable;
        const hasSeekable = seekable && seekable.length > 0;
        const upper = Number.isFinite(dur) && dur > 0
          ? dur
          : (hasSeekable ? seekable.end(seekable.length - 1) : Infinity);

        let target;
        if (Number.isFinite(payload.absoluteTime)) {
          target = payload.absoluteTime;
        } else {
          const delta = Number(payload.delta) || 0;
          target = (Number(video.currentTime) || 0) + delta;
        }
        target = Math.max(0, Math.min(upper, target));
        if (!Number.isFinite(target)) return { handled: false };

        try {
          video.currentTime = target;
        } catch (e) {
          console.warn("[PlaybackKeys] seek failed:", e);
          return { handled: false };
        }

        if (Number.isFinite(payload.absoluteTime)) {
          return { handled: true, toast: null };
        }
        const delta = Number(payload.delta) || 0;
        const sign = delta >= 0 ? "+" : "−";
        const ic = delta >= 0 ? "»" : "«";
        return { handled: true, toast: { ic, name: `${sign}${Math.abs(delta)}s`, det: "" } };
      }
      case "speed": {
        if (payload.reset) {
          resetRate(video);
          return { handled: true, toast: { ic: "↺", name: msg("toastResetTo1x"), det: "" } };
        }
        const min = Number.isFinite(payload.min) ? payload.min : 0.05;
        const max = Number.isFinite(payload.max) ? payload.max : 16;
        const wrap = !!payload.wrap;
        const cur = readRate(video) || 1;
        let next = Math.round((cur + (Number(payload.delta) || 0)) * 100) / 100;
        if (wrap) {
          if (next > max) next = min;
          else if (next < min) next = max;
        } else {
          next = Math.max(min, Math.min(max, next));
        }
        setRate(video, next);
        const sign = payload.delta >= 0 ? "+" : "−";
        return { handled: true, toast: { ic: sign, name: fmtSpeed(next), det: `${sign}${Math.abs(payload.delta).toFixed(2)}×` } };
      }
      case "noop":
        return { handled: true, toast: { ic: "•", name: msg("statusControlling"), det: document.title || location.hostname } };
      case "status":
        return {
          handled: true,
          status: {
            currentSpeed: readRate(video),
            paused: video.paused,
            duration: video.duration || 0,
            currentTime: video.currentTime || 0,
          },
        };
      default:
        return { handled: false };
    }
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== REQ) return;
    // Sync UI prefs from message payload (set by SW from chrome.storage).
    if (data.prefs) {
      if (typeof data.prefs.showBadge === "boolean") badgePrefShown = data.prefs.showBadge;
      if (typeof data.prefs.showToast === "boolean") toastPrefShown = data.prefs.showToast;
      if (Number.isFinite(data.prefs.toastDurationMs)) toastDurationMs = data.prefs.toastDurationMs;
      if (typeof data.prefs.themeMode === "string") applyThemeMode(data.prefs.themeMode);
      applyI18nMessages(data.prefs.i18n);
    }
    const result = handle(data.payload);
    if (result?.handled && data.showToast && result.toast) showToast(result.toast);
    if (result?.handled) updateBadge();
    window.postMessage({ source: RES, id: data.id, result }, "*");
  });

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== I18N || !data.messages) return;
    applyI18nMessages(data.messages);
  });

  // ---------- Presence reporting ----------

  function announce(state) {
    window.postMessage({ source: PRESENCE, state }, "*");
  }

  function attachVideoListeners(v) {
    if (v.__pkBound) return;
    v.__pkBound = true;
    v.addEventListener("play", () => announce("playing"));
    v.addEventListener("playing", () => announce("playing"));
    v.addEventListener("pause", () => announce("paused"));
    v.addEventListener("emptied", () => announce("gone"));
    v.addEventListener("ratechange", updateBadge);
    announce(v.paused ? "paused" : "playing");
    updateBadge();
  }

  function scanVideos() {
    document.querySelectorAll("video").forEach(attachVideoListeners);
    // Videos popped out into Picture-in-Picture live outside this document's
    // normal tree: the native PiP element stays here, while a Document PiP
    // player lives in a same-origin PiP window. Keep them announced too.
    try {
      const pipEl = document.pictureInPictureElement;
      if (pipEl && pipEl.tagName === "VIDEO") attachVideoListeners(pipEl);
    } catch { /* ignore */ }
    const pipWin = getPipWindow();
    if (pipWin) {
      pipWin.document.querySelectorAll("video").forEach(attachVideoListeners);
      watchPipWindow(pipWin);
    }
  }

  // Initial pass.
  if (document.readyState !== "loading") scanVideos();
  document.addEventListener("DOMContentLoaded", scanVideos, { once: true });

  // Watch for late-mounted players (YouTube SPA, dynamic embeds).
  // Inspect added nodes directly when possible; fall back to a debounced
  // full scan so heavy SPAs don't pay for a querySelectorAll on every tick.
  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => { scanScheduled = false; scanVideos(); }, 200);
  }
  const mo = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO") {
          attachVideoListeners(node);
        } else if (node.querySelector && node.querySelector("video")) {
          // Subtree contains a video — schedule a scan instead of recursing now.
          scheduleScan();
          return;
        }
      }
    }
  });
  mo.observe(document.documentElement, { subtree: true, childList: true });

  // Document Picture-in-Picture opens its own window, which the observer above
  // never sees (the player is moved out of this document). Re-scan and re-announce
  // when a PiP window opens so presence stays accurate.
  try {
    const pipApi = window.documentPictureInPicture;
    if (pipApi && typeof pipApi.addEventListener === "function") {
      pipApi.addEventListener("enter", () => {
        setTimeout(() => {
          scanVideos();
          const v = pickBestVideo();
          if (v) announce(v.paused ? "paused" : "playing");
        }, 0);
      });
    }
  } catch { /* ignore */ }

  // YouTube SPA navigation.
  document.addEventListener("yt-navigate-finish", () => setTimeout(scanVideos, 50));

  // If the host is gone, tell SW.
  window.addEventListener("pagehide", () => announce("gone"));
})();
