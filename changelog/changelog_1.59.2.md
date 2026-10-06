# Changelog v1.59.2 (Web Platform)

## [CHANGED]

- **Data updates never flood the host**: every request of the Data updates tab and of its workers now goes through one network governor per page — at most 6 requests in flight, 10 to 16 per second — which halves its pace and pauses for a few seconds (up to a minute) as soon as the host stops answering or answers 429/503. In 1.59.1 a shared host's firewall banned the operator's address after a run: the two pools, one request per stored brick and an unthrottled speed test sent tens of connections and over 40 requests per second. The tab says when requests are being held back.
- **Stored bricks read in batches**: the browser reads the level-k bricks a brick-pyramid unit needs in requests of up to 128 (`store_get_many`, Python and PHP) instead of one request per brick — about 1 000 requests per unit before. A server without the action is read the old way.
- **Gentler speed test**: the browser converts batches of 8 test blocks, downloaded in one request and uploaded in one, under the same governor; each side's score is its throughput up to its last finished batch.

## [FIXED]

- **Data updates no longer double the load on the host**: in 1.59.1 each executor queue had its own pool of browser workers, so a server-queue step the server cannot run (e.g. the v3 brick pyramid on a PHP host without lossless WebP encoding) ran in a second pool beside the browser queue's — twice the units and requests in flight against the host, enough to make a shared host drop connections. Every browser-run step now goes through one shared pool, as before 1.59.1; pausing or cancelling a dataset aborts only that dataset's units.
- **"Connection lost" stuck on screen**: the message is now cleared when the last waiting request gets through or is aborted, and is computed per source (the shared pool, each queue), so one recovering source no longer hides or shows another's state.
