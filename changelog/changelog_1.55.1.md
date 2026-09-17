# Changelog v1.55.1 (Web Platform)

## [FIXED]

- **Z-Stack Browser 1.1.3 could be installed on a platform that ignores its view-side request**: the plugin asks for the −Z face with `setView('xy', { side: 'back' })` (v1.54.2), but its manifest still declared `platformCompat: ">=1.52.0"`. On a host whose core is older than v1.54.2, `ctx.viewer.setView` drops the option and the stack is shown from the +Z face as before — the very orientation the update was meant to correct — with no error and no hint. The plugin now declares `>=1.54.2` (`zstack-browser` 1.1.4, marketplace package re-packaged and signed): a host that has not updated its platform sees the plugin update as *Requires a newer platform* instead of installing something that cannot work there. Nothing changes for a host already at v1.54.2 or later.
