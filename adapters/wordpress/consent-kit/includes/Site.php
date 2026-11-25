<?php

declare(strict_types=1);

namespace ConsentKit\WordPress;

use ConsentKit\Config;
use ConsentKit\ConsentCookie;

// loaded by the plugin (and the tests, which define ABSPATH): a direct request for this file ends here
defined('ABSPATH') || exit;

/**
 * The plugin's logic, without WordPress's hooks: its settings checked as the HTML adapter checks a site config
 * (siteValues() in adapters/html/generate.mjs) and as WordPress's esc_url() keeps them, the settings form's fields
 * and their save, the server cleanup's header fields, and the fragments filled.
 * The fragments are the HTML adapter's own, generated into fragments/ with placeholders as values
 * (adapters/wordpress/generate.mjs): every URL is filled with esc_url(), the site id with esc_attr(), the config
 * block's JSON with every "<" escaped, as configBlock() in kit/build.mjs writes it, and every text as
 * renderBanner() there fills it — HTML-escaped, the first-layer text in blocks.
 *
 * The settings are the site config's keys (adapters/html/README.md, The site config), with its one language as
 * `language`, `privacyUrl`, `imprintUrl` and `texts`, and `serverCleanup`.
 */
final class Site
{
    /** The generated fragments (adapters/wordpress/generate.mjs). */
    private const FRAGMENTS = __DIR__ . '/../fragments/';
    /** The kit's sample strings, kit/src/i18n/ byte for byte (adapters/wordpress/generate.mjs). */
    private const I18N = __DIR__ . '/../i18n/';
    private const KEYS = ['revision', 'cookie', 'domain', 'categories', 'cleanup', 'legacy', 'endpoint', 'site', 'language', 'privacyUrl', 'imprintUrl', 'serverCleanup', 'texts'];
    private const CATEGORIES = ['analytics', 'marketing'];
    // the HTML adapter's patterns; D: "$" only at the very end, as in JavaScript; u: UTF-8 only
    private const NAME = '/^[A-Za-z0-9_.-]+$/D';
    private const COOKIE_PATTERN = '/^[A-Za-z0-9_.-]+\*?$/D';
    private const CONSENT_VALUE = '/^[A-Za-z0-9_-]+$/D';
    private const DOMAIN = '/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/D';
    /** JavaScript's \s, which the HTML adapter's patterns use: PCRE's, even with u, takes U+0085 and U+180E and not U+FEFF. */
    private const SPACE = '\t\n\x0B\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}';
    private const ENDPOINT = '~^https://[A-Za-z0-9.-]+(:[0-9]+)?/[^' . self::SPACE . '"\'<>\\\\]*$~Du';
    /** An https:// URL, a path that starts with one "/" (never "//" or "/\": another host, to a browser), a #fragment. */
    private const LINK = '~^(https://[A-Za-z0-9.-]+(:[0-9]+)?([/?#][^' . self::SPACE . '"\'<>\\\\]*)?|/([^/\\\\' . self::SPACE . '"\'<>][^' . self::SPACE . '"\'<>\\\\]*)?|#[^' . self::SPACE . '"\'<>\\\\]+)$~Du';

