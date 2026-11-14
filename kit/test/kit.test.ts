// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://www.example.test/", "settings": { "disableJavaScriptFileLoading": true, "disableCSSFileLoading": true, "handleDisabledFileLoadingAsSuccess": true, "navigation": { "disableMainFrameNavigation": true } } }
/**
 * Consent kit — the behaviour of the SHIPPED bytes: the minified head snippet and kit.js exactly as
 * `kit/build.mjs` produces them, run in happy-dom on the reference markup (templates/banner.html,
 * rendered like an adapter renders it): the stored choice, GPC, decisions and their records (the endpoint
 * and site id from layer 1's markup), activation, cleanup and withdrawal (deciding clicks ignored while a
 * reload is under way), a page that stays alive (the back/forward cache, a decision in another tab), the
 * settings dialog (layer 1 back in its `cancel` event) and the reference markup.
 *
 * Network is impossible by construction: fetch is a spy, JavaScript file loading is off (an activated tag
 * is reported as loaded without a request), main-frame navigation is off and location.reload is a spy.
 * Cookie WRITES are observed through a pass-through `document.cookie` accessor, because happy-dom keys a
 * cookie by name + host + path only: the Domain attribute of a deletion is visible in the written string,
 * not in the jar — and a duplicate (host + domain) copy can only be staged through that accessor's getter.
 * happy-dom has no native dialog behaviour (no Escape, no focus return, no closedby): Escape is staged as
 * the browser's `cancel` + close(); the kit's own focus handling and backdrop fallback are what is tested.
 * happy-dom paints nothing: every test runs with a PerformanceObserver stand-in that supports paint timing, and
 * `paint()` is the browser reporting the first paint and the first contentful paint.
 */
import { buildAssets, renderBanner, configBlock, strings } from "../build.mjs";

type Assets = Record<"head.js" | "kit.js" | "kit.css", string>;
type Detail = { analytics: boolean; marketing: boolean; decided: boolean; revision: number | null };
type Api = { get(): Detail; open(): void };
type Win = Window & { consentKit?: Api; dataLayer?: unknown[] };

const win = () => window as unknown as Win;

const CONFIG = {
	revision: 2,
	cookie: "ck_consent",
	domain: "example.test",
	categories: { analytics: "analytics", marketing: "marketing" },
	cleanup: {
		analytics: { cookies: ["_ga", "_ga_*"] },
		marketing: { cookies: ["_gcl_*"], localStorage: ["_gcl_ls"] },
	},
	legacy: ["previous-tool-consent"],
};

/** Layer 1's data-endpoint / data-site — the site's markup, not the config. */
const ENDPOINT = "https://records.example.test/v1/record";
const SITE = "example-site";

/** The sample strings the page is rendered with (German) — read from the strings file, never repeated here. */
const S = strings("de") as Record<string, string>;

const GATED =
	'<script type="text/plain" data-consent="analytics" src="/js/analytics.js" integrity="sha256-abc" crossorigin="anonymous" async data-cfasync="false"></script>' +
	'<script type="text/plain" data-consent="marketing" src="/js/ads.js"></script>';

const EXPIRED = "=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/";
/** The page's hostname (the environment URL above): a previous tool or a tag may have left a domain cookie on it. */
const HOST = "www.example.test";
/** The deletion of a cookie's copy on the full hostname (`Domain=www.example.test`). */
const onHost = (name: string) => name + EXPIRED + "; Domain=" + HOST;

let assets: Assets;
let cookieWrites: string[];
/** Call order across cookie writes, fetch and reload. */
let order: string[];
/** A staged `document.cookie` read (e.g. a host + domain duplicate happy-dom cannot hold); null = the real jar. */
let fakeJar: string | null;
let fetchSpy: ReturnType<typeof vi.fn>;
let beaconSpy: ReturnType<typeof vi.fn>;
let reloadSpy: ReturnType<typeof vi.fn>;
let events: Detail[];
const onConsent = (e: Event) => events.push((e as CustomEvent<Detail>).detail);

beforeAll(async () => {
	assets = await buildAssets();
});

type PaintEntry = { name: string; entryType: string; startTime: number };
/** A paint entry list, as the kit's paint observer receives it. */
type PaintList = { getEntries(): PaintEntry[]; getEntriesByName(name: string): PaintEntry[] };
/** Both paint entries — what a buffered observer gets at once when the page has painted before it observes. */
const PAINTED = ["first-paint", "first-contentful-paint"];
/** PerformanceObserver stand-in (happy-dom paints nothing): what is observed, whether it was disconnected;
 *  `notify()` delivers paint entries to this observer, `paint()` to every connected one. */
const paintObservers: FakePerformanceObserver[] = [];
class FakePerformanceObserver {
	static supportedEntryTypes: readonly string[] = ["mark", "measure", "navigation", "paint", "resource"];
	options: unknown[] = [];
	disconnected = false;
	private readonly callback: (list: PaintList, observer: FakePerformanceObserver) => void;
	constructor(callback: (list: PaintList, observer: FakePerformanceObserver) => void) {
		this.callback = callback;
		paintObservers.push(this);
	}
	observe(options: unknown) {
		this.options.push(options);
	}
	disconnect() {
		this.disconnected = true;
	}
	/** One notification with these paint entries (default: both) for this observer — also after a disconnect (an
	 *  engine that still delivers a queued one). */
	notify(...names: string[]) {
		const entries = (names.length ? names : PAINTED).map((name) => ({ name, entryType: "paint", startTime: 100 }));
		this.callback({ getEntries: () => entries, getEntriesByName: (name) => entries.filter((e) => e.name === name) }, this);
	}
}
/** The browser reports paint entries (default: `first-paint` and `first-contentful-paint` in one notification):
 *  every connected observer gets them. */
const paint = (...names: string[]) => {
	for (const o of paintObservers.slice()) if (!o.disconnected && o.options.length) o.notify(...names);
};

/** The prototype's real `cookie` accessor, wrapped so every write is recorded (and a read can be staged). */
function watchCookieWrites() {
	let proto: object | null = Object.getPrototypeOf(document);
	let desc: PropertyDescriptor | undefined;
	while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, "cookie"))) proto = Object.getPrototypeOf(proto);
	if (!desc?.get || !desc.set) throw new Error("no document.cookie accessor found");
	const { get, set } = desc;
	Object.defineProperty(document, "cookie", {
		configurable: true,
		get: () => fakeJar ?? get.call(document),
		set: (v: string) => {
			cookieWrites.push(v);
			order.push("cookie " + v.split(";")[0]);
			set.call(document, v);
		},
	});
}

function cookieNames(): string[] {
	return document.cookie
		.split("; ")
		.filter(Boolean)
		.map((c) => c.split("=")[0] ?? "");
}

function stored(choice: unknown): string {
	return encodeURIComponent(JSON.stringify(choice));
}

const now = () => Math.floor(Date.now() / 1000);

/** The next animation frame (the kit re-checks a prevented `cancel` there). */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

beforeEach(() => {
	fakeJar = null;
	for (const name of cookieNames()) document.cookie = name + EXPIRED;
	localStorage.clear();
	cookieWrites = [];
	order = [];
	events = [];
	watchCookieWrites();
	fetchSpy = vi.fn(() => {
		order.push("fetch");
		return Promise.resolve(new Response(null, { status: 204 }));
	});
	vi.stubGlobal("fetch", fetchSpy);
	beaconSpy = vi.fn(() => true);
	Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beaconSpy });
	reloadSpy = vi.fn(() => order.push("reload"));
	vi.spyOn(window.location, "reload").mockImplementation(reloadSpy as () => void);
	paintObservers.length = 0;
	vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
	document.addEventListener("consentkit:change", onConsent);
	delete win().consentKit;
	win().dataLayer = [];
	document.documentElement.className = "";
	document.documentElement.removeAttribute("style"); // an earlier kit's layer-1 height (--ck-layer-h)
	document.documentElement.lang = "de";
});

