<?php

declare(strict_types=1);

namespace ConsentKit;

/**
 * The kit's stored choice, read from a request's Cookie header exactly as the head snippet reads it
 * (spec/consent-cookie.md, pinned by spec/vectors.json), and the cleanup a server may send for it.
 * Nothing here writes output or calls header(), except sendDeletionHeaders().
 */
final class ConsentCookie
{
    /** A cookie name a Set-Cookie field can carry: an RFC 6265 token. */
    private const COOKIE_NAME = "/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/D";
    /** A Host value, lower-cased: a host name (labels of letters, digits, "-" and "_"; one trailing dot) or an IPv4
     *  address, or an IPv6 literal in brackets; then an optional port. */
    private const HOST = '/^(\[[0-9a-f:.]+\]|[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*)\.?(:[0-9]{1,5})?$/D';
    /** The most one response's deletions take as sent ("Set-Cookie: ", the value, CRLF): nginx reads a FastCGI or
     *  proxied answer's headers into one buffer of a memory page (4 KB on most platforms) and answers 502 past it. */
    private const MAX_BYTES = 2048;
    /** kit.js's drop(): an empty value, expired, on Path=/. */
    private const GONE = '=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/';

    /**
     * The verdict for a request whose Cookie header is $cookieHeader (null: none). Several Cookie field lines are read
     * as their values joined by "; " in their order (RFC 9113, 8.2.3), never by ",". No config: undecided.
     */
    public static function verdict(?Config $config, ?string $cookieHeader): Verdict
    {
        $copies = 0;
        $analytics = $marketing = true;
        foreach ($config === null ? [] : self::pieces($cookieHeader) as $piece) {
            // § 2: a literal prefix, byte for byte (a regular expression would read "." in the name as any character)
            if (!str_starts_with($piece, $config->cookie . '=')) {
                continue;
            }
            $choice = self::choice(substr($piece, strlen($config->cookie) + 1), $config->revision);
            if ($choice !== null) {
                // § 6: a category is granted only when every copy that counts grants it
                $copies++;
                $analytics = $analytics && $choice[0];
                $marketing = $marketing && $choice[1];
            }
        }
        return new Verdict($copies > 0, $analytics, $marketing);
    }

    /** The verdict for the current request, from $_SERVER['HTTP_COOKIE'] — never $_COOKIE, which decodes on its own terms. */
    public static function verdictFromGlobals(?Config $config): Verdict
    {
        return self::verdict($config, $_SERVER['HTTP_COOKIE'] ?? null);
    }

    /**
     * The kit's cleanup as Set-Cookie field values (spec/consent-cookie.md, What a server may do with it): for each
     * category the verdict denies, undecided included, every cookie of the request whose name matches one of the
     * category's cleanup patterns (an exact name, or a prefix ending in "*"); and the legacy cookies, on any request.
     * Each one deleted on the host, with the config's domain on that domain, and on $hostname unless it is the domain.
     * Nothing without a config; never the choice cookie (the kit is its only writer). Whole cookies in request order,
     * at most MAX_BYTES per response: the rest, and a name no Set-Cookie field can carry, are left to the kit's own
     * cleanup at its next page load. A response that carries them depends on the visitor's cookies: send it with
     * Cache-Control: private (or no-store).
     *
     * @param string $hostname the host the page is served on — best the site's own configured name, not the request's
     *                         Host header: only its syntax is checked (a port is dropped, anything that is no host throws)
     * @param bool $cleanUp false on a request that withholds the choice cookie (mayCleanUp()): legacy deletions only
     * @return list<string>
     */
    public static function deletionHeaders(Verdict $verdict, ?Config $config, string $hostname, ?string $cookieHeader, bool $cleanUp): array
    {
        if ($config === null) {
            return [];
        }
        if (!preg_match(self::HOST, strtolower($hostname), $host)) {
            throw new \InvalidArgumentException('consent-kit: the hostname must be a host with an optional port, not ' . json_encode($hostname));
        }
        $hostname = $host[1]; // no port, no trailing dot; an IPv6 literal keeps its brackets, as kit.js's location.hostname does
        $patterns = $config->legacy;
        if ($cleanUp && !$verdict->analytics) {
            $patterns = array_merge($patterns, $config->cleanup['analytics']);
        }
        if ($cleanUp && !$verdict->marketing) {
            $patterns = array_merge($patterns, $config->cleanup['marketing']);
        }
        $lines = [];
        $bytes = 0;
        // a cookie's name: its piece up to the first "=", the whole piece without one
        foreach (array_unique(array_map(static fn (string $piece): string => explode('=', $piece, 2)[0], self::pieces($cookieHeader))) as $name) {
            $matches = static fn (string $p): bool => str_ends_with($p, '*') ? str_starts_with($name, substr($p, 0, -1)) : $name === $p;
            // a name no Set-Cookie field can carry (a control character, a space) is never echoed into one
            if ($name === $config->cookie || !preg_match(self::COOKIE_NAME, $name) || !array_filter($patterns, $matches)) {
                continue;
            }
            $fields = [$name . self::GONE];
            if ($config->domain !== null) {
                $fields[] = $name . self::GONE . '; Domain=' . $config->domain;
            }
            if ($hostname !== $config->domain) {
                $fields[] = $name . self::GONE . '; Domain=' . $hostname;
            }
            $bytes += strlen(implode('', $fields)) + 14 * count($fields); // each field also takes "Set-Cookie: " and CRLF
            if ($bytes > self::MAX_BYTES) {
                break;
            }
            array_push($lines, ...$fields);
        }
        return $lines;
    }

