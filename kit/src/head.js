/**
 * Consent kit — head snippet (inline, synchronous).
 *
 * Placement (adapter contract, README): in <head>, AFTER the site's Google Consent Mode default script
 * (all denied) and AFTER the kit's config block <script type="application/json" id="ck-config">.
 * Every <script> of the kit carries data-cfasync="false" (Rocket Loader leaves it in place).
 *
 * It reads the stored choice — cookie `<config.cookie>` = encodeURIComponent(JSON {v, a, m, t}) — and accepts
 * it only when v equals config.revision (an integer from 1 to 1,000,000 — the records service's range; a bump
 * re-asks; any other revision, or a config.cookie that is not a non-empty string, makes the whole config count
 * as missing), a and m are 0 or 1 and t is a positive integer (unix seconds). Several copies of the cookie
 * (host + registrable domain) fail closed: the most restrictive valid copy counts. A valid choice:
 *   - adds `ck-decided` to <html> (kit.css hides layer 1 — no flash, no layout shift),
 *   - pushes gtag('consent', 'update', …) NOW, before any gated script can be activated (kit.js activates
 *     them later, after the parse), and gtag('set', 'url_passthrough', true) only with marketing consent.
 * No valid choice + Global Privacy Control (navigator.globalPrivacyControl === true) = a reject: no layer 1,
 * no cookie, no record, nothing pushed (the defaults are already denied); the footer link still opens the
 * settings, so an explicit opt-in stays possible.
 * At `load`, when kit.js has not booted (blocked, 404, an old engine), `ck-off` on <html> hides the
 * dead layer 1: nothing can be granted then (fail-closed).
 *
 * window.consentKit — the page's consent API, defined here so inline scripts after this one can read it:
 *   get()  → {analytics, marketing, decided, revision}
 *   open() → opens the settings dialog; queued until the deferred kit.js is ready (kit.js replaces it)
 *   _c / _s / _q / _k / _u / _r — kit-internal: the parsed config, the state {a, m, d, g}, the queued
 *   open(), kit.js ready, the one Consent Mode update (a, m), the one reader of the stored choice (kit.js
 *   reads it again when the page comes back from the back/forward cache or into view).
 * Any failure (no config, a malformed cookie) leaves the visitor undecided: nothing is granted.
 */
(function (w, d) {
  var cfg = null;

  function bit(x) {
    return x === 0 || x === 1;
  }

  /** A revision the records service accepts (worker/src/contract.ts): an integer from 1 to 1,000,000. */
  function rev(x) {
    return typeof x === "number" && x >= 1 && x <= 1e6 && Math.floor(x) === x;
  }

  /** Every valid copy of the choice cookie (a document may carry a host and a domain copy). */
  function stored(name) {
    var parts = d.cookie ? d.cookie.split("; ") : [];
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf(name + "=") !== 0) continue;
      try {
        var o = JSON.parse(decodeURIComponent(parts[i].slice(name.length + 1)));
        if (o && o.v === cfg.revision && bit(o.a) && bit(o.m) && typeof o.t === "number" && o.t > 0 && Math.floor(o.t) === o.t) {
          out.push(o);
        }
      } catch (e) {
        /* a malformed copy is no choice */
      }
    }
    return out;
  }

  function push() {
    (w.dataLayer = w.dataLayer || []).push(arguments);
  }

  function word(on) {
    return on ? "granted" : "denied";
  }

  /** THE Consent Mode update (kit.js calls it too, as consentKit._u): url_passthrough only with marketing. */
  function update(a, m) {
    push("consent", "update", {
      analytics_storage: word(a),
      ad_storage: word(m),
      ad_user_data: word(m),
      ad_personalization: word(m),
    });
    if (m) push("set", "url_passthrough", true);
  }

  /** THE reading of the stored choice (kit.js calls it too, as consentKit._r): the state {a, m, d, g} —
   *  the most restrictive valid copy; none + GPC = a reject; none, or no config = undecided. */
  function read() {
    var s = { a: 0, m: 0, d: 0, g: 0 };
    var copies = cfg ? stored(cfg.cookie) : [];
    if (copies.length) {
      s = { a: 1, m: 1, d: 1, g: 0 };
      for (var i = 0; i < copies.length; i++) {
        s.a = Math.min(s.a, copies[i].a);
        s.m = Math.min(s.m, copies[i].m);
      }
    } else if (cfg && w.navigator.globalPrivacyControl === true) {
      s = { a: 0, m: 0, d: 1, g: 1 };
    }
    return s;
  }

  try {
    cfg = JSON.parse(d.getElementById("ck-config").textContent);
    if (!cfg || !rev(cfg.revision) || typeof cfg.cookie !== "string" || !cfg.cookie) cfg = null;
  } catch (e) {
    cfg = null;
  }

  var st = read();

  if (st.d) {
    d.documentElement.classList.add("ck-decided");
    if (!st.g) update(st.a, st.m);
  }

  var api = (w.consentKit = {
    _c: cfg,
    _s: st,
    _q: 0,
    _k: 0,
    _u: update,
    _r: read,
    get: function () {
      var s = api._s;
      return { analytics: s.a === 1, marketing: s.m === 1, decided: s.d === 1, revision: cfg ? cfg.revision : null };
    },
    open: function () {
      api._q = 1;
    },
  });

  w.addEventListener("load", function () {
    if (w.consentKit === api && !api._k) d.documentElement.classList.add("ck-off");
  });
})(window, document);
