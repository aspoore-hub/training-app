# Architecture Rules

## 1. Purpose
This document defines strict data-path rules for the app.
The goal is simple: one clear source of truth per domain, and one approved way to read/write that domain.

## 2. Core Rule: One Approved Read/Write Path Per Domain
For each domain, use only the approved module path.
Do not add alternate paths for the same domain data.
If a second path appears, remove it or route it back through the approved path.

## 3. Auth and Team Identity
Source of truth:
- Supabase auth
- `profiles`
- `teams`
- `team_members`
- `team_invites`

Approved modules:
- `lib/supabase.ts`
- `lib/profile.ts`
- `lib/team.ts`

## 4. Roster Domain
Source of truth:
- `team_athletes`

Approved path:
- `lib/teamDataStore.ts`
- `lib/team.ts`
- `lib/teamRoster.ts`

Rule:
- Do **not** reintroduce `lib/roster.ts` as an active runtime data path.

## 5. Workout Domain
Source of truth:
- `team_workouts`

Approved path:
- `lib/teamWorkoutsCloud.ts`

Rule:
- Screens must **not** call `supabase.from("team_workouts")` directly.
- Screens must use `lib/teamWorkoutsCloud.ts` helpers.

## 6. Mileage Domain
Source of truth:
- `team_mileage_cells`
- `team_mileage_day_flags`

Approved path:
- `lib/mileageCloud.ts`
- `lib/teamDataStore.ts`

Rule:
- Do **not** reintroduce legacy mileage-plan key storage as source of truth.

## 7. Planner Domain
Planner must compose data through approved paths:
- Roster from `teamDataStore`
- Mileage from `teamDataStore`
- Workouts via `lib/teamWorkoutsCloud.ts`
- Settings via `lib/settings.ts`

## 8. Settings Domain
Approved path:
- `lib/settings.ts`

Rule:
- Settings read/write logic should flow through `lib/settings.ts`, not ad-hoc key handling in screens.

## 9. Stores
- `teamDataStore` is the active shared store.
- Do **not** reintroduce `teamStore`.

## 10. Direct Supabase Query Policy
Direct Supabase queries are allowed only inside approved domain modules.
Screens should call domain helpers/stores, not raw table queries.

## 11. Before Adding New Data Logic
Ask these 5 questions first:
1. What is the exact source-of-truth table/key for this data?
2. Which approved module already owns this domain?
3. Am I adding a second read/write path by mistake?
4. Can I extend the approved module instead of querying in a screen?
5. Does this change keep existing screens on one shared path?

If any answer is unclear, stop and resolve it before coding.

## 12. UI State vs Domain State
UI state is local and temporary (open/closed panels, selected tab, input focus, draft text).
Domain state is shared and persistent (roster/workouts/mileage/settings).
Do not store domain truth only in component state.

## 13. Refactor Priority Order
When cleaning architecture, use this order:
1. Remove duplicate runtime data paths
2. Route screens to approved helpers/stores
3. Remove dead compatibility code
4. Remove dead keys/migrations
5. Delete deprecated files last

## 14. Non-Negotiable Rule
Never introduce a second source of truth for a domain.
If a feature needs data, it must use that domain’s approved path.
