<?php
/**
 * Plugin Name: Consent Kit
 * Description: The consent kit on every page: Consent Mode defaults, the first layer and the settings dialog, the reopen link, the stored choice read on the server.
 * Version: 0.1.5
 * Requires at least: 5.9
 * Requires PHP: 8.1
 * Update URI: false
 */

declare(strict_types=1);

use ConsentKit\Config;
use ConsentKit\ConsentCookie;
use ConsentKit\Verdict;
use ConsentKit\WordPress\Site;

if (!defined('ABSPATH')) {
    exit;
}

// the PHP helper, unless another plugin or theme has loaded its classes already: declaring them twice is fatal
if (!class_exists(Config::class, false)) {
    require_once __DIR__ . '/helper/Config.php';
}
if (!class_exists(Verdict::class, false)) {
    require_once __DIR__ . '/helper/Verdict.php';
}
if (!class_exists(ConsentCookie::class, false)) {
    require_once __DIR__ . '/helper/ConsentCookie.php';
}
require_once __DIR__ . '/includes/Site.php';

/**
 * The saved settings, checked once per request (Site::usable()), or null: not set up, or invalid — then the plugin
 * emits nothing, sends nothing and reads every visitor as undecided, as the kit does without a config.
 */
function consent_kit_values(): ?array
{
    static $values = false;
    if ($values === false) {
        try {
            $values = Site::usable(get_option('consent_kit'), 'esc_url');
        } catch (\InvalidArgumentException) {
            $values = null;
        }
    }
    return $values;
}

/**
 * The visitor's stored choice in this request (spec/consent-cookie.md), for what a theme or plugin sets itself — an
 * optional cookie, a server-side tag: only while it grants the category. Undecided, every category denied, without
 * valid settings.
 */
function consent_kit_verdict(): Verdict
{
    $values = consent_kit_values();
    return ConsentCookie::verdictFromGlobals($values === null ? null : Config::fromArray($values['config']));
}

/** The reopen link for the footer of every page, also the shortcode [consent_kit_link]: '' without valid settings. */
function consent_kit_footer_link(): string
{
    $values = consent_kit_values();
    return $values === null ? '' : Site::footerLink($values);
}

/** The first layer and the settings dialog, once per page: a theme may call wp_body_open() twice, or not at all. */
function consent_kit_banner(): string
{
    static $emitted = false;
    $values = consent_kit_values();
    if ($emitted || $values === null) {
        return '';
    }
    $emitted = true;
    return Site::banner($values);
}

add_shortcode('consent_kit_link', 'consent_kit_footer_link');

// The first output of wp_head() (adapters/wordpress/README.md, What goes into a page): the Consent Mode defaults
// have to come before any tag's own code.
add_action('wp_head', static function (): void {
    $values = consent_kit_values();
    echo $values === null ? '' : Site::head($values);
}, PHP_INT_MIN);

// First in <body> (kit/README.md, Page structure): wp_body_open() follows the <body> tag, and this runs before the
// toolbar (wp_admin_bar_render, priority 0) and a theme's skip link — the first layer is the first keyboard stop.
add_action('wp_body_open', static function (): void {
    echo consent_kit_banner();
}, PHP_INT_MIN);

// Last before </body>: after the footer scripts (wp_print_footer_scripts, priority 20) and the gated tags among them.
// A theme without wp_body_open() gets the first layer here, right before kit.js.
add_action('wp_footer', static function (): void {
    echo consent_kit_banner();
    echo consent_kit_values() === null ? '' : Site::script(plugins_url('fragments/consent-kit/', __FILE__));
}, PHP_INT_MAX);

// The server cleanup (Site::cleanupHeaders()), before the response's output.
add_action('send_headers', static function (): void {
    $values = consent_kit_values();
    if ($values === null || headers_sent()) {
        return;
    }
    foreach (Site::cleanupHeaders($values, $_SERVER, home_url()) as $field) {
        header($field, false);
    }
});

add_action('admin_init', static function (): void {
    register_setting('consent_kit', 'consent_kit', [
        'type' => 'array',
        'show_in_rest' => false,
        'sanitize_callback' => static function (mixed $input): mixed {
            [$value, $error] = Site::sanitize($input, get_option('consent_kit'), 'esc_url');
            if ($error !== null) {
                add_settings_error('consent_kit', 'consent_kit', esc_html($error)); // settings_errors() prints it as HTML
                // the form shows what was posted, once, so that one wrong value does not empty it
                set_transient('consent_kit_form_' . get_current_user_id(), Site::fromForm(is_array($input) ? $input : []), MINUTE_IN_SECONDS);
            }
            return $value;
        },
    ]);
});

add_action('admin_menu', static function (): void {
    add_options_page('Consent Kit', 'Consent Kit', 'manage_options', 'consent-kit', 'consent_kit_settings_page');
});

