#!/usr/bin/env sh
# =============================================================================
# run.sh — the WordPress plugin in a real WordPress, by hand (never in the gate: it needs Docker):
#   sh adapters/wordpress/test/run.sh
# Starts WordPress 7.1.5 on PHP 8.3 with WP_DEBUG and MariaDB 11.8 (compose.yaml), installs WordPress with WP-CLI,
# activates the plugin (../consent-kit, mounted read-only), saves its settings (settings.json: the HTML adapter's
# example site config) and checks with curl what visitors and admins get. Needs Docker with Compose v2 and curl,
# and 127.0.0.1:8890 (CONSENT_KIT_WP_PORT for another port). Writes only below .tmp/wordpress-test/ of the
# repository; removes its containers and volumes at the end, after a failure too. Exit code 0 = every check passed.
# =============================================================================
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$DIR/../../.." && pwd)
OUT="$REPO/.tmp/wordpress-test"
SAVED=/repo/.tmp/wordpress-test          # $OUT inside the containers (compose.yaml mounts the repository at /repo)
HTML="$REPO/adapters/html/example/fragments"
BASE="http://localhost:${CONSENT_KIT_WP_PORT:-8890}"
PASS=consent-kit-test                    # the throwaway users' password, on 127.0.0.1 only

compose() { docker compose -f "$DIR/compose.yaml" "$@"; }
cli() { compose run --rm -T cli wp "$@"; }
php() { compose exec -T wordpress php "$@"; }

failed=0
check() { # check <what> <command…>: ok when the command succeeds
  what="$1"; shift
  if "$@" >/dev/null 2>&1; then printf 'ok   %s\n' "$what"; else printf 'FAIL %s\n' "$what"; failed=$((failed + 1)); fi
}
fetch() { # fetch <name> <curl arguments…>: the answer's header fields into <name>.headers, its body into <name>.html
  name="$1"; shift
  curl -sS -D "$OUT/$name.headers" -o "$OUT/$name.html" "$@"
}
has() { grep -qF -- "$2" "$OUT/$1"; }
lacks() { ! grep -qF -- "$2" "$OUT/$1"; }
# no PHP error, warning, notice or deprecation in a saved answer (WP_DEBUG prints them), and no critical-error page
quiet() { ! grep -qE '(Fatal error|Warning|Notice|Deprecated)</b>:|There has been a critical error' "$OUT/$1"; }
# the settings form's field labels in a saved answer, one per line
labels() { grep -o '<label for="consent-kit-[^"]*">[^<]*</label>' "$OUT/$1" | sed 's/<[^>]*>//g'; }
# the bytes of a reference file (a path below $REPO, read at /repo inside the container) in one piece, in a saved
# answer; a file that cannot be read, or is empty, fails
contains() { php -r '$a = file_get_contents($argv[1]); $b = file_get_contents($argv[2]); exit(is_string($a) && is_string($b) && $b !== "" && str_contains($a, $b) ? 0 : 1);' "$SAVED/$1" "/repo${2#"$REPO"}"; }
# the line after (before) the first line with the text, its indentation dropped
after() { awk -v s="$2" 'found { print; exit } index($0, s) { found = 1 }' "$OUT/$1" | sed 's/^[[:space:]]*//'; }
before() { awk -v s="$2" 'index($0, s) { print prev; exit } { prev = $0 }' "$OUT/$1" | sed 's/^[[:space:]]*//'; }
status() { head -n 1 "$OUT/$1.headers" | cut -d ' ' -f 2; }
deletions() { grep -c '^Set-Cookie: ' "$OUT/$1.headers" || true; }
# a stored choice of revision 1: analytics $1, marketing $2 (encodeURIComponent of the kit's JSON)
choice() { printf 'ck_consent=%%7B%%22v%%22%%3A1%%2C%%22a%%22%%3A%s%%2C%%22m%%22%%3A%s%%2C%%22t%%22%%3A1700000000%%7D' "$1" "$2"; }
verdict() { curl -sS "$@" "$BASE/?consent-kit-verdict"; }
TAGS='_ga=1; _ga_ABC=1; _gcl_au=1; previous-tool-consent=yes; theme=dark'
GONE='=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'

