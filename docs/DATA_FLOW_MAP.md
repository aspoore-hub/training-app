# Data Flow Map

## 1. Sign In
### Purpose
Authenticate users and route them into coach or athlete app flows.

### What it displays
- Email/password login form
- Account creation flow
- Role selection when needed
- Invite claim flow (`join`)

### Reads from
- `lib/supabase.ts` auth session
- `lib/profile.ts` (`profiles`)
- `lib/team.ts` (`profiles`, `teams`, `team_members`, `team_invites`)

### Writes to
- `profiles` (role/current team via `lib/profile.ts` / `lib/team.ts`)
- `teams` and `team_members` (coach setup via `lib/team.ts`)
- `team_invites` / invite claim RPC path (`lib/team.ts`)
- Local key: `training_app_selected_athlete_v1` (after invite claim)

### Source of truth
- Supabase auth + tables: `profiles`, `teams`, `team_members`, `team_invites`

### Local/UI-only state
- Form fields (`email`, `password`)
- Busy/loading flags
- Role picker state

### Risks or legacy leftovers
- Bootstrap paths still involve synced local keys for some setup steps.

### Recommended rule going forward
- Keep identity/role/team ownership in Supabase via `lib/profile.ts` + `lib/team.ts`; do not add alternate identity stores.

---

## 2. Calendar
### Purpose
Show workouts by month/week and provide planning visibility/export.

### What it displays
- Month grid and weekly summaries
- Workout sessions by date
- PDF export output

### Reads from
- `lib/teamWorkoutsCloud.ts` (`listTeamWorkoutsInRange`) → `team_workouts`
- `lib/settings.ts` (`loadCoachSettings`)
- `lib/teamRoster.ts` (`getRosterMapById`, name resolution)
- Synced key read via `loadJSON`: `WEEK_START_KEY`

### Writes to
- None for workout domain from this page (display/export path)

### Source of truth
- Workouts: `team_workouts`
- Settings/week start: `lib/settings.ts` + synced key storage

### Local/UI-only state
- Calendar mode (month/week)
- Expanded/collapsed sections
- Current date/week focus
- Exporting flags

### Risks or legacy leftovers
- Mixed reads: workout rows from Supabase, some config from synced keys.

### Recommended rule going forward
- Keep workout reads through `lib/teamWorkoutsCloud.ts`; do not query `team_workouts` directly in the screen.

---

## 3. Mileage
### Purpose
Manage weekly athlete mileage/XT entries and totals.

### What it displays
- Athlete rows with AM/PM mileage cells
- NCAA off-day flags
- Weekly mileage and XT totals
- Spreadsheet editing tools and PDF export

### Reads from
- `lib/teamDataStore.ts` (roster + mileage week cache)
- `lib/mileageCloud.ts` via `teamDataStore` for week data
- Tables: `team_mileage_cells`, `team_mileage_day_flags`
- `lib/settings.ts` and other settings helpers for pace/unit/week-start defaults

### Writes to
- `teamDataStore.actions.setMileageCell(...)` → `lib/mileageCloud.ts` → `team_mileage_cells`
- `teamDataStore.actions.setMileageOffFlag(...)` → `lib/mileageCloud.ts` → `team_mileage_day_flags`

### Source of truth
- `team_mileage_cells` and `team_mileage_day_flags`

### Local/UI-only state
- Cell drafts and invalid markers
- Selection/copy/paste UI state
- Banner/toast state
- Exporting state

### Risks or legacy leftovers
- Must avoid treating legacy key-based mileage plans as truth.
- Local draft state can temporarily differ while edits are pending save.

### Recommended rule going forward
- Mileage truth must stay in Supabase mileage tables via `lib/mileageCloud.ts` and `lib/teamDataStore.ts`.

---

## 4. Planner
### Purpose
Create workout sessions/batches for selected athletes on a date/session.

### What it displays
- Session/date/time/title/details form
- Athlete selection
- Category and routine selections
- Draft/template controls

