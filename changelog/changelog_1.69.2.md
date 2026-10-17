# Changelog v1.69.2 (Web Platform)

## [FIXED]

- **Several admin tabs converting at once**: each tab of the admin panel had its own request limits, so three tabs converting three datasets sent three times the requests a shared host tolerates (the kind of burst that got the operator's address banned in 1.59.1). The tabs of one browser now share one quota: while several of them convert, each takes its part of the limits (requests in flight, requests per second), and a tab whose host stops answering or asks it to slow down makes every other tab wait as well.
- **One dataset converted in two tabs**: two tabs could run the same dataset, computing every unit twice. A dataset is now taken by one tab only (a browser lock, released when the tab closes). Another tab shows it as *In another tab*, without buttons, and leaves it out of *Update all*. A paused or finished conversion releases the dataset, so another tab can pick it up.

## [ADDED]

- **Shared quota notice**: while several tabs of the browser convert datasets, the Data updates tab says how many share the request quota.
- **Tests**: `tests/js/test_mig_tabs.mjs` simulates several tabs of one browser. It checks the split quota, the shared cooldown, one tab per dataset with and without browser locks, and that the runner skips a dataset held by another tab and releases its own.