afterEach(() => {
	document.removeEventListener("consentkit:change", onConsent);
	delete (document as unknown as { cookie?: string }).cookie;
	delete (document as unknown as { visibilityState?: string }).visibilityState;
	delete (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl;
	delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** A page as the adapter emits it: config block in <head>, reference markup first in <body>, a footer link, gated tags;
 *  `text` replaces the sample first-layer text. */
function page(opts: { cookie?: string; gpc?: boolean; config?: object | null; extra?: string; endpoint?: string; site?: string; text?: string } = {}) {
	const { cookie, gpc, config = CONFIG, extra = GATED, endpoint = ENDPOINT, site = SITE, text } = opts;
	document.head.innerHTML = config ? configBlock(config) : "";
	document.body.innerHTML =
		renderBanner("de", { privacyUrl: "/datenschutz/", imprintUrl: "/impressum/", endpoint, site, ...(text === undefined ? {} : { text }) }) +
		'<main><p>Inhalt</p></main><footer><a id="footer-link" href="#cookie-settings" data-ck-open>Cookie-Einstellungen</a></footer>' +
		extra;
	if (cookie !== undefined) document.cookie = `ck_consent=${cookie}; Path=/`;
	if (gpc !== undefined) Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: gpc });
	cookieWrites = [];
	order = [];
}

const runHead = () => new Function(assets["head.js"])();
const runKit = () => new Function(assets["kit.js"])();
const boot = (opts?: Parameters<typeof page>[0]) => {
	page(opts);
	runHead();
	runKit();
};

const api = () => {
	const a = win().consentKit;
	if (!a) throw new Error("window.consentKit is missing");
	return a;
};
const $ = <T extends Element = HTMLElement>(sel: string) => {
	const el = document.querySelector<T>(sel);
	if (!el) throw new Error(`missing ${sel}`);
	return el;
};
const layer1 = (action: "accept" | "reject") => $<HTMLButtonElement>(`[data-ck-banner] [data-ck-action="${action}"]`);
const layer1Settings = () => $<HTMLButtonElement>("[data-ck-banner] [data-ck-open]");
const footerLink = () => $<HTMLAnchorElement>("#footer-link");
const dialog = () => $<HTMLDialogElement>("[data-ck-dialog]");
const inDialog = (action: "accept" | "reject" | "save") => $<HTMLButtonElement>(`[data-ck-dialog] [data-ck-action="${action}"]`);
const closeControl = () => $<HTMLButtonElement>("[data-ck-dialog] [data-ck-close]");
const toggle = (category: "analytics" | "marketing") => $<HTMLInputElement>(`[data-ck-category="${category}"]`);
const has = (cls: string) => document.documentElement.classList.contains(cls);
const decided = () => has("ck-decided");

/** dataLayer entries as plain arrays (gtag pushes `arguments` objects). */
const commands = () => (win().dataLayer ?? []).map((e) => Array.from(e as ArrayLike<unknown>));
const updates = () => commands().filter((c) => c[0] === "consent" && c[1] === "update");
const passthrough = () => commands().filter((c) => c[0] === "set" && c[1] === "url_passthrough");

/** Scripts the kit inserted (real ones, not the text/plain originals). */
const activated = (src: string) =>
	Array.from(document.querySelectorAll<HTMLScriptElement>("script")).filter((s) => s.getAttribute("type") !== "text/plain" && s.getAttribute("src") === src);

/** Writes of a choice cookie VALUE (deletions excluded). */
const consentWrite = () => cookieWrites.filter((w) => w.startsWith("ck_consent=") && !w.startsWith("ck_consent=;"));
const recorded = (call = 0) => JSON.parse(String((fetchSpy.mock.calls[call] as [string, RequestInit] | undefined)?.[1]?.body));

/** What the browser does on Escape for a modal dialog: a cancelable `cancel`, then close(). */
function pressEscape(d: HTMLDialogElement) {
	if (d.dispatchEvent(new Event("cancel", { cancelable: true }))) d.close();
}

/** The browser's `pageshow`; `persisted` = the page comes back from the back/forward cache. */
function pageshow(persisted: boolean) {
	const e = new Event("pageshow");
	Object.defineProperty(e, "persisted", { value: persisted });
	window.dispatchEvent(e);
}

/** The page goes into the back/forward cache: `pagehide` (persisted), then the tab is hidden. */
function toCache() {
	const e = new Event("pagehide");
	Object.defineProperty(e, "persisted", { value: true });
	window.dispatchEvent(e);
	visibility("hidden");
}

/** The tab is hidden, or comes back into view. */
function visibility(state: "hidden" | "visible") {
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
	document.dispatchEvent(new Event("visibilitychange"));
}

/** Back from the back/forward cache: the browser fires `pageshow` (persisted) and `visibilitychange`, in either order. */
const RESTORES = [
	[
		"pageshow first",
		() => {
			pageshow(true);
			visibility("visible");
		},
	],
	[
		"visibilitychange first",
		() => {
			visibility("visible");
			pageshow(true);
		},
	],
] as const;

/** A decision in another tab: the stored choice changes behind this page's back (`null` = deleted). Not one
 *  of this page's writes — the write log starts empty again. */
function elsewhere(value: string | null) {
	document.cookie = value === null ? "ck_consent" + EXPIRED : `ck_consent=${value}; Path=/`;
	cookieWrites = [];
	order = [];
}

/** The SHIPPED CSS's own hiding rules for layer 1 (top-level rules giving .ck-cc display:none): happy-dom's
 *  getComputedStyle does not re-cascade on an ancestor's class change, so they are matched against the DOM. */
function hiders(): string[] {
	const topLevel = assets["kit.css"].replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
	return topLevel
		.split("}")
		.map((rule) => rule.split("{"))
		.filter(([sel, body]) => sel?.includes(".ck-cc") && /display:none/.test(body ?? ""))
		.flatMap(([sel]) => (sel ?? "").split(","))
		.sort();
}
const layer1Shown = () => !hiders().some((sel) => document.querySelector(sel) === $("[data-ck-banner]"));

/** Every rule of the SHIPPED CSS, in order: [media condition ("" at the top level), selectors, declarations]. */
function cssRules(): [string, string, string][] {
	const out: [string, string, string][] = [];
	for (const m of assets["kit.css"].matchAll(/@media([^{]*)\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}|([^{}@]+)\{([^{}]*)\}/g)) {
		if (m[1] === undefined) out.push(["", m[3] ?? "", m[4] ?? ""]);
		else for (const [, selectors = "", body = ""] of (m[2] ?? "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push([m[1].trim(), selectors, body]);
	}
	return out;
}

describe("head snippet — the stored choice", () => {
	it("a valid choice for the current revision: html class, the Consent Mode update in <head>, get()", () => {
		page({ cookie: stored({ v: 2, a: 1, m: 0, t: now() }) });
		runHead();
		expect(decided()).toBe(true);
		expect(updates()).toEqual([
			["consent", "update", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }],
		]);
		expect(passthrough()).toEqual([]);
		expect(api().get()).toEqual({ analytics: true, marketing: false, decided: true, revision: 2 });
	});

	it("url_passthrough is set only with marketing consent", () => {
		page({ cookie: stored({ v: 2, a: 0, m: 1, t: now() }) });
		runHead();
		expect(updates()[0]?.[2]).toEqual({ analytics_storage: "denied", ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" });
		expect(passthrough()).toEqual([["set", "url_passthrough", true]]);
	});

	it("a choice stored for an older revision re-asks: layer 1 shows, nothing is pushed", () => {
		page({ cookie: stored({ v: 1, a: 1, m: 1, t: now() }) });
		runHead();
		expect(decided()).toBe(false);
		expect(updates()).toEqual([]);
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: false, revision: 2 });
	});

	it.each([
		["not JSON", "yes"],
		["a = 2", stored({ v: 2, a: 2, m: 0, t: 1 })],
		["a = true", stored({ v: 2, a: true, m: 0, t: 1 })],
		["m = 2", stored({ v: 2, a: 0, m: 2, t: 1 })],
		["m = '1'", stored({ v: 2, a: 0, m: "1", t: 1 })],
		["no t", stored({ v: 2, a: 1, m: 0 })],
		["negative t", stored({ v: 2, a: 1, m: 0, t: -5 })],
		["fractional t", stored({ v: 2, a: 1, m: 0, t: 1.5 })],
		["v as a string", stored({ v: "2", a: 1, m: 0, t: 1 })],
		["null", stored(null)],
		["an array", stored([2, 1, 0, 1])],
		["broken escape", "%E0%A4%A"],
	])("a malformed cookie (%s) is no choice: undecided, fail-closed", (_label, value) => {
		page({ cookie: value });
		runHead();
		expect(decided()).toBe(false);
		expect(updates()).toEqual([]);
		expect(api().get().decided).toBe(false);
	});

	it("two copies of the cookie (host + registrable domain) fail closed to the most restrictive valid one", () => {
		page();
		fakeJar = [
			`ck_consent=${stored({ v: 2, a: 1, m: 1, t: 1 })}`,
			`ck_consent=${stored({ v: 2, a: 1, m: 0, t: 2 })}`,
			`ck_consent=${stored({ v: 1, a: 0, m: 0, t: 3 })}`,
		].join("; ");
		runHead();
		expect(api().get()).toEqual({ analytics: true, marketing: false, decided: true, revision: 2 });
		expect(updates()[0]?.[2]).toMatchObject({ analytics_storage: "granted", ad_storage: "denied" });
	});

	it("a cookie whose name only ends in the kit's name is not the kit's cookie", () => {
		page();
		fakeJar = `xck_consent=${stored({ v: 2, a: 1, m: 1, t: 1 })}`;
		runHead();
		expect(api().get().decided).toBe(false);
	});

	it.each([
		["no config block", null],
		["a revision that is not a number", { ...CONFIG, revision: "2" }],
	])("%s: undecided and kit.js does nothing at all", (_label, config) => {
		page({ config, cookie: stored({ v: 2, a: 1, m: 1, t: 1 }) });
		runHead();
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: false, revision: null });
		runKit();
		layer1("accept").click();
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(decided()).toBe(false);
	});

	it.each([
		["a fractional revision (1.5)", 1.5],
		["revision 0", 0],
		["a revision above 1,000,000", 1_000_001],
	])("%s — one the records service refuses — counts as no config: a stored choice for it grants nothing, kit.js does nothing", (_label, revision) => {
		page({ config: { ...CONFIG, revision }, cookie: stored({ v: revision, a: 1, m: 1, t: 1 }) });
		runHead();
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: false, revision: null });
		expect(updates()).toEqual([]);
		runKit();
		expect(activated("/js/analytics.js")).toHaveLength(0);
		layer1("accept").click();
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(decided()).toBe(false);
	});

	it("a revision of 1e400 (JSON.parse makes it Infinity) counts as no config too", () => {
		page({ cookie: stored({ v: 2, a: 1, m: 1, t: 1 }) });
		document.head.innerHTML = configBlock(CONFIG).replace('"revision":2', '"revision":1e400');
		runHead();
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: false, revision: null });
	});

	it.each([1, 1_000_000])("the records service's bounds are valid revisions (%i): a stored choice for it counts", (revision) => {
		page({ config: { ...CONFIG, revision }, cookie: stored({ v: revision, a: 1, m: 0, t: 1 }) });
		runHead();
		expect(api().get()).toEqual({ analytics: true, marketing: false, decided: true, revision });
	});
});

describe("kit.js not booted by `load`", () => {
	it("the head snippet hides the dead layer 1 (ck-off), nothing granted", () => {
		page();
		runHead();
		window.dispatchEvent(new Event("load"));
		expect(has("ck-off")).toBe(true);
		expect(hiders()).toContain(".ck-off .ck-cc");
		expect(layer1Shown()).toBe(false);
		expect(api().get().analytics).toBe(false);
	});

	it("a booted kit keeps layer 1 at `load`", () => {
		boot();
		window.dispatchEvent(new Event("load"));
		expect(has("ck-off")).toBe(false);
		expect(layer1Shown()).toBe(true);
	});
});

describe("Global Privacy Control", () => {
	it("GPC without a stored choice = reject: no layer 1, no cookie, no record, nothing pushed, one reject event", () => {
		boot({ gpc: true });
		expect(decided()).toBe(true);
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: true, revision: 2 });
		expect(consentWrite()).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(updates()).toEqual([]);
		expect(events).toEqual([{ analytics: false, marketing: false, decided: true, revision: 2 }]);
		expect(activated("/js/analytics.js")).toHaveLength(0);
	});

	it("GPC with a choice of an older revision is still a reject (no banner, nothing granted)", () => {
		boot({ gpc: true, cookie: stored({ v: 1, a: 1, m: 1, t: 1 }) });
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: true, revision: 2 });
		expect(activated("/js/analytics.js")).toHaveLength(0);
	});

	it("a stored choice wins over GPC", () => {
		boot({ gpc: true, cookie: stored({ v: 2, a: 1, m: 0, t: now() }) });
		expect(api().get()).toEqual({ analytics: true, marketing: false, decided: true, revision: 2 });
		expect(activated("/js/analytics.js")).toHaveLength(1);
	});

	it("opt-in stays possible: the footer link opens the settings and a saved choice is stored and recorded", () => {
		boot({ gpc: true });
		footerLink().click();
		expect(dialog().open).toBe(true);
		toggle("analytics").checked = true;
		inDialog("save").click();
		expect(api().get()).toEqual({ analytics: true, marketing: false, decided: true, revision: 2 });
		expect(consentWrite()).toHaveLength(1);
		expect(recorded()).toMatchObject({ a: 1, m: 0, action: "save" });
		expect(activated("/js/analytics.js")).toHaveLength(1);
	});
});

