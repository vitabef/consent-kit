// @vitest-environment happy-dom
/**
 * spec/vectors.json against the reference reader: the head snippet exactly as built (kit/src/head.js minified by
 * kit/build.mjs, run the way kit.test.ts runs it) reads, for each vector, the vector's config block and a
 * `document.cookie` made from its `cookieHeader` — and consentKit.get() must be the vector's expected verdict.
 *
 * The conversion header → document.cookie (spec/consent-cookie.md, The test vectors): no header is "", otherwise the
 * header split at every ";", spaces and tabs at both ends of each piece removed, empty pieces dropped, the rest
 * joined by "; " — the form a browser gives both `document.cookie` and the Cookie header it sends. The vectors carry
 * no HttpOnly cookie, the one kind a header has and `document.cookie` lacks. `document.cookie` is a stubbed getter:
 * happy-dom's own jar keys a cookie by name, host and path and cannot hold two copies of one name.
 * No vector has a GPC input: `navigator.globalPrivacyControl` is false throughout (with it, the head snippet reads
 * a visitor without a valid copy as a decided reject; the server verdict stays undecided — spec, GPC).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO, buildAssets, configBlock } from "../build.mjs";

type Verdict = { decided: boolean; analytics: boolean; marketing: boolean };
type Vector = { name: string; config: { cookie: unknown; revision: unknown }; cookieHeader: string | null; expected: Verdict };
type Win = Window & { consentKit?: { get(): Verdict & { revision: number | null } }; dataLayer?: unknown[] };

const FILE = JSON.parse(readFileSync(path.join(REPO, "spec/vectors.json"), "utf8")) as { version: number; vectors: Vector[] };

/** What `document.cookie` shows for the cookies a Cookie header carries. */
const documentCookie = (header: string | null) =>
	header === null
		? ""
		: header
				.split(";")
				.map((piece) => piece.replace(/^[ \t]+|[ \t]+$/g, ""))
				.filter((piece) => piece !== "")
				.join("; ");

let head = "";
beforeAll(async () => {
	head = (await buildAssets())["head.js"];
});

afterEach(() => {
	delete (document as unknown as { cookie?: string }).cookie;
	delete (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl;
});

describe("spec/vectors.json", () => {
	it("version 1, 122 vectors (one deleted fails here), every vector named once, every expectation fail-closed (undecided grants nothing)", () => {
		expect(FILE.version).toBe(1);
		expect(FILE.vectors).toHaveLength(122);
		expect(new Set(FILE.vectors.map((v) => v.name)).size).toBe(FILE.vectors.length);
		for (const { name, expected } of FILE.vectors) {
			expect(Object.keys(expected), name).toEqual(["decided", "analytics", "marketing"]);
			if (!expected.decided) expect(expected, name).toEqual({ decided: false, analytics: false, marketing: false });
		}
	});

	it("the conversion: pieces trimmed of spaces and tabs, empty ones dropped, joined by '; '", () => {
		expect(documentCookie(null)).toBe("");
		expect(documentCookie(" a=1;b=2 ;;\tc=3 ; ")).toBe("a=1; b=2; c=3");
	});
});

describe("the head snippet reads each vector's cookieHeader as the vector expects", () => {
	it.each(FILE.vectors.map((v): [string, Vector] => [v.name, v]))("%s", (_name, { config, cookieHeader, expected }) => {
		const w = window as unknown as Win;
		delete w.consentKit;
		w.dataLayer = [];
		document.documentElement.className = "";
		document.head.innerHTML = configBlock(config);
		Object.defineProperty(document, "cookie", { configurable: true, get: () => documentCookie(cookieHeader) });
		Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: false });
		new Function(head)();
		// read through a fresh cast: after `delete w.consentKit`, TypeScript takes the property for undefined
		const { decided, analytics, marketing } = (window as unknown as Win).consentKit?.get() ?? {};
		expect({ decided, analytics, marketing }).toEqual(expected);
	});
});
