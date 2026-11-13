/**
 * Read at most `max` bytes of the request body. A declared `Content-Length` above the cap is never
 * read at all; an undeclared (chunked) body is read chunk by chunk and abandoned the moment it exceeds
 * the cap — a junk upload costs the isolate at most `max` bytes of memory. `null` = over the cap or
 * unreadable (the caller treats it as "no record").
 */
export async function readBoundedBody(req: Request, max: number): Promise<string | null> {
	const declared = Number(req.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) return null;
	if (!req.body) return "";
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > max) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}
	const buf = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		buf.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(buf);
}
