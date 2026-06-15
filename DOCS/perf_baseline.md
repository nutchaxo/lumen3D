# Phase 0 - Baseline Performance (2026-04-28)

## Scope
Baseline collectee avec `preprocess/browser_qa.py` + `PerfTelemetry` sur 2 profils:

1. Desktop non throttle (`--profile desktop --scenario full`)
2. Mobile throttle CPU/reseau (`--profile mobile-throttled --scenario viewer-only`)

Artefacts:

- [`DOCS/perf_baseline_2026-04-28_desktop.json`](perf_baseline_2026-04-28_desktop.json)
- [`DOCS/perf_baseline_2026-04-28_mobile-throttled.json`](perf_baseline_2026-04-28_mobile-throttled.json)

## Profils de bench

- Desktop:
  - CPU throttle: `x1`
  - Network: `unlimited`
- Mobile throttled:
  - Viewport: `390x844@3x`
  - CPU throttle: `x4`
  - Network: `180 ms`, `1800 kbps down`, `768 kbps up`

## Resultats fonctionnels

- Desktop full suite:
  - pages `index/explorer/compare/about`: OK
  - viewer fixed: rendu non vide + slice native OK
  - compare: 2 panels actifs
  - tracking: chargement OK
- Mobile throttled viewer-only:
  - viewer ready: OK
  - preview + native slice: OK
  - studio open + layers: OK

## Telemetry - Desktop (viewer)

| Operation | Count | Min (ms) | P50 (ms) | P95 (ms) | Max (ms) | Avg (ms) |
|---|---:|---:|---:|---:|---:|---:|
| `viewer.init` | 1 | 1953.9 | 1953.9 | 1953.9 | 1953.9 | 1953.9 |
| `viewer.timepoint.load` | 1 | 1899.8 | 1899.8 | 1899.8 | 1899.8 | 1899.8 |
| `volume.load.slices` | 1 | 1898.9 | 1898.9 | 1898.9 | 1898.9 | 1898.9 |
| `volume.load.bricks` | 2 | 5.6 | 5.6 | 5.6 | 7.6 | 6.60 |
| `texture.upload.prepare` | 3 | 0.0 | 0.1 | 0.1 | 0.1 | 0.07 |
| `image.fetch.decode` | 222 | 4.2 | 154.9 | 471.4 | 709.1 | 143.87 |
| `slice.preview.render` | 3 | 534.5 | 2515.4 | 2515.4 | 2632.2 | 1894.03 |
| `slice.native.render` | 1 | 545.7 | 545.7 | 545.7 | 545.7 | 545.7 |

## Telemetry - Mobile throttled (viewer)

| Operation | Count | Min (ms) | P50 (ms) | P95 (ms) | Max (ms) | Avg (ms) |
|---|---:|---:|---:|---:|---:|---:|
| `viewer.init` | 1 | 8408.1 | 8408.1 | 8408.1 | 8408.1 | 8408.1 |
| `viewer.timepoint.load` | 1 | 6829.2 | 6829.2 | 6829.2 | 6829.2 | 6829.2 |
| `volume.load.slices` | 1 | 6818.7 | 6818.7 | 6818.7 | 6818.7 | 6818.7 |
| `volume.load.bricks` | 2 | 36.8 | 36.8 | 36.8 | 203.7 | 120.25 |
| `texture.upload.prepare` | 3 | 0.7 | 1.1 | 1.1 | 1.3 | 1.03 |
| `image.fetch.decode` | 212 | 253.8 | 340.9 | 1497.9 | 1988.9 | 443.22 |
| `slice.preview.render` | 3 | 502.8 | 575.5 | 575.5 | 10119.5 | 3732.60 |
| `slice.native.render` | 1 | 1169.7 | 1169.7 | 1169.7 | 1169.7 | 1169.7 |

## Phase 0 status

Phase 0 est complete:

1. Telemetry JSON par session en place.
2. Bench standardises desktop + mobile throttled en place.
3. Rapport baseline versionne dans `DOCS/`.
