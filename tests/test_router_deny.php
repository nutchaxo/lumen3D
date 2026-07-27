<?php
/**
 * router.php deny-list path normalisation (php -S twin of api/.htaccess).
 *
 * Regression: the router derived its path with parse_url(REQUEST_URI, PHP_URL_PATH).
 * A request starting with two slashes makes parse_url read the first segment as an
 * AUTHORITY — '//api/admin_credential.json' returned host='api', path='/admin_credential.json',
 * matching no deny rule — while `php -S` collapsed the slashes and served the real
 * file. The PBKDF2 credential hash went out with a 200. Three slashes were worse:
 * parse_url returned false and every rule saw an empty path.
 *
 * Run: php tests/test_router_deny.php
 */
declare(strict_types=1);

/** The exact normalisation router.php applies before matching. Keep in sync. */
function router_normalise(string $requestUri): string {
    $path = explode('?', $requestUri, 2)[0];
    $path = urldecode($path);
    $path = preg_replace('#/+#', '/', $path);
    $segs = [];
    foreach (explode('/', $path) as $s) {
        if ($s === '' || $s === '.') continue;
        if ($s === '..') { array_pop($segs); continue; }
        $segs[] = $s;
    }
    return '/' . implode('/', $segs);
}

/** The exact deny predicate router.php applies. Keep in sync. */
function router_denied(string $path): bool {
    return (bool)(preg_match('#^/api/.*\.json$#i', $path)
        || preg_match('#^/api/_[A-Za-z0-9_]+\.php$#i', $path)
        || preg_match('#^/api/config\.php$#i', $path)
        || preg_match('#^/(secrets|logs|backups|\.git)(/|$)#i', $path));
}

$fails = 0;
function check(string $uri, bool $want, string $why): void {
    global $fails;
    $got = router_denied(router_normalise($uri));
    if ($got !== $want) {
        $fails++;
        printf("FAIL %-42s got %s want %s  (%s)\n", $uri, var_export($got, true), var_export($want, true), $why);
    } else {
        printf("ok   %-42s %s\n", $uri, $want ? 'denied' : 'served');
    }
}

// Must be denied — every slash/encoding variant reaching the same file.
check('/api/admin_credential.json',        true,  'direct');
check('//api/admin_credential.json',       true,  'double slash: the parse_url authority bug');
check('///api/stats.json',                 true,  'triple slash: parse_url returned false');
check('////api/plugin-trust.json',         true,  'quadruple slash');
check('/./api/admin_credential.json',      true,  'dot segment');
check('/x/../api/admin_credential.json',   true,  'traversal');
check('/api%2fadmin_credential.json',      true,  'encoded separator');
check('/api/page-drafts/home.json',        true,  'unpublished drafts (subdirectory)');
check('//api/page-drafts/home.json',       true,  'drafts + double slash');
check('/api/_admin_lib.php',               true,  'shared include');
check('/api/config.php',                   true,  'legacy config');
check('/secrets/marketplace-signing-seed.hex', true, 'Ed25519 signing seed');
check('//secrets/marketplace-signing-seed.hex', true, 'seed + double slash');
check('/logs/dev-server.log',              true,  'logs');
check('/.git/config',                      true,  'VCS metadata');
check('/api/admin_credential.json?x=1',    true,  'query string stripped, not matched');

// Must still be served — the real API routes and ordinary assets.
check('/api/auth.php',                     false, 'auth route');
check('/api/datasets.php',                 false, 'datasets route');
check('/api/plugins.php',                  false, 'plugins route');
check('/api/catalog.php',                  false, 'catalog route');
check('/index.html',                       false, 'page');
check('/js/core/utils.js',                 false, 'asset');
check('/DATA_WEB/fixed/x/metadata.json',   false, 'dataset metadata is public');
check('/config/pages/home.json',           false, 'published page doc is public');
check('/apiclient.js',                     false, 'not under api/ despite the prefix');

if ($fails > 0) { printf("\n%d failure(s)\n", $fails); exit(1); }
echo "\nAll router deny-list checks passed.\n";
