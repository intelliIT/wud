---
title: Next (Unreleased)
description: Unreleased changes and upcoming features in WUD (What's Up Docker?).
---

# Next (Unreleased)

> Changes below are merged on `main` and will be included in the upcoming release.

- ✨ [UI] Containers page warns (⚠ + creation date) when the running image is older than one year (disable with `WUD_SERVER_FEATURE_IMAGEAGE=false`)
- ✨ [EOL] Show whether the running version is end of life: endoflife.date lookup (`WUD_EOL_ENABLED`, `wud.eol.product`) and label policies (`wud.eol.policy=latest-minor`, `latest-n-major:3`, …); EOL badge, filter and details on the Containers page
- ✨ [WATCHER] Report the best available update per semver kind (`result.candidates`: major / minor / patch); the Containers page shows them next to the main update (e.g. a patch release besides a minor one)
- ✨ [UI] Update kind filter on the Containers page now supports selecting several kinds at once (e.g. patch + minor)
- 🐛 [WATCHER] Fix cool-down delay ignored for tag updates when digest watching is disabled (#1543)
- 🐛 [WATCHER] Populate candidate digest on SemVer updates when digest watching is disabled (fixes #1542)

---
