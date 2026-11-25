<?php

declare(strict_types=1);

namespace ConsentKit\Test;

use ConsentKit\Config;
use ConsentKit\ConsentCookie;
use ConsentKit\Verdict;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** deletionHeaders() for a page on www.example.com with the HTML adapter's example config, and mayCleanUp(). */
final class CleanupTest extends TestCase
{
    private const HEADER = '_ga=GA1.1.1.1; _ga_ABC=GS1.1; _gcl_au=1.1.1; previous-tool-consent=yes; theme=dark; ck_consent=%7B%7D';
    private const BOTH = ['example.com', 'www.example.com'];

    private static function config(array $values = []): Config
    {
        $config = Config::fromArray($values + json_decode(file_get_contents(__DIR__ . '/../../html/example/site.json'), true));
        self::assertNotNull($config);
        return $config;
    }

    /** @return list<string> */
    private static function headers(Verdict $verdict, ?string $header = self::HEADER, bool $cleanUp = true, ?Config $config = null, string $hostname = 'www.example.com'): array
    {
        return ConsentCookie::deletionHeaders($verdict, $config ?? self::config(), $hostname, $header, $cleanUp);
    }

    /** kit.js's drop(): the host-only deletion, then one per domain. */
    private static function gone(string $name, string ...$domains): array
    {
        $gone = $name . '=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/';
        return [$gone, ...array_map(static fn (string $domain): string => "$gone; Domain=$domain", $domains)];
    }

    public function testUndecidedDeletesBothCategoriesAndTheLegacyCookieInThreeScopes(): void
    {
        self::assertSame(
            [...self::gone('_ga', ...self::BOTH), ...self::gone('_ga_ABC', ...self::BOTH), ...self::gone('_gcl_au', ...self::BOTH), ...self::gone('previous-tool-consent', ...self::BOTH)],
            self::headers(new Verdict(false, true, true)), // undecided denies whatever it is given
        );
    }

    public function testAGrantedCategoryKeepsItsCookies(): void
    {
        self::assertSame([...self::gone('_gcl_au', ...self::BOTH), ...self::gone('previous-tool-consent', ...self::BOTH)], self::headers(new Verdict(true, true, false)));
        self::assertSame(self::gone('previous-tool-consent', ...self::BOTH), self::headers(new Verdict(true, true, true)));
    }

    public function testARequestThatMayNotCleanUpDeletesTheLegacyCookiesOnly(): void
    {
        self::assertSame(self::gone('previous-tool-consent', ...self::BOTH), self::headers(new Verdict(false, false, false), cleanUp: false));
    }

    public function testThePageOnTheDomainItselfAndAConfigWithoutDomain(): void
    {
        self::assertSame(self::gone('_ga', 'example.com'), self::headers(new Verdict(false, false, false), '_ga=1', hostname: 'example.com'));
        self::assertSame(self::gone('_ga', 'www.example.com'), self::headers(new Verdict(false, false, false), '_ga=1', config: self::config(['domain' => null])));
    }

    public function testOnlyCookiesTheRequestCarries(): void
    {
        self::assertSame([], self::headers(new Verdict(false, false, false), '_gax=1; x_ga=1; _gcl=1; theme=dark; ck_consent=x'));
        self::assertSame([], self::headers(new Verdict(false, false, false), null));
    }

    public function testNoConfigDeletesNothing(): void
    {
        self::assertSame([], ConsentCookie::deletionHeaders(new Verdict(false, false, false), null, 'www.example.com', self::HEADER, true));
        // the host is not even checked then: a site without a config never fails on it
        self::assertSame([], ConsentCookie::deletionHeaders(new Verdict(false, false, false), null, "www.example.com\r\n", self::HEADER, true));
    }

    public function testOneResponseDeletesAtMost2KB(): void
    {
        $lines = self::headers(new Verdict(false, false, false), implode('; ', array_map(static fn (int $i): string => "_ga_$i=GS1.1", range(0, 59))));
        // 8 whole cookies of about 245 bytes each, in request order: the ninth would pass 2,048 bytes
        self::assertCount(24, $lines);
        self::assertSame(self::gone('_ga_0', ...self::BOTH), array_slice($lines, 0, 3));
        self::assertLessThanOrEqual(2048, array_sum(array_map(static fn (string $line): int => strlen("Set-Cookie: $line\r\n"), $lines)));
    }

    public function testDeletionHeadersFromGlobals(): void
    {
        $_SERVER['HTTP_COOKIE'] = '_ga=1; previous-tool-consent=yes';
        $_SERVER['HTTPS'] = 'on';
        $https = ConsentCookie::deletionHeadersFromGlobals(new Verdict(false, false, false), self::config(), 'www.example.com');
        unset($_SERVER['HTTPS']);
        $http = ConsentCookie::deletionHeadersFromGlobals(new Verdict(false, false, false), self::config(), 'www.example.com');
        unset($_SERVER['HTTP_COOKIE']);
        self::assertSame([...self::gone('_ga', ...self::BOTH), ...self::gone('previous-tool-consent', ...self::BOTH)], $https);
        self::assertSame(self::gone('previous-tool-consent', ...self::BOTH), $http, 'plain http: the legacy cookies only');
    }

