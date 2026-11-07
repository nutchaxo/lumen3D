<?php
/**
 * Lumen3D — PHP error safety net (shared prelude of every PHP entry point)
 * =======================================================================
 * Twin of what dev_server.py:_guarded gives the Python side: whatever goes wrong inside
 * an endpoint, the client gets a clean answer and the operator gets a log line.
 *
 *  - display_errors is forced off (log_errors on): a warning or deprecation on a host
 *    configured with display_errors=On used to land INSIDE a JSON body, which the admin
 *    then reported as "unable to load". No error handler is installed, so @-suppression
 *    and every existing control flow stay exactly as they were: this only decides where
 *    the message goes (the log, never the response).
 *  - an uncaught exception / TypeError, and a fatal (memory, time, compile), answer
 *    HTTP 500 {"error":"internal_error"} when nothing has been sent yet (a plain
 *    "Internal Server Error" text for an HTML page). Paths and exception text only go to
 *    the log. When bytes are already on the wire the response is left as it is.
 *  - the fatal pass runs after every shutdown function the endpoint registered itself
 *    (api/integrity.php answers a fatal of its own `check` action), and an endpoint
 *    that answered a fatal sets $GLOBALS['lumen_fatal_answered'] so it is not overridden.
 *
 * The command line is left alone (a test or a tool must see its own errors), unless
 * LUMEN_SAFETY_NET_FORCE is defined. LUMEN_SAFETY_NET_MODE ('json' | 'text') overrides the
 * answer shape, which is otherwise JSON for anything under /api/ or answering JSON.
 *
 * Include with require_once; this file only installs hooks and prints nothing. Leading
 * underscore => denied over HTTP by api/.htaccess and router.php.
 */
declare(strict_types=1);

if (!defined('LUMEN_SAFETY_NET')) {
    define('LUMEN_SAFETY_NET', true);

    function lumen_safety_net_wants_json(): bool {
        if (defined('LUMEN_SAFETY_NET_MODE')) return LUMEN_SAFETY_NET_MODE === 'json';
        $uri  = (string)(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '');
        $path = explode('?', $uri, 2)[0];
        if (strpos($path, '/api/') !== false || substr($path, -5) === '.json') return true;
        foreach (headers_list() as $h) {
            if (stripos($h, 'content-type:') === 0 && stripos($h, 'json') !== false) return true;
        }
        return false;
    }

    /** One log line, no newlines, never to the client. */
    function lumen_safety_net_log(string $what): void {
        @error_log('[lumen] ' . str_replace(["\r", "\n"], ' ', $what));
    }

    /** Replace whatever was prepared with a 500 — only while nothing has been sent. */
    function lumen_safety_net_answer(): void {
        if (headers_sent()) return;
        while (ob_get_level() > 0) @ob_end_clean();
        foreach (['Content-Length', 'Content-Disposition', 'Content-Encoding', 'Content-Range', 'Location', 'Content-Type'] as $h) {
            @header_remove($h);
        }
        @http_response_code(500);
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        if (lumen_safety_net_wants_json()) {
            header('Content-Type: application/json; charset=utf-8');
            echo '{"error":"internal_error"}';
        } else {
            header('Content-Type: text/plain; charset=utf-8');
            echo 'Internal Server Error';
        }
    }

    function lumen_safety_net_fatal_pass(): void {
        unset($GLOBALS['lumen_net_reserve']);   // memory for the handler itself after an out-of-memory fatal
        try {
            $e = error_get_last();
            $fatal = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR];
            if (!$e || !in_array($e['type'], $fatal, true)) return;
            if (!empty($GLOBALS['lumen_fatal_answered'])) return;
            lumen_safety_net_log('fatal: ' . $e['message'] . ' in ' . $e['file'] . ':' . $e['line']);
            lumen_safety_net_answer();
        } catch (Throwable $t) {
            // nothing sensible left to do while shutting down
        }
    }

    function lumen_safety_net_install(): void {
        @ini_set('display_errors', '0');
        @ini_set('display_startup_errors', '0');
        @ini_set('html_errors', '0');
        @ini_set('log_errors', '1');

        $GLOBALS['lumen_net_reserve'] = str_repeat('x', 65536);

        set_exception_handler(function ($e) {
            try {
                lumen_safety_net_log('uncaught ' . get_class($e) . ': ' . $e->getMessage()
                    . ' in ' . $e->getFile() . ':' . $e->getLine());
                lumen_safety_net_answer();
            } catch (Throwable $t) {
                // already failing; the process ends right after this handler
            }
        });
        // Registered from inside a shutdown function: PHP runs it after the ones queued so far.
        register_shutdown_function(function () {
            register_shutdown_function('lumen_safety_net_fatal_pass');
        });
    }

    if (PHP_SAPI !== 'cli' || defined('LUMEN_SAFETY_NET_FORCE')) lumen_safety_net_install();
}