describe("a decision", () => {
	it("accept writes the cookie {v, a, m, t} for 6 months: Max-Age, Path=/, SameSite=Lax, Secure", () => {
		boot();
		const before = now();
		layer1("accept").click();
		const [write] = consentWrite();
		expect(write).toBeDefined();
		const [pair, ...attrs] = (write ?? "").split("; ");
		expect(attrs).toEqual(["Max-Age=15552000", "Path=/", "SameSite=Lax", "Secure"]);
		const value = JSON.parse(decodeURIComponent((pair ?? "").slice("ck_consent=".length)));
		expect(Object.keys(value)).toEqual(["v", "a", "m", "t"]);
		expect(value).toMatchObject({ v: 2, a: 1, m: 1 });
		expect(value.t).toBeGreaterThanOrEqual(before);
		expect(value.t).toBeLessThanOrEqual(now());
		expect(document.cookie).toContain("ck_consent=");
		expect(decided()).toBe(true);
	});

	it("every copy of the old choice (host, registrable domain AND full hostname) is deleted before the new one is written — none after it", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: 1 }) });
		footerLink().click();
		inDialog("reject").click();
		const i = cookieWrites.indexOf("ck_consent" + EXPIRED);
		const j = cookieWrites.indexOf("ck_consent" + EXPIRED + "; Domain=example.test");
		const h = cookieWrites.indexOf(onHost("ck_consent"));
		const k = cookieWrites.findIndex((w) => w.startsWith("ck_consent=%7B"));
		expect(i).toBeGreaterThanOrEqual(0);
		expect(j).toBeGreaterThan(i);
		expect(h).toBeGreaterThan(j);
		expect(k).toBeGreaterThan(h);
		expect(cookieWrites.slice(k + 1).filter((w) => w.startsWith("ck_consent="))).toEqual([]);
		expect(document.cookie).toContain("ck_consent=%7B");
	});

	it("without a configured domain no registrable-domain deletion is written: the host's and the full hostname's only (choice, cleanup and the old tool's cookie)", () => {
		page({ config: { ...CONFIG, domain: undefined } });
		document.cookie = "previous-tool-consent=x; Path=/";
		document.cookie = "_ga=1; Path=/";
		runHead();
		runKit();
		layer1("reject").click();
		expect(cookieWrites.filter((w) => w.includes("Domain=") && !w.endsWith("; Domain=" + HOST))).toEqual([]);
		expect(cookieWrites).toEqual(expect.arrayContaining(["previous-tool-consent", "_ga", "ck_consent"].flatMap((n) => [n + EXPIRED, onHost(n)])));
	});

	it("a page served on the configured domain itself (domain = the full hostname) writes that deletion once, not twice", () => {
		page({ config: { ...CONFIG, domain: HOST } });
		document.cookie = "previous-tool-consent=x; Path=/";
		cookieWrites = [];
		runHead();
		runKit();
		expect(cookieWrites).toEqual(["previous-tool-consent" + EXPIRED, onHost("previous-tool-consent")]);
	});

	it("the stored cookie is read back as a valid choice by the head snippet on the next page", () => {
		boot();
		layer1("accept").click();
		const value = document.cookie.split("; ").find((c) => c.startsWith("ck_consent="))?.slice("ck_consent=".length);
		boot({ cookie: value });
		expect(api().get()).toEqual({ analytics: true, marketing: true, decided: true, revision: 2 });
	});

	it("reject: cookie a0/m0, update denied, nothing activated, layer 1 hidden, record action reject", () => {
		boot();
		layer1("reject").click();
		expect(JSON.parse(decodeURIComponent((consentWrite()[0] ?? "").split("; ")[0]!.slice("ck_consent=".length)))).toMatchObject({ v: 2, a: 0, m: 0 });
		expect(updates()).toEqual([
			["consent", "update", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }],
		]);
		expect(passthrough()).toEqual([]);
		expect(activated("/js/analytics.js")).toHaveLength(0);
		expect(activated("/js/ads.js")).toHaveLength(0);
		expect(decided()).toBe(true);
		expect(layer1Shown()).toBe(false);
		expect(recorded().action).toBe("reject");
	});

	it("the consent update is pushed before any gated script is activated, and the event fires after activation", () => {
		boot();
		const seen: { updatesAtCreate: number; scriptsAtEvent: number }[] = [];
		const create = document.createElement.bind(document);
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
			if (tag === "script") seen.push({ updatesAtCreate: updates().length, scriptsAtEvent: -1 });
			return create(tag);
		}) as typeof document.createElement);
		document.addEventListener("consentkit:change", () => seen.push({ updatesAtCreate: -1, scriptsAtEvent: activated("/js/analytics.js").length }), { once: true });
		layer1("accept").click();
		expect(seen).toEqual([
			{ updatesAtCreate: 1, scriptsAtEvent: -1 },
			{ updatesAtCreate: 1, scriptsAtEvent: -1 },
			{ updatesAtCreate: -1, scriptsAtEvent: 1 },
		]);
	});

	it("a returning visitor: the head snippet's update is in the dataLayer before kit.js activates anything", () => {
		page({ cookie: stored({ v: 2, a: 1, m: 0, t: now() }) });
		runHead();
		const updatesAtCreate: number[] = [];
		const create = document.createElement.bind(document);
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
			if (tag === "script") updatesAtCreate.push(updates().length);
			return create(tag);
		}) as typeof document.createElement);
		runKit();
		expect(updatesAtCreate).toEqual([1]);
		expect(updates()[0]?.[2]).toMatchObject({ analytics_storage: "granted" });
	});

	it("the record: one fetch POST to layer 1's data-endpoint, keepalive, credentials omit, mode no-cors, no headers, body {site, v, a, m, action, lang} ≤ 512 B", () => {
		boot();
		layer1("accept").click();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(ENDPOINT);
		expect(init).toEqual({ method: "POST", body: expect.any(String), keepalive: true, credentials: "omit", mode: "no-cors" });
		expect(JSON.parse(String(init.body))).toEqual({ site: SITE, v: 2, a: 1, m: 1, action: "accept", lang: "de" });
		expect(new TextEncoder().encode(String(init.body)).length).toBeLessThanOrEqual(512);
		expect(beaconSpy).not.toHaveBeenCalled();
	});

	it.each([
		["de-DE", "de"],
		["EN", "en"],
		["en-gb", "en"],
	])("<html lang=\"%s\"> goes into the record as its lowercase primary subtag „%s“ — the records service takes exactly de / en", (lang, sent) => {
		document.documentElement.lang = lang;
		boot();
		layer1("accept").click();
		expect(recorded()).toEqual({ site: SITE, v: 2, a: 1, m: 1, action: "accept", lang: sent });
	});

	it.each([
		["an empty lang attribute", () => document.documentElement.setAttribute("lang", "")],
		["no lang attribute", () => document.documentElement.removeAttribute("lang")],
	])("%s: the record carries lang \"\" — the records service drops it (it takes de / en only); the decision itself stands", (_label, setLang) => {
		setLang();
		boot();
		layer1("accept").click();
		expect(recorded()).toEqual({ site: SITE, v: 2, a: 1, m: 1, action: "accept", lang: "" });
		expect(api().get()).toEqual({ analytics: true, marketing: true, decided: true, revision: 2 });
		expect(consentWrite()).toHaveLength(1);
	});

	it("the endpoint and the site id are the markup's: another site's values go into the record unchanged", () => {
		boot({ endpoint: "https://consent.other.example/v1/record", site: "other-site" });
		inDialog("reject").click();
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://consent.other.example/v1/record");
		expect(recorded()).toMatchObject({ site: "other-site", action: "reject" });
	});

	it.each([
		["an empty data-endpoint", { endpoint: "" }],
		["an empty data-site", { site: "" }],
		["both empty — even with a config that still carries the old `records` / `site` keys", { endpoint: "", site: "", config: { ...CONFIG, records: ENDPOINT, site: SITE } }],
	])("%s: no record is sent — the decision itself stands", (_label, opts) => {
		boot(opts);
		layer1("accept").click();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(beaconSpy).not.toHaveBeenCalled();
		expect(api().get()).toEqual({ analytics: true, marketing: true, decided: true, revision: 2 });
		expect(consentWrite()).toHaveLength(1);
	});

	it("without layer 1's markup no record is sent either (the dialog alone still decides)", () => {
		page();
		$("[data-ck-banner]").remove();
		runHead();
		runKit();
		footerLink().click();
		inDialog("accept").click();
		expect(api().get().decided).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("save stores exactly the switches and activates only what they grant", () => {
		boot();
		layer1Settings().click();
		toggle("marketing").checked = true;
		inDialog("save").click();
		expect(api().get()).toEqual({ analytics: false, marketing: true, decided: true, revision: 2 });
		expect(activated("/js/ads.js")).toHaveLength(1);
		expect(activated("/js/analytics.js")).toHaveLength(0);
		expect(passthrough()).toEqual([["set", "url_passthrough", true]]);
		expect(recorded()).toMatchObject({ a: 0, m: 1, action: "save" });
		expect(dialog().open).toBe(false);
	});

	it("an unknown action does nothing — no decision, the dialog stays open", () => {
		boot();
		layer1Settings().click();
		const odd = document.createElement("button");
		odd.setAttribute("data-ck-action", "maybe");
		dialog().appendChild(odd);
		odd.click();
		expect(dialog().open).toBe(true);
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("no network before a decision", () => {
	it("an undecided visitor: no fetch, no beacon, no XHR, no script element created (the one element is the page-end spacer, after the first contentful paint)", () => {
		const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, "open");
		page();
		const create = vi.spyOn(document, "createElement");
		runHead();
		runKit();
		expect(create.mock.calls).toEqual([]);
		paint();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(beaconSpy).not.toHaveBeenCalled();
		expect(xhrOpen).not.toHaveBeenCalled();
		expect(create.mock.calls).toEqual([["div"]]);
		expect(events).toEqual([]);
		expect(decided()).toBe(false);
	});
});

describe("activation of text/plain scripts", () => {
	it("a returning analytics visitor: the gated tag runs once, with every attribute but type and id copied, data-cfasync=false", () => {
		boot({
			cookie: stored({ v: 2, a: 1, m: 0, t: now() }),
			extra:
				'<script type="text/plain" data-consent="analytics" src="/js/analytics.js" integrity="sha256-abc" crossorigin="" async nonce="n0nce" referrerpolicy="no-referrer" fetchpriority="low" id="ga-bundle" data-extra="x"></script>' +
				'<script type="text/plain" data-consent="analytics" src="/js/creds.js" crossorigin="use-credentials"></script>' +
				'<script type="text/plain" data-consent="analytics">window.__inline = 1</script>' +
				'<script type="text/plain" data-consent="marketing" src="/js/ads.js"></script>',
		});
		const [tag] = activated("/js/analytics.js");
		expect(tag).toBeDefined();
		expect(tag?.hasAttribute("type")).toBe(false);
		expect(tag?.hasAttribute("data-consent-state")).toBe(false);
		expect(tag?.hasAttribute("id")).toBe(false);
		expect(document.querySelectorAll("#ga-bundle")).toHaveLength(1);
		for (const [name, value] of [
			["integrity", "sha256-abc"],
			["crossorigin", ""],
			["nonce", "n0nce"],
			["referrerpolicy", "no-referrer"],
			["fetchpriority", "low"],
			["data-extra", "x"],
			["data-cfasync", "false"],
		]) {
			expect(tag?.getAttribute(name as string)).toBe(value);
		}
		expect(tag?.async).toBe(true);
		expect(activated("/js/creds.js")[0]?.getAttribute("crossorigin")).toBe("use-credentials");
		expect(activated("/js/creds.js")[0]?.async).toBe(false);
		const original = $<HTMLScriptElement>('script[type="text/plain"][src="/js/analytics.js"]');
		expect(original.getAttribute("data-consent-state")).toBe("active");
		expect(original.nextElementSibling).toBe(tag);
		const inline = Array.from(document.querySelectorAll("script")).filter((s) => !s.hasAttribute("type") && !s.hasAttribute("src"));
		expect(inline.map((s) => s.text)).toEqual(["window.__inline = 1"]);
		expect(activated("/js/ads.js")).toHaveLength(0);
	});

	it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])("a gated tag named like an Object.prototype member (data-consent=\"%s\") never activates — not after a reject, not after accept all", (name) => {
		boot({ extra: GATED + `<script type="text/plain" data-consent="${name}" src="/js/odd.js"></script>` });
		layer1("reject").click();
		expect(activated("/js/odd.js")).toHaveLength(0);
		footerLink().click();
		inDialog("accept").click();
		expect(activated("/js/analytics.js")).toHaveLength(1);
		expect(activated("/js/odd.js")).toHaveLength(0);
	});

	it("a later decision activates the newly granted category but never re-inserts an active tag", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 0, t: now() }) });
		footerLink().click();
		inDialog("accept").click();
		expect(activated("/js/analytics.js")).toHaveLength(1);
		expect(activated("/js/ads.js")).toHaveLength(1);
		layer1("accept").click();
		expect(activated("/js/analytics.js")).toHaveLength(1);
		expect(activated("/js/ads.js")).toHaveLength(1);
	});
});

describe("the consentkit:change event", () => {
	it("a returning visitor gets it ONCE on load with the stored state; a click adds one more", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 0, t: now() }) });
		expect(events).toEqual([{ analytics: true, marketing: false, decided: true, revision: 2 }]);
		footerLink().click();
		toggle("marketing").checked = true;
		inDialog("save").click();
		expect(events).toEqual([
			{ analytics: true, marketing: false, decided: true, revision: 2 },
			{ analytics: true, marketing: true, decided: true, revision: 2 },
		]);
	});

	it("an undecided visitor gets none on load", () => {
		boot();
		expect(events).toEqual([]);
		expect(api().get().decided).toBe(false);
	});

	it("kit.js run twice: no double wiring, no double event, no double record", () => {
		page({ cookie: stored({ v: 2, a: 0, m: 0, t: now() }) });
		runHead();
		runKit();
		runKit();
		expect(events).toHaveLength(1);
		layer1("accept").click();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(events).toHaveLength(2);
		expect(activated("/js/analytics.js")).toHaveLength(1);
	});
});