    /**
     * The checked settings: the config block's config, the first layer's endpoint and site id, the banner language,
     * the two links, the server cleanup's switch and the texts — the site's own, the kit's sample for every one it
     * leaves out. Every invalid value throws: the head snippet would treat a bad revision or cookie as no config and
     * do nothing at all, silently. A null value counts as left out.
     *
     * @return array{config: array<string, mixed>, endpoint: string, site: string, language: string, privacyUrl: string, imprintUrl: string, serverCleanup: bool, texts: array<string, string>}
     * @throws \InvalidArgumentException with the message, which starts with "Consent Kit: "
     */
    public static function values(mixed $settings): array
    {
        if (!self::isObject($settings)) {
            self::fail('the site config must be a JSON object');
        }
        self::only($settings, self::KEYS, '');
        $revision = $settings['revision'] ?? null;
        $cookie = $settings['cookie'] ?? null;
        $domain = $settings['domain'] ?? null;
        $categories = $settings['categories'] ?? [];
        $cleanup = $settings['cleanup'] ?? null;
        $legacy = $settings['legacy'] ?? null;
        $endpoint = $settings['endpoint'] ?? null;
        $site = $settings['site'] ?? '';
        if (!((is_int($revision) || (is_float($revision) && floor($revision) === $revision)) && $revision >= 1 && $revision <= 1000000)) {
            self::fail('revision must be an integer from 1 to 1000000, not ' . self::show($revision));
        }
        if (!is_string($cookie) || !preg_match(self::NAME, $cookie)) {
            self::fail('cookie must be a cookie name (letters, digits, "_", ".", "-"), not ' . self::show($cookie));
        }
        if ($domain !== null && !(is_string($domain) && preg_match(self::DOMAIN, $domain))) {
            self::fail('domain must be a lower-case domain such as "example.com" (no scheme, port or leading dot), not ' . self::show($domain));
        }
        if (!is_string($endpoint) || !($endpoint === '' || preg_match(self::ENDPOINT, $endpoint))) {
            self::fail('endpoint must be the records URL (https://…/v1/record), or "" for no records, not ' . self::show($endpoint));
        }
        if (!is_string($site) || !($site === '' || preg_match(self::NAME, $site))) {
            self::fail('site must be a site id (letters, digits, "_", ".", "-"), not ' . self::show($site));
        }
        if ($endpoint !== '' && $site === '') {
            self::fail('site is missing: the endpoint needs the site id');
        }

        if (!self::isObject($categories)) {
            self::fail('categories must be an object (analytics, marketing), not ' . self::show($categories));
        }
        self::only($categories, self::CATEGORIES, 'categories.');
        foreach ($categories as $category => $value) {
            if (!is_string($value) || !preg_match(self::CONSENT_VALUE, $value)) {
                self::fail("categories.$category must be a data-consent value (letters, digits, \"_\", \"-\"), not " . self::show($value));
            }
        }
        // every category: kit.js activates nothing for a category the config does not map
        $mapped = array_merge(['analytics' => 'analytics', 'marketing' => 'marketing'], $categories);
        // one value for both would let a grant of either category activate the other's tags
        if ($mapped['analytics'] === $mapped['marketing']) {
            self::fail('categories: analytics and marketing must activate different data-consent values, not both ' . self::show($mapped['analytics']));
        }
        if ($cleanup !== null) {
            if (!self::isObject($cleanup)) {
                self::fail('cleanup must be an object (analytics, marketing), not ' . self::show($cleanup));
            }
            self::only($cleanup, self::CATEGORIES, 'cleanup.');
            foreach ($cleanup as $category => $rule) {
                if (!self::isObject($rule)) {
                    self::fail("cleanup.$category must be an object (cookies, localStorage), not " . self::show($rule));
                }
                self::only($rule, ['cookies', 'localStorage'], "cleanup.$category.");
                foreach (self::list($rule['cookies'] ?? [], self::COOKIE_PATTERN, "cleanup.$category.cookies", 'a cookie name or a prefix ending in "*"') as $pattern) {
                    // kit.js's match: an exact name, or a prefix ending in "*" — the choice cookie would go with every denial
                    if (str_ends_with($pattern, '*') ? str_starts_with($cookie, substr($pattern, 0, -1)) : $pattern === $cookie) {
                        self::fail("cleanup.$category.cookies: " . self::show($pattern) . ' would delete the choice cookie ' . self::show($cookie));
                    }
                }
                self::list($rule['localStorage'] ?? [], '/./su', "cleanup.$category.localStorage", 'a non-empty key');
            }
        }
        if ($legacy !== null && in_array($cookie, self::list($legacy, self::NAME, 'legacy', 'a cookie name (letters, digits, "_", ".", "-")'), true)) {
            self::fail('legacy: ' . self::show($cookie) . ' is the choice cookie, which kit.js would delete on every page load');
        }

        $language = $settings['language'] ?? null;
        if (!is_string($language) || !in_array($language, self::languages(), true)) {
            self::fail('language must be one of the kit\'s languages (' . implode(', ', self::languages()) . '), not ' . self::show($language));
        }
        foreach (['privacyUrl', 'imprintUrl'] as $key) {
            if (!is_string($settings[$key] ?? null) || !preg_match(self::LINK, $settings[$key])) {
                self::fail("$key must be an https:// URL, a path that starts with one \"/\" or a #fragment, not " . self::show($settings[$key] ?? null));
            }
        }
        $samples = self::strings($language);
        $texts = $settings['texts'] ?? [];
        if (!self::isObject($texts)) {
            self::fail('texts must be an object of the kit\'s string keys');
        }
        self::only($texts, array_keys($samples), 'texts.');
        foreach ($texts as $key => $text) {
            // a check of its own: PCRE's u validates the subject first, PHP's one UTF-8 check without mbstring
            if (is_string($text) && preg_match('//u', $text) !== 1) {
                self::fail("texts.$key must be UTF-8 text, not " . self::show($text));
            }
            // empty is whitespace only to JavaScript's trim(), as in the HTML adapter
            if (!is_string($text) || preg_match('/[^' . self::SPACE . ']/u', $text) !== 1) {
                self::fail("texts.$key must be a non-empty string, not " . self::show($text));
            }
        }
        $serverCleanup = $settings['serverCleanup'] ?? false;
        if (!is_bool($serverCleanup)) {
            self::fail('serverCleanup must be true or false, not ' . self::show($serverCleanup));
        }

        $config = ['revision' => (int) $revision, 'cookie' => $cookie]
            + ($domain === null ? [] : ['domain' => $domain])
            + ['categories' => $mapped]
            + ($cleanup === null ? [] : ['cleanup' => $cleanup])
            + ($legacy === null ? [] : ['legacy' => $legacy]);
        return ['config' => $config, 'endpoint' => $endpoint, 'site' => $site, 'language' => $language, 'privacyUrl' => $settings['privacyUrl'], 'imprintUrl' => $settings['imprintUrl'], 'serverCleanup' => $serverCleanup, 'texts' => $texts + $samples];
    }