mkdir -p "$OUT"
trap 'compose down -v --remove-orphans >/dev/null 2>&1' EXIT
trap 'exit 130' INT TERM
compose up -d --wait wordpress
tries=0
until curl -s -o /dev/null "$BASE/wp-login.php"; do # Apache answers once WordPress is copied into its volume
  tries=$((tries + 1))
  [ "$tries" -lt 90 ] || { echo "WordPress did not answer on $BASE"; exit 1; }
  sleep 1
done
cli core install --url="$BASE" --title="Consent Kit test" --admin_user=admin --admin_password="$PASS" --admin_email=admin@example.com --skip-email
cli user create visitor visitor@example.com --role=subscriber --user_pass="$PASS"
cli plugin activate consent-kit
links=$(cli post create --post_type=page --post_status=publish --post_title=Links --post_content='[consent_kit_link]' --porcelain)

echo "--- not set up: the plugin emits nothing"
fetch unset "$BASE/"
check "no Consent Mode defaults, config block, first layer or kit.js" sh -c "! grep -qE 'window.dataLayer|ck-config|data-ck-banner|consent-kit/kit\.' '$OUT/unset.html'"
check "a visitor with a granting choice reads undecided" test "$(verdict -H "Cookie: $(choice 1 1)")" = '{"analytics":false,"marketing":false,"decided":false}'

echo "--- the HTML adapter's example settings (test/settings.json)"
cli option update consent_kit --format=json <"$DIR/settings.json"
fetch page "$BASE/"
cat "$HTML/consent-mode.html" "$HTML/head.html" >"$OUT/head-part.expected"
check "<head>: the HTML adapter's consent-mode.html and head.html, byte for byte, in one piece" contains page.html "$OUT/head-part.expected"
check "<head>: first, right after <meta charset>" test "$(after page.html '<meta charset=')" = '<script data-cfasync="false">'
check "<body>: the HTML adapter's en/banner.html, byte for byte" contains page.html "$HTML/en/banner.html"
check "<body>: the first layer is its first child" test "$(after page.html '<body ')" = "$(head -n 1 "$HTML/en/banner.html")"
script=$(sed "s|src=\"/consent-kit/|src=\"$BASE/wp-content/plugins/consent-kit/fragments/consent-kit/|" "$HTML/script.html")
check "kit.js: the HTML adapter's script.html, served from the plugin folder" has page.html "$script"
check "kit.js: the last thing before </body>" test "$(before page.html '</body>')" = "$script"
check "no PHP error, warning, notice or deprecation (WP_DEBUG)" quiet page.html

src=$(printf '%s\n' "$script" | sed 's/.* src="\([^"]*\)".*/\1/')
integrity=$(printf '%s\n' "$script" | sed 's/.* integrity="\([^"]*\)".*/\1/')
fetch kit "$src"
check "kit.js: 200, a script" sh -c "head -n 1 '$OUT/kit.headers' | grep -q ' 200' && grep -qi '^Content-Type: [a-z]*/javascript' '$OUT/kit.headers'"
check "kit.js: byte for byte dist/kit.js" cmp -s "$OUT/kit.html" "$REPO/dist/kit.js"
check "kit.js: its SHA-256 is the integrity value ($integrity)" test "sha256-$(php -r 'echo base64_encode(hash_file("sha256", $argv[1], true));' "$SAVED/kit.html")" = "$integrity"

