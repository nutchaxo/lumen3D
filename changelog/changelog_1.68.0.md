# Changelog v1.68.0 (Web Platform)

## [OPTIMIZED]

- **Faster format-5 conversion in the browser**: a worker now takes up to 16 units at once. It asks for all their inputs in one request (`unit_inputs_many`), reads each byte run of the batch only once, and sends the results back together (`unit_put_many`), so the server writes its journal once per batch instead of once per unit. That is about 0.3 requests per unit instead of three, so the request quota no longer holds the conversion back, and the browser's CPU is actually put to work. On a test volume of 600 × 500 × 80 with two channels on a PHP server, 298 units converted in about 90 s with 87 requests, against about 100 units per minute before. The result is identical to the server executor's: lossless columns, plane and cut stores exactly, lossy columns within their bounds.
- **More workers on a capable machine**: the Data updates tab now runs up to four conversion workers (two with less than 8 GB of memory, never more than half the processor cores) instead of two. Every request still goes through the page's network governor (≤ 6 in flight, ≤ 6 per second).

## [FIXED]

- **Conversion paused with "HTTP 200" on a PHP host**: PHP refuses a request body larger than its `post_max_size` (8 MB by default) before the platform's code runs, and the answer still says 200. A level-0 unit of a large dataset is bigger than that, so the job retried, then paused. The PHP server now announces the real limit (`maxUnitBody`: the smaller of 32 MiB and `post_max_size` minus 64 KiB). The workers keep every request below it, and a unit result larger than the limit is sent in pieces (`unit_put_part`), then stored once the last piece arrives.

## [ADDED]

- **Tests**: `tests/test_format5_batches.py` runs a whole job of batches and pieces on both servers: the Python tree equals the server executor's and the PHP tree is byte-identical to it. It also covers the refusals, the stage-A rule within a batch and the announced limit. `tests/js/test_mig_worker_batches.mjs` checks that no request goes over the limit, that pieces are contiguous, that shared runs are read once and that a server without batches falls back.
