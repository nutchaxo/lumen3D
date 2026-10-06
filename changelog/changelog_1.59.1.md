# Changelog v1.59.1 (Web Platform)

## [ADDED]

- **Speed test in Data updates**: one button, no setting, no dataset: for 5 seconds the browser and the server convert the same synthetic test block (a 64³ brick shipped with the platform) at the same time, and two progress bars race to a score. The browser's blocks include the download and the upload, as in a real update. The winner becomes the default executor of every dataset. Server actions `speedtest` and `speedtest_put` (Python and PHP twins).
- **Executor per dataset, run in parallel**: each dataset has its own *This browser / The server* switch, chosen before it starts and locked while it runs. Each executor has its own queue, so a dataset on the browser and another on the server are converted at the same time. A step the chosen executor cannot run goes to the other one, in order.
- **Admin sidebar categories**: the tabs are grouped under *Data*, *Public site*, *Extensions* and *System*, and the top bar shows the category before the tab name.

## [CHANGED]

- **Data updates tab redesigned**: one card per dataset with its steps, its executor, its actions and a live progress bar (step, %, rate, time left); datasets already up to date, the data formats and the history fold away. The per-migration executor table, the benchmark settings (dataset, unit count) and the growing estimate table are gone.
- **No executor switch mid-run**: a running or queued dataset keeps its executor; it can be changed between runs (the server journal lets the other executor resume a paused job).
- **One toast per dataset**: a dataset updated through several steps announces itself once, when its last step lands.

## [FIXED]

- **User name not saved by the browser**: the admin sign-in fields now sit in a real form with named `username` / `current-password` fields, so Chrome's password manager stores and fills the user name along with the password.
