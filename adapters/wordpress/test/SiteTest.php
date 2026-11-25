<?php

declare(strict_types=1);

namespace ConsentKit\WordPress\Test;

use ConsentKit\Config;
use ConsentKit\WordPress\Site;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The plugin's settings checks, its settings form and its fragments (includes/Site.php), without WordPress
 * (test/bootstrap.php). The oracle is the HTML adapter's committed example: test/settings.json holds its site config
 * as the plugin's settings, and the plugin fills its templates into exactly those fragments.
 */
final class SiteTest extends TestCase
{
    private const HTML = __DIR__ . '/../../html/example/';
    /** The HTML adapter's invalid site configs, which its own tests run too. */
    private const CASES = __DIR__ . '/../../html/test/config-cases.json';
    private const HOSTILE = '"><img src=x onerror=alert(1)>';

    /** test/settings.json, with $change merged over it (a null value: the key left out). */
    private static function settings(array $change = []): array
    {
        $settings = array_replace(json_decode((string) file_get_contents(__DIR__ . '/settings.json'), true, 512, JSON_THROW_ON_ERROR), $change);
        return array_filter($settings, static fn (mixed $value): bool => $value !== null);
    }

    private static function html(string $fragment): string
    {
        return (string) file_get_contents(self::HTML . "fragments/$fragment");
    }

    public function testTheFixtureIsTheHtmlAdaptersExampleSiteConfig(): void
    {
        $site = json_decode((string) file_get_contents(self::HTML . 'site.json'), true, 512, JSON_THROW_ON_ERROR);
        $languages = $site['languages'];
        unset($site['languages']);
        self::assertEquals($site + ['language' => 'en'] + $languages['en'] + ['serverCleanup' => true], self::settings());
    }

    public function testTheExampleSettingsFillTheTemplatesIntoTheHtmlAdaptersFragments(): void
    {
        $values = Site::values(self::settings());
        self::assertSame(self::html('consent-mode.html') . self::html('head.html'), Site::head($values));
        self::assertSame(self::html('en/banner.html'), Site::banner($values));
        self::assertSame(self::html('en/footer-link.html'), Site::footerLink($values));
        self::assertSame(self::html('script.html'), Site::script('/consent-kit/'), 'the HTML adapter serves kit.js from /consent-kit/');

        $german = Site::values(self::settings(['language' => 'de', 'privacyUrl' => '/datenschutz/', 'imprintUrl' => '/impressum/']));
        self::assertSame(self::html('de/banner.html'), Site::banner($german));
        self::assertSame(self::html('de/footer-link.html'), Site::footerLink($german));
        self::assertSame(['de', 'en'], Site::languages());
    }

    public function testTheValues(): void
    {
        $values = Site::values(self::settings());
        $config = [
            'revision' => 1,
            'cookie' => 'ck_consent',
            'domain' => 'example.com',
            'categories' => ['analytics' => 'analytics', 'marketing' => 'marketing'],
            'cleanup' => ['analytics' => ['cookies' => ['_ga', '_ga_*']], 'marketing' => ['cookies' => ['_gcl_*'], 'localStorage' => ['_gcl_ls']]],
            'legacy' => ['previous-tool-consent'],
        ];
        self::assertSame(
            ['config' => $config, 'endpoint' => 'https://consent.example.com/v1/record', 'site' => 'example-site', 'language' => 'en', 'privacyUrl' => '/en/privacy/', 'imprintUrl' => '/en/imprint/', 'serverCleanup' => true],
            $values,
        );
        // the PHP helper reads the same config: the server's verdict and cleanup follow the page's config block
        $helper = Config::fromArray($values['config']);
        self::assertNotNull($helper);
        self::assertSame(['ck_consent', 1, 'example.com', ['analytics' => ['_ga', '_ga_*'], 'marketing' => ['_gcl_*']], ['previous-tool-consent']], [$helper->cookie, $helper->revision, $helper->domain, $helper->cleanup, $helper->legacy]);
    }

