# Changelog v1.60.2 (Web Platform)

## [FIXED]

- **Data updates history no longer stops at 20**: the History list of the Data updates tab kept only its 20 latest entries, and every finished step adds one (two per dataset for 2 → 3 → 4), so after ten datasets its count stayed at 20 while new conversions kept landing — which read as the same dataset being converted again. It now keeps 1 000 entries, a whole catalogue.

## [CHANGED]

- **Each executor names what it converts**: the lane strip of the Data updates tab shows, beside *converting*, the dataset in progress and its step (*step 2 of 2*), so the next dataset of the queue is no longer mistaken for the one just finished.
