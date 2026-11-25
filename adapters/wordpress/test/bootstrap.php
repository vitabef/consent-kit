<?php

declare(strict_types=1);

// The plugin's classes without WordPress. Its two escaping functions stand in as htmlspecialchars(): the same bytes
// for every value of these tests, but not WordPress's other rules (esc_url() writes "&" as "&#038;" and drops what
// is no URL); test/run.sh runs the real ones in a real WordPress.
const ABSPATH = __DIR__ . '/';

function esc_attr(string $text): string
{
    return htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
}

function esc_url(string $url): string
{
    return htmlspecialchars($url, ENT_QUOTES, 'UTF-8');
}

require __DIR__ . '/../consent-kit/helper/Config.php';
require __DIR__ . '/../consent-kit/helper/Verdict.php';
require __DIR__ . '/../consent-kit/helper/ConsentCookie.php';
require __DIR__ . '/../consent-kit/includes/Site.php';