    public function testTheOptionalKeysLeftOut(): void
    {
        $values = Site::values(['revision' => 3.0, 'cookie' => 'site_consent', 'endpoint' => '', 'language' => 'en', 'privacyUrl' => '#privacy', 'imprintUrl' => 'https://www.example.com/imprint/']);
        self::assertSame(['revision' => 3, 'cookie' => 'site_consent', 'categories' => ['analytics' => 'analytics', 'marketing' => 'marketing']], $values['config']);
        self::assertSame(['', '', false], [$values['endpoint'], $values['site'], $values['serverCleanup']]);
        self::assertStringContainsString('<script type="application/json" id="ck-config">{"revision":3,"cookie":"site_consent","categories":{"analytics":"analytics","marketing":"marketing"}}</script>', Site::head($values));
        self::assertStringContainsString('data-endpoint="" data-site=""', Site::banner($values));
        $null = ['domain' => null, 'categories' => null, 'cleanup' => null, 'legacy' => null, 'serverCleanup' => null] + self::settings();
        self::assertSame(Site::values(self::settings(array_fill_keys(['domain', 'categories', 'cleanup', 'legacy', 'serverCleanup'], null))), Site::values($null), 'null counts as left out');
    }

    /** WordPress's esc_url() as test/run.sh sees it: a #fragment with a ":" emptied, "{" and "}" dropped, "&" as "&#038;". */
    private static function escUrl(string $url): string
    {
        return str_starts_with($url, '#') && str_contains($url, ':') ? '' : str_replace(['{', '}', '&'], ['', '', '&#038;'], $url);
    }

    public function testUsableSettingsKeepEveryUrlThroughEscUrl(): void
    {
        $escUrl = self::escUrl(...);
        self::assertSame(Site::values(self::settings()), Site::usable(self::settings(), $escUrl));
        self::assertSame('/p/?a=1&b=2', Site::usable(self::settings(['privacyUrl' => '/p/?a=1&b=2']), $escUrl)['privacyUrl'], 'its entities are the same URL');
        foreach ([['privacyUrl', '#a:b', '""'], ['imprintUrl', '#a:b', '""'], ['endpoint', 'https://consent.example.com/v1/{x}', '"https://consent.example.com/v1/x"']] as [$key, $url, $written]) {
            try {
                Site::usable(self::settings([$key => $url]), $escUrl);
                self::fail("$key $url passed");
            } catch (\InvalidArgumentException $error) {
                self::assertSame("Consent Kit: $key " . json_encode($url, JSON_UNESCAPED_SLASHES) . " is not kept by WordPress's esc_url(), which writes $written", $error->getMessage());
            }
        }
    }

    public function testASaveOfTheForm(): void
    {
        $escUrl = self::escUrl(...);
        $form = ['revision' => '1', 'cookie' => 'ck_consent', 'endpoint' => '', 'language' => 'en', 'privacyUrl' => '#privacy', 'imprintUrl' => '#imprint'];
        $settings = Site::fromForm($form);
        self::assertSame([$settings, null], Site::sanitize($form, false, $escUrl), 'a valid form: its settings');
        self::assertSame([$settings, null], Site::sanitize($settings, false, $escUrl), 'the second run of a first save: the settings as they are');
        self::assertSame(
            [['the saved settings'], 'Consent Kit: privacyUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "javascript:x"'],
            Site::sanitize(['privacyUrl' => 'javascript:x'] + $form, ['the saved settings'], $escUrl),
        );
        self::assertSame([false, "Consent Kit: privacyUrl \"#a:b\" is not kept by WordPress's esc_url(), which writes \"\""], Site::sanitize(['privacyUrl' => '#a:b'] + $form, false, $escUrl));
        self::assertSame([false, 'Consent Kit: revision must be an integer from 1 to 1000000, not ""'], Site::sanitize('no form', false, $escUrl));
        self::assertSame([false, 'Consent Kit: x is not a key (revision, cookie, domain, categories, cleanup, legacy, endpoint, site, language, privacyUrl, imprintUrl, serverCleanup)'], Site::sanitize(['x' => 1] + $settings, false, $escUrl), 'a number as revision is no pass');
    }

    public function testTheServerCleanupsHeaderFields(): void
    {
        $values = Site::values(self::settings());
        $choice = static fn (int $granted): string => 'ck_consent=' . rawurlencode(json_encode(['v' => 1, 'a' => $granted, 'm' => $granted, 't' => 1700000000]));
        $tags = '_ga=1; _gcl_au=1; previous-tool-consent=yes; theme=dark';
        $https = ['HTTPS' => 'on', 'REQUEST_METHOD' => 'GET'];
        $home = 'https://www.example.com/';
        // the kit's three deletions, the page's host name from $home
        $gone = static fn (string $name): array => array_map(static fn (string $scope): string => "Set-Cookie: $name=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/$scope", ['', '; Domain=example.com', '; Domain=www.example.com']);
        $denied = "$tags; " . $choice(0);
        self::assertSame(['Cache-Control: private', ...$gone('_ga'), ...$gone('_gcl_au'), ...$gone('previous-tool-consent')], Site::cleanupHeaders($values, $https + ['HTTP_COOKIE' => $denied], $home));
        self::assertSame(['Cache-Control: private', ...$gone('previous-tool-consent')], Site::cleanupHeaders($values, $https + ['HTTP_COOKIE' => "$tags; " . $choice(1)], $home), 'both granted: the previous tool only');
        self::assertSame(['Cache-Control: private', ...$gone('previous-tool-consent')], Site::cleanupHeaders($values, ['HTTP_COOKIE' => $denied], $home), 'plain http: the previous tool only');
        self::assertSame([], Site::cleanupHeaders(['serverCleanup' => false] + $values, $https + ['HTTP_COOKIE' => $denied], $home), 'the switch off');
        self::assertSame([], Site::cleanupHeaders($values, $https, $home), 'no cookie to delete');
        self::assertSame([], Site::cleanupHeaders($values, $https + ['HTTP_COOKIE' => $tags], 'no host'), 'a home without a host name');
    }

