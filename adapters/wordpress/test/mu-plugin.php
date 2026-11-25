<?php
/**
 * The WordPress run's test hooks (test/run.sh), mounted as a must-use plugin there and never part of the plugin:
 *   ?consent-kit-verdict          answers consent_kit_verdict() of the request as JSON
 *   ?consent-kit-no-body-open     the page of a theme without wp_body_open(): nothing runs on it
 *   ?consent-kit-body-open-twice  the page of a theme that calls wp_body_open() twice: once more in its footer
 *   ?consent-kit-cdn              plugins_url() on another origin, as a CDN plugin rewrites it (the admin too)
 */

declare(strict_types=1);

add_action('template_redirect', static function (): void {
    if (isset($_GET['consent-kit-verdict'])) {
        wp_send_json(consent_kit_verdict());
    }
    if (isset($_GET['consent-kit-no-body-open'])) {
        remove_all_actions('wp_body_open');
    }
    if (isset($_GET['consent-kit-body-open-twice'])) {
        add_action('wp_footer', static function (): void {
            do_action('wp_body_open');
        }, 1);
    }
});

if (isset($_GET['consent-kit-cdn'])) {
    add_filter('plugins_url', static fn (string $url): string => (string) preg_replace('~^https?://[^/]+~', 'https://cdn.example.com', $url));
}