### Reads from
- Roster: `lib/teamDataStore.ts`
- Mileage lookup for planned distance: `lib/teamDataStore.ts` mileage week cache (`team_mileage_cells`)
- Settings and options: `lib/settings.ts`
- Planner drafts: `lib/plannerDrafts.ts` (synced local key)
- Selected-athletes key via `loadJSON` (`training_app_planner_selected_athletes_v1`)

### Writes to
- Workouts: `lib/teamWorkoutsCloud.ts` (`buildTeamWorkoutInsertRows`, `createTeamWorkoutBatch`) → `team_workouts`
- Drafts: `lib/plannerDrafts.ts`
- Selected-athletes key via `saveJSON`

### Source of truth
- Workout rows: `team_workouts`
- Roster: `team_athletes` via `teamDataStore`
- Mileage for planned distance: `team_mileage_cells` via `teamDataStore`
- Settings: `lib/settings.ts`

### Local/UI-only state
- Form input state
- Dropdown/modal open states
- Focus/keyboard navigation state
- Creating/submission status

### Risks or legacy leftovers
- Planner still uses synced local keys for drafts and some selections.
- Must keep mileage-derived planned distance tied to `teamDataStore` week data.

### Recommended rule going forward
- Planner must compose domain reads/writes through approved modules only:
  - roster/mileage from `teamDataStore`
  - workouts via `teamWorkoutsCloud`
  - settings via `settings.ts`

---

## 5. Roster
### Purpose
Manage team athletes (list, create, edit, delete, invite).

### What it displays
- Roster list with search
- Athlete detail editor
- Invite actions

### Reads from
- `lib/teamDataStore.ts` (`use`, `getState`, `getAthleteById`)
- `lib/team.ts` helper calls where needed
- Table: `team_athletes`

### Writes to
- Create athlete via `lib/team.ts` (`createTeamAthlete`) → `team_athletes`
- Update/delete via `teamDataStore.actions.updateAthlete/deleteAthlete` → `team_athletes`
- Invite creation via `lib/team.ts` (`createClaimInvite`) → `team_invites`

### Source of truth
- `team_athletes`

### Local/UI-only state
- Search text
- Create/edit form fields
- Busy/status banners
- Latest copied invite token

### Risks or legacy leftovers
- Legacy `lib/roster.ts` still exists in repo but is no longer active roster UI path.

### Recommended rule going forward
- Keep roster domain on `team_athletes` via `teamDataStore`, `team.ts`, and `teamRoster.ts`; do not reintroduce `lib/roster.ts` runtime use.

---

## 6. Settings
### Purpose
Manage coach-wide settings, categories, defaults, unit conversions, and related maintenance operations.

### What it displays
- Pace/unit/week start controls
- Categories and category routine defaults
- Custom groups
- Auxiliary routines
- Athlete pace overrides

### Reads from
- `lib/settings.ts` (coach settings/category paths)
- `team_kv_blobs` through `lib/settings.ts` where applicable
- Synced local keys via `loadJSON` where applicable
- Some workout reads via `lib/teamWorkoutsCloud.ts` for bulk conversion/update operations

### Writes to
- Settings/category saves via `lib/settings.ts` (including `team_kv_blobs` and synced key cache behavior)
- Synced keys via `saveJSON` for certain settings
- Workout patches via `lib/teamWorkoutsCloud.ts` (`bulkUpdateTeamWorkouts`) to `team_workouts`

### Source of truth
- Settings domain should flow through `lib/settings.ts`
- Team settings backing includes `team_kv_blobs` plus synced local keys where currently implemented

### Local/UI-only state
- Toggle and editor UI state
- Dropdown open/close state
- Draft text for edits

### Risks or legacy leftovers
- Settings currently mix team-scoped cloud-backed keys and synced local key reads/writes.

### Recommended rule going forward
- Keep all settings access routed through `lib/settings.ts`; avoid direct ad-hoc key/table logic in screens.