fetch no-body-open "$BASE/?consent-kit-no-body-open"
check "a theme without wp_body_open(): the first layer once" sh -c "test \"\$(grep -c 'data-ck-banner' '$OUT/no-body-open.html')\" = 1"
check "… right before kit.js, the last line before </body>" sh -c "test \"\$(grep -B 1 -F '$script' '$OUT/no-body-open.html' | head -n 1)\" = '</dialog>' && test \"\$(grep -A 1 -F '$script' '$OUT/no-body-open.html' | sed -n 2p)\" = '</body>'"
check "… and the whole first layer and dialog there" contains no-body-open.html "$HTML/en/banner.html"
fetch body-open-twice "$BASE/?consent-kit-body-open-twice"
check "a theme that calls wp_body_open() twice: the first layer once, first in <body>" sh -c "test \"\$(grep -c 'data-ck-banner' '$OUT/body-open-twice.html')\" = 1 && test \"\$(grep -c 'id=\"ck-cd-t\"' '$OUT/body-open-twice.html')\" = 1"
check "… first in <body>" test "$(after body-open-twice.html '<body ')" = "$(head -n 1 "$HTML/en/banner.html")"

fetch links "$BASE/?page_id=$links"
check "the shortcode [consent_kit_link]: the HTML adapter's en/footer-link.html" has links.html "$(cat "$HTML/en/footer-link.html")"
check "consent_kit_footer_link() for themes: the same link" test "$(cli eval 'echo consent_kit_footer_link();')" = "$(cat "$HTML/en/footer-link.html")"

echo "--- consent_kit_verdict()"
check "no cookie: undecided" test "$(verdict)" = '{"analytics":false,"marketing":false,"decided":false}'
check "a choice granting both" test "$(verdict -H "Cookie: theme=dark; $(choice 1 1)")" = '{"analytics":true,"marketing":true,"decided":true}'
check "a choice granting analytics only" test "$(verdict -H "Cookie: $(choice 1 0)")" = '{"analytics":true,"marketing":false,"decided":true}'
check "a choice denying both" test "$(verdict -H "Cookie: $(choice 0 0)")" = '{"analytics":false,"marketing":false,"decided":true}'
check "a choice of another revision: undecided" test "$(verdict -H "Cookie: $(choice 1 1 | sed 's/%22v%22%3A1/%22v%22%3A2/')")" = '{"analytics":false,"marketing":false,"decided":false}'
check "a granting and a denying copy: the most restrictive counts" test "$(verdict -H "Cookie: $(choice 1 1); $(choice 0 1)")" = '{"analytics":false,"marketing":true,"decided":true}'

echo "--- the server cleanup"
fetch https-deny -H "X-Forwarded-Proto: https" -H "Cookie: $TAGS; $(choice 0 0)" "$BASE/"
for name in _ga _ga_ABC _gcl_au previous-tool-consent; do
  check "https, both denied: $name deleted on the host, on example.com and on localhost" sh -c "grep -qF 'Set-Cookie: $name$GONE' '$OUT/https-deny.headers' && grep -qF 'Set-Cookie: $name$GONE; Domain=example.com' '$OUT/https-deny.headers' && grep -qF 'Set-Cookie: $name$GONE; Domain=localhost' '$OUT/https-deny.headers'"
done
check "https, both denied: 12 deletions, neither the choice cookie nor another cookie" test "$(deletions https-deny)" = 12
check "https, both denied: Cache-Control: private" has https-deny.headers 'Cache-Control: private'
fetch http-deny -H "Cookie: $TAGS; $(choice 0 0)" "$BASE/"
check "plain http: the previous tool's cookie only (3 deletions; the Secure choice cookie stays home)" sh -c "test \"\$(grep -c '^Set-Cookie: ' '$OUT/http-deny.headers')\" = 3 && grep -qF 'Set-Cookie: previous-tool-consent$GONE' '$OUT/http-deny.headers'"
fetch https-grant -H "X-Forwarded-Proto: https" -H "Cookie: $TAGS; $(choice 1 1)" "$BASE/"
check "https, both granted: the previous tool's cookie only" sh -c "test \"\$(grep -c '^Set-Cookie: ' '$OUT/https-grant.headers')\" = 3 && ! grep -qF 'Set-Cookie: _ga' '$OUT/https-grant.headers'"
fetch https-frame -H "X-Forwarded-Proto: https" -H "Sec-Fetch-Site: cross-site" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Dest: iframe" -H "Cookie: $TAGS" "$BASE/"
check "https, a cross-site frame (no choice cookie sent): the previous tool's cookie only" test "$(deletions https-frame)" = 3
cli option patch update consent_kit serverCleanup false --format=json
fetch https-off -H "X-Forwarded-Proto: https" -H "Cookie: $TAGS; $(choice 0 0)" "$BASE/"
check "server cleanup off: no deletion, no Cache-Control: private" sh -c "! grep -qE '^(Set-Cookie|Cache-Control: private)' '$OUT/https-off.headers'"