    /**
     * Whether a request may run the category cleanup — one that would carry the choice cookie if the visitor had one:
     * an https request (the kit writes the cookie Secure on https, so a plain-http request goes without it) that is no
     * cross-site request other than a top-level GET navigation (Fetch Metadata: that one goes without the SameSite=Lax
     * cookie). Either reads undecided because the cookie was withheld, not because the visitor denied. $server:
     * $_SERVER, or a framework's server parameters; https: HTTPS (not "off"), REQUEST_SCHEME or X-Forwarded-Proto —
     * a client that fakes the last one only touches its own cookies; no Fetch Metadata: may.
     */
    public static function mayCleanUp(array $server): bool
    {
        $https = !in_array(strtolower((string) ($server['HTTPS'] ?? '')), ['', 'off'], true)
            || strtolower((string) ($server['REQUEST_SCHEME'] ?? '')) === 'https'
            || strtolower((string) ($server['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
        return $https && (($server['HTTP_SEC_FETCH_SITE'] ?? '') !== 'cross-site'
            || (($server['REQUEST_METHOD'] ?? '') === 'GET' && ($server['HTTP_SEC_FETCH_MODE'] ?? '') === 'navigate'
                && ($server['HTTP_SEC_FETCH_DEST'] ?? '') === 'document'));
    }

    /** deletionHeaders() of the current request: its Cookie header and mayCleanUp() from $_SERVER. @return list<string> */
    public static function deletionHeadersFromGlobals(Verdict $verdict, ?Config $config, string $hostname): array
    {
        return self::deletionHeaders($verdict, $config, $hostname, $_SERVER['HTTP_COOKIE'] ?? null, self::mayCleanUp($_SERVER));
    }

    /** For a plain PHP page, before any output: deletionHeadersFromGlobals(), sent with header(). */
    public static function sendDeletionHeaders(Verdict $verdict, ?Config $config, string $hostname): void
    {
        foreach (self::deletionHeadersFromGlobals($verdict, $config, $hostname) as $value) {
            header('Set-Cookie: ' . $value, false);
        }
    }

    /** § 1: the header split at every ";", only spaces and tabs removed at both ends (trim()'s default removes more), empty pieces dropped. */
    private static function pieces(?string $header): array
    {
        return array_filter(array_map(static fn (string $piece): string => trim($piece, " \t"), explode(';', $header ?? '')), static fn (string $piece): bool => $piece !== '');
    }

    /**
     * §§ 3–5: [analytics, marketing] of a copy that counts; null for a malformed copy or a copy of another revision.
     * A copy the head snippet may read although this cannot — raw bytes that are not UTF-8 (§ 3), JSON that
     * json_decode() refuses for an unpaired surrogate escape or its depth (§ 4: it reads 1,023 nested arrays and
     * objects and refuses 1,024) — denies both categories: skipped, its denial would drop out of the minimum and
     * another copy could grant what the browser denies. json_decode() decodes to arrays, so no member name is refused,
     * and reads a number beyond the integers as the nearest float, as JSON.parse does.
     */
    private static function choice(string $value, int $revision): ?array
    {
        if (!preg_match('//u', $value)) {
            return [false, false]; // § 3: raw bytes that are not UTF-8 deny
        }
        // § 3: every "%" starts an escape of two hex digits, rawurldecode() keeps a "+" a "+" (urldecode() would not),
        // and the decoded bytes must be UTF-8, as decodeURIComponent() checks (preg_match() with /u fails otherwise)
        if (preg_match('/%(?![0-9A-Fa-f]{2})/', $value) || !preg_match('//u', $text = rawurldecode($value))) {
            return null;
        }
        try {
            $o = json_decode($text, true, 1024, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            return in_array($e->getCode(), [JSON_ERROR_UTF16, JSON_ERROR_DEPTH], true) ? [false, false] : null;
        }
        $number = static function (string $member) use ($o): ?float {
            $x = is_array($o) ? ($o[$member] ?? null) : null;
            return is_int($x) || is_float($x) ? (float) $x : null; // never true or "1"
        };
        [$v, $a, $m, $t] = array_map($number, ['v', 'a', 'm', 't']);
        $bit = static fn (?float $x): bool => $x === 0.0 || $x === 1.0; // -0.0 === 0.0
        // § 5: t a positive integer of at most 2^53 - 1; INF (1e400) is valid in no member
        return $v === (float) $revision && $bit($a) && $bit($m) && $t !== null && $t >= 1.0 && $t <= 9007199254740991.0 && floor($t) === $t
            ? [$a === 1.0, $m === 1.0]
            : null;
    }
}
