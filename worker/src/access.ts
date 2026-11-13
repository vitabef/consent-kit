/**
 * The admin page's gate: a valid Cloudflare Access token, or nothing. Cloudflare Access (an
 * application on the Worker's host with the path `admin`, README.md § Admin page) signs every request it
 * lets through with a JWT in the `Cf-Access-Jwt-Assertion` header; the Worker verifies it itself, so
 * a request that reaches the Worker around Access (a misconfigured or deleted application) is still
 * refused.
 *
 * Verified with `jose`: the signature against the team's keys (`createRemoteJWKSet` on
 * `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, cached per isolate — jose refetches when a key
 * id is unknown or the set is older than 10 minutes) with RS256 only (the algorithm Access signs with),
 * the audience (`ACCESS_AUD`, the application's AUD tag), the issuer (`https://<ACCESS_TEAM_DOMAIN>`,
 * as in Cloudflare's validation guide) and the token's time claims (`exp` required, `nbf` when present).
 * The team domain must be `<team-name>.cloudflareaccess.com`: the keys are never fetched from another host.
 *
 * DENY by default: an empty or malformed `ACCESS_TEAM_DOMAIN` (another host included), an empty
 * `ACCESS_AUD`, a missing header, or a token that fails any check (a bad signature, another algorithm, an
 * unknown key, another audience, another issuer, expired or without `exp`, not valid yet, a key set that
 * cannot be fetched) → `false`. Never throws.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";

/** The header Cloudflare Access sets on every request it lets through. */
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** A Cloudflare Access team domain, `<team-name>.cloudflareaccess.com` (lower-cased): one label on
 *  Cloudflare's Access domain — no other host, no scheme, no path, no port. */
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/;

/** One remote key set per team domain, kept for the isolate's life (jose caches the keys inside it). */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function teamKeys(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
	let keys = keySets.get(teamDomain);
	if (!keys) {
		keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
		keySets.set(teamDomain, keys);
	}
	return keys;
}

/** Does the request carry a valid Cloudflare Access token for this team and application? */
export async function hasAdminAccess(req: Request, env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">): Promise<boolean> {
	const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase();
	const audience = (env.ACCESS_AUD ?? "").trim();
	if (!audience || !TEAM_DOMAIN.test(teamDomain)) return false;
	const token = req.headers.get(ACCESS_JWT_HEADER);
	if (!token) return false;
	try {
		await jwtVerify(token, teamKeys(teamDomain), { algorithms: ["RS256"], audience, issuer: `https://${teamDomain}`, requiredClaims: ["exp"] });
		return true;
	} catch {
		return false;
	}
}