echo "--- invalid saved settings fail closed (written past the settings page, with WP-CLI)"
cli option patch update consent_kit revision 0 --format=json
fetch bad-revision -H "X-Forwarded-Proto: https" -H "Cookie: $TAGS; $(choice 0 0)" "$BASE/"
check "revision 0: no Consent Mode defaults, config block, first layer or kit.js" sh -c "! grep -qE 'window.dataLayer|ck-config|data-ck-banner|consent-kit/kit\.' '$OUT/bad-revision.html'"
check "revision 0: no deletion" test "$(deletions bad-revision)" = 0
check "revision 0: a granting choice reads undecided" test "$(verdict -H "Cookie: $(choice 1 1)")" = '{"analytics":false,"marketing":false,"decided":false}'
check "revision 0: the shortcode writes nothing" test "$(cli eval 'echo consent_kit_footer_link();')" = ''
cli option update consent_kit --format=json <"$DIR/settings.json"
cli option patch update consent_kit privacyUrl '"><img src=x onerror=alert(1)>'
fetch bad-link "$BASE/"
check "a privacy link that leaves its attribute: nothing emitted, the value nowhere" sh -c "! grep -qE 'data-ck-banner|onerror' '$OUT/bad-link.html'"
cli option update consent_kit --format=json <"$DIR/settings.json"
cli option patch update consent_kit cleanup marketing localStorage '["</script><img src=x onerror=alert(1)>"]' --format=json
fetch hostile "$BASE/"
check "a localStorage key that closes the element: not in the page as written" lacks hostile.html '</script><img src=x onerror=alert(1)>'
check "… and the config block holds it, escaped" php -r 'preg_match("~id=.ck-config.>(.*?)</script>~", file_get_contents($argv[1]), $m); exit(json_decode($m[1], true)["cleanup"]["marketing"]["localStorage"] === [$argv[2]] ? 0 : 1);' "$SAVED/hostile.html" '</script><img src=x onerror=alert(1)>'
check "… and the page keeps the first layer" has hostile.html 'data-ck-banner'

echo "--- the site's own texts (test/texts.json), saved past the settings page"
cli option update consent_kit --format=json <"$DIR/settings.json"
cli option patch insert consent_kit texts "$(cat "$DIR/texts.json")" --format=json
fetch texts "$BASE/"
check "the first layer and the dialog in them: the HTML adapter's bytes (test/texts/banner.html)" contains texts.html "$DIR/texts/banner.html"
check "… no text as written" lacks texts.html '</script><script>alert(1)</script>'
check "… no PHP error, warning, notice or deprecation" quiet texts.html
fetch texts-links "$BASE/?page_id=$links"
check "the reopen link named by the site's dialog title (test/texts/footer-link.html)" has texts-links.html "$(cat "$DIR/texts/footer-link.html")"
cli option patch update consent_kit texts acceptAll ' '
fetch bad-text "$BASE/"
check "a text of spaces only: nothing emitted" sh -c "! grep -qE 'ck-config|data-ck-banner|consent-kit/kit\.' '$OUT/bad-text.html'"
check "… and no PHP error, warning, notice or deprecation (a fatal error emits nothing too)" quiet bad-text.html

