# Changelog v1.59.2 (Web Platform)

## [FIXED]

- **Data updates no longer double the load on the host**: in 1.59.1 each executor queue had its own pool of browser workers, so a server-queue step the server cannot run (e.g. the v3 brick pyramid on a PHP host without lossless WebP encoding) ran in a second pool beside the browser queue's — twice the units and requests in flight against the host, enough to make a shared host drop connections. Every browser-run step now goes through one shared pool, as before 1.59.1; pausing or cancelling a dataset aborts only that dataset's units.
- **"Connection lost" stuck on screen**: the message is now cleared when the last waiting request gets through or is aborted, and is computed per source (the shared pool, each queue), so one recovering source no longer hides or shows another's state.
