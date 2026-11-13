/**
 * Consent kit — the deferred logic file (one same-origin <script data-cfasync="false" src="…" defer>).
 *
 * Needs the head snippet (window.consentKit with the parsed config) and the reference markup
 * (templates/banner.html: layer 1 [data-ck-banner], the settings <dialog data-ck-dialog>).
 * Without the head snippet's config it does nothing at all — fail-closed: nothing activates, nothing is sent,
 * and the head snippet hides the dead layer 1 at `load` (it never saw this file's ready flag `_k`).
 *
 * Boot (deferred = after the parse, so inline end-of-body listeners already exist; a second run does nothing):
 *   1. one click listener on document for every [data-ck-action] (accept | reject | save),
 *      [data-ck-open] (layer-1 „Einstellungen“, the footer link — added later too) and
 *      [data-ck-close]; consentKit.open() is replaced (a queued call opens now);
 *   2. deletes a previous consent tool's cookies (config.legacy, e.g. `previous-tool-consent`) on the host and the
 *      registrable domain, and runs the cleanup of every category that is not granted — undecided, GPC and a
 *      denied choice alike: no consent, no tracking cookies;
 *   3. a decided visitor: activates the granted `script[type="text/plain"][data-consent]` and dispatches
 *      `consentkit:change` ONCE (detail = consentKit.get()). Consumers read consentKit.get() FIRST and then listen
 *      to `consentkit:change`: a listener registered after this file ran (a later defer / async / module script)
 *      has missed the on-load event.
 * NO network request before a decision: no record, no beacon, no gated script.
 *
 * Layer 1 never hides the focus (WCAG 2.4.11 Focus Not Obscured): while it is on screen (undecided), its height —
 * kept current by a ResizeObserver, without one measured at boot and at every focus check — is --ck-layer-h on
 * <html>; kit.css turns it into the scroll-padding-bottom of the root and of <body> and the height of a spacer
 * kit.js appends as the last child of <body>, so every focused element, the last footer link included, can scroll
 * clear of it. A keyboard focus (:focus-visible) that layer 1 still covers once its position has held still for two
 * frames (an engine that ignores scroll-padding for focus) is scrolled into view to the nearest edge, smooth unless
 * the visitor prefers reduced motion. A decision — or one followed from another tab — removes the height, the
 * spacer, the observer and that check.
 *
 * A decision (a click) runs, in this order: delete every copy of the choice cookie (host and registrable
 * domain — a stale domain copy would otherwise be read first), write it (6 months, SameSite=Lax; Path=/,
 * Secure on https), the Consent Mode update (consentKit._u — the head snippet's one implementation:
 * url_passthrough only with marketing), the cleanup of every denied category, the activation, `consentkit:change`,
 * the consent record (fetch keepalive, credentials "omit", mode "no-cors" — text/plain, no preflight, no
 * cookies; never sendBeacon, which sends cookies) and hides layer 1. The record goes to layer 1's
 * `data-endpoint` with its `data-site` — the site's markup, not this file: without both, no record is sent.
 * A withdrawal (a granted category denied) goes straight from the cleanup to the record (action `withdraw`)
 * and a reload — a loaded tag cannot be unloaded; no activation, event or focus work first — and every
 * deciding click after it is ignored while the reload is under way (for 10 s, or until the page comes back
 * from the back/forward cache: a host's beforeunload „stay“ cancels a reload). Focus then goes back to the
 * opener when it is still on screen, else to <main>.
 *
 * A page that stays alive — back from the back/forward cache (`pageshow`, persisted) or a tab coming back
 * into view (`visibilitychange`) — reads the stored choice again with the head snippet's reader
 * (consentKit._r, GPC included): a category this page granted that is now denied, or no valid choice any
 * more → a reload; a page that has become decided or gained a grant (a decision in another tab) → the state,
 * `ck-decided`, the Consent Mode update (none under GPC), the activation and `consentkit:change`, like
 * after a decision — but no cookie write and no record (the deciding page did both) — an open dialog's
 * switches show the new state and focus inside the now hidden layer 1 goes to <main>; unchanged → nothing.
 * A restore fires both events, in either order: it lifts only a reload guard that was up when the page was
 * hidden (`pagehide`), never the guard of a reload the first of the two events started.
 * Cookies blocked: a decision whose cookie did not stick (read back right after the write: no stored choice)
 * marks this page, which then skips the lost-choice reload while no choice is stored — it stays as decided
 * instead of asking again; the first stored choice it reads (a decision in another tab) ends the mark.
 * Head and kit ship as a pair: next to a head snippet without the reader (`_r`) a decision still completes,
 * but nothing is read back or followed.
 */
