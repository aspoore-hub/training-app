export const TEAM_KEYS = [
  // Shared team data
  "training_app_roster_v2",
  "training_app_categories_v1",
  "training_app_mileage_plans_v1",
  "training_app_workout_templates_v1",

  // Shared settings (coach-defined)
  "training_app_week_start_v1",
  "training_app_default_practice_times_v1",
  "training_app_custom_groups_v1",
  "training_app_category_routine_defaults_v1",
  "training_app_auxiliary_routines_v1",
  "training_app_pace_seconds_per_mile_v1",
  "training_app_distance_unit_v1",
] as const;

export const USER_KEYS = [
  // Personal UI selections
  "training_app_selected_athlete_v1",
  "training_app_planner_selected_athletes_v1",
  "training_app_planner_drafts_v1",
  "training_app_feedback_flags_enabled_v1",

  // Migration bookkeeping (safe as user-level)
  "training_app_migrations_v1",

  // Optional: keep these user-level for now
  "training_app_mileage_feedback_v1",
  "training_app_athlete_pace_seconds_per_unit_v1",
] as const;

export const SYNC_KEYS = [...TEAM_KEYS, ...USER_KEYS] as const;

export type TeamKey = (typeof TEAM_KEYS)[number];
export type UserKey = (typeof USER_KEYS)[number];
export type SyncKey = (typeof SYNC_KEYS)[number];

export function isTeamKey(key: string): key is TeamKey {
  return (TEAM_KEYS as readonly string[]).includes(key);
}

export function isUserKey(key: string): key is UserKey {
  return (USER_KEYS as readonly string[]).includes(key);
}

export function isSyncKey(key: string): key is SyncKey {
  return isTeamKey(key) || isUserKey(key);
}
