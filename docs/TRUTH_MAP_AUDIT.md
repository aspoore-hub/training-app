# Truth Map Audit (Current)

Date: 2026-03-06

This file documents the **current authoritative source** for each major domain and the surviving read/write paths.

## Roster
- Authoritative storage: Supabase table `team_athletes`
- Authoritative read path:
  - `lib/teamRoster.ts` (`loadTeamRoster`, `getSortableRoster`, `getRosterMapById`)
- Authoritative write path:
  - `lib/team.ts` (`createTeamAthlete`, `updateTeamAthlete`, `deleteTeamAthlete`)
  - `lib/teamStore.ts` / `lib/teamDataStore.ts` actions write to `team_athletes`
- Duplicate/conflicting paths removed/bypassed:
  - `app/(coach)/(tabs)/settings.tsx` no longer uses `lib/roster.ts` local roster store
- Notes:
  - `lib/roster.ts` remains legacy/local compatibility and is not authoritative.

## Workouts
- Authoritative storage: Supabase table `team_workouts`
- Authoritative read/write path:
  - `lib/teamWorkoutsCloud.ts`
- Duplicate/conflicting paths removed:
  - Deleted `lib/workouts.ts`
  - Deleted `lib/workoutsLegacy.ts`
  - Deleted temporary wrapper `lib/data/workouts.ts`

## Mileage
- Authoritative storage: Supabase tables
  - `team_mileage_cells`
  - `team_mileage_day_flags`
- Authoritative read/write path:
  - `lib/mileageCloud.ts`
- Duplicate/conflicting paths removed:
  - Deleted temporary wrapper `lib/data/mileage.ts`
- Notes:
  - `MILEAGE_PLANS_KEY` in storage is a separate planning artifact, not the workout feedback mileage tables.

## Settings
- Authoritative storage: existing synced settings keys managed by:
  - `lib/settings.ts`
  - backing sync tables: `kv_blobs`, `team_kv_blobs`
- Authoritative read/write path:
  - `loadCoachSettings`, `saveCoachSettings` in `lib/settings.ts`
- Duplicate/conflicting paths removed:
  - Deleted temporary wrapper `lib/data/settings.ts`

## Templates
- Authoritative storage: synced local key
  - `WORKOUT_TEMPLATES_KEY` in `lib/workoutTemplates.ts`
  - backing sync tables: `kv_blobs`, `team_kv_blobs`
- Authoritative read/write path:
  - `loadWorkoutTemplates`, `createWorkoutTemplate*`, `updateWorkoutTemplate`, `deleteWorkoutTemplate`
- Duplicate/conflicting paths removed:
  - Deleted temporary wrapper `lib/data/templates.ts`

## Guessed/Conceptual Schema Names
- Audit result: no Supabase `.from(...)` calls reference guessed/nonexistent table names.
- Current table names in use are limited to:
  - `team_athletes`
  - `team_workouts`
  - `team_mileage_cells`
  - `team_mileage_day_flags`
  - `team_members`
  - `team_invites`
  - `teams`
  - `profiles`
  - `kv_blobs`
  - `team_kv_blobs`