    /**
     * The settings form's fields as settings: the revision's digits as a number, the text fields trimmed, a list
     * one entry per line (blank lines dropped), the checkbox as true or false; an optional field left empty is
     * left out — a text too, which keeps the kit's sample. Not checked: values() does that.
     *
     * @param array<array-key, mixed> $form the posted fields below consent_kit[…]
     * @return array<string, mixed>
     */
    public static function fromForm(array $form): array
    {
        $text = static fn (mixed $value): string => is_string($value) ? trim($value) : '';
        $lines = static fn (mixed $value): array => array_values(array_filter(array_map('trim', explode("\n", $text($value))), 'strlen'));
        $revision = $text($form['revision'] ?? '');
        $categories = array_filter(['analytics' => $text($form['categories']['analytics'] ?? ''), 'marketing' => $text($form['categories']['marketing'] ?? '')], 'strlen');
        $cleanup = [];
        foreach (self::CATEGORIES as $category) {
            $rule = array_filter(['cookies' => $lines($form['cleanup'][$category]['cookies'] ?? ''), 'localStorage' => $lines($form['cleanup'][$category]['localStorage'] ?? '')]);
            if ($rule !== []) {
                $cleanup[$category] = $rule;
            }
        }
        $optional = ['domain' => $text($form['domain'] ?? ''), 'categories' => $categories, 'cleanup' => $cleanup, 'legacy' => $lines($form['legacy'] ?? '')];
        $texts = is_array($form['texts'] ?? null) ? array_filter(array_map($text, $form['texts']), 'strlen') : [];
        return ['revision' => preg_match('/^[0-9]{1,7}$/D', $revision) ? (int) $revision : $revision, 'cookie' => $text($form['cookie'] ?? '')]
            + array_filter($optional, static fn (string|array $value): bool => $value !== '' && $value !== [])
            + ['endpoint' => $text($form['endpoint'] ?? '')]
            + array_filter(['site' => $text($form['site'] ?? '')], 'strlen')
            + [
                'language' => $text($form['language'] ?? ''),
                'privacyUrl' => $text($form['privacyUrl'] ?? ''),
                'imprintUrl' => $text($form['imprintUrl'] ?? ''),
                'serverCleanup' => ($form['serverCleanup'] ?? '') === '1',
            ]
            + array_filter(['texts' => $texts]);
    }