describe("cleanup and withdrawal", () => {
	function seedTracking() {
		for (const c of ["_ga=GA1.1.1", "_ga_ABC123=GS1.1", "_gcl_au=1.1.1", "_gcl_dc=x", "keep_me=1", "_gat_x=1", "x_ga_1=1"]) document.cookie = `${c}; Path=/`;
		localStorage.setItem("_gcl_ls", "{}");
		localStorage.setItem("other", "1");
		cookieWrites = [];
	}
	const deletions = (name: string) => [name + EXPIRED, name + EXPIRED + "; Domain=example.test", onHost(name)];

	it("reject deletes _ga, _ga_*, _gcl_* on the host, the registrable domain AND the full hostname, and localStorage _gcl_ls; decoys survive", () => {
		boot();
		seedTracking();
		layer1("reject").click();
		for (const name of ["_ga", "_ga_ABC123", "_gcl_au", "_gcl_dc"]) expect(cookieWrites).toEqual(expect.arrayContaining(deletions(name)));
		expect(cookieWrites.filter((w) => /^(keep_me|_gat_x|x_ga_1)=/.test(w))).toEqual([]);
		expect(cookieNames().sort()).toEqual(["_gat_x", "ck_consent", "keep_me", "x_ga_1"]);
		expect(localStorage.getItem("_gcl_ls")).toBeNull();
		expect(localStorage.getItem("other")).toBe("1");
	});

	it("a custom choice without marketing runs only the marketing cleanup — the granted analytics cookies stay", () => {
		boot();
		seedTracking();
		layer1Settings().click();
		toggle("analytics").checked = true;
		inDialog("save").click();
		expect(cookieNames().sort()).toEqual(["_ga", "_ga_ABC123", "_gat_x", "ck_consent", "keep_me", "x_ga_1"]);
		expect(localStorage.getItem("_gcl_ls")).toBeNull();
	});

	it.each([
		["undecided (a revision bump, a visitor who accepted in a previous consent tool)", undefined, undefined, ["_gat_x", "keep_me", "x_ga_1"]],
		["GPC", true, undefined, ["_gat_x", "keep_me", "x_ga_1"]],
		["analytics granted only", undefined, stored({ v: 2, a: 1, m: 0, t: 1 }), ["_ga", "_ga_ABC123", "_gat_x", "ck_consent", "keep_me", "x_ga_1"]],
	] as const)("on load, every category that is not granted is cleaned (%s) — without a choice cookie of its own", (_label, gpc, cookie, left) => {
		page({ gpc, cookie });
		seedTracking();
		runHead();
		runKit();
		expect(cookieNames().sort()).toEqual([...left]);
		expect(consentWrite()).toEqual([]);
		expect(localStorage.getItem("_gcl_ls")).toBeNull();
	});

	it("grant → deny: the cookie is written, the record (action withdraw) is queued, THEN the page reloads", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: now() }) });
		footerLink().click();
		inDialog("reject").click();
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		const write = order.findIndex((o) => o.startsWith("cookie ck_consent=%7B"));
		expect(write).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("fetch")).toBeGreaterThan(write);
		expect(order.indexOf("reload")).toBeGreaterThan(order.indexOf("fetch"));
		expect(recorded()).toMatchObject({ a: 0, m: 0, action: "withdraw" });
	});

	it("withdrawing only marketing reloads too, recorded as withdraw", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: now() }) });
		footerLink().click();
		toggle("marketing").checked = false;
		inDialog("save").click();
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		expect(recorded()).toMatchObject({ a: 1, m: 0, action: "withdraw" });
	});

	it("while the withdrawal's reload is under way, every further deciding click is ignored: no cookie, no record, no grant, no second reload", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: now() }) });
		expect(activated("/js/analytics.js")).toHaveLength(1); // the stored grant, activated at boot
		footerLink().click();
		inDialog("reject").click();
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		const writes = [...cookieWrites];
		const pushed = commands().length;
		for (const button of [inDialog("accept"), inDialog("save"), inDialog("reject"), layer1("accept"), layer1("reject")]) {
			const click = new MouseEvent("click", { bubbles: true, cancelable: true });
			button.dispatchEvent(click);
			expect(click.defaultPrevented).toBe(true);
		}
		expect(cookieWrites).toEqual(writes);
		expect(commands()).toHaveLength(pushed);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(recorded()).toMatchObject({ a: 0, m: 0, action: "withdraw" });
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: true, revision: 2 });
		expect(activated("/js/ads.js")).toHaveLength(1);
		expect(activated("/js/analytics.js")).toHaveLength(1);
		expect(events).toHaveLength(1);
	});

	it("a withdrawal's reload that does not happen (a host's beforeunload „stay“): the deciding clicks work again after 10 s", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: now() }) });
		footerLink().click();
		inDialog("reject").click();
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		layer1("accept").click();
		vi.advanceTimersByTime(9_999);
		layer1("accept").click();
		expect(fetchSpy).toHaveBeenCalledTimes(1); // the withdrawal's record only
		vi.advanceTimersByTime(1);
		layer1("accept").click();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(recorded(1)).toMatchObject({ a: 1, m: 1, action: "accept" });
		expect(api().get()).toEqual({ analytics: true, marketing: true, decided: true, revision: 2 });
		expect(reloadSpy).toHaveBeenCalledTimes(1);
	});

	it.each(RESTORES)("…and at once when the page comes back from the back/forward cache (%s)", (_label, restore) => {
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: now() }) });
		footerLink().click();
		inDialog("reject").click();
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		layer1("accept").click();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		toCache(); // the page went into the back/forward cache: that reload never ran
		restore();
		expect(reloadSpy).toHaveBeenCalledTimes(1); // the stored choice is this page's own withdrawal: nothing stale
		layer1("accept").click();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(recorded(1)).toMatchObject({ a: 1, m: 1, action: "accept" });
	});

	it("a reload that never ran (the page went into the back/forward cache and came back) leaves no timer behind: a later reload's guard holds its full 10 s", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: now() }) });
		footerLink().click();
		inDialog("reject").click(); // a withdrawal: the first reload, its guard for 10 s
		toCache();
		vi.advanceTimersByTime(4_000);
		pageshow(true); // back: that reload never ran
		layer1("accept").click(); // a grant again …
		footerLink().click();
		inDialog("reject").click(); // … and a second withdrawal: its guard for 10 s from here
		expect(reloadSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		vi.advanceTimersByTime(6_000); // the first reload's 10 s are over
		layer1("accept").click();
		expect(fetchSpy).toHaveBeenCalledTimes(3); // still under the second reload's guard
		vi.advanceTimersByTime(4_000);
		layer1("accept").click();
		expect(fetchSpy).toHaveBeenCalledTimes(4);
	});

	it.each([
		["undecided → reject", undefined, "reject"],
		["analytics → accept all", stored({ v: 2, a: 1, m: 0, t: 1 }), "accept"],
		["reject → reject", stored({ v: 2, a: 0, m: 0, t: 1 }), "reject"],
	] as const)("no reload without a withdrawal (%s) — and the next decision is taken as usual", (_label, cookie, action) => {
		boot({ cookie });
		footerLink().click();
		inDialog(action).click();
		expect(reloadSpy).not.toHaveBeenCalled();
		expect(recorded().action).toBe(action);
		footerLink().click();
		inDialog("save").click();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});

describe("a page that stays alive — back from the back/forward cache, or a tab coming back into view", () => {
	it.each([
		["a withdrawal (reject all)", stored({ v: 2, a: 1, m: 1, t: now() }), stored({ v: 2, a: 0, m: 0, t: now() })],
		["a deleted choice (no valid choice any more)", stored({ v: 2, a: 1, m: 1, t: now() }), null],
		["a deleted choice, on a page that granted nothing (layer 1 must come back)", stored({ v: 2, a: 0, m: 0, t: now() }), null],
	])("restored from the back/forward cache after %s in another tab: the page reloads — no cookie written, no record", (_label, before, value) => {
		boot({ cookie: before });
		expect(decided()).toBe(true);
		elsewhere(value);
		pageshow(false); // the first load's pageshow is no restore
		expect(reloadSpy).not.toHaveBeenCalled();
		pageshow(true);
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("restored after an accept in another tab, on an undecided page: decided, the Consent Mode update, the activation and consentkit:change — but no cookie written, no record", () => {
		boot();
		expect(decided()).toBe(false);
		elsewhere(stored({ v: 2, a: 1, m: 1, t: now() }));
		pageshow(true);
		expect(reloadSpy).not.toHaveBeenCalled();
		expect(decided()).toBe(true);
		expect(layer1Shown()).toBe(false);
		expect(api().get()).toEqual({ analytics: true, marketing: true, decided: true, revision: 2 });
		expect(updates()).toEqual([
			["consent", "update", { analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" }],
		]);
		expect(passthrough()).toEqual([["set", "url_passthrough", true]]);
		expect(activated("/js/analytics.js")).toHaveLength(1);
		expect(activated("/js/ads.js")).toHaveLength(1);
		expect(events).toEqual([{ analytics: true, marketing: true, decided: true, revision: 2 }]);
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("a tab coming back into view after marketing was granted in another tab: only the new grant activates, one more event; no cookie, no record", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 0, t: now() }) });
		elsewhere(stored({ v: 2, a: 1, m: 1, t: now() }));
		visibility("visible");
		expect(api().get()).toEqual({ analytics: true, marketing: true, decided: true, revision: 2 });
		expect(updates().at(-1)?.[2]).toEqual({ analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" });
		expect(activated("/js/analytics.js")).toHaveLength(1);
		expect(activated("/js/ads.js")).toHaveLength(1);
		expect(events).toHaveLength(2);
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each([
		["the same choice", { cookie: stored({ v: 2, a: 1, m: 0, t: now() }) }],
		["still undecided", {}],
		["GPC, still no stored choice", { gpc: true }],
	])("unchanged (%s): nothing happens — no reload, update, activation, event, cookie or record", (_label, opts) => {
		boot(opts);
		const pushed = commands().length;
		const seen = events.length;
		const scripts = document.querySelectorAll("script").length;
		const classes = document.documentElement.className;
		pageshow(true);
		visibility("hidden");
		visibility("visible");
		expect(reloadSpy).not.toHaveBeenCalled();
		expect(commands()).toHaveLength(pushed);
		expect(events).toHaveLength(seen);
		expect(document.querySelectorAll("script")).toHaveLength(scripts);
		expect(document.documentElement.className).toBe(classes);
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("a tab coming back into view after marketing was withdrawn in another tab reloads — hidden, it does nothing; its deciding clicks wait for the reload", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: now() }) });
		elsewhere(stored({ v: 2, a: 1, m: 0, t: now() }));
		visibility("hidden");
		expect(reloadSpy).not.toHaveBeenCalled();
		visibility("visible");
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		layer1("accept").click();
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("while this page's own reload is under way, coming back into view changes nothing — no second reload, no sync", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: now() }) });
		footerLink().click();
		inDialog("reject").click(); // a withdrawal here: the reload is under way
		elsewhere(stored({ v: 2, a: 1, m: 1, t: now() })); // another tab grants again meanwhile
		const pushed = commands().length;
		visibility("visible");
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		expect(commands()).toHaveLength(pushed);
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: true, revision: 2 });
		expect(events).toHaveLength(1); // the boot's only
	});

	it("a GPC page whose visitor opts in in another tab: synced like any stored choice — the Consent Mode update included", () => {
		boot({ gpc: true });
		elsewhere(stored({ v: 2, a: 1, m: 0, t: now() }));
		visibility("visible");
		expect(api().get()).toEqual({ analytics: true, marketing: false, decided: true, revision: 2 });
		expect(updates()).toEqual([
			["consent", "update", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }],
		]);
		expect(activated("/js/analytics.js")).toHaveLength(1);
		expect(events).toHaveLength(2);
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("an undecided page that now reads GPC turns decided (layer 1 hidden, one event) with no Consent Mode update — the defaults are already denied", () => {
		boot();
		Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: true });
		visibility("visible");
		expect(decided()).toBe(true);
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: true, revision: 2 });
		expect(updates()).toEqual([]);
		expect(events).toEqual([{ analytics: false, marketing: false, decided: true, revision: 2 }]);
		expect(activated("/js/analytics.js")).toHaveLength(0);
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each([
		["undecided → accept all", {}, () => layer1("accept").click(), { analytics: true, marketing: true, decided: true, revision: 2 }],
		[
			"GPC → an explicit opt-in to statistics",
			{ gpc: true },
			() => {
				footerLink().click();
				toggle("analytics").checked = true;
				inDialog("save").click();
			},
			{ analytics: true, marketing: false, decided: true, revision: 2 },
		],
	] as const)("cookies blocked — the choice cannot be stored (%s): the page stays as decided when it comes back into view, no lost-choice reload", (_label, opts, decideHere, state) => {
		boot(opts);
		fakeJar = ""; // the browser keeps no cookie: every write is lost, every read comes back empty
		decideHere();
		expect(consentWrite()).toHaveLength(1); // the write was tried
		expect(fetchSpy).toHaveBeenCalledTimes(1); // and the decision recorded
		const pushed = commands().length;
		const seen = events.length;
		visibility("hidden");
		visibility("visible");
		pageshow(true);
		expect(reloadSpy).not.toHaveBeenCalled();
		expect(api().get()).toEqual(state);
		expect(decided()).toBe(true);
		expect(commands()).toHaveLength(pushed);
		expect(events).toHaveLength(seen);
	});

	it("a decision that WAS stored and is gone later (deleted in another tab): coming back into view still reloads", () => {
		boot();
		layer1("accept").click();
		elsewhere(null);
		visibility("visible");
		expect(reloadSpy).toHaveBeenCalledTimes(1);
	});

	it("cookies blocked, then a choice stored in another tab is followed: once that choice is gone again, the page reloads (it holds grants nothing backs)", () => {
		boot();
		fakeJar = ""; // this page's own decision does not stick
		layer1("reject").click();
		fakeJar = `ck_consent=${stored({ v: 2, a: 1, m: 1, t: now() })}`; // a choice stored in another tab
		visibility("visible");
		expect(api().get()).toEqual({ analytics: true, marketing: true, decided: true, revision: 2 });
		expect(activated("/js/analytics.js")).toHaveLength(1);
		expect(reloadSpy).not.toHaveBeenCalled();
		fakeJar = ""; // deleted in another tab
		visibility("visible");
		expect(reloadSpy).toHaveBeenCalledTimes(1);
	});

	it.each(RESTORES)("back from the back/forward cache after a withdrawal in another tab (%s): exactly one reload — the second event keeps the first one's guard", (_label, restore) => {
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: now() }) });
		toCache();
		elsewhere(stored({ v: 2, a: 0, m: 0, t: now() }));
		restore();
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		layer1("accept").click(); // the reload is under way: ignored
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("a decision followed from another tab while the settings dialog is open: its switches show the new state", () => {
		boot();
		footerLink().click();
		toggle("marketing").checked = true; // not saved
		elsewhere(stored({ v: 2, a: 1, m: 0, t: now() }));
		visibility("visible");
		expect(dialog().open).toBe(true);
		expect([toggle("analytics").checked, toggle("marketing").checked]).toEqual([true, false]);
	});

	it.each([
		["inside layer 1 lands on <main>, as after a decision there", () => layer1("reject"), () => $("main")],
		["elsewhere stays where it is", () => footerLink(), () => footerLink()],
	] as const)("a decision followed from another tab hides layer 1 — focus %s", (_label, from, to) => {
		boot();
		from().focus();
		elsewhere(stored({ v: 2, a: 0, m: 0, t: now() }));
		visibility("visible");
		expect(layer1Shown()).toBe(false);
		expect(document.activeElement).toBe(to());
	});
});

