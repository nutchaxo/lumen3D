# Changelog 1.72.2

## [FIXED]
- **Failed data update restarts by itself**: a job that failed (a crashed worker, a unit that kept failing, a lost link) was left in "Failed" until Retry was clicked, so a long conversion of a large dataset stopped for good. The runner now restarts it from the journal after 10 s, 30 s, 1 min, 2 min, 5 min, and gives up only after five failures in a row without a single new unit finished. Unit timeouts, missing executors and failed preparations stay final.
- **Last error stays visible**: the "Failed" line of a dataset shows the browser's own error when the server journal has none, and every automatic restart is written to the history.
