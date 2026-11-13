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
	document.addEventListener("consentkit:change", onConsent);
	delete win().consentKit;
	win().dataLayer = [];
	document.documentElement.className = "";
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

/** A page as the adapter emits it: config block in <head>, reference markup first in <body>, a footer link, gated tags. */
function page(opts: { cookie?: string; gpc?: boolean; config?: object | null; extra?: string; endpoint?: string; site?: string } = {}) {
	const { cookie, gpc, config = CONFIG, extra = GATED, endpoint = ENDPOINT, site = SITE } = opts;
	document.head.innerHTML = config ? configBlock(config) : "";
	document.body.innerHTML =
		renderBanner("de", { privacyUrl: "/datenschutz/", imprintUrl: "/impressum/", endpoint, site }) +
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

	it("every copy of the old choice (host AND registrable domain) is deleted before the new one is written", () => {
		boot({ cookie: stored({ v: 2, a: 1, m: 1, t: 1 }) });
		footerLink().click();
		inDialog("reject").click();
		const i = cookieWrites.indexOf("ck_consent" + EXPIRED);
		const j = cookieWrites.indexOf("ck_consent" + EXPIRED + "; Domain=example.test");
		const k = cookieWrites.findIndex((w) => w.startsWith("ck_consent=%7B"));
		expect(i).toBeGreaterThanOrEqual(0);
		expect(j).toBeGreaterThan(i);
		expect(k).toBeGreaterThan(j);
	});

	it("without a configured domain only host deletions are written (choice, cleanup and the old tool's cookie)", () => {
		page({ config: { ...CONFIG, domain: undefined } });
		document.cookie = "previous-tool-consent=x; Path=/";
		document.cookie = "_ga=1; Path=/";
		runHead();
		runKit();
		layer1("reject").click();
		expect(cookieWrites.filter((w) => w.includes("Domain="))).toEqual([]);
		expect(cookieWrites).toEqual(expect.arrayContaining(["previous-tool-consent" + EXPIRED, "_ga" + EXPIRED, "ck_consent" + EXPIRED]));
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
	it("an undecided visitor: no fetch, no beacon, no XHR, no script element created", () => {
		const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, "open");
		page();
		const create = vi.spyOn(document, "createElement");
		runHead();
		runKit();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(beaconSpy).not.toHaveBeenCalled();
		expect(xhrOpen).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
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
	const deletions = (name: string) => [name + EXPIRED, name + EXPIRED + "; Domain=example.test"];

	it("reject deletes _ga, _ga_*, _gcl_* on the host AND the registrable domain and localStorage _gcl_ls; decoys survive", () => {
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
	it("a previous consent tool's cookie (previous-tool-consent) is deleted on the host and the domain at boot", () => {
		page();
		document.cookie = "previous-tool-consent=id:abc,consent:yes; Path=/";
		cookieWrites = [];
		runHead();
		runKit();
		expect(cookieWrites).toEqual(["previous-tool-consent" + EXPIRED, "previous-tool-consent" + EXPIRED + "; Domain=example.test"]);
		expect(cookieNames()).toEqual([]);
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