    public function testNeverTheChoiceCookie(): void
    {
        // patterns that match it (the adapters refuse such a config): the other cookies go, the choice cookie stays
        $config = self::config(['cleanup' => ['analytics' => ['cookies' => ['ck_*']]], 'legacy' => ['ck_consent']]);
        self::assertSame(self::gone('ck_other', ...self::BOTH), self::headers(new Verdict(false, false, false), 'ck_consent=x; ck_other=1', config: $config));
    }

    public function testTheNames(): void
    {
        // a piece without "=" is a cookie of that name; a name twice is deleted once; a name a Set-Cookie field cannot
        // carry (a space, a quote, a control character) is never echoed into one
        self::assertSame(
            [...self::gone('_ga', ...self::BOTH), ...self::gone('_ga_2', ...self::BOTH)],
            self::headers(new Verdict(false, false, false), "_ga; _ga=1; _ga_2=1; _ga_2=2; _ga_ x=1; _ga_\"=1; _ga_\x01=1"),
        );
    }

    public function testAHostValueLosesItsPort(): void
    {
        $undecided = new Verdict(false, false, false);
        self::assertSame(self::gone('_ga', ...self::BOTH), self::headers($undecided, '_ga=1', hostname: 'WWW.Example.com:8443'));
        self::assertSame(self::gone('_ga', 'example.com'), self::headers($undecided, '_ga=1', hostname: 'example.com:443'));
        self::assertSame(self::gone('_ga', 'example.com', '[::1]'), self::headers($undecided, '_ga=1', hostname: '[::1]:8080'));
        self::assertSame(self::gone('_ga', 'example.com', 'my_host.example.com'), self::headers($undecided, '_ga=1', hostname: 'my_host.example.com.'));
    }

    public static function hostnames(): iterable
    {
        foreach (['', '.example.com', 'www..example.com', 'www.example.com..', 'www.example.com:', 'www.example.com:1:2', 'example.com;x', '[::1', "www.example.com\r\nX-Injected: 1"] as $hostname) {
            yield json_encode($hostname) => [$hostname];
        }
    }

    #[DataProvider('hostnames')]
    public function testAHostnameThatIsNoHostThrows(string $hostname): void
    {
        $this->expectException(\InvalidArgumentException::class);
        self::headers(new Verdict(false, false, false), hostname: $hostname);
    }

    public static function requests(): iterable
    {
        $fetch = static fn (string $method, string $site, string $mode, string $dest): array => ['HTTPS' => 'on', 'REQUEST_METHOD' => $method, 'HTTP_SEC_FETCH_SITE' => $site, 'HTTP_SEC_FETCH_MODE' => $mode, 'HTTP_SEC_FETCH_DEST' => $dest];
        yield 'plain http: the Secure choice cookie stays home' => [false, ['REQUEST_METHOD' => 'GET']];
        yield 'HTTPS "off" (IIS on http)' => [false, ['HTTPS' => 'off'] + $fetch('GET', 'same-origin', 'navigate', 'document')];
        yield 'https by REQUEST_SCHEME' => [true, ['REQUEST_SCHEME' => 'https', 'REQUEST_METHOD' => 'GET']];
        yield 'https by X-Forwarded-Proto, behind a proxy' => [true, ['HTTP_X_FORWARDED_PROTO' => 'HTTPS', 'REQUEST_METHOD' => 'GET']];
        yield 'no Fetch Metadata (an older browser, a script)' => [true, ['HTTPS' => 'on', 'REQUEST_METHOD' => 'POST']];
        yield 'same-origin' => [true, $fetch('POST', 'same-origin', 'cors', 'empty')];
        yield 'same-site' => [true, $fetch('GET', 'same-site', 'no-cors', 'image')];
        yield 'a typed address' => [true, $fetch('GET', 'none', 'navigate', 'document')];
        yield 'a cross-site top-level GET navigation' => [true, $fetch('GET', 'cross-site', 'navigate', 'document')];
        yield 'a cross-site form POST' => [false, $fetch('POST', 'cross-site', 'navigate', 'document')];
        yield 'a cross-site frame' => [false, $fetch('GET', 'cross-site', 'navigate', 'iframe')];
        yield 'a cross-site image' => [false, $fetch('GET', 'cross-site', 'no-cors', 'image')];
    }

    #[DataProvider('requests')]
    public function testMayCleanUp(bool $may, array $server): void
    {
        self::assertSame($may, ConsentCookie::mayCleanUp($server));
    }
}
