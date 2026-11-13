/**
 * The pure parts of the records contract (worker/src/contract.ts) and the bounded reader
 * (worker/src/body.ts): the address bucket and the `CF-Connecting-IP` parse the rate-limit keys rest
 * on, the `SITES` parse, the reader's cap.
 */
import { describe, it, expect } from "vitest";
import { allowedSites, consentRateLimitKeys, firstConnectingIp, ipBucket } from "../src/contract";
import { readBoundedBody } from "../src/body";

describe("ipBucket — the unit a per-client brake keys on", () => {
	it("IPv4: the full address", () => {
		expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
	});

	it("IPv6: the /64 (a client with a routed /64 cannot rotate out of its bucket)", () => {
		expect(ipBucket("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3:8d3");
		// `::` expansion — the first four hextets, zero groups included.
		expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0");
		expect(ipBucket("::1")).toBe("0:0:0:0");
		// Two addresses in one /64 → one bucket; a different /64 → another.
		expect(ipBucket("2001:db8:85a3:8d3::1")).toBe(ipBucket("2001:db8:85a3:8d3:ffff:ffff:ffff:ffff"));
		expect(ipBucket("2001:db8:85a3:8d4::1")).not.toBe(ipBucket("2001:db8:85a3:8d3::1"));
		// Case and leading zeros do not split a bucket.
		expect(ipBucket("2001:0DB8:85A3:08D3::1")).toBe("2001:db8:85a3:8d3");
	});

	it("an IPv4-mapped IPv6 address keys on the embedded IPv4", () => {
		expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
	});
});

describe("firstConnectingIp — the ONE CF-Connecting-IP parse", () => {
	it("the first list entry, trimmed and lower-cased; a missing or blank header is the empty string", () => {
		expect(firstConnectingIp(undefined)).toBe("");
		expect(firstConnectingIp(null)).toBe("");
		expect(firstConnectingIp("   ")).toBe("");
		expect(firstConnectingIp(" 203.0.113.7 , 10.0.0.1")).toBe("203.0.113.7");
		expect(firstConnectingIp("2001:DB8::1")).toBe("2001:db8::1");
	});
});

describe("consentRateLimitKeys", () => {
	it("IPv4 → an address key only; IPv6 → the /64 address key and the /48 prefix key; no address → null", () => {
		expect(consentRateLimitKeys("203.0.113.7")).toEqual({ address: "consent:203.0.113.7", prefix: null });
		expect(consentRateLimitKeys("2001:DB8:abcd:12::1")).toEqual({ address: "consent:2001:db8:abcd:12", prefix: "consent48:2001:db8:abcd" });
		expect(consentRateLimitKeys(" , 10.0.0.1")).toBeNull();
		expect(consentRateLimitKeys(undefined)).toBeNull();
	});
});

describe("allowedSites — the SITES var", () => {
	it("comma-separated, trimmed, blanks dropped; unset or empty allows none", () => {
		expect(allowedSites("example-site")).toEqual(["example-site"]);
		expect(allowedSites(" a , b ,, c ")).toEqual(["a", "b", "c"]);
		expect(allowedSites("")).toEqual([]);
		expect(allowedSites(" , ")).toEqual([]);
		expect(allowedSites(undefined)).toEqual([]);
	});
});

describe("readBoundedBody — the capped read", () => {
	const MAX = 512;
	const req = (body: string | ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) =>
		new Request("http://worker.test/v1/record", { method: "POST", body, headers, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);

	it("reads a small body, an empty body, and refuses a declared Content-Length over the cap without reading", async () => {
		expect(await readBoundedBody(req("x=1"), MAX)).toBe("x=1");
		expect(await readBoundedBody(req(null), MAX)).toBe("");
		const big = new Request("http://worker.test/v1/record", { method: "POST", body: "x=1", headers: { "content-length": String(MAX + 1) } });
		expect(await readBoundedBody(big, MAX)).toBeNull();
	});

	it("abandons an undeclared (chunked) body the moment it exceeds the cap — it never buffers more than the cap", async () => {
		let pulled = 0;
		const chunk = new TextEncoder().encode("x".repeat(100));
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(chunk);
			},
		});
		expect(await readBoundedBody(req(stream), MAX)).toBeNull();
		// 6 chunks (600 B) cross 512; a reader that buffered the whole stream would never return.
		expect(pulled).toBeLessThanOrEqual(8);
	});
});