describe("the previous tool's cookie", () => {
	it("a previous consent tool's cookie (previous-tool-consent) is deleted on the host, the domain and the full hostname at boot", () => {
		expect(location.hostname).toBe(HOST);
		page();
		document.cookie = "previous-tool-consent=id:abc,consent:yes; Path=/";
		cookieWrites = [];
		runHead();
		runKit();
		expect(cookieWrites).toEqual(["previous-tool-consent" + EXPIRED, "previous-tool-consent" + EXPIRED + "; Domain=example.test", onHost("previous-tool-consent")]);
		expect(cookieNames()).toEqual([]);
	});

	// A previous tool that set its cookie with Domain=<the full host> left `.www.example.test`: a domain cookie that no
	// host-only deletion and no Domain=example.test deletion removes. happy-dom keys a Domain=<host> cookie like the
	// host-only one, so its jar cannot hold that copy apart: the deletions are asserted on the written strings.
	it.each([
		["a reject", undefined, () => layer1("reject").click(), 0],
		[
			"a withdrawal",
			stored({ v: 2, a: 1, m: 1, t: 1 }),
			() => {
				footerLink().click();
				inDialog("reject").click();
			},
			1,
		],
	] as const)("%s: the old tool's cookie (at boot) and the denied categories' cookies (in the decision) are deleted on the full hostname too; the new choice stays", (_label, cookie, decide, reloads) => {
		page({ cookie });
		document.cookie = "previous-tool-consent=x; Path=/";
		cookieWrites = [];
		runHead();
		runKit();
		expect(cookieWrites).toEqual(["previous-tool-consent" + EXPIRED, "previous-tool-consent" + EXPIRED + "; Domain=example.test", onHost("previous-tool-consent")]);
		for (const c of ["_ga=GA1.1.1", "_gcl_au=1.1.1"]) document.cookie = `${c}; Path=/`;
		cookieWrites = [];
		decide();
		expect(reloadSpy).toHaveBeenCalledTimes(reloads);
		expect(cookieWrites).toEqual(expect.arrayContaining([onHost("_ga"), onHost("_gcl_au")]));
		const write = cookieWrites.findIndex((w) => w.startsWith("ck_consent=%7B"));
		expect(write).toBeGreaterThan(cookieWrites.indexOf(onHost("ck_consent")));
		expect(cookieWrites.slice(write + 1).filter((w) => w.startsWith("ck_consent="))).toEqual([]);
		expect(cookieNames()).toEqual(["ck_consent"]);
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: true, revision: 2 });
	});

	it("nothing is written when it is absent", () => {
		boot();
		expect(cookieWrites).toEqual([]);
	});
});

describe("the settings dialog", () => {
	it("opens with showModal() (never show()), switches unchecked; a second open() while open is a no-op", () => {
		boot();
		const modal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
		const show = vi.spyOn(HTMLDialogElement.prototype, "show");
		layer1Settings().click();
		api().open();
		expect(modal).toHaveBeenCalledTimes(1);
		expect(show).not.toHaveBeenCalled();
		expect(dialog().open).toBe(true);
		expect([toggle("analytics").checked, toggle("marketing").checked]).toEqual([false, false]);
	});

	it("Escape closes without saving; focus returns to the clicked opener (never pre-focused); layer 1 is back", () => {
		boot();
		layer1Settings().click();
		expect(has("ck-settings")).toBe(true);
		expect(layer1Shown()).toBe(false);
		toggle("analytics").checked = true;
		pressEscape(dialog());
		expect(dialog().open).toBe(false);
		expect(has("ck-settings")).toBe(false);
		expect(layer1Shown()).toBe(true);
		expect(document.activeElement).toBe(layer1Settings());
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(api().get().decided).toBe(false);
		layer1Settings().click();
		expect(toggle("analytics").checked).toBe(false);
	});

	it("Escape / the native light dismiss: layer 1 is back IN the `cancel` event — before the browser closes the dialog and returns focus, whose `close` event comes a task later", async () => {
		boot();
		layer1Settings().click();
		// a listener registered after the kit's runs where the browser's close steps (and its focus return) follow
		const atCancel: boolean[] = [];
		dialog().addEventListener("cancel", () => atCancel.push(layer1Shown()));
		const notPrevented = dialog().dispatchEvent(new Event("cancel", { cancelable: true }));
		expect(notPrevented).toBe(true);
		expect(atCancel).toEqual([true]);
		expect(has("ck-settings")).toBe(false);
		// the browser then closes the dialog; the frame after it keeps layer 1 (the dialog is closed)
		dialog().close();
		await nextFrame();
		expect(layer1Shown()).toBe(true);
		expect(document.activeElement).toBe(layer1Settings());
		expect(cookieWrites).toEqual([]);
	});

	it("the close control closes without a decision and returns focus; it is not one of the equal decision buttons", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 0, t: now() }) });
		footerLink().click();
		toggle("marketing").checked = true;
		closeControl().click();
		expect(dialog().open).toBe(false);
		expect(document.activeElement).toBe(footerLink());
		expect(consentWrite()).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(api().get()).toEqual({ analytics: true, marketing: false, decided: true, revision: 2 });
		expect(closeControl().classList.contains("ck-cc-btn")).toBe(false);
		expect(closeControl().textContent).toBe(S.close);
	});

	it("a press AND release on the backdrop closes without a decision; a press inside does not", () => {
		boot();
		expect(dialog().getAttribute("closedby")).toBe("any");
		layer1Settings().click();
		vi.spyOn(dialog(), "getBoundingClientRect").mockReturnValue({ left: 20, top: 100, right: 370, bottom: 700, width: 350, height: 600, x: 20, y: 100, toJSON: () => ({}) } as DOMRect);
		const pointer = (type: string, x: number, y: number) => dialog().dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true }));
		pointer("pointerdown", 100, 300);
		pointer("pointerup", 5, 50);
		expect(dialog().open).toBe(true);
		pointer("pointerdown", 5, 50);
		pointer("pointerup", 6, 60);
		expect(dialog().open).toBe(false);
		expect(layer1Shown()).toBe(true);
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("a stale `close` event — Chromium fires it a task after Escape — reaching the dialog opened again in that gap changes nothing", () => {
		boot();
		footerLink().click();
		pressEscape(dialog()); // happy-dom fires `close` at once; in Chromium it would still be queued here
		expect(document.activeElement).toBe(footerLink());
		layer1Settings().click(); // opened again before the queued event runs
		const focused = document.activeElement;
		dialog().dispatchEvent(new Event("close")); // the first opening's stale `close`
		expect(dialog().open).toBe(true);
		expect(has("ck-settings")).toBe(true);
		expect(layer1Shown()).toBe(false);
		expect(document.activeElement).toBe(focused);
		// the second opening still closes the usual way: layer 1 back, focus to its own opener
		pressEscape(dialog());
		expect(has("ck-settings")).toBe(false);
		expect(document.activeElement).toBe(layer1Settings());
	});

	it("reopened after a choice, the switches show the stored choice; Escape returns focus to the footer link", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 0, t: now() }) });
		footerLink().click();
		expect([toggle("analytics").checked, toggle("marketing").checked]).toEqual([true, false]);
		pressEscape(dialog());
		expect(document.activeElement).toBe(footerLink());
	});

	it("after a decision in layer 1 focus lands on <main> (layer 1 is gone), with a temporary tabindex", () => {
		boot();
		layer1("accept").click();
		const main = $("main");
		expect(document.activeElement).toBe(main);
		expect(main.getAttribute("tabindex")).toBe("-1");
		main.blur();
		expect(main.hasAttribute("tabindex")).toBe(false);
	});

	it("after a decision in the dialog opened from layer 1, focus lands on <main>", () => {
		boot();
		layer1Settings().click();
		inDialog("reject").click();
		expect(document.activeElement).toBe($("main"));
	});

	it("after a decision in the dialog opened from the footer link, focus returns to the link", () => {
		boot();
		footerLink().click();
		inDialog("save").click();
		expect(document.activeElement).toBe(footerLink());
	});

	it("consentKit.open() before kit.js is ready is queued and opens the dialog on boot", () => {
		page();
		runHead();
		api().open();
		expect(dialog().open).toBe(false);
		runKit();
		expect(dialog().open).toBe(true);
		dialog().close();
		api().open();
		expect(dialog().open).toBe(true);
	});

	it("an opener added after boot works (one listener on document); its navigation is prevented", () => {
		boot();
		const late = document.createElement("a");
		late.href = "#later";
		late.setAttribute("data-ck-open", "");
		document.body.appendChild(late);
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		late.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		expect(dialog().open).toBe(true);
	});
});

/** ResizeObserver stand-in (happy-dom's never reports): what is observed, whether it was disconnected; `report()`
 *  is the browser reporting a resize — the kit reads the size from the element itself. */
const observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
	observed: Element[] = [];
	disconnected = false;
	private readonly callback: ResizeObserverCallback;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		observers.push(this);
	}
	observe(el: Element) {
		this.observed.push(el);
	}
	unobserve() {}
	disconnect() {
		this.disconnected = true;
	}
	report() {
		this.callback([], this as unknown as ResizeObserver);
	}
}