echo "--- the settings page (Settings → Consent Kit)"
cli option delete consent_kit
jar="$OUT/admin.cookies"
curl -sS -c "$jar" -o /dev/null "$BASE/wp-login.php"
curl -sS -b "$jar" -c "$jar" -o /dev/null -d log=admin -d "pwd=$PASS" -d testcookie=1 "$BASE/wp-login.php"
fetch settings -b "$jar" "$BASE/wp-admin/options-general.php?page=consent-kit"
check "an admin: the page, its form to options.php with the settings group and its nonce" sh -c "grep -qF 'action=\"options.php\"' '$OUT/settings.html' && grep -qE 'name=.option_page. value=.consent_kit.' '$OUT/settings.html' && grep -qF 'name=\"_wpnonce\"' '$OUT/settings.html'"
check "nothing saved yet: the page says the kit is on no page" has settings.html 'Not set up: the kit is on no page'
check "the Texts section: a field per string, empty, the banner language's sample as its placeholder" has settings.html 'name="consent_kit[texts][acceptAll]" value="" class="large-text" placeholder="Accept all">'
check "… the first-layer text in a text area" has settings.html 'name="consent_kit[texts][text]" rows="5" class="large-text" placeholder="We would like to use cookies'
check "the form: 30 fields, 16 settings and 14 texts" test "$(labels settings.html | wc -l | tr -d ' ')" = 30
check "… no label twice" test -z "$(labels settings.html | sort | uniq -d)"
nonce=$(sed -n 's/.*name="_wpnonce" value="\([0-9a-f]*\)".*/\1/p' "$OUT/settings.html" | head -n 1)
post() { # post <name> <nonce> <privacy URL> [curl arguments…]: the form with test/settings.json's values, as a browser sends it
  post_name="$1"; post_nonce="$2"; post_privacy="$3"; shift 3
  fetch "$post_name" -L -b "$jar" -c "$jar" "$BASE/wp-admin/options.php" \
    --data-urlencode option_page=consent_kit --data-urlencode action=update --data-urlencode "_wpnonce=$post_nonce" \
    --data-urlencode "_wp_http_referer=/wp-admin/options-general.php?page=consent-kit" \
    --data-urlencode "consent_kit[revision]=1" --data-urlencode "consent_kit[cookie]=ck_consent" \
    --data-urlencode "consent_kit[domain]=example.com" \
    --data-urlencode "consent_kit[categories][analytics]=" --data-urlencode "consent_kit[categories][marketing]=" \
    --data-urlencode "consent_kit[cleanup][analytics][cookies]=$(printf '_ga\r\n_ga_*')" \
    --data-urlencode "consent_kit[cleanup][analytics][localStorage]=" \
    --data-urlencode "consent_kit[cleanup][marketing][cookies]=_gcl_*" \
    --data-urlencode "consent_kit[cleanup][marketing][localStorage]=_gcl_ls" \
    --data-urlencode "consent_kit[legacy]=previous-tool-consent" \
    --data-urlencode "consent_kit[endpoint]=https://consent.example.com/v1/record" \
    --data-urlencode "consent_kit[site]=example-site" --data-urlencode "consent_kit[language]=en" \
    --data-urlencode "consent_kit[privacyUrl]=$post_privacy" --data-urlencode "consent_kit[imprintUrl]=/en/imprint/" \
    --data-urlencode "consent_kit[serverCleanup]=1" "$@"
}
stored() { cli eval 'exit(get_option("consent_kit") === json_decode(file_get_contents("/repo/adapters/wordpress/test/settings.json"), true) ? 0 : 1);'; }
post hostile-form "$nonce" '"><img src=x onerror=alert(1)>'
check "an invalid value: the error notice with its message" sh -c "grep -qF \"setting-error-consent_kit\" '$OUT/hostile-form.html' && grep -qF 'Consent Kit: privacyUrl must be an https:// URL' '$OUT/hostile-form.html'"
check "… the value in it HTML-escaped, nowhere as written" sh -c "grep -qF '&lt;img src=x onerror=alert(1)&gt;' '$OUT/hostile-form.html' && ! grep -qF '<img src=x onerror=alert(1)>' '$OUT/hostile-form.html'"
check "… the form keeps the posted values, escaped" has hostile-form.html 'name="consent_kit[privacyUrl]" value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'
check "… and nothing saved" sh -c "! docker compose -f '$DIR/compose.yaml' run --rm -T cli wp option get consent_kit"
post saved "$nonce" /en/privacy/
check "valid values: Settings saved." has saved.html 'Settings saved.'
check "… stored as test/settings.json, exactly (a first save: WordPress sanitizes it twice)" stored
check "… and the page says the kit is on" has saved.html 'On: the kit is in every page that the theme renders with wp_head() and wp_footer().'
fetch settings-cdn -b "$jar" "$BASE/wp-admin/options-general.php?page=consent-kit&consent-kit-cdn"
check "kit.js on another origin (a CDN's plugins_url()): the page says it cannot work" has settings-cdn.html 'On, but not working: kit.js comes from https://cdn.example.com:443, the pages from http://localhost:'
post hostile-again "$nonce" '#'
check "an invalid value over saved settings: the error notice" has hostile-again.html 'Consent Kit: privacyUrl must be an https:// URL'
check "… and the saved settings stay as they were" stored
post esc-form "$nonce" '#a:b'
check "a link esc_url() empties (#a:b): refused with the reason" has esc-form.html 'Consent Kit: privacyUrl &quot;#a:b&quot; is not kept by WordPress&#039;s esc_url(), which writes &quot;&quot;'
check "… and the saved settings stay as they were" stored
post bad-text-form "$nonce" /en/privacy/ --data-urlencode "consent_kit[texts][close]=$(printf '\302\240')"
check "a text of no-break spaces only (kept by PHP's trim()): refused with its message" has bad-text-form.html 'Consent Kit: texts.close must be a non-empty string'
check "… and the saved settings stay as they were" stored
post text-form "$nonce" /en/privacy/ --data-urlencode 'consent_kit[texts][acceptAll]= Allow "all" & go ' --data-urlencode 'consent_kit[texts][close]='
check "a text of its own: saved, trimmed, after the other settings; an empty one left out" cli eval 'exit(get_option("consent_kit") === json_decode(file_get_contents("/repo/adapters/wordpress/test/settings.json"), true) + ["texts" => ["acceptAll" => "Allow \"all\" & go"]] ? 0 : 1);'
fetch text-page "$BASE/"
check "… in both layers, escaped as the kit escapes it" test "$(grep -cF 'data-ck-action="accept">Allow &quot;all&quot; &amp; go</button>' "$OUT/text-page.html")" = 2
check "… and no PHP error, warning, notice or deprecation" quiet text-page.html
# an entity in a text, as written: esc_attr() keeps one, so the form writes its text fields with htmlspecialchars()
check "esc_attr() keeps an entity as written" test "$(cli eval 'echo esc_attr("Fish &amp; chips");')" = 'Fish &amp; chips'
amp_stored() { cli eval 'exit(get_option("consent_kit")["texts"]["close"] === "Fish &amp; chips" ? 0 : 1);'; }
post amp-form "$nonce" /en/privacy/ --data-urlencode 'consent_kit[texts][close]=Fish &amp; chips'
check "a text with an entity as written (&amp;): stored as written" amp_stored
fetch amp-settings -b "$jar" "$BASE/wp-admin/options-general.php?page=consent-kit"
check "… back in its field encoded once more, so the browser shows it as written" has amp-settings.html 'name="consent_kit[texts][close]" value="Fish &amp;amp; chips"'
shown=$(sed -n 's/.*name="consent_kit\[texts]\[close]" value="\([^"]*\)".*/\1/p' "$OUT/amp-settings.html" | php -r 'echo html_entity_decode(trim(stream_get_contents(STDIN)), ENT_QUOTES | ENT_HTML5, "UTF-8");')
post amp-resave "$nonce" /en/privacy/ --data-urlencode "consent_kit[texts][close]=$shown"
check "… and a save of the form as the browser sends it back keeps it unchanged" amp_stored
post amp-kept "$nonce" '#' --data-urlencode 'consent_kit[texts][close]=Fish &amp; chips'
check "… also in the form kept after an invalid value" has amp-kept.html 'name="consent_kit[texts][close]" value="Fish &amp;amp; chips"'
cli option update consent_kit --format=json <"$DIR/settings.json"
post bad-nonce 0123456789 /en/privacy/
check "a wrong nonce: 403, nothing changed" sh -c "test \"\$(head -n 1 '$OUT/bad-nonce.headers' | cut -d ' ' -f 2)\" = 403"
check "… still test/settings.json" stored
fetch admin-front -b "$jar" "$BASE/"
check "an admin on the front end: the first layer comes before the toolbar" test "$(after admin-front.html '<body ')" = "$(head -n 1 "$HTML/en/banner.html")"
visitor="$OUT/visitor.cookies"
curl -sS -c "$visitor" -o /dev/null "$BASE/wp-login.php"
curl -sS -b "$visitor" -c "$visitor" -o /dev/null -d log=visitor -d "pwd=$PASS" -d testcookie=1 "$BASE/wp-login.php"
fetch visitor-page -b "$visitor" "$BASE/wp-admin/options-general.php?page=consent-kit"
check "a subscriber: the page answers 403" test "$(status visitor-page)" = 403
fetch visitor-post -b "$visitor" "$BASE/wp-admin/options.php" --data-urlencode option_page=consent_kit --data-urlencode action=update --data-urlencode "consent_kit[revision]=5"
check "a subscriber: options.php answers 403, nothing changed" sh -c "test \"\$(head -n 1 '$OUT/visitor-post.headers' | cut -d ' ' -f 2)\" = 403"
check "… still test/settings.json" stored
cli option patch update consent_kit revision 0 --format=json
fetch settings-invalid -b "$jar" "$BASE/wp-admin/options-general.php?page=consent-kit"
check "invalid saved settings: the settings page says why" has settings-invalid.html 'the saved settings are invalid: Consent Kit: revision must be an integer from 1 to 1000000, not 0'

