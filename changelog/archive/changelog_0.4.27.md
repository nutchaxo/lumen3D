# Changelog 0.4.27

## [FIXED]
- Fixed ChannelPanel modifications being ignored in Compare Studio mode. Deep-cloning logic (`JSON.parse(JSON.stringify)`) previously stripped out critical HTML `iframe` references from `layoutMaps`, causing the GPU slicer context to be lost when applying channel updates.
- Fixed ChannelPanel state resetting when switching between dataset views in Compare Studio mode. The initialization logic now correctly reads and applies the existing `channelState` object properties instead of forcibly overwriting them with default values.