    public function testOrigins(): void
    {
        self::assertSame('https://www.example.com:443', Site::origin('https://WWW.Example.com/wp-content/plugins/'));
        self::assertSame('http://localhost:8890', Site::origin('http://localhost:8890/'));
        self::assertSame('http://example.com:80', Site::origin('HTTP://example.com'));
        self::assertNotSame(Site::origin('https://cdn.example.com/x/'), Site::origin('https://www.example.com/'));
        self::assertNotSame(Site::origin('http://www.example.com/'), Site::origin('https://www.example.com/'));
        self::assertSame('', Site::origin('//cdn.example.com/x/'), 'no scheme: no origin of its own, so never the pages\'');
    }

    public function testTheConfigBlockWritesCleanupAsObjects(): void
    {
        // PHP's json_decode() reads {} as []: the block has the HTML adapter's objects all the same
        self::assertStringContainsString('"cleanup":{}}', Site::head(Site::values(self::settings(['cleanup' => [], 'legacy' => null]))));
        $rules = ['analytics' => [], 'marketing' => ['cookies' => []]];
        self::assertStringContainsString('"cleanup":{"analytics":{},"marketing":{"cookies":[]}}}', Site::head(Site::values(self::settings(['cleanup' => $rules, 'legacy' => null]))));
    }

    public function testTheUrlsWhitespaceIsJavaScripts(): void
    {
        // what JavaScript's \s leaves out passes, as in the HTML adapter (U+FEFF, which it takes, is a shared case)
        foreach (["\u{85}", "\u{180e}"] as $char) {
            self::assertSame("/a{$char}b/", Site::values(self::settings(['privacyUrl' => "/a{$char}b/"]))['privacyUrl']);
        }
    }

    public function testNoValueCanCloseTheConfigBlockOrLeaveAnAttribute(): void
    {
        $hostile = ['</script><script>alert(1)</script>', 'a&b>c<!--', self::HOSTILE];
        $head = Site::head(Site::values(self::settings(['cleanup' => ['marketing' => ['localStorage' => $hostile]]])));
        self::assertSame(3, substr_count($head, '<script'), 'the Consent Mode defaults, the config block, the head snippet');
        self::assertSame(3, substr_count($head, '</script>'));
        preg_match('~<script type="application/json" id="ck-config">(.*)</script>~', $head, $block);
        self::assertStringNotContainsString('<', $block[1]);
        self::assertSame($hostile, json_decode($block[1], true)['cleanup']['marketing']['localStorage']);

        // every value the checks would refuse, filled anyway: each one escaped where it lands
        $values = ['language' => 'en', 'privacyUrl' => self::HOSTILE, 'imprintUrl' => self::HOSTILE, 'endpoint' => self::HOSTILE, 'site' => self::HOSTILE];
        foreach ([Site::banner($values), Site::footerLink($values), Site::script(self::HOSTILE)] as $html) {
            self::assertStringNotContainsString('"><img', $html);
            self::assertStringContainsString('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;', $html);
        }
        self::assertSame(6, substr_count(Site::banner($values), '&quot;&gt;&lt;img'), 'two links in each layer, the endpoint, the site id');
    }

