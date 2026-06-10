# Changelog

All notable changes to hcs-sync will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

## [0.2.4] - 2026-06-10

### Fixed
- `pullSingleEntity`: fixed "Cannot convert undefined or null to object" crash on Pull & Sync — `update.$set` was undefined because `buildUpsertUpdate` returns an aggregation pipeline array; corrected to `update[0].$set`.

## [0.2.3] - 2026-06-10

Initial changelog entry. Version reflects the state of the codebase at this point.
