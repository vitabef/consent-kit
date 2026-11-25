<?php

declare(strict_types=1);

namespace ConsentKit\Test;

use ConsentKit\Config;
use ConsentKit\ConsentCookie;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** spec/vectors.json through the public API: each vector's config as the site config (an invalid one is no config), its cookieHeader as the request's. */
final class VectorsTest extends TestCase
{
    private static function file(): array
    {
        return json_decode(file_get_contents(__DIR__ . '/../../../spec/vectors.json'), true, 512, JSON_THROW_ON_ERROR);
    }

    public function testVersion1With124Vectors(): void
    {
        $file = self::file();
        self::assertSame(1, $file['version']);
        self::assertCount(124, $file['vectors'], 'a vector added or deleted: count it here, as kit/test/cookie-vectors.test.ts does');
    }

    public static function vectors(): iterable
    {
        foreach (self::file()['vectors'] as $vector) {
            yield $vector['name'] => [$vector];
        }
    }

    #[DataProvider('vectors')]
    public function testVector(array $vector): void
    {
        $verdict = ConsentCookie::verdict(Config::fromArray($vector['config']), $vector['cookieHeader']);
        self::assertSame($vector['expected'], ['decided' => $verdict->decided, 'analytics' => $verdict->analytics, 'marketing' => $verdict->marketing]);
    }

    /** spec § 3 — JSON vectors cannot carry raw bytes that are not UTF-8: a raw one denies, an escaped one is skipped. */
    public function testBytesThatAreNoUtf8(): void
    {
        $config = Config::fromArray(['cookie' => 'ck_consent', 'revision' => 2]);
        $grant = 'ck_consent=' . rawurlencode('{"v":2,"a":1,"m":1,"t":1700000000}');
        $raw = 'ck_consent=' . rawurlencode('{"v":2,"a":1,"m":1,"t":1700000000,"x":"') . "\xFF" . rawurlencode('"}');
        $read = static function (string $header) use ($config): array {
            $verdict = ConsentCookie::verdict($config, $header);
            return [$verdict->decided, $verdict->analytics, $verdict->marketing];
        };
        self::assertSame([true, false, false], $read($raw), 'alone: a copy that denies');
        self::assertSame([true, false, false], $read("$raw; $grant"), 'next to a granting copy: its denial counts');
        self::assertSame([true, true, true], $read('ck_consent=' . rawurlencode('{"v":2,"a":0,"m":0,"t":1700000000,"x":"') . '%FF%22%7D; ' . $grant), 'escaped: malformed, skipped');
    }

    public function testVerdictFromGlobals(): void
    {
        $config = Config::fromArray(['cookie' => 'ck_consent', 'revision' => 2]);
        $_SERVER['HTTP_COOKIE'] = 'ck_consent=' . rawurlencode('{"v":2,"a":0,"m":1,"t":1700000000}');
        $verdict = ConsentCookie::verdictFromGlobals($config);
        unset($_SERVER['HTTP_COOKIE']);
        self::assertSame([true, false, true], [$verdict->decided, $verdict->analytics, $verdict->marketing]);
        self::assertFalse(ConsentCookie::verdictFromGlobals($config)->decided);
    }
}
