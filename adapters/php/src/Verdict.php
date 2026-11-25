<?php

declare(strict_types=1);

namespace ConsentKit;

/** The stored choice as a server reads it (spec/consent-cookie.md, The verdict): undecided denies every category. */
final class Verdict
{
    public readonly bool $analytics;
    public readonly bool $marketing;

    public function __construct(public readonly bool $decided, bool $analytics, bool $marketing)
    {
        $this->analytics = $decided && $analytics;
        $this->marketing = $decided && $marketing;
    }
}