    /**
     * The settings as the plugin uses them: values(), and each URL kept as given by $escapeUrl, WordPress's
     * esc_url() — which empties or rewrites a few forms those checks accept (a #fragment with a ":", a "{") and would
     * put a broken link into the page. Its entities ("&" as "&#038;") are the same URL.
     *
     * @throws \InvalidArgumentException with the message
     */
    public static function usable(mixed $settings, callable $escapeUrl): array
    {
        $values = self::values($settings);
        foreach (['privacyUrl', 'imprintUrl', 'endpoint'] as $key) {
            $escaped = html_entity_decode($escapeUrl($values[$key]), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if ($escaped !== $values[$key]) {
                self::fail("$key " . self::show($values[$key]) . " is not kept by WordPress's esc_url(), which writes " . self::show($escaped));
            }
        }
        return $values;
    }

    /**
     * A save of the settings form: what to store, and the error to show. Settings that are valid as they are stay —
     * a first save runs the sanitizer twice (add_option() once more), and the second run gets the settings, whose
     * revision is a number, the form's always text —; a valid form becomes its settings; anything else keeps $saved.
     *
     * @return array{0: mixed, 1: ?string}
     */
    public static function sanitize(mixed $input, mixed $saved, callable $escapeUrl): array
    {
        $settings = is_array($input) && is_int($input['revision'] ?? null) ? $input : self::fromForm(is_array($input) ? $input : []);
        try {
            self::usable($settings, $escapeUrl);
            return [$settings, null];
        } catch (\InvalidArgumentException $error) {
            return [$saved, $error->getMessage()];
        }
    }

    /**
     * The server cleanup's header fields for one request ($server: $_SERVER): with the switch on, the PHP helper's
     * deletions under its own conditions, on the host name of $home — the site's own address, never the request's
     * Host header — and Cache-Control: private with them, as they follow the visitor's cookies. None for a host name
     * the helper refuses: the kit's own cleanup still runs on the page.
     *
     * @return list<string>
     */
    public static function cleanupHeaders(array $values, array $server, string $home): array
    {
        $config = $values['serverCleanup'] ? Config::fromArray($values['config']) : null;
        $cookies = is_string($server['HTTP_COOKIE'] ?? null) ? $server['HTTP_COOKIE'] : null;
        try {
            $lines = ConsentCookie::deletionHeaders(ConsentCookie::verdict($config, $cookies), $config, (string) parse_url($home, PHP_URL_HOST), $cookies, ConsentCookie::mayCleanUp($server));
        } catch (\InvalidArgumentException) {
            return [];
        }
        return $lines === [] ? [] : ['Cache-Control: private', ...array_map(static fn (string $line): string => "Set-Cookie: $line", $lines)];
    }

    /** A URL's origin — scheme, host and port, lower-cased, the default port filled in — or "" for a URL without one. */
    public static function origin(string $url): string
    {
        $parts = parse_url($url);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
            return '';
        }
        $scheme = strtolower($parts['scheme']);
        return "$scheme://" . strtolower($parts['host']) . ':' . ($parts['port'] ?? ($scheme === 'https' ? 443 : 80));
    }

    /** The kit's languages: the files of i18n/. @return list<string> */
    public static function languages(): array
    {
        return array_map(static fn (string $file): string => basename($file, '.json'), glob(self::I18N . '*.json') ?: []);
    }

