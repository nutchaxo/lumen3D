# Changelog v1.69.1 (Web Platform)

## [CHANGED]

- **Data updates progress starts at 0 %**: a conversion used to open at about 30 %. Its units with no data under them (the background around the sample, regions of a channel without signal) have nothing to compute and count as done from the start. The bar and the unit counts now cover only the real work and start at 0 %. Those empty units are listed beside them, e.g. "96 without data, already done".

## [FIXED]

- **Dataset size hidden once its update started**: the size in MB of a dataset disappeared from its row as soon as a job existed for it. The row now keeps it while the job runs or is paused, with what is left of it, e.g. "163 MB (84.3 MB left)". The size is written with the decimal separator of the interface language.

## [ADDED]

- **Tests**: `tests/js/test_mig_work_progress.mjs` checks the progress counts without the empty units, the bounds, and the new strings in every locale.