(() => {
  const d = document;
  const w = window;
  const api = w.consentKit;
  const cfg = api && api._c;
  if (!cfg || api._k) return;

  const html = d.documentElement;
  const found = d.querySelector("[data-ck-dialog]");
  // an engine without <dialog>: no settings layer (its openers keep their own href); layer 1 still decides
  const dialog = found && typeof found.showModal === "function" ? found : null;
  const BANNER = "[data-ck-banner]";
  const DECIDED = "ck-decided";
  const SETTINGS = "ck-settings";
  const SIX_MONTHS = 15552000;
  // where the records go and which site they name: the site's own markup on layer 1 (empty = no records)
  const banner = d.querySelector(BANNER);
  const endpoint = (banner && banner.getAttribute("data-endpoint")) || "";
  const site = (banner && banner.getAttribute("data-site")) || "";
  let opener = null;
  let shut = true; // the dialog's close handling ran for the current opening
  let reloading = false; // a reload is under way: no further decision on this page (until it is reset)
  let timer = 0; // the reload guard's 10 s timer
  let held = false; // the guard was up when the page was hidden (pagehide): back from the cache, that reload never ran
  let unstored = false; // this page's last decision did not stick (cookies blocked): no lost-choice reload

  /* ---------- cookies & storage ---------- */
  const names = () => (d.cookie ? d.cookie.split("; ").map((c) => c.split("=")[0]) : []);
  const drop = (name) => {
    const gone = name + "=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/";
    d.cookie = gone;
    if (cfg.domain) d.cookie = gone + "; Domain=" + cfg.domain;
  };
  /** Deletes a category's cookies (exact names, or a prefix ending in `*`) and localStorage keys. */
  const clean = (category) => {
    const rule = (cfg.cleanup && cfg.cleanup[category]) || {};
    const patterns = rule.cookies || [];
    names().forEach((n) => {
      if (patterns.some((p) => (p.slice(-1) === "*" ? n.indexOf(p.slice(0, -1)) === 0 : n === p))) drop(n);
    });
    (rule.localStorage || []).forEach((key) => {
      try {
        w.localStorage.removeItem(key);
      } catch (e) {
        /* storage blocked: nothing stored there either */
      }
    });
  };

  /* ---------- activation of gated scripts ---------- */
  const activate = () => {
    const map = cfg.categories || {};
    const on = Object.create(null); // no prototype: data-consent="constructor" / "__proto__" is no category
    if (api._s.a && map.analytics) on[map.analytics] = 1;
    if (api._s.m && map.marketing) on[map.marketing] = 1;
    d.querySelectorAll('script[type="text/plain"][data-consent]').forEach((node) => {
      if (node.getAttribute("data-consent-state") === "active" || !on[node.getAttribute("data-consent")]) return;
      node.setAttribute("data-consent-state", "active");
      const s = d.createElement("script");
      // every attribute travels (src, integrity, crossorigin, nonce, referrerpolicy, fetchpriority, data-*) —
      // but the id, which would then exist twice
      Array.from(node.attributes).forEach((at) => {
        if (at.name !== "type" && at.name !== "data-consent-state" && at.name !== "id") s.setAttribute(at.name, at.value);
      });
      if (node.nonce) s.nonce = node.nonce; // the nonce attribute reads "" once the page is CSP-protected
      s.setAttribute("data-cfasync", "false");
      if (!node.hasAttribute("src")) s.text = node.text;
      s.async = node.hasAttribute("async");
      node.parentNode.insertBefore(s, node.nextSibling);
    });
  };

  const emit = () => d.dispatchEvent(new CustomEvent("consentkit:change", { detail: api.get() }));

  const record = (action) => {
    if (!endpoint || !site) return;
    // lang: the primary subtag of <html lang>, lower-cased (de-DE → de, EN → en): the service takes exactly de / en
    try {
      fetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ site, v: cfg.revision, a: api._s.a, m: api._s.m, action, lang: html.lang.split("-")[0].toLowerCase() }),
        keepalive: true,
        credentials: "omit",
        mode: "no-cors",
      }).catch(() => {});
    } catch (e) {
      /* no fetch: the decision stands, only its record is lost */
    }
  };

  /* ---------- focus ---------- */
  /** An element focus can return to: connected, not inside the kit's dialog, not in a hidden layer 1, rendered. */
  const onScreen = (el) =>
    !!el &&
    el.nodeType === 1 &&
    el !== d.body &&
    el.isConnected &&
    !el.closest("[data-ck-dialog]") &&
    !(el.closest(BANNER) && html.classList.contains(DECIDED)) &&
    el.getClientRects().length > 0;
  /** The defined landing place when the opener is gone: <main> (else <body>), focusable for the moment. */
  const land = () => {
    const t = d.querySelector("main") || d.body;
    if (!t.hasAttribute("tabindex")) {
      t.setAttribute("tabindex", "-1");
      t.addEventListener("blur", () => t.removeAttribute("tabindex"), { once: true });
    }
    t.focus({ preventScroll: true });
  };

  /* ---------- layer 1 never hides the focus (WCAG 2.4.11 Focus Not Obscured) ---------- */
  // While layer 1 is on screen, its height is --ck-layer-h on <html>: kit.css turns it into the scroll-padding-bottom
  // of the root and of <body> and the height of the spacer, an empty block kit.js keeps as the last child of <body>.
  // A ResizeObserver keeps it current without a layout forced at boot; 0 — layer 1 hidden behind the open dialog —
  // keeps the last height, so nothing behind the modal moves. A kit whose page a newer head snippet took over keeps
  // its observer connected, but inert: it writes nothing any more (the new kit, once booted, takes the spacer over).
  const LAYER_H = "--ck-layer-h";
  let sizer = null;
  let spacer = null;
  const put = (h) => {
    if (h && w.consentKit === api) html.style.setProperty(LAYER_H, h + "px");
  };
  const measure = () => put(banner.getBoundingClientRect().height);
  /** A keyboard focus — :focus-visible; a pointer focuses what it already shows. An engine without it: every focus. */
  const keyboard = (el) => {
    try {
      return el.matches(":focus-visible");
    } catch (e) {
      return true;
    }
  };
  /** A keyboard focus that layer 1 still covers after the browser's own focus scroll (an engine that ignores
   *  scroll-padding for focus) is scrolled clear — to the nearest edge, smooth unless the visitor prefers reduced
   *  motion. It is checked once its position has held still for two frames (120 at the latest), so a smooth focus
   *  scroll still under way is never restarted. Covered = overlapping layer 1's box: an element below the
   *  viewport (a host's focus with preventScroll) is not; an element taller than the space above layer 1 that
   *  already shows stays; a hidden layer 1 (the dialog open, or decided meanwhile) has no height. Without an
   *  observer every check measures layer 1 again (a rotation). */
  const uncover = (e) => {
    const t = e.target;
    let top; // the target's top a frame earlier
    let n = 0;
    const check = () => {
      if (w.consentKit !== api || d.activeElement !== t || banner.contains(t) || !keyboard(t)) return;
      const b = banner.getBoundingClientRect();
      const r = t.getBoundingClientRect();
      if (!sizer) put(b.height);
      if (r.top !== top && n++ < 120) {
        top = r.top;
        w.requestAnimationFrame(check);
      } else if (b.height && r.bottom > b.top && r.top < b.bottom && (r.top >= b.top || r.height < b.top)) {
        t.scrollIntoView({ block: "nearest", behavior: w.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    };
    w.requestAnimationFrame(check);
  };
  /** Decided: layer 1 hides for good — its height (the padding), the spacer, the observer and the focus check go. */
  const hide = () => {
    html.classList.add(DECIDED);
    if (sizer) sizer.disconnect();
    if (spacer) spacer.remove();
    html.style.removeProperty(LAYER_H);
    d.removeEventListener("focusin", uncover, true);
  };

  /** A fresh page (a loaded tag cannot be unloaded). Deciding clicks wait for it — for 10 s: a host's
   *  beforeunload „stay“ cancels the reload, and the page must not stay dead. */
  const reload = () => {
    reloading = true;
    w.clearTimeout(timer); // one guard, one timer: an earlier reload's must not end this one early
    timer = w.setTimeout(() => {
      reloading = false;
    }, 1e4);
    w.location.reload();
  };

  /* ---------- a decision ---------- */
  /** A state of the head snippet's reader with no stored choice behind it: undecided, or the GPC default. */
  const none = (s) => !s.d || s.g;
  /** Returns true when the decision withdrew a grant: the page is then reloading. */
  const decide = (a, m, action) => {
    const prev = api._s;
    const withdrawn = !!((prev.a && !a) || (prev.m && !m));
    api._s = { a, m, d: 1, g: 0 };
    drop(cfg.cookie);
    d.cookie =
      cfg.cookie +
      "=" +
      encodeURIComponent(JSON.stringify({ v: cfg.revision, a, m, t: Math.floor(Date.now() / 1e3) })) +
      "; Max-Age=" +
      SIX_MONTHS +
      "; Path=/; SameSite=Lax" +
      // Secure on https only: a plain-http test host would drop the whole cookie silently
      (w.location.protocol === "https:" ? "; Secure" : "");
    unstored = typeof api._r === "function" && none(api._r()); // read back: blocked cookies keep nothing
    api._u(a, m);
    if (!a) clean("analytics");
    if (!m) clean("marketing");
    if (withdrawn) {
      // a loaded tag cannot be unloaded: the record, then a fresh page — no activation, event or focus first
      record("withdraw");
      reload();
      return true;
    }
    activate();
    emit();
    record(action);
    hide();
    return false;
  };

  /* ---------- the settings dialog ---------- */
  const checked = (category) => {
    const el = dialog && dialog.querySelector('[data-ck-category="' + category + '"]');
    return el && el.checked ? 1 : 0;
  };
  /** The switches show the page's state: at every opening, and when the page follows a decision made elsewhere. */
  const syncSwitches = () => {
    const s = api.get();
    dialog.querySelectorAll("[data-ck-category]").forEach((el) => {
      el.checked = s[el.getAttribute("data-ck-category")] === true;
    });
  };
  const open = (from) => {
    if (!dialog || dialog.open) return;
    syncSwitches();
    // the clicked element: Safari does not focus a button on click, so activeElement would be <body>
    const el = from || d.activeElement;
    try {
      dialog.showModal();
    } catch (e) {
      return; // not opened: no state changes
    }
    // after showModal(): the dialog has recorded the still-visible opener for its own focus return
    opener = el;
    shut = false;
    html.classList.add(SETTINGS);
  };
  /** Once per close, whichever way: layer 1 back, focus to the opener if it is on screen, else <main>. Called
   *  right after our own close() calls too — the `close` event is a later task in Chromium, so a stale one can
   *  reach a dialog opened again in between: an open dialog is left alone. */
  const after = () => {
    if (shut || dialog.open) return;
    shut = true;
    html.classList.remove(SETTINGS);
    const el = opener;
    opener = null;
    if (onScreen(el)) el.focus({ preventScroll: true });
    else land();
  };
  /** Closes without a decision; layer 1 is back before the browser returns focus into it. */
  const dismiss = () => {
    html.classList.remove(SETTINGS);
    dialog.close();
    after();
  };
  if (dialog) {
    // Escape (a close request) closes without saving — so do the close control and a click on the backdrop;
    // the next open() re-reads the stored choice.
    dialog.addEventListener("close", after);
    // Escape and the native light dismiss (closedby="any") fire `cancel`, then the browser closes the dialog
    // and returns focus in the SAME task — the `close` event follows as a later task (1–50 ms in Chromium).
    // Layer 1 comes back here, so that focus can land in it and no frame shows neither layer. A `cancel`
    // that a later listener prevents keeps the dialog open: layer 1 steps aside again before the next frame.
    dialog.addEventListener("cancel", (e) => {
      if (e.defaultPrevented) return;
      html.classList.remove(SETTINGS);
      w.requestAnimationFrame(() => {
        if (w.consentKit === api && dialog.open && !shut) html.classList.add(SETTINGS);
      });
    });
    if (!("closedBy" in dialog)) {
      // closedby="any" where it is unsupported (Safari): a press AND a release on the backdrop dismiss,
      // tested by position — the dialog is also the target of its own padding
      const outside = (e) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      let pressed = false;
      dialog.addEventListener("pointerdown", (e) => {
        pressed = outside(e);
      });
      dialog.addEventListener("pointerup", (e) => {
        if (pressed && outside(e) && dialog.open) dismiss();
        pressed = false;
      });
    }
  }

  const CHOICE = { accept: () => [1, 1], reject: () => [0, 0], save: () => [checked("analytics"), checked("marketing")] };
  d.addEventListener("click", (e) => {
    if (w.consentKit !== api) return; // a newer head snippet owns the page
    const t = e.target && e.target.closest ? e.target.closest("[data-ck-action],[data-ck-open],[data-ck-close]") : null;
    if (!t) return;
    if (t.hasAttribute("data-ck-open")) {
      if (!dialog) return; // no settings layer here: the opener's own href is the fallback
      e.preventDefault();
      open(t);
      return;
    }
    if (t.hasAttribute("data-ck-close")) {
      e.preventDefault();
      if (dialog && dialog.open) dismiss();
      return;
    }
    const action = t.getAttribute("data-ck-action");
    if (!Object.prototype.hasOwnProperty.call(CHOICE, action)) return;
    e.preventDefault();
    if (reloading) return; // a reload is under way: this page decides nothing more
    const [a, m] = CHOICE[action]();
    if (decide(a, m, action)) return; // a withdrawal: the page is reloading
    if (dialog && dialog.open) {
      dialog.close();
      after();
    } else if (t.closest(BANNER)) land();
  });

  /* ---------- a page that stays alive: the back/forward cache, a decision in another tab ---------- */
  const resync = () => {
    // no reader: a head snippet of another build (head and kit ship as a pair) — nothing to follow
    if (w.consentKit !== api || reloading || typeof api._r !== "function") return;
    const s = api._s;
    const n = api._r();
    if (!none(n)) unstored = false; // a choice is stored (made elsewhere): from now on, losing it is a lost choice
    // this page's own choice never reached the cookie and still none is stored: nothing was lost elsewhere —
    // the page stays as decided (a reload would only ask again)
    if (unstored && none(n)) return;
    if ((s.a && !n.a) || (s.m && !n.m) || (s.d && !n.d)) {
      reload(); // a grant this page holds is gone, or the choice itself
    } else if ((n.a && !s.a) || (n.m && !s.m) || (n.d && !s.d)) {
      // decided elsewhere: that page wrote the cookie and sent the record — this one only follows, its UI
      // too: an open dialog's switches, and focus in layer 1 lands as after a decision there
      const focused = banner && banner.contains(d.activeElement);
      api._s = n;
      if (!n.g) api._u(n.a, n.m);
      activate();
      emit();
      hide();
      if (dialog) syncSwitches();
      if (focused) land();
    }
  };
  // back from the back/forward cache, `pageshow` (persisted) and `visibilitychange` both fire, in either order:
  // only a guard that was up when the page was hidden belongs to a reload that never ran — a reload the first
  // of the two events started keeps its guard and its timer
  w.addEventListener("pagehide", () => {
    held = reloading;
  });
  w.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    if (held) {
      held = false;
      w.clearTimeout(timer);
      reloading = false; // a page that is back was not reloaded
    }
    resync();
  });
  d.addEventListener("visibilitychange", () => {
    if (d.visibilityState === "visible") resync();
  });

  /* ---------- boot ---------- */
  html.classList.remove("ck-off"); // a late boot heals the head snippet's load-time fallback
  const queued = api._q;
  api._q = 0;
  api.open = () => open(null);

  const legacy = cfg.legacy || [];
  names().forEach((n) => {
    if (legacy.indexOf(n) !== -1) drop(n);
  });
  if (!api._s.a) clean("analytics");
  if (!api._s.m) clean("marketing");
  if (api._s.d) {
    activate();
    emit();
  } else if (banner) {
    // undecided: layer 1 is on screen, and the spacer at the end of the page — one (a kit before this one, on a page
    // a newer head snippet took over, may have left its own)
    spacer = d.getElementById("ck-sp") || d.createElement("div");
    spacer.id = "ck-sp";
    spacer.setAttribute("aria-hidden", "true");
    d.body.appendChild(spacer);
    if (w.ResizeObserver) (sizer = new w.ResizeObserver(measure)).observe(banner);
    else measure();
    d.addEventListener("focusin", uncover, true);
  }
  api._k = 1;
  if (queued) open(null);
})();
