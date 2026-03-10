# Settings Truth Map Debug (2026-03-06)

## 1) Actual active Settings page
- File: `app/(coach)/(tabs)/settings.tsx`
- Route: coach tabs `settings` screen from `app/(coach)/(tabs)/_layout.tsx`

## 2) Active settings read path (visible Settings UI)
- `app/(coach)/(tabs)/settings.tsx` calls:
  - `loadCoachSettings()` from `lib/settings.ts`
  - `loadPracticeTimeDefaults()` from `lib/practiceDefaults.ts` (same storage key family)
- `lib/settings.ts` reads keys via `loadJSON(...)` from `lib/storage.ts`:
  - `training_app_categories_v1`
  - `training_app_default_practice_times_v1`
  - `training_app_distance_unit_v1`
- For team keys, `lib/storage.ts` routes to `loadJSONWithTeamCloudSync(...)` in `lib/teamCloudSync.ts`.
- Team cloud table: `team_kv_blobs`.

## 3) Active settings write path (visible Settings UI)
- Distance unit and categories:
  - `saveCoachSettings(...)` in `lib/settings.ts`
  - writes same keys listed above via `saveJSON(...)` -> `saveJSONWithTeamCloudSync(...)` -> `team_kv_blobs`
- Practice defaults:
  - `savePracticeTimeDefaults(...)` in `lib/practiceDefaults.ts`
  - writes `training_app_default_practice_times_v1` via `saveJSON(...)` -> `saveJSONWithTeamCloudSync(...)` -> `team_kv_blobs`

## 4) Duplicate/legacy/conflicting settings paths found
- Legacy user-scoped blob path exists in app:
  - `loadJSONWithCloudSync/saveJSONWithCloudSync` in `lib/cloudSync.ts`
  - table: `kv_blobs`
- Current settings keys are marked as team keys in `lib/syncKeys.ts`, so active settings now read/write team scope (`team_kv_blobs`).

## 5) Root mismatch identified
- Existing settings may appear lost when they still exist in legacy user-scoped `kv_blobs` but current UI only reads team-scoped `team_kv_blobs`.
- This creates a load mismatch after migration to team-key routing.

## 6) Fix applied in this pass
- Kept authoritative source as team settings path (`team_kv_blobs`) for save.
- Added read fallback in `lib/settings.ts`:
  - If no authoritative team-key settings are present, attempt legacy read from `kv_blobs` for the same keys.
  - This restores existing values without introducing a new source of truth.
- Added visible Settings debug panel and console logs on active settings page:
  - load source, save source, loaded counts, last save status/error
  - load/save payload and result/error logging