describe("layer 1 never hides the focus (WCAG 2.4.11 Focus Not Obscured)", () => {
	/** A layout box as getBoundingClientRect reports it — happy-dom computes no layout. */
	const box = (top: number, height: number) =>
		({ x: 0, y: top, top, bottom: top + height, left: 0, right: 375, width: 375, height, toJSON: () => ({}) }) as DOMRect;
	/** Layer 1 as measured on a 375 × 667 phone: 285 px high at the bottom of the viewport. */
	const LAYER = box(382, 285);
	const banner = () => $("[data-ck-banner]");
	const at = (el: Element, rect: DOMRect) => vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect);
	const layerHeight = () => document.documentElement.style.getPropertyValue("--ck-layer-h");
	/** The page-end spacer kit.js keeps while layer 1 is on screen. */
	const spacer = () => document.getElementById("ck-sp");
	const scrolls = (el: Element) => vi.spyOn(el, "scrollIntoView").mockImplementation(() => {});
	/** `n` animation frames: the kit checks a focus once its position has held still for two frames. */
	const frames = async (n: number) => {
		for (let i = 0; i < n; i++) await nextFrame();
	};
	/** The visitor's motion preference, as matchMedia reports it. */
	const motion = (reduce: boolean) =>
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)", media: query }));
	/** How `el` was focused, as :focus-visible tells: by a pointer (no match), or in an engine without the selector
	 *  (matches() throws). happy-dom matches :focus-visible on every focus — a keyboard focus. */
	const focusedBy = (el: Element, how: "pointer" | "an engine without :focus-visible") => {
		const real = el.matches.bind(el);
		vi.spyOn(el, "matches").mockImplementation((selector: string) => {
			if (selector !== ":focus-visible") return real(selector);
			if (how === "pointer") return false;
			throw new DOMException(`'${selector}' is not a valid selector`, "SyntaxError");
		});
	};
	/** An undecided page whose layer 1 is LAYER, painted once and reported once by the observer. */
	const measured = (opts?: Parameters<typeof page>[0]) => {
		page(opts);
		const layer = at(banner(), LAYER);
		runHead();
		runKit();
		paint();
		observers[0]?.report();
		return layer;
	};
	/** kit.css's rules that make room for layer 1 (both read --ck-layer-h), and the elements each applies to now:
	 *  ROOM = the scroll padding to <html> and <body>, the height to the spacer; NO_ROOM = none. */
	const room = () => cssRules().filter(([, , body]) => body.includes("--ck-layer-h"));
	const roomApplies = () => room().map(([, selectors]) => Array.from(document.querySelectorAll(selectors), (el) => el.tagName.toLowerCase()));
	const ROOM = [["html", "body"], ["div"]];
	const NO_ROOM = [[], []];

	beforeEach(() => {
		observers.length = 0;
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
	});

	it("undecided: layer 1's height becomes --ck-layer-h on <html> at the observer's first report — the observer started after the first paint, no layout forced at boot — and follows every resize; hidden behind the open dialog (0) it keeps the last height", () => {
		page();
		const layer = at(banner(), LAYER);
		runHead();
		runKit();
		expect(observers).toHaveLength(0);
		paint();
		expect(observers).toHaveLength(1);
		expect(observers[0]?.observed).toEqual([banner()]);
		expect(layer).not.toHaveBeenCalled();
		expect(layerHeight()).toBe("");
		observers[0]?.report();
		expect(layerHeight()).toBe("285px");
		layer.mockReturnValue(box(352, 315)); // a narrower viewport: the text wraps once more
		observers[0]?.report();
		expect(layerHeight()).toBe("315px");
		layer1Settings().click();
		layer.mockReturnValue(box(0, 0)); // display: none while the dialog is open
		observers[0]?.report();
		expect(layerHeight()).toBe("315px");
		expect(observers[0]?.disconnected).toBe(false);
	});

	it("undecided: kit.js appends ONE spacer as the last child of <body> — an empty block hidden from assistive technology (a second run adds none)", () => {
		measured();
		const el = spacer();
		expect(el?.tagName).toBe("DIV");
		expect(document.body.lastElementChild).toBe(el);
		expect(el?.getAttribute("aria-hidden")).toBe("true");
		expect(el?.childNodes).toHaveLength(0);
		runKit();
		expect(document.querySelectorAll("#ck-sp")).toHaveLength(1);
	});

	it("without ResizeObserver, layer 1 is measured once, after the first contentful paint", () => {
		vi.stubGlobal("ResizeObserver", undefined);
		page();
		const layer = at(banner(), LAYER);
		runHead();
		runKit();
		paint("first-paint");
		expect(layer).not.toHaveBeenCalled();
		expect(layerHeight()).toBe("");
		paint("first-contentful-paint");
		paint("first-contentful-paint");
		expect(layer).toHaveBeenCalledTimes(1);
		expect(layerHeight()).toBe("285px");
	});

	it("without ResizeObserver, every focus check reads layer 1's height again: no missing height after a measure that found none, no stale one after a rotation", async () => {
		vi.stubGlobal("ResizeObserver", undefined);
		motion(false);
		page();
		const layer = at(banner(), box(0, 0)); // no height when it is measured (not laid out yet)
		runHead();
		runKit();
		paint();
		expect(layerHeight()).toBe("");
		layer.mockReturnValue(LAYER);
		const link = footerLink();
		at(link, box(100, 20));
		link.focus();
		await frames(2);
		expect(layerHeight()).toBe("285px");
		layer.mockReturnValue(box(352, 315)); // rotated: the text wraps once more
		link.blur();
		link.focus();
		await frames(2);
		expect(layerHeight()).toBe("315px");
	});

	it("kit.css: the scroll padding of <html> and <body> (a <body> that scrolls itself) is the height + 0.5rem (30vh until it is measured), the spacer's height the same (none until measured; screen only; its geometry forced) — both only while the visitor is undecided and kit.js has booted; no rule on html::after", () => {
		expect(room()).toEqual([
			[
				"",
				"html:not(.ck-decided):not(.ck-off),html:not(.ck-decided):not(.ck-off)>body",
				"scroll-padding-bottom:calc(var(--ck-layer-h, 30vh) + .5rem)",
			],
			[
				"screen",
				"html:not(.ck-decided):not(.ck-off) #ck-sp",
				"display:block!important;flex:none!important;height:calc(var(--ck-layer-h) + .5rem)!important;margin:0!important;padding:0!important;border:0!important;visibility:hidden!important;pointer-events:none!important",
			],
		]);
		expect(cssRules().filter(([, selectors]) => selectors.includes("#ck-sp"))[0]).toEqual(["", "#ck-sp", "display:none!important"]);
		expect(assets["kit.css"]).not.toMatch(/html[^{},]*::?after/);
		measured();
		expect(roomApplies()).toEqual(ROOM);
		for (const cls of ["ck-decided", "ck-off", "ck-decided ck-off"]) {
			document.documentElement.className = cls;
			expect(roomApplies()).toEqual(NO_ROOM);
		}
	});

	it.each([
		["accept in layer 1", () => layer1("accept").click()],
		["reject in layer 1", () => layer1("reject").click()],
		[
			"save in the dialog",
			() => {
				layer1Settings().click();
				inDialog("save").click();
			},
		],
	] as const)("after %s the height, the observer and the spacer are gone — the padding with them", (_label, decideHere) => {
		measured();
		expect(layerHeight()).toBe("285px");
		decideHere();
		expect(decided()).toBe(true);
		expect(layerHeight()).toBe("");
		expect(observers[0]?.disconnected).toBe(true);
		expect(spacer()).toBeNull();
		expect(roomApplies()).toEqual(NO_ROOM);
	});

	it.each([
		[
			"GPC read when the page comes back into view",
			() => {
				Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: true });
				visibility("visible");
			},
		],
		[
			"a decision in another tab, followed when the tab comes back into view",
			() => {
				elsewhere(stored({ v: 2, a: 1, m: 0, t: now() }));
				visibility("visible");
			},
		],
		[
			"a decision in another tab, followed when the page comes back from the back/forward cache (pageshow)",
			() => {
				elsewhere(stored({ v: 2, a: 1, m: 0, t: now() }));
				pageshow(true);
			},
		],
	] as const)("%s: the height, the observer and the spacer are gone too", (_label, follow) => {
		measured();
		follow();
		expect(decided()).toBe(true);
		expect(layerHeight()).toBe("");
		expect(observers[0]?.disconnected).toBe(true);
		expect(spacer()).toBeNull();
	});

	it.each([
		["a stored choice", { cookie: stored({ v: 2, a: 1, m: 0, t: now() }) }],
		["GPC", { gpc: true }],
	] as const)("decided at boot (%s): no observer, no height, no spacer, no padding", (_label, opts) => {
		measured(opts);
		expect(paintObservers).toEqual([]);
		expect(observers).toEqual([]);
		expect(layerHeight()).toBe("");
		expect(spacer()).toBeNull();
		expect(roomApplies()).toEqual(NO_ROOM);
	});

	it("an undecided page without layer-1 markup gets no observer, no spacer and no focus check", () => {
		page();
		banner().remove();
		const listen = vi.spyOn(document, "addEventListener");
		runHead();
		runKit();
		paint();
		expect(paintObservers).toEqual([]);
		expect(observers).toEqual([]);
		expect(layerHeight()).toBe("");
		expect(spacer()).toBeNull();
		expect(listen.mock.calls.map(([type]) => type)).not.toContain("focusin");
	});

	it("kit.js not booted by `load` (ck-off): no height, no spacer, no padding — a late boot adds the spacer and measures layer 1", () => {
		page();
		at(banner(), LAYER);
		runHead();
		window.dispatchEvent(new Event("load"));
		expect(has("ck-off")).toBe(true);
		expect(layerHeight()).toBe("");
		expect(spacer()).toBeNull();
		expect(roomApplies()).toEqual(NO_ROOM);
		runKit();
		paint(); // the first paint is long past: the buffered observer gets both entries at once
		expect(document.body.lastElementChild).toBe(spacer());
		observers[0]?.report();
		expect(layerHeight()).toBe("285px");
		expect(roomApplies()).toEqual(ROOM);
	});

	it.each([
		["entirely under it", box(600, 20)],
		["partly under it", box(370, 20)],
		["partly under it, partly below the viewport", box(650, 40)],
		["taller than the space above it, its top under it", box(400, 500)],
	])("a keyboard focus that layer 1 still covers (%s) is scrolled clear of it once its position has held still for two frames — after the browser's own focus scrolling: the nearest edge, smooth; once", async (_label, rect) => {
		motion(false);
		measured();
		const link = footerLink();
		at(link, rect);
		const scroll = scrolls(link);
		link.focus();
		await frames(1);
		expect(scroll).not.toHaveBeenCalled();
		await frames(1);
		expect(scroll).toHaveBeenCalledTimes(1);
		expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
		await frames(3);
		expect(scroll).toHaveBeenCalledTimes(1);
	});

	it("reduced motion: the same scroll without animation (behavior auto)", async () => {
		motion(true);
		measured();
		const link = footerLink();
		at(link, box(600, 20));
		const scroll = scrolls(link);
		link.focus();
		await frames(2);
		expect(scroll).toHaveBeenCalledTimes(1);
		expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
	});

	it("an engine without :focus-visible: every focus counts as a keyboard focus", async () => {
		motion(false);
		measured();
		const link = footerLink();
		at(link, box(600, 20));
		focusedBy(link, "an engine without :focus-visible");
		const scroll = scrolls(link);
		link.focus();
		await frames(2);
		expect(scroll).toHaveBeenCalledTimes(1);
	});

	it("a focus the browser is still scrolling into view (smooth: still moving a frame later) is left to it — checked once it holds still; clear of layer 1 by then, it is not scrolled again", async () => {
		motion(false);
		measured();
		const link = footerLink();
		at(link, box(250, 20)).mockReturnValueOnce(box(600, 20)).mockReturnValueOnce(box(450, 20)).mockReturnValueOnce(box(300, 20));
		const scroll = scrolls(link);
		link.focus();
		await frames(8);
		expect(scroll).not.toHaveBeenCalled();
	});

	it("a focus that holds still under layer 1 after the browser's own scrolling (an engine whose focus scroll ignores the scroll padding) is scrolled clear once, then", async () => {
		motion(false);
		measured();
		const link = footerLink();
		at(link, box(640, 20)).mockReturnValueOnce(box(700, 20)).mockReturnValueOnce(box(660, 20));
		const scroll = scrolls(link);
		link.focus();
		await frames(3); // 700 → 660 → 640: still moving
		expect(scroll).not.toHaveBeenCalled();
		await frames(1); // 640 again: it holds still, under layer 1
		expect(scroll).toHaveBeenCalledTimes(1);
		await frames(3);
		expect(scroll).toHaveBeenCalledTimes(1);
	});

	it("a focus that never holds still (an animated element) is checked after 120 frames at the latest, and the check ends there", async () => {
		motion(false);
		measured();
		const link = footerLink();
		let top = 500;
		vi.spyOn(link, "getBoundingClientRect").mockImplementation(() => box(top++, 20));
		const scroll = scrolls(link);
		link.focus();
		await frames(120);
		expect(scroll).not.toHaveBeenCalled();
		await frames(1);
		expect(scroll).toHaveBeenCalledTimes(1);
		await frames(3);
		expect(scroll).toHaveBeenCalledTimes(1);
		expect(top).toBe(621); // 121 reads: no frame after the check
	});

	/** Positions `el` at `rect` and returns it: the element the test then focuses. */
	const placed = (el: HTMLElement, rect: DOMRect) => {
		at(el, rect);
		return el;
	};

	it.each([
		[
			"an element above layer 1",
			() => {
				measured();
				return placed(footerLink(), box(100, 20));
			},
		],
		[
			"an element below the viewport (a host's focus({ preventScroll: true })): layer 1 does not cover it",
			() => {
				measured();
				return placed(footerLink(), box(900, 20));
			},
		],
		[
			"an element just below the viewport, its top on layer 1's bottom edge",
			() => {
				measured();
				return placed(footerLink(), box(667, 20));
			},
		],
		[
			"a pointer focus (no :focus-visible) under layer 1: a pointer focuses what it shows",
			() => {
				measured();
				const link = placed(footerLink(), box(600, 20));
				focusedBy(link, "pointer");
				return link;
			},
		],
		[
			"layer 1's own button",
			() => {
				measured();
				return placed(layer1("reject"), box(600, 44));
			},
		],
		[
			"an element taller than the space above layer 1 that already shows (focus landing on <main>)",
			() => {
				measured();
				$("main").setAttribute("tabindex", "-1");
				return placed($("main"), box(50, 1950));
			},
		],
		[
			"layer 1 hidden behind the open dialog",
			() => {
				const layer = measured();
				layer1Settings().click();
				layer.mockReturnValue(box(0, 0));
				return placed(toggle("analytics"), box(600, 24));
			},
		],
		[
			"a visitor decided at boot",
			() => {
				measured({ cookie: stored({ v: 2, a: 1, m: 0, t: now() }) });
				return placed(footerLink(), box(600, 20));
			},
		],
		[
			"a visitor who decided on this page",
			() => {
				measured();
				layer1("accept").click();
				return placed(footerLink(), box(600, 20));
			},
		],
	] as const)("no scroll for %s", async (_label, setUp) => {
		motion(false);
		const el = setUp();
		const scroll = scrolls(el);
		el.focus();
		await frames(4);
		expect(document.activeElement).toBe(el);
		expect(scroll).not.toHaveBeenCalled();
	});

	it("the observer and the focus check of a kit whose page a newer head snippet now owns never touch the page", async () => {
		motion(false);
		const layer = measured();
		const link = footerLink();
		at(link, box(600, 20));
		const scroll = scrolls(link);
		link.focus();
		runHead(); // a newer head snippet takes the page over before the frame
		layer.mockReturnValue(box(352, 315));
		observers[0]?.report();
		await frames(4);
		expect(layerHeight()).toBe("285px");
		expect(scroll).not.toHaveBeenCalled();
	});

	it("a newer head snippet and its kit.js: the new kit takes the one spacer over and removes it at a decision; the old kit's observer stays connected, but writes nothing", () => {
		const layer = measured();
		const old = spacer();
		runHead();
		runKit();
		paint(); // the new kit's buffered paint observer: the page has painted long ago
		expect(document.querySelectorAll("#ck-sp")).toHaveLength(1);
		expect(spacer()).toBe(old);
		expect(document.body.lastElementChild).toBe(old);
		layer.mockReturnValue(box(352, 315));
		observers[0]?.report();
		expect(layerHeight()).toBe("285px");
		observers[1]?.report();
		expect(layerHeight()).toBe("315px");
		layer1("accept").click();
		expect(spacer()).toBeNull();
		expect(layerHeight()).toBe("");
		expect(observers.map((o) => o.disconnected)).toEqual([false, true]);
	});

	it("focus that moves on before the frame is not chased: only where focus is by then counts", async () => {
		motion(false);
		measured({ extra: GATED + '<a id="other" href="#other">Other</a>' });
		const link = footerLink();
		at(link, box(600, 20));
		const linkScroll = scrolls(link);
		const other = $("#other");
		at(other, box(100, 20));
		const otherScroll = scrolls(other);
		link.focus();
		other.focus();
		await frames(4);
		expect(linkScroll).not.toHaveBeenCalled();
		expect(otherScroll).not.toHaveBeenCalled();
	});

	describe("nothing of the kit inside the first paint", () => {
		/** An undecided page, booted: layer 1 is LAYER, no paint reported yet. */
		const booted = () => {
			page();
			const layer = at(banner(), LAYER);
			runHead();
			runKit();
			return layer;
		};

		/** Records every attribute change of <html> and <body> and every child change of <body>, as "<tag> <what>". */
		const watchRoot = () => {
			const seen: string[] = [];
			const note = (records: MutationRecord[]) =>
				seen.push(...records.map((r) => `${(r.target as Element).tagName.toLowerCase()} ${r.type === "attributes" ? (r.attributeName ?? "") : r.type}`));
			const watch = new MutationObserver(note);
			watch.observe(document.documentElement, { attributes: true });
			watch.observe(document.body, { attributes: true, childList: true });
			return {
				/** What has changed so far. */
				seen: () => {
					note(watch.takeRecords());
					return seen;
				},
				stop: () => watch.disconnect(),
			};
		};

		it("the boot changes no attribute of <html> or <body> and no child of <body> before the first contentful paint — not even in the rendering update before it, where a ResizeObserver reports; the spacer and the height come after it", () => {
			page();
			at(banner(), LAYER);
			runHead();
			const root = watchRoot();
			runKit();
			for (const o of observers) o.report(); // the first rendering update: a ResizeObserver's first report comes before the paint
			expect(root.seen()).toEqual([]);
			paint("first-paint");
			for (const o of observers) o.report();
			expect(root.seen()).toEqual([]);
			paint("first-contentful-paint");
			for (const o of observers) o.report();
			expect([...root.seen()].sort()).toEqual(["body childList", "html style"]); // the control: the watch sees the kit's changes
			root.stop();
			expect(document.body.lastElementChild).toBe(spacer());
			expect(layerHeight()).toBe("285px");
		});

		it("sizing waits for the first contentful paint: a buffered paint observer, no spacer, no ResizeObserver, no measure, no height — the padding's 30vh fallback meanwhile; a first-paint entry alone starts nothing; the first-contentful-paint entry disconnects the observer and starts the spacer and the ResizeObserver", () => {
			const layer = booted();
			expect(paintObservers).toHaveLength(1);
			expect(paintObservers[0]?.options).toEqual([{ type: "paint", buffered: true }]);
			expect(observers).toHaveLength(0);
			expect(spacer()).toBeNull();
			expect(layer).not.toHaveBeenCalled();
			expect(layerHeight()).toBe("");
			expect(roomApplies()).toEqual([["html", "body"], []]); // the scroll padding (30vh fallback); no spacer yet
			paint("first-paint");
			expect(paintObservers[0]?.disconnected).toBe(false);
			expect(observers).toHaveLength(0);
			expect(spacer()).toBeNull();
			paint("first-contentful-paint");
			expect(paintObservers[0]?.disconnected).toBe(true);
			expect(document.body.lastElementChild).toBe(spacer());
			expect(observers).toHaveLength(1);
			expect(observers[0]?.observed).toEqual([banner()]);
			observers[0]?.report();
			expect(layerHeight()).toBe("285px");
			expect(roomApplies()).toEqual(ROOM);
		});

		it("both entries in one notification (a boot after both paints: the buffered entries arrive at once) start sizing", () => {
			booted();
			paint("first-paint", "first-contentful-paint");
			expect(paintObservers[0]?.disconnected).toBe(true);
			expect(observers).toHaveLength(1);
			expect(document.body.lastElementChild).toBe(spacer());
		});

		it.each([
			["no PerformanceObserver", undefined],
			["no paint timing (supportedEntryTypes without paint)", class extends FakePerformanceObserver {
				static override supportedEntryTypes = ["mark", "measure", "navigation", "resource"];
			}],
			["no supportedEntryTypes (an older engine)", class extends FakePerformanceObserver {
				static override supportedEntryTypes = undefined as unknown as readonly string[];
			}],
			["an observe() that throws", class extends FakePerformanceObserver {
				override observe(): void {
					throw new TypeError("The provided type is not supported");
				}
			}],
		] as const)("%s: sizing starts at once, as before — the spacer and the observer at boot — and the boot completes", (_label, observer) => {
			vi.stubGlobal("PerformanceObserver", observer);
			booted();
			expect(document.body.lastElementChild).toBe(spacer());
			expect(observers).toHaveLength(1);
			expect(observers[0]?.observed).toEqual([banner()]);
			observers[0]?.report();
			expect(layerHeight()).toBe("285px");
			expect((api() as unknown as { _k: number })._k).toBe(1);
		});

		it("a decision before the first paint disconnects the paint observer at once: no ResizeObserver, no height — the paint that follows starts nothing", () => {
			booted();
			layer1("accept").click();
			expect(decided()).toBe(true);
			expect(paintObservers[0]?.disconnected).toBe(true);
			paint();
			expect(observers).toEqual([]);
			expect(layerHeight()).toBe("");
			expect(spacer()).toBeNull();
		});

		it("a paint entry an engine still delivers after a decision starts nothing: sizing only while layer 1 is undecided", () => {
			booted();
			layer1("reject").click();
			paintObservers[0]?.notify();
			expect(observers).toEqual([]);
			expect(layerHeight()).toBe("");
		});

		it("a newer head snippet that owns the page before the first paint: the old kit's paint observer starts nothing", () => {
			booted();
			runHead();
			paint();
			expect(observers).toEqual([]);
			expect(layerHeight()).toBe("");
		});

		it("a second first-contentful-paint notification starts no second ResizeObserver and appends no second spacer: sizing starts once", () => {
			booted();
			const appends = vi.spyOn(document.body, "appendChild");
			paintObservers[0]?.notify("first-contentful-paint");
			paintObservers[0]?.notify("first-contentful-paint");
			expect(observers).toHaveLength(1);
			expect(appends).toHaveBeenCalledTimes(1);
			expect(document.querySelectorAll("#ck-sp")).toHaveLength(1);
		});

		it("a decision before the first paint, then: no spacer to remove, nothing thrown, the focus check gone", () => {
			booted();
			const listen = vi.spyOn(document, "removeEventListener");
			expect(() => layer1("accept").click()).not.toThrow();
			expect(spacer()).toBeNull();
			expect(listen.mock.calls.map(([type]) => type)).toContain("focusin");
		});

		/** The height on <html> at each scroll of `el`: the scroll padding the browser scrolls with. */
		const scrollsWithHeight = (el: Element) => {
			const heights: string[] = [];
			vi.spyOn(el, "scrollIntoView").mockImplementation(() => {
				heights.push(layerHeight());
			});
			return heights;
		};

		it("a keyboard focus before the first contentful paint (an autofocus field): its check writes nothing to <html> and counts no frame as still — after the paint it waits for the height (the observer's first report), then scrolls a covered focus clear with it", async () => {
			motion(false);
			booted();
			const link = footerLink();
			at(link, box(600, 20));
			const heights = scrollsWithHeight(link);
			const root = watchRoot();
			link.focus();
			await frames(4);
			expect(root.seen()).toEqual([]);
			expect(heights).toEqual([]);
			paint(); // sizing starts: the spacer, the observer — its first report in the next rendering update
			await frames(1);
			expect(heights).toEqual([]); // the first frame after the start: the height is not there yet
			observers[0]?.report();
			await frames(1);
			root.stop();
			expect(heights).toEqual(["285px"]);
			await frames(3);
			expect(heights).toEqual(["285px"]);
		});

		it("no paint entry ever (an engine that lists paint timing but delivers no buffered entry to a late boot): the first keyboard focus's check starts sizing after 120 frames, then scrolls a covered focus clear with the height", async () => {
			motion(false);
			booted();
			const link = footerLink();
			at(link, box(600, 20));
			const heights = scrollsWithHeight(link);
			link.focus();
			await frames(119);
			expect(observers).toHaveLength(0);
			expect(spacer()).toBeNull();
			await frames(1);
			expect(observers).toHaveLength(1);
			expect(document.body.lastElementChild).toBe(spacer());
			observers[0]?.report();
			await frames(1);
			expect(heights).toEqual(["285px"]);
		});
	});
});