    /**
     * The kit's sample strings in one of its languages, without the note: the texts a site leaves out. A damaged
     * i18n/<lang>.json throws as an invalid setting does, so the plugin emits nothing instead of failing every page.
     *
     * @return array<string, string>
     * @throws \InvalidArgumentException with the message
     */
    public static function strings(string $language): array
    {
        try {
            $strings = json_decode((string) file_get_contents(self::I18N . "$language.json"), true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            $strings = null;
        }
        if (!self::isObject($strings) || $strings === [] || array_filter($strings, static fn (mixed $text): bool => !is_string($text)) !== []) {
            self::fail("the plugin's i18n/$language.json is damaged: install the plugin folder again");
        }
        unset($strings['_note']);
        return $strings;
    }

    /** The <head> part: the Consent Mode defaults, the config block, the inline head snippet, the inline styles. */
    public static function head(array $values): string
    {
        $config = $values['config'];
        if (isset($config['cleanup'])) {
            // objects, as the HTML adapter writes them: PHP's json_decode() reads {} as [], which would be a list here
            $config['cleanup'] = (object) array_map(static fn (array $rule): object => (object) $rule, $config['cleanup']);
        }
        $json = json_encode($config, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS | JSON_THROW_ON_ERROR);
        return self::fragment('consent-mode.html', []) . self::fragment('head.html', ['"{{config}}"' => str_replace('<', '\u003c', $json)]);
    }

    /** The first layer and the settings dialog, the first thing in <body>. */
    public static function banner(array $values): string
    {
        $fill = [
            '{{privacyUrl}}' => esc_url($values['privacyUrl']),
            '{{imprintUrl}}' => esc_url($values['imprintUrl']),
            '{{endpoint}}' => esc_url($values['endpoint']),
            '{{site}}' => esc_attr($values['site']),
        ];
        foreach ($values['texts'] as $key => $text) {
            // either form of a string placeholder, as fill() in kit/build.mjs renders it
            $fill['{{' . $key . '}}'] = self::escape($text);
            $fill['{{' . $key . '|blocks}}'] = self::blocks($text);
        }
        return self::fragment('banner.html', $fill);
    }

    /** The reopen link for the footer: to the privacy policy, named like the settings dialog. */
    public static function footerLink(array $values): string
    {
        return self::fragment('footer-link.html', ['{{privacyUrl}}' => esc_url($values['privacyUrl']), '{{dialogTitle}}' => self::escape($values['texts']['dialogTitle'])]);
    }

    /** kit.js, deferred, with Subresource Integrity, from $kitPath — the URL of the plugin's fragments/consent-kit/. */
    public static function script(string $kitPath): string
    {
        return self::fragment('script.html', ['{{kitPath}}' => esc_url($kitPath)]);
    }

    /** A fragment with its placeholders replaced, in one pass: a value is never searched for another placeholder. */
    private static function fragment(string $file, array $values): string
    {
        return strtr((string) file_get_contents(self::FRAGMENTS . $file), $values);
    }

    /** escapeHtml() of kit/build.mjs — not esc_html(), which writes ' as &#039; and keeps an entity as written: the HTML adapter's bytes. */
    private static function escape(string $text): string
    {
        return strtr($text, ['&' => '&amp;', '<' => '&lt;', '>' => '&gt;', '"' => '&quot;']);
    }

    /** blocks() of kit/build.mjs: one span per line (split at "\n", spaces, tabs and carriage returns at its ends dropped, empty lines left out), each escaped, joined by one space. */
    private static function blocks(string $text): string
    {
        $lines = array_filter(array_map(static fn (string $line): string => trim($line, " \t\r"), explode("\n", $text)), 'strlen');
        return implode(' ', array_map(static fn (string $line): string => '<span class="ck-cc-s">' . self::escape($line) . '</span>', $lines));
    }

    private static function fail(string $message): never
    {
        throw new \InvalidArgumentException("Consent Kit: $message");
    }

    /** A JSON object: an array with string keys, or the empty one (PHP's json_decode() makes {} and [] alike). */
    private static function isObject(mixed $value): bool
    {
        return is_array($value) && ($value === [] || !array_is_list($value));
    }

    /** Fails on a key of $values that is not one of $keys. */
    private static function only(array $values, array $keys, string $where): void
    {
        foreach (array_keys($values) as $key) {
            if (!in_array($key, $keys, true)) {
                self::fail("$where$key is not a key (" . implode(', ', $keys) . ')');
            }
        }
    }

    /** A list of strings that each match $pattern. @return list<string> */
    private static function list(mixed $value, string $pattern, string $where, string $what): array
    {
        if (!is_array($value) || !array_is_list($value)) {
            self::fail("$where must be a list of $what, not " . self::show($value));
        }
        foreach ($value as $item) {
            if (!is_string($item) || !preg_match($pattern, $item)) {
                self::fail("$where: " . self::show($item) . " is not $what");
            }
        }
        return $value;
    }

    private static function show(mixed $value): string
    {
        return $value === null ? 'nothing' : (string) json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    }
}
