<?php

declare(strict_types=1);

namespace ConsentKit\Test;

use ConsentKit\Config;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ConfigTest extends TestCase
{
    private const VALID = ['cookie' => 'ck_consent', 'revision' => 2];

    public function testTheHtmlAdaptersExampleSiteConfig(): void
    {
        $config = Config::fromJson(file_get_contents(__DIR__ . '/../../html/example/site.json'));
        self::assertNotNull($config);
        self::assertSame(
            ['ck_consent', 1, 'example.com', ['analytics' => ['_ga', '_ga_*'], 'marketing' => ['_gcl_*']], ['previous-tool-consent']],
            [$config->cookie, $config->revision, $config->domain, $config->cleanup, $config->legacy],
        );
    }

    public function testTheOptionalKeysLeftOut(): void
    {
        $config = Config::fromArray(['revision' => 2.0] + self::VALID);
        self::assertNotNull($config);
        self::assertSame([2, null, ['analytics' => [], 'marketing' => []], []], [$config->revision, $config->domain, $config->cleanup, $config->legacy]);
        self::assertSame('ck consent;', Config::fromArray(['cookie' => 'ck consent;'] + self::VALID)?->cookie, 'the name is any non-empty string, as in the head snippet');
    }

    public static function invalid(): iterable
    {
        yield 'no cookie' => [['revision' => 2]];
        yield 'an empty cookie' => [['cookie' => ''] + self::VALID];
        yield 'a cookie that is no string' => [['cookie' => 1] + self::VALID];
        foreach ([0, 1000001, 1.5, '2', true, null, INF, NAN] as $revision) {
            yield 'revision ' . var_export($revision, true) => [['revision' => $revision] + self::VALID];
        }
        foreach (['Example.com', 'example.com:443', '.example.com', "example.com\n", 'https://example.com', '', 5] as $domain) {
            yield 'domain ' . json_encode($domain) => [['domain' => $domain] + self::VALID];
        }
        yield 'cleanup that is no object' => [['cleanup' => 'x'] + self::VALID];
        yield 'a cleanup rule that is no object' => [['cleanup' => ['analytics' => 'x']] + self::VALID];
        yield 'cookies that are no list' => [['cleanup' => ['marketing' => ['cookies' => '_gcl_*']]] + self::VALID];
        foreach (['*', '_ga *', 'a*b', "_ga\n", 1] as $pattern) {
            yield 'the pattern ' . json_encode($pattern) => [['cleanup' => ['analytics' => ['cookies' => [$pattern]]]] + self::VALID];
        }
        yield 'legacy that is no list' => [['legacy' => 'previous-tool-consent'] + self::VALID];
        yield 'a legacy name with a "*"' => [['legacy' => ['previous-*']] + self::VALID];
    }

    #[DataProvider('invalid')]
    public function testAnInvalidConfigIsNoConfig(array $values): void
    {
        self::assertNull(Config::fromArray($values));
    }

    public function testJsonThatIsNoConfigObject(): void
    {
        foreach (['', 'null', '[]', '"ck_consent"', '{"cookie":"ck_consent","revision":2', "\xEF\xBB\xBF" . json_encode(self::VALID)] as $json) {
            self::assertNull(Config::fromJson($json), $json);
        }
        self::assertNotNull(Config::fromJson(json_encode(self::VALID)));
    }
}
