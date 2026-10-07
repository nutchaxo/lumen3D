# Changelog v1.59.3 (Web Platform)

## [OPTIMIZED]

- **Eight times fewer requests during data updates**: a unit converted in the browser now reads all its input byte runs in one request (`read_ranges`, Python and PHP) instead of one request per run — a layer projection used to read its 64 plane tiles one by one, a planes or v3 pyramid unit dozens of pack runs. Measured on the test pair of datasets: 424 requests instead of 3 443, about 3.7 per second instead of 8, and the conversion four times faster (115 s instead of 436 s). A server without the action is read the old way.
- **Lower request ceiling**: with the inputs grouped, the network governor of the Data updates tab now starts at 4 requests per second and never goes above 6 (10–16 in 1.59.2), still halving its pace and pausing when the host stops answering.
- **Speed test in batches of 16**: the browser side downloads and uploads 16 test blocks per request pair, so the lower ceiling does not hold its score back.