describe("robustness", () => {
	it("on plain http the choice cookie is written without Secure (else the browser drops it silently)", () => {
		boot();
		vi.spyOn(window.location, "protocol", "get").mockReturnValue("http:");
		layer1("accept").click();
		const [write] = consentWrite();
		expect(write?.split("; ").slice(1)).toEqual(["Max-Age=15552000", "Path=/", "SameSite=Lax"]);
	});

	it("without the settings dialog an opener keeps its own href (no preventDefault); layer 1 still decides", () => {
		page();
		dialog().remove();
		runHead();
		runKit();
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		footerLink().dispatchEvent(click);
		expect(click.defaultPrevented).toBe(false);
		layer1("reject").click();
		expect(api().get()).toEqual({ analytics: false, marketing: false, decided: true, revision: 2 });
	});

	it("an engine without <dialog>: kit.js still boots, layer 1 accepts, openers keep their href", () => {
		page();
		vi.stubGlobal("HTMLDialogElement", undefined);
		Object.defineProperty(dialog(), "showModal", { configurable: true, value: undefined });
		runHead();
		expect(() => runKit()).not.toThrow();
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		footerLink().dispatchEvent(click);
		expect(click.defaultPrevented).toBe(false);
		layer1("accept").click();
		expect(api().get()).toEqual({ analytics: true, marketing: true, decided: true, revision: 2 });
		expect(consentWrite()).toHaveLength(1);
	});

	it("a showModal() that throws leaves no state behind: no settings class, a later close event moves no focus", () => {
		boot();
		vi.spyOn(dialog(), "showModal").mockImplementation(() => {
			throw new DOMException("not allowed", "InvalidStateError");
		});
		layer1Settings().click();
		expect(has("ck-settings")).toBe(false);
		const before = document.activeElement;
		dialog().dispatchEvent(new Event("close"));
		expect(document.activeElement).toBe(before);
		expect($("main").hasAttribute("tabindex")).toBe(false);
	});

	it("a cancel that a LATER listener prevents leaves the dialog open — and layer 1 hidden again before the next frame", async () => {
		boot();
		layer1Settings().click();
		dialog().addEventListener("cancel", (e) => e.preventDefault());
		pressEscape(dialog());
		expect(dialog().open).toBe(true);
		await nextFrame();
		expect(has("ck-settings")).toBe(true);
		expect(layer1Shown()).toBe(false);
		// the dialog still closes the usual way afterwards
		closeControl().click();
		expect(dialog().open).toBe(false);
		expect(layer1Shown()).toBe(true);
	});

	it("a cancel prevented BEFORE the kit's listener ran never lets layer 1 out from behind the open dialog", async () => {
		page();
		dialog().addEventListener("cancel", (e) => e.preventDefault()); // registered before kit.js boots
		runHead();
		runKit();
		layer1Settings().click();
		const atCancel: boolean[] = [];
		dialog().addEventListener("cancel", () => atCancel.push(layer1Shown()));
		pressEscape(dialog());
		expect(atCancel).toEqual([false]);
		expect(dialog().open).toBe(true);
		expect(has("ck-settings")).toBe(true);
		await nextFrame();
		expect(layer1Shown()).toBe(false);
	});

	it("the frame check of a kit whose page a newer head snippet now owns never touches <html>", async () => {
		boot();
		layer1Settings().click();
		dialog().addEventListener("cancel", (e) => e.preventDefault()); // the dialog stays open: the frame check would re-hide
		pressEscape(dialog());
		runHead(); // a newer head snippet takes the page over before the frame
		await nextFrame();
		expect(has("ck-settings")).toBe(false);
	});

	it.each([
		["no cookie name", { ...CONFIG, cookie: undefined }],
		["an empty cookie name", { ...CONFIG, cookie: "" }],
	])("a config with %s fails closed: undecided, kit.js does nothing", (_label, config) => {
		page({ config });
		runHead();
		expect(api().get().revision).toBeNull();
		runKit();
		layer1("accept").click();
		expect(cookieWrites).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("an opener inside a host's own <dialog> gets the focus back (only the kit's dialog is excluded)", () => {
		page({ extra: GATED + '<dialog id="host" open><a id="host-link" href="#c" data-ck-open>Cookies</a></dialog>' });
		runHead();
		runKit();
		$<HTMLAnchorElement>("#host-link").click();
		expect(dialog().open).toBe(true);
		pressEscape(dialog());
		expect(document.activeElement).toBe($("#host-link"));
	});

	it("a withdrawal goes straight to the record and the reload: no activation, no event, no focus work", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 0, t: now() }) });
		expect(events).toHaveLength(1);
		footerLink().click();
		toggle("analytics").checked = false;
		toggle("marketing").checked = true;
		inDialog("save").click();
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		expect(recorded()).toMatchObject({ a: 0, m: 1, action: "withdraw" });
		expect(activated("/js/ads.js")).toHaveLength(0);
		expect(events).toHaveLength(1);
		expect(document.activeElement).not.toBe($("main"));
		expect(updates().at(-1)?.[2]).toMatchObject({ analytics_storage: "denied", ad_storage: "granted" });
	});

	it("kit.js uses the head snippet's one Consent Mode update (consentKit._u)", () => {
		page();
		runHead();
		const u = vi.spyOn(api() as unknown as { _u: (a: number, m: number) => void }, "_u");
		runKit();
		layer1("accept").click();
		expect(u).toHaveBeenCalledWith(1, 1);
		expect(updates()).toHaveLength(1);
		expect(passthrough()).toHaveLength(1);
	});

	it("a kit.js that boots after `load` removes the head snippet's ck-off again", () => {
		page();
		runHead();
		window.dispatchEvent(new Event("load"));
		expect(has("ck-off")).toBe(true);
		runKit();
		expect(has("ck-off")).toBe(false);
		expect(layer1Shown()).toBe(true);
	});

	it("next to a head snippet without the reader (consentKit._r — head and kit ship as a pair) a decision still completes, and a page coming back throws nothing", () => {
		page();
		runHead();
		delete (api() as unknown as { _r?: unknown })._r;
		runKit();
		const errors: unknown[] = [];
		const onError = (e: ErrorEvent) => errors.push(e.error);
		window.addEventListener("error", onError);
		layer1("accept").click();
		visibility("visible");
		pageshow(true);
		window.removeEventListener("error", onError);
		expect(errors).toEqual([]);
		expect(api().get()).toEqual({ analytics: true, marketing: true, decided: true, revision: 2 });
		expect(recorded()).toMatchObject({ a: 1, m: 1, action: "accept" });
		expect(activated("/js/analytics.js")).toHaveLength(1);
		expect(decided()).toBe(true);
	});
});