    public function testTheFormsFieldsAsSettings(): void
    {
        $form = [
            'revision' => ' 1 ',
            'cookie' => 'ck_consent ',
            'domain' => 'example.com',
            'categories' => ['analytics' => '', 'marketing' => ' '],
            'cleanup' => [
                'analytics' => ['cookies' => "_ga\r\n  _ga_* \r\n\r\n", 'localStorage' => ''],
                'marketing' => ['cookies' => '_gcl_*', 'localStorage' => "_gcl_ls\n"],
            ],
            'legacy' => 'previous-tool-consent',
            'endpoint' => 'https://consent.example.com/v1/record',
            'site' => 'example-site',
            'language' => 'en',
            'privacyUrl' => '/en/privacy/',
            'imprintUrl' => '/en/imprint/',
            'serverCleanup' => '1',
        ];
        self::assertSame(self::settings(), Site::fromForm($form));
        // every optional field empty, the checkbox off; a revision that is no number stays text, for its message
        self::assertSame(
            ['revision' => 'abc', 'cookie' => 'ck', 'endpoint' => '', 'language' => 'de', 'privacyUrl' => '#p', 'imprintUrl' => '#i', 'serverCleanup' => false],
            Site::fromForm(['revision' => 'abc', 'cookie' => 'ck', 'domain' => '', 'legacy' => " \r\n", 'endpoint' => '', 'site' => '', 'language' => 'de', 'privacyUrl' => '#p', 'imprintUrl' => '#i']),
        );
        self::assertSame('12345678', Site::fromForm(['revision' => '12345678'])['revision']);
        // a post that is not the form's shape: no field read as anything but empty text
        self::assertSame(['revision' => '', 'cookie' => '', 'endpoint' => '', 'language' => '', 'privacyUrl' => '', 'imprintUrl' => '', 'serverCleanup' => false], Site::fromForm(['revision' => ['1'], 'categories' => 'x', 'cleanup' => ['analytics' => 'x']]));
    }

    /**
     * The HTML adapter's cases (adapters/html/test/config-cases.json) as the plugin's settings: the case's site
     * config with its one language — the one the case changes, else the first — as `language` and that entry's keys,
     * a null value left out. The message is the HTML adapter's without `languages.<lang>.`, or the case's `wordpress`.
     */
    public static function shared(): iterable
    {
        $cases = json_decode((string) file_get_contents(self::CASES), true, 512, JSON_THROW_ON_ERROR)['cases'];
        $example = json_decode((string) file_get_contents(self::HTML . 'site.json'), true, 512, JSON_THROW_ON_ERROR);
        foreach ($cases as $case) {
            $message = $case['wordpress'] ?? preg_replace('/^languages\.[a-z]+\./', '', $case['message']);
            if (array_key_exists('input', $case)) {
                yield $case['name'] => [$case['input'], $message];
                continue;
            }
            $site = array_replace($example, $case['site'] ?? []);
            $languages = is_array($site['languages'] ?? null) ? $site['languages'] : [];
            unset($site['languages']);
            [$lang, $values] = $case['language'] ?? [array_key_first($languages), []];
            $settings = $lang === null ? $site : $site + ['language' => $lang] + array_replace($languages[$lang] ?? [], $values);
            yield $case['name'] => [array_filter($settings, static fn (mixed $value): bool => $value !== null), $message];
        }
    }

    /** The plugin's own cases: no saved settings, the server cleanup's switch, and values the shared cases leave out. */
    public static function invalid(): iterable
    {
        $settings = self::settings(...);
        yield 'no settings saved' => [false, 'the site config must be a JSON object'];
        yield 'revision true' => [$settings(['revision' => true]), 'revision must be an integer from 1 to 1000000, not true'];
        yield 'a cookie name with a line break at its end' => [$settings(['cookie' => "ck\n"]), 'cookie must be a cookie name'];
        yield 'an endpoint that leaves its attribute' => [$settings(['endpoint' => 'https://consent.example.com/' . self::HOSTILE]), 'endpoint must be the records URL'];
        yield 'a site id that leaves its attribute' => [$settings(['site' => self::HOSTILE]), 'site must be a site id'];
        yield 'a localStorage key that is not UTF-8' => [$settings(['cleanup' => ['marketing' => ['localStorage' => ["\xFF"]]]]), 'cleanup.marketing.localStorage: "'];
        yield 'a privacy link that leaves its attribute' => [$settings(['privacyUrl' => self::HOSTILE]), 'privacyUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "\"><img src=x onerror=alert(1)>"'];
        yield 'a privacy link with a no-break space' => [$settings(['privacyUrl' => "/a\u{a0}b/"]), 'privacyUrl must be an https:// URL'];
        yield 'the server cleanup as text' => [$settings(['serverCleanup' => '1']), 'serverCleanup must be true or false, not "1"'];
    }

    #[DataProvider('shared')]
    #[DataProvider('invalid')]
    public function testAnInvalidSettingFailsWithItsMessage(mixed $settings, string $message): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage("Consent Kit: $message");
        Site::values($settings);
    }
}
