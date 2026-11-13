// Demo stand-in for the site's gated analytics bundle: it only counts its runs (no request, no cookie),
// so the demo can show that the kit activated it once, and only after an analytics grant.
window.__fakeAnalyticsRuns = (window.__fakeAnalyticsRuns || 0) + 1;
