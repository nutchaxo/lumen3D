# Changelog v1.55.6 (Web Platform)

## [CHANGED]

- **The Studio loads the native slice directly again**: the intermediate stages of v1.55.5 (a 1024 then a 2048 picture before native) are gone — for someone who wants the native picture they only added a quarter of the bytes and of the waiting time, and the preview already stands in while the native chunks land. *Open in Studio* now runs one native pass, as before v1.55.5, with what v1.55.5 brought kept: the byte-range fetching of the packs a cut needs only part of, the progress bar with chunks, megabytes and time left, and *Stop here* keeping the picture as it is. `_renderNativeSliceForStudio` still accepts a `lod`, unused by the page.
- **Tests**: `tests/js/test_studio_lod_ladder.mjs` removed with the ladder.
