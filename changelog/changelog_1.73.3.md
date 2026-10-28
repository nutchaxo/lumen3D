## [FIXED]
- **Data updates tab no longer ends in a 500**: on a PHP host the status of every dataset is rebuilt after each update (the row cache is keyed on this file), which could outlast the host's execution time and answer `Could not read the update status (500)`. The status now computes rows within a time budget and answers `partial`; the tab asks again until the list is complete, each call continuing from the cached rows.
- **One unreadable dataset cannot break the list**: an error while reading a single dataset is reported on its own row (`status_failed`) instead of failing the whole answer.

## [OPTIMIZED]
- **Faster status signature**: each path of the cache signature is read with a single `stat()` instead of four filesystem calls, which is the dominant cost on a slow shared disk.