describe("the reference markup", () => {
	it("layer 1 is a region named by aria-label — no heading, no visible title; it carries the endpoint and site; the dialog's title is a heading; both are data-nosnippet", () => {
		boot();
		const banner = $("[data-ck-banner]");
		expect(banner.getAttribute("role")).toBe("region");
		expect(banner.getAttribute("aria-label")).toBe(S.title);
		expect(banner.hasAttribute("aria-labelledby")).toBe(false);
		expect(banner.querySelector("h1, h2, h3, h4, h5, h6, .ck-cc-t")).toBeNull();
		expect(banner.textContent).not.toContain(S.title);
		expect(banner.getAttribute("data-endpoint")).toBe(ENDPOINT);
		expect(banner.getAttribute("data-site")).toBe(SITE);
		expect(banner.hasAttribute("data-nosnippet")).toBe(true);
		expect(dialog().hasAttribute("data-nosnippet")).toBe(true);
		const title = document.getElementById(dialog().getAttribute("aria-labelledby") ?? "");
		expect(title?.tagName).toBe("H2");
		expect(title?.textContent).toBe(S.dialogTitle);
		expect(dialog().hasAttribute("aria-describedby")).toBe(false);
		for (const category of ["analytics", "marketing"] as const) {
			const el = toggle(category);
			expect(el.type).toBe("checkbox");
			expect(el.getAttribute("role")).toBe("switch");
			expect(document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.tagName).toBe("SUMMARY");
			expect(document.getElementById(el.getAttribute("aria-describedby") ?? "")?.closest("details")).not.toBeNull();
		}
	});

	it("the first-layer text with line breaks: in the one paragraph, one block per non-empty line (a span kit.css makes display: block), its markup characters text; the paragraph's textContent has one space between the parts", () => {
		boot({ text: '  Part <b>one</b> & "two"\r\n\n \nPart two\t\nPart three\n' });
		const p = $(".ck-cc-p");
		expect(document.querySelectorAll("[data-ck-banner] p.ck-cc-p")).toHaveLength(1);
		expect(Array.from(p.children, (el) => `${el.tagName} ${el.className}`)).toEqual(["SPAN ck-cc-s", "SPAN ck-cc-s", "SPAN ck-cc-s"]);
		expect(Array.from(p.children, (el) => el.textContent)).toEqual(['Part <b>one</b> & "two"', "Part two", "Part three"]);
		expect(p.querySelector("b")).toBeNull();
		expect(p.textContent).toBe('Part <b>one</b> & "two" Part two Part three');
		expect(cssRules()).toContainEqual(["", ".ck-cc .ck-cc-s", "display:block"]);
	});

	it("the sample text (no line break) is one block: one span, the whole text", () => {
		boot();
		const p = $(".ck-cc-p");
		expect(p.children).toHaveLength(1);
		expect(p.firstElementChild?.className).toBe("ck-cc-s");
		expect(p.textContent).toBe(S.text);
	});

	it("the dialog has exactly the two consent categories — no „Notwendig“ block, no intro", () => {
		boot();
		const categories = Array.from(dialog().querySelectorAll("[data-ck-category]")).map((el) => el.getAttribute("data-ck-category"));
		expect(categories).toEqual(["analytics", "marketing"]);
		expect(dialog().querySelectorAll("details")).toHaveLength(2);
		expect(Array.from(dialog().querySelectorAll("summary")).map((s) => s.textContent)).toEqual([S.analytics, S.marketing]);
		expect(dialog().querySelectorAll(":scope > p")).toHaveLength(1); // the links line only
	});

	it("the three decision buttons of each layer are identical: one class, type=button, no inline style", () => {
		boot();
		for (const root of ["[data-ck-banner]", "[data-ck-dialog]"]) {
			const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(`${root} .ck-cc-btn`));
			expect(buttons).toHaveLength(3);
			for (const b of buttons) {
				expect(b.className).toBe("ck-cc-btn");
				expect(b.type).toBe("button");
				expect(b.hasAttribute("style")).toBe(false);
				const attrs = b.getAttributeNames().filter((n) => !n.startsWith("data-ck-")).sort();
				expect(attrs).toEqual(["class", "type"]);
			}
		}
		expect(document.querySelectorAll("[data-ck-dialog] button:not(.ck-cc-btn)")).toHaveLength(1);
	});

	it("no CSS rule can tell the buttons apart: every rule on .ck-cc-btn names only the class (+ :hover / :active)", () => {
		const css = assets["kit.css"];
		expect(css).not.toMatch(/data-ck-(action|open)/);
		const rules = css.replace(/@media[^{]*\{/g, "").split("}");
		const selectors = rules.map((r) => r.split("{")[0] ?? "").filter((s) => s.includes("ck-cc-btn"));
		expect(selectors.length).toBeGreaterThan(0);
		for (const group of selectors) {
			for (const sel of group.split(",")) {
				expect(sel.trim()).toMatch(/^\.ck-c[cd] \.ck-cc-btn(:hover|:active)?$/);
			}
		}
	});

	it("layer 1 hides while the dialog is open, after a decision and when kit.js never booted — nothing else", () => {
		expect(hiders()).toEqual([".ck-decided .ck-cc", ".ck-off .ck-cc", ".ck-settings .ck-cc"]);
	});
});