/** Settings → Consent Kit: one field per setting; options.php checks the capability and the nonce, and saves. */
function consent_kit_settings_page(): void
{
    if (!current_user_can('manage_options')) {
        return;
    }
    $saved = get_option('consent_kit');
    $posted = get_transient('consent_kit_form_' . get_current_user_id());
    delete_transient('consent_kit_form_' . get_current_user_id());
    $languages = Site::languages();
    $locale = substr(get_locale(), 0, 2);
    $settings = is_array($posted) ? $posted : (is_array($saved) ? $saved : ['revision' => 1, 'cookie' => 'ck_consent', 'language' => in_array($locale, $languages, true) ? $locale : $languages[0]]);
    try {
        Site::usable($saved, 'esc_url');
        // kit.js carries an integrity value and no crossorigin: from another origin than the pages, a browser blocks it
        $kit = Site::origin(plugins_url('fragments/consent-kit/', __FILE__));
        $pages = Site::origin(home_url('/'));
        $state = $kit === $pages
            ? ['notice-success', 'On: the kit is in every page that the theme renders with wp_head() and wp_footer().']
            : ['notice-error', "On, but not working: kit.js comes from $kit, the pages from $pages — a browser blocks a script with an integrity value from another origin, so no visitor can decide. Serve the plugin folder from the pages' origin."];
    } catch (\InvalidArgumentException $error) {
        $state = ['notice-warning', $saved === false ? 'Not set up: the kit is on no page until these settings are saved.' : 'Off — the saved settings are invalid: ' . $error->getMessage()];
    }
    $fields = [
        // the setting's path, label, input, help
        [['revision'], 'Revision', 'number', 'An integer from 1 to 1,000,000. Raising it asks every visitor again: purge every cached page then.'],
        [['cookie'], 'Cookie name', 'text', 'The choice cookie: letters, digits, "_", ".", "-".'],
        [['domain'], 'Cookie domain', 'text', 'Optional: the registrable domain (example.com) — every cookie deletion is written once more on it.'],
        [['categories', 'analytics'], 'Statistics: data-consent value', 'text', 'Optional: the data-consent value a statistics grant activates (default analytics).'],
        [['categories', 'marketing'], 'Marketing: data-consent value', 'text', 'Optional: the data-consent value a marketing grant activates (default marketing).'],
        [['cleanup', 'analytics', 'cookies'], 'Statistics: cookies', 'lines', 'Deleted while statistics is not granted. One per line; a trailing * is a prefix (_ga_*).'],
        [['cleanup', 'analytics', 'localStorage'], 'Statistics: localStorage keys', 'lines', 'Removed while statistics is not granted. One per line.'],
        [['cleanup', 'marketing', 'cookies'], 'Marketing: cookies', 'lines', 'Deleted while marketing is not granted. One per line; a trailing * is a prefix.'],
        [['cleanup', 'marketing', 'localStorage'], 'Marketing: localStorage keys', 'lines', 'Removed while marketing is not granted. One per line.'],
        [['legacy'], 'Previous consent tool', 'lines', 'Its cookies, deleted on every page load. One per line.'],
        [['endpoint'], 'Records endpoint', 'text', 'Where the consent records go (https://consent.example.com/v1/record); empty: no records.'],
        [['site'], 'Site id', 'text', 'The site id in every record, one of the records service\'s SITES; needed with an endpoint.'],
        [['language'], 'Banner language', 'select', 'The language of the first layer, the dialog and the reopen link (the kit\'s sample texts).'],
        [['privacyUrl'], 'Privacy policy', 'text', 'An https:// URL, a path that starts with one "/", or a #fragment. The reopen link goes there too.'],
        [['imprintUrl'], 'Imprint', 'text', 'An https:// URL, a path that starts with one "/", or a #fragment.'],
        [['serverCleanup'], 'Server cleanup', 'checkbox', 'Also delete a denied category\'s cookies in the page responses, with Set-Cookie headers (https only).'],
    ];
    ?>
    <div class="wrap">
        <h1>Consent Kit</h1>
        <div class="notice <?php echo esc_attr($state[0]); ?> inline"><p><?php echo esc_html($state[1]); ?></p></div>
        <form method="post" action="options.php">
            <?php settings_fields('consent_kit'); ?>
            <table class="form-table" role="presentation">
                <?php
                foreach ($fields as [$path, $label, $input, $help]) {
                    $value = $settings;
                    foreach ($path as $key) {
                        $value = is_array($value) ? ($value[$key] ?? '') : '';
                    }
                    $value = is_array($value) ? implode("\n", array_filter($value, 'is_string')) : (is_scalar($value) ? (string) $value : '');
                    $id = esc_attr('consent-kit-' . implode('-', $path));
                    $name = esc_attr('consent_kit[' . implode('][', $path) . ']');
                    echo '<tr><th scope="row"><label for="' . $id . '">' . esc_html($label) . '</label></th><td>';
                    echo match ($input) {
                        'lines' => "<textarea id=\"$id\" name=\"$name\" rows=\"3\" class=\"large-text code\">" . esc_textarea($value) . '</textarea>',
                        'select' => "<select id=\"$id\" name=\"$name\">" . implode('', array_map(static fn (string $lang): string => '<option value="' . esc_attr($lang) . '"' . selected($value, $lang, false) . '>' . esc_html($lang) . '</option>', $languages)) . '</select>',
                        'checkbox' => "<input type=\"checkbox\" id=\"$id\" name=\"$name\" value=\"1\"" . checked($value, '1', false) . '>',
                        default => "<input type=\"$input\" id=\"$id\" name=\"$name\" value=\"" . esc_attr($value) . '" class="regular-text">',
                    };
                    echo '<p class="description"><code>' . esc_html(implode('.', $path)) . '</code> ' . esc_html($help) . '</p></td></tr>';
                }
                ?>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}
