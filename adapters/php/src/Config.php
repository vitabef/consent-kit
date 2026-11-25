<?php

declare(strict_types=1);

namespace ConsentKit;

/**
 * The kit's config: the values of the page's config block (kit/README.md, The config block), read from the same
 * source as the pages, so that a revision bump reaches the pages and the server together.
 */
final class Config
{
    /** A cookie name, as the HTML and the Hugo adapter accept it. */
    private const NAME = '/^[A-Za-z0-9_.-]+$/D';
    /** A cookie name, or a prefix ending in "*". */
    private const PATTERN = '/^[A-Za-z0-9_.-]+\*?$/D';
    /** A lower-case domain: no scheme, port or leading dot. */
    private const DOMAIN = '/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/D';

    /**
     * @param array{analytics: list<string>, marketing: list<string>} $cleanup the cookie patterns per category
     * @param list<string> $legacy a previous consent tool's cookie names
     */
    private function __construct(
        public readonly string $cookie,
        public readonly int $revision,
        public readonly ?string $domain,
        public readonly array $cleanup,
        public readonly array $legacy,
    ) {
    }

    /** The config from JSON text: the config block's, or a file with the same keys (the HTML adapter's site.json). */
    public static function fromJson(string $json): ?self
    {
        $values = json_decode($json, true);
        return is_array($values) ? self::fromArray($values) : null;
    }

    /**
     * The config, or null for no config (spec/consent-cookie.md, Inputs): `cookie` a non-empty string and `revision`
     * a number with an integer value from 1 to 1,000,000, as the head snippet checks them. When set, `domain` is a
     * lower-case domain (no scheme, port or leading dot), `cleanup` an object whose `analytics` and `marketing` rules
     * are objects with a list of `cookies` — names of letters, digits, "_", "." and "-", or such a prefix ending in
     * "*" — and `legacy` a list of such names. Everything else is ignored (`localStorage`, `categories`, `endpoint`…).
     */
    public static function fromArray(array $values): ?self
    {
        $cookie = $values['cookie'] ?? null;
        $revision = $values['revision'] ?? null;
        $domain = $values['domain'] ?? null;
        $rules = $values['cleanup'] ?? [];
        $legacy = self::names($values['legacy'] ?? [], self::NAME);
        if (
            !is_string($cookie) || $cookie === ''
            || !(is_int($revision) || is_float($revision)) || $revision < 1 || $revision > 1e6 || floor($revision) != $revision
            || ($domain !== null && !(is_string($domain) && preg_match(self::DOMAIN, $domain)))
            || !is_array($rules) || $legacy === null
        ) {
            return null;
        }
        $cleanup = [];
        foreach (['analytics', 'marketing'] as $category) {
            $rule = $rules[$category] ?? [];
            $cookies = is_array($rule) ? self::names($rule['cookies'] ?? [], self::PATTERN) : null;
            if ($cookies === null) {
                return null;
            }
            $cleanup[$category] = $cookies; // its localStorage keys are the browser's: kit.js removes them
        }
        return new self($cookie, (int) $revision, $domain, $cleanup, $legacy);
    }

    /** @return list<string>|null $list, or null when it is not a list of strings that each match $form */
    private static function names(mixed $list, string $form): ?array
    {
        if (!is_array($list) || !array_is_list($list)) {
            return null;
        }
        foreach ($list as $name) {
            if (!is_string($name) || !preg_match($form, $name)) {
                return null;
            }
        }
        return $list;
    }
}
