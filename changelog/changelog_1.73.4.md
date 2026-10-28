# Changelog 1.73.4

## [ADDED]
- **Recheck button in Data integrity**: every dataset with a warning or an error gets a *Recheck* button that runs the check of that one dataset again, in place, without re-running the whole table.
- **How to fix each finding**: each finding now says what to do about it (re-import, Data updates, edit the gallery, delete the leftovers…), in the four languages.

## [FIXED]
- **"The check itself failed — no answer"**: a failed check now reports why: the HTTP status and the start of the body, or on PHP hosts the fatal error itself (memory or time limit, with the limits in force). The check also asks PHP for 1 GiB and 300 s before reading a large timelapse manifest.