echo "--- links that WordPress's esc_url() would change, saved past the settings page"
check "esc_url(\"#a:b\") is empty" test "$(cli eval 'echo esc_url("#a:b");')" = ''
check "esc_url() drops the braces of https://consent.example.com/v1/{x}" test "$(cli eval 'echo esc_url("https://consent.example.com/v1/{x}");')" = 'https://consent.example.com/v1/x'
esc_case() { # esc_case <setting> <link>: the link saved with WP-CLI, past the settings page
  cli option update consent_kit --format=json <"$DIR/settings.json"
  cli option patch update consent_kit "$1" "$2"
  fetch esc-page "$BASE/"
  check "$1 $2: nothing emitted" sh -c "! grep -qE 'ck-config|data-ck-banner|consent-kit/kit\.' '$OUT/esc-page.html'"
  fetch esc-settings -b "$jar" "$BASE/wp-admin/options-general.php?page=consent-kit"
  check "… and the settings page says why" has esc-settings.html "Off — the saved settings are invalid: Consent Kit: $1 &quot;$2&quot; is not kept by WordPress&#039;s esc_url()"
}
esc_case privacyUrl '#a:b'
esc_case endpoint 'https://consent.example.com/v1/{x}'

echo
if [ "$failed" -eq 0 ]; then echo "WordPress run: every check passed"; else echo "WordPress run: $failed check(s) FAILED"; exit 1; fi
