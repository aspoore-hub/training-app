import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase } from "../../../lib/supabase";
import {
  createCoachInvite,
  listCoachInvites,
  listTeamStaffMembers,
  removeTeamStaffMember,
  updateTeamStaffRole,
  type CoachInviteRole,
  type TeamCoachInvite,
  type TeamStaffMember,
} from "../../../lib/team";
import {
  canManageCoaches,
  getCurrentTeamRole,
  normalizeTeamRole,
  type TeamRole,
} from "../../../lib/teamPermissions";
import { CategoriesContent } from "./categories";
import { formatPace, loadPaceSecondsPerMile, parsePace, savePaceSecondsPerMile } from "../../../lib/pace";
import { loadJSON } from "../../../lib/storage";
import {
  convertDistance,
  convertPaceSecondsPerUnit,
  distanceUnitLabel,
  paceUnitLongLabel,
  type DistanceUnit,
} from "../../../lib/units";
import { getSortableRoster, type TeamRosterAthlete } from "../../../lib/teamRoster";
import {
  isActiveTrainingGroupMembership,
  teamDataStore,
  type TeamSeason,
  type TeamTrainingGroup,
} from "../../../lib/teamDataStore";
import {
  loadAthletePaceOverrides,
  saveAthletePaceOverrides,
  type AthletePaceOverrides,
} from "../../../lib/athletePace";
import {
  emptyPracticeTimeDefaults,
  loadPracticeTimeDefaults,
  savePracticeTimeDefaults,
  type PracticeTimeDefaults,
} from "../../../lib/practiceDefaults";
// Practice defaults editor path in this screen stays dedicated:
// use loadPracticeTimeDefaults/savePracticeTimeDefaults and do not bind
// this editor directly to coachSettings.defaultSessionTimes.
import { normalizeWorkoutTimeInput } from "../../../lib/time";
import {
  COACH_SETTINGS_SAVE_SOURCE,
  getLastCoachSettingsLoadSource,
  loadCoreCoachSettings,
  loadWeekStartSetting,
  saveCoreCoachSettings,
  saveWeekStartSetting,
  type WeekStartSetting,
} from "../../../lib/settings";
import {
  loadFeedbackFlagSettings,
  saveFeedbackFlagSettings,
  type FeedbackWarningMode,
} from "../../../lib/feedbackFlags";
import { bulkUpdateTeamWorkouts, listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const FEEDBACK_WINDOW_OPTIONS: Array<{ mode: FeedbackWarningMode; label: string }> = [
  { mode: "all", label: "All past days" },
  { mode: "previous_month", label: "Previous month only" },
  { mode: "last_14_days", label: "Previous 14 days" },
  { mode: "last_7_days", label: "Previous 7 days" },
  { mode: "since_date", label: "From a specific date" },
];
const WEEK_START_OPTIONS: WeekStartSetting[] = ["sunday", "monday"];

function countNonEmptyPracticeDefaults(defaults: PracticeTimeDefaults): number {
  let count = 0;
  for (let day = 0; day < 7; day++) {
    const key = String(day);
    const am = String(defaults[key]?.am ?? "").trim();
    const pm = String(defaults[key]?.pm ?? "").trim();
    if (am) count += 1;
    if (pm) count += 1;
  }
  return count;
}

function round2(n: number) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

function getErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    const anyError = error as any;
    return (
      anyError.message ||
      anyError.error_description ||
      anyError.details ||
      anyError.hint ||
      anyError.code ||
      JSON.stringify(error)
    );
  }
  return String(error);
}

function convertWorkoutDistances(rawWorkouts: any[], from: DistanceUnit, to: DistanceUnit): any[] {
  return (rawWorkouts ?? []).map((w: any) => {
    const next: any = { ...w };
    if (typeof next.planned_distance === "number") {
      next.planned_distance = round2(convertDistance(next.planned_distance, from, to));
      next.planned_distance_unit = to;
    }
    return next;
  });
}

export default function CoachSettingsTab() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isDesktopWeb = Platform.OS === "web";
  const [paceText, setPaceText] = useState("");
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [weekStartSetting, setWeekStartSetting] = useState<WeekStartSetting>("monday");
  const [feedbackFlagsEnabled, setFeedbackFlagsEnabled] = useState(false);
  const [feedbackWarningMode, setFeedbackWarningMode] = useState<FeedbackWarningMode>("all");
  const [feedbackStartDateText, setFeedbackStartDateText] = useState("");
  const [feedbackWindowMenuOpen, setFeedbackWindowMenuOpen] = useState(false);
  const [currentTeamRole, setCurrentTeamRole] = useState<TeamRole | null>(null);
  const settingsReadOnly = normalizeTeamRole(currentTeamRole) === "viewer";
  const [staffMembers, setStaffMembers] = useState<TeamStaffMember[]>([]);
  const [coachInvites, setCoachInvites] = useState<TeamCoachInvite[]>([]);
  const [coachInviteEmail, setCoachInviteEmail] = useState("");
  const [coachInviteRole, setCoachInviteRole] = useState<CoachInviteRole>("viewer");
  const [staffBusy, setStaffBusy] = useState(false);
  const [staffStatus, setStaffStatus] = useState<string | null>(null);
  const [lastCoachInviteToken, setLastCoachInviteToken] = useState("");

  const [workoutTypesOpen, setWorkoutTypesOpen] = useState(false);
  const [customGroupsOpen, setCustomGroupsOpen] = useState(false);
  const [seasonsOpen, setSeasonsOpen] = useState(false);
  const [individualPaceOpen, setIndividualPaceOpen] = useState(false);
  const [practiceDefaultsOpen, setPracticeDefaultsOpen] = useState(false);
  const [weekStartMenuOpen, setWeekStartMenuOpen] = useState(false);
  const [paceMenuOpen, setPaceMenuOpen] = useState(false);

  const [roster, setRoster] = useState<TeamRosterAthlete[]>([]);
  const teamStore = teamDataStore.use();
  const [trainingGroups, setTrainingGroups] = useState<TeamTrainingGroup[]>([]);
  const [teamSeasons, setTeamSeasons] = useState<TeamSeason[]>([]);
  const [practiceDefaults, setPracticeDefaults] = useState<PracticeTimeDefaults>(emptyPracticeTimeDefaults());
  const [athletePaceOverrides, setAthletePaceOverrides] = useState<AthletePaceOverrides>({});
  const [athletePaceTextById, setAthletePaceTextById] = useState<Record<string, string>>({});
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupNameText, setGroupNameText] = useState("");
  const [draftAthleteIds, setDraftAthleteIds] = useState<string[]>([]);
  const [groupSaveBusy, setGroupSaveBusy] = useState(false);
  const [groupSaveError, setGroupSaveError] = useState<string | null>(null);
  const [groupSaveSuccess, setGroupSaveSuccess] = useState<string | null>(null);
  const [editingSeasonId, setEditingSeasonId] = useState<string | null>(null);
  const [seasonNameText, setSeasonNameText] = useState("");
  const [seasonStartDateText, setSeasonStartDateText] = useState("");
  const [seasonEndDateText, setSeasonEndDateText] = useState("");
  const [seasonColorText, setSeasonColorText] = useState("");

  const loadStaffAccess = useCallback(async () => {
    const role = await getCurrentTeamRole();
    setCurrentTeamRole(role);
    if (!role) {
      setStaffMembers([]);
      setCoachInvites([]);
      return;
    }
    const members = await listTeamStaffMembers();
    setStaffMembers(members);
    if (canManageCoaches(role)) {
      const invites = await listCoachInvites();
      setCoachInvites(invites);
    } else {
      setCoachInvites([]);
    }
  }, []);

  const loadSettingsScreenData = useCallback(
    async (isActive?: () => boolean) => {
      try {
        const [paceSec, coreSettings, loadedRoster, loadedOverrides, weekStartResult, feedbackFlagSettings] = await Promise.all([
          loadPaceSecondsPerMile(),
          loadCoreCoachSettings(),
          getSortableRoster(),
          loadAthletePaceOverrides(),
          loadWeekStartSetting(),
          loadFeedbackFlagSettings(),
        ]);
        await Promise.all([
          teamDataStore.actions.loadTrainingGroups(true),
          teamDataStore.actions.loadTeamSeasons(true),
          teamDataStore.actions.loadAthleteSeasonOverrides(true),
        ]);
        const defaults = await loadPracticeTimeDefaults();
        if (isActive && !isActive()) return;

        console.log("[settings] practice defaults loaded", {
          nonEmptyCount: countNonEmptyPracticeDefaults(defaults),
        });
        setPaceText(formatPace(paceSec));
        setDistanceUnit(coreSettings.distanceUnit);
        const normalizedWeekStart = weekStartResult.normalized;
        console.log("[settings] week start loaded via shared helper", {
          raw: weekStartResult.raw,
          normalized: normalizedWeekStart,
        });
        console.log("[coach-settings] load summary", {
          source: getLastCoachSettingsLoadSource(),
          categoriesCount: coreSettings.categories.length,
          distanceUnit: coreSettings.distanceUnit,
        });
        setWeekStartSetting(normalizedWeekStart);
        setRoster(loadedRoster);
        setFeedbackFlagsEnabled(!!feedbackFlagSettings.enabled);
        setFeedbackWarningMode(feedbackFlagSettings.mode ?? "all");
        setFeedbackStartDateText(String(feedbackFlagSettings.startDateISO ?? ""));
        await loadStaffAccess();
        setTrainingGroups(Array.isArray(teamDataStore.getState().trainingGroups) ? teamDataStore.getState().trainingGroups : []);
        setTeamSeasons(Array.isArray(teamDataStore.getState().teamSeasons) ? teamDataStore.getState().teamSeasons : []);
        setAthletePaceOverrides(loadedOverrides);
        setPracticeDefaults(defaults);

        const textById: Record<string, string> = {};
        for (const athlete of loadedRoster) {
          const value = loadedOverrides?.[athlete.id];
          textById[athlete.id] = Number.isFinite(value) ? formatPace(value) : "";
        }
        setAthletePaceTextById(textById);
      } catch (error: any) {
        if (isActive && !isActive()) return;
        const message = error instanceof Error ? error.message : String(error ?? "Unknown settings load error");
        console.error("[settings-screen] load failed", error);
        Alert.alert("Settings load failed", message);
      }
    },
    [loadStaffAccess]
  );

  useEffect(() => {
    let cancelled = false;
    void loadSettingsScreenData(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadSettingsScreenData]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void loadSettingsScreenData(() => !cancelled);
      return () => {
        cancelled = true;
      };
    }, [loadSettingsScreenData])
  );

  const rosterById = useMemo(() => {
    const map = new Map<string, TeamRosterAthlete>();
    for (const athlete of roster) map.set(athlete.id, athlete);
    return map;
  }, [roster]);

  const sortedRoster = useMemo(() => {
    return [...roster].sort((a, b) => {
      const byLast = (a.lastName ?? "").localeCompare(b.lastName ?? "");
      if (byLast !== 0) return byLast;
      const byFirst = (a.firstName ?? "").localeCompare(b.firstName ?? "");
      if (byFirst !== 0) return byFirst;
      return String(a.displayName ?? "").localeCompare(String(b.displayName ?? ""));
    });
  }, [roster]);

  useEffect(() => {
    setTrainingGroups(Array.isArray(teamStore.trainingGroups) ? teamStore.trainingGroups : []);
  }, [teamStore.trainingGroups]);

  useEffect(() => {
    setTeamSeasons(Array.isArray(teamStore.teamSeasons) ? teamStore.teamSeasons : []);
  }, [teamStore.teamSeasons]);

  const sortedGroups = useMemo(() => {
    return [...trainingGroups].sort((a, b) => a.name.localeCompare(b.name));
  }, [trainingGroups]);

  const sortedSeasons = useMemo(() => {
    return [...teamSeasons].sort((a, b) => {
      const aSort = Number.isFinite(a.sort_order as number) ? Number(a.sort_order) : Number.MAX_SAFE_INTEGER;
      const bSort = Number.isFinite(b.sort_order as number) ? Number(b.sort_order) : Number.MAX_SAFE_INTEGER;
      if (aSort !== bSort) return aSort - bSort;
      const byStart = String(a.start_date ?? "").localeCompare(String(b.start_date ?? ""));
      if (byStart !== 0) return byStart;
      return String(a.name ?? "").localeCompare(String(b.name ?? ""));
    });
  }, [teamSeasons]);

  const overrideCountBySeasonId = useMemo(() => {
    const bySeason = new Map<string, Set<string>>();
    (Array.isArray(teamStore.athleteSeasonOverrides) ? teamStore.athleteSeasonOverrides : []).forEach((override) => {
      const seasonId = String(override?.season_id ?? "").trim();
      const athleteId = String(override?.athlete_profile_id ?? "").trim();
      if (!seasonId || !athleteId) return;
      const set = bySeason.get(seasonId) ?? new Set<string>();
      set.add(athleteId);
      bySeason.set(seasonId, set);
    });
    const counts = new Map<string, number>();
    bySeason.forEach((set, seasonId) => counts.set(seasonId, set.size));
    return counts;
  }, [teamStore.athleteSeasonOverrides]);

  function toggleSettingsSection(
    _reason: string,
    setter: React.Dispatch<React.SetStateAction<boolean>>
  ) {
    setter((prev) => !prev);
  }

  async function switchDistanceUnit(nextUnit: DistanceUnit) {
    if (nextUnit === distanceUnit) return;

    const [rawWorkouts, currentPace, currentOverrides] = await Promise.all([
      listTeamWorkoutsInRange("1900-01-01", "9999-12-31"),
      loadPaceSecondsPerMile(),
      loadAthletePaceOverrides(),
    ]);
    console.log("[coach-settings] workouts fetch", {
      purpose: "distance-unit-conversion",
      start: "1900-01-01",
      end: "9999-12-31",
      count: (rawWorkouts as TeamWorkoutRow[])?.length ?? 0,
    });

    const nextWorkouts = convertWorkoutDistances(rawWorkouts as TeamWorkoutRow[], distanceUnit, nextUnit);
    const nextPace = Math.max(1, Math.round(convertPaceSecondsPerUnit(currentPace, distanceUnit, nextUnit)));
    const nextOverrides: AthletePaceOverrides = {};
    for (const [athleteId, sec] of Object.entries(currentOverrides ?? {})) {
      nextOverrides[athleteId] = Math.max(1, Math.round(convertPaceSecondsPerUnit(sec, distanceUnit, nextUnit)));
    }

    const workoutPatches = (rawWorkouts as TeamWorkoutRow[])
      .map((workout, idx) => {
        const next = nextWorkouts[idx] as TeamWorkoutRow;
        if (workout.planned_distance === next.planned_distance && workout.planned_distance_unit === next.planned_distance_unit) {
          return null;
        }
        return {
          id: workout.id,
          patch: {
            planned_distance: next.planned_distance ?? null,
            planned_distance_unit: next.planned_distance_unit ?? nextUnit,
          },
        };
      })
      .filter(Boolean) as Array<{ id: string; patch: Partial<TeamWorkoutRow> }>;

    console.log("[settings-screen] save payload", {
      action: "switchDistanceUnit",
      source: COACH_SETTINGS_SAVE_SOURCE,
      distanceUnit: nextUnit,
      workoutPatchCount: workoutPatches.length,
    });

    try {
      await Promise.all([
        workoutPatches.length > 0 ? bulkUpdateTeamWorkouts(workoutPatches) : Promise.resolve(),
        savePaceSecondsPerMile(nextPace),
        saveAthletePaceOverrides(nextOverrides),
        saveCoreCoachSettings({ distanceUnit: nextUnit }),
      ]);
      console.log("[settings-screen] save response", {
        action: "switchDistanceUnit",
        status: "success",
      });
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error ?? "Unknown settings save error");
      console.error("[settings-screen] save failed", { action: "switchDistanceUnit", error });
      Alert.alert("Settings save failed", message);
      throw error;
    }

    setDistanceUnit(nextUnit);
    setPaceText(formatPace(nextPace));
    setAthletePaceOverrides(nextOverrides);
    setAthletePaceTextById((prev) => {
      const next = { ...prev };
      for (const athlete of roster) {
        const override = nextOverrides[athlete.id];
        next[athlete.id] = Number.isFinite(override) ? formatPace(override) : "";
      }
      return next;
    });
    Alert.alert(
      "Distance unit updated",
      `All saved distance values were converted to ${distanceUnitLabel(nextUnit)} and pace was converted to per ${paceUnitLongLabel(nextUnit)}.`
    );
  }

  async function saveIndividualPaceOverrides() {
    const next: AthletePaceOverrides = {};
    const invalidNames: string[] = [];

    for (const athlete of sortedRoster) {
      const raw = String(athletePaceTextById[athlete.id] ?? "").trim();
      if (!raw) continue;
      const parsed = parsePace(raw);
      if (parsed == null) {
        invalidNames.push(String(athlete.displayName ?? "Athlete"));
        continue;
      }
      next[athlete.id] = parsed;
    }

    if (invalidNames.length > 0) {
      Alert.alert(
        "Invalid pace values",
        `Fix pace for: ${invalidNames.slice(0, 3).join(", ")}${invalidNames.length > 3 ? ` +${invalidNames.length - 3} more` : ""}. Use mm:ss or minutes.`
      );
      return;
    }

    await saveAthletePaceOverrides(next);
    setAthletePaceOverrides(next);
    Alert.alert("Saved", "Individual athlete conversion paces updated.");
  }

  async function clearAllIndividualOverrides() {
    await saveAthletePaceOverrides({});
    setAthletePaceOverrides({});
    setAthletePaceTextById((prev) => {
      const next = { ...prev };
      for (const athlete of sortedRoster) next[athlete.id] = "";
      return next;
    });
    Alert.alert("Cleared", "All athletes now use the team default conversion.");
  }

  async function saveWeekStart(next: WeekStartSetting) {
    setWeekStartSetting(next);
    console.log("[settings] week start save", { value: next });
    await saveWeekStartSetting(next);
  }

  async function toggleFeedbackFlags(enabled: boolean) {
    setFeedbackFlagsEnabled(enabled);
    await saveFeedbackFlagSettings({
      enabled,
      mode: feedbackWarningMode,
      startDateISO: feedbackStartDateText.trim() || undefined,
    });
  }

  async function saveFeedbackWindow(mode: FeedbackWarningMode, startDateISO?: string) {
    const nextStart = String(startDateISO ?? "").trim();
    if (mode === "since_date" && nextStart) {
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(nextStart) && !Number.isNaN(new Date(nextStart + "T00:00:00").getTime());
      if (!valid) {
        Alert.alert("Invalid date", "Use YYYY-MM-DD format for the start date.");
        return;
      }
    }
    setFeedbackWarningMode(mode);
    setFeedbackStartDateText(nextStart);
    await saveFeedbackFlagSettings({
      enabled: feedbackFlagsEnabled,
      mode,
      startDateISO: nextStart || undefined,
    });
  }

  function updatePracticeDefault(dayIndex: number, field: "am" | "pm", value: string) {
    const key = String(dayIndex);
    setPracticeDefaults((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] ?? {}),
        [field]: value,
      },
    }));
  }

  function normalizePracticeDefaultInput(dayIndex: number, field: "am" | "pm") {
    const key = String(dayIndex);
    const raw = String(practiceDefaults[key]?.[field] ?? "").trim();
    if (!raw) return;
    const normalized = normalizeWorkoutTimeInput(raw);
    if (!normalized) return;
    if (normalized === raw) return;
    updatePracticeDefault(dayIndex, field, normalized);
  }

  async function savePracticeDefaults() {
    const next: PracticeTimeDefaults = emptyPracticeTimeDefaults();
    const invalid: string[] = [];

    for (let day = 0; day < 7; day++) {
      const key = String(day);
      const amRaw = String(practiceDefaults[key]?.am ?? "").trim();
      const pmRaw = String(practiceDefaults[key]?.pm ?? "").trim();

      if (amRaw) {
        const normalized = normalizeWorkoutTimeInput(amRaw);
        if (!normalized) invalid.push(`${WEEKDAY_LABELS[day]} AM`);
        else next[key].am = normalized;
      }

      if (pmRaw) {
        const normalized = normalizeWorkoutTimeInput(pmRaw);
        if (!normalized) invalid.push(`${WEEKDAY_LABELS[day]} PM`);
        else next[key].pm = normalized;
      }
    }

    if (invalid.length > 0) {
      Alert.alert(
        "Invalid default time",
        `Fix: ${invalid.slice(0, 4).join(", ")}${invalid.length > 4 ? ` +${invalid.length - 4} more` : ""}.`
      );
      return;
    }

    console.log("[settings] practice defaults save", {
      nonEmptyCount: countNonEmptyPracticeDefaults(next),
    });

    console.log("[settings-screen] save payload", {
      action: "savePracticeDefaults",
      source: COACH_SETTINGS_SAVE_SOURCE,
      defaultTimesCount: Object.values(next).reduce((count, day) => {
        const am = String(day?.am ?? "").trim();
        const pm = String(day?.pm ?? "").trim();
        return count + (am ? 1 : 0) + (pm ? 1 : 0);
      }, 0),
    });

    try {
      await savePracticeTimeDefaults(next);
      setPracticeDefaults(next);
      console.log("[settings] practice defaults saved");
      console.log("[settings-screen] save response", {
        action: "savePracticeDefaults",
        status: "success",
      });
      Alert.alert("Saved", "Default practice times updated.");
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error ?? "Unknown settings save error");
      console.error("[settings-screen] save failed", { action: "savePracticeDefaults", error });
      Alert.alert("Settings save failed", message);
    }
  }

  function resetGroupEditor() {
    setEditingGroupId(null);
    setGroupNameText("");
    setDraftAthleteIds([]);
  }

  function toggleDraftAthlete(athleteId: string) {
    setDraftAthleteIds((prev) =>
      prev.includes(athleteId) ? prev.filter((id) => id !== athleteId) : [...prev, athleteId]
    );
  }

  function startEditGroup(group: TeamTrainingGroup) {
    setEditingGroupId(group.id);
    setGroupNameText(group.name);
    setGroupSaveError(null);
    setGroupSaveSuccess(null);
    const activeMembershipIds = teamStore.trainingGroupMemberships
      .filter(
        (row) =>
          String(row.group_id ?? "").trim() === group.id &&
          isActiveTrainingGroupMembership(row)
      )
      .map((row) => String(row.athlete_profile_id ?? "").trim())
      .filter(Boolean);
    setDraftAthleteIds(activeMembershipIds);
    setCustomGroupsOpen(true);
  }

  async function saveGroup() {
    const name = groupNameText.trim();
    if (!name) {
      Alert.alert("Group name required", "Enter a name for this training group.");
      return;
    }
    if (groupSaveBusy) return;

    setGroupSaveBusy(true);
    setGroupSaveError(null);
    setGroupSaveSuccess(null);
    try {
      const cleanAthleteIds = Array.from(
        new Set((draftAthleteIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))
      );
      console.log("[settings][training-groups] save start", {
        mode: editingGroupId ? "update" : "create",
        groupId: editingGroupId,
        groupName: name,
        selectedAthleteCount: cleanAthleteIds.length,
        selectedAthleteSample: cleanAthleteIds.slice(0, 10),
      });

      let targetGroupId = editingGroupId;
      if (editingGroupId) {
        console.log("[TrainingGroups] rename start", { groupId: editingGroupId, name });
        try {
          const renamed = await teamDataStore.actions.renameTrainingGroup(editingGroupId, name);
          console.log("[TrainingGroups] rename success", {
            groupId: renamed?.id,
            groupName: renamed?.name,
          });
        } catch (error) {
          console.error("[TrainingGroups] rename failed", error);
          throw new Error(`Update group name failed: ${getErrorMessage(error)}`);
        }
      } else {
        console.log("[TrainingGroups] create start", { name });
        try {
          const created = await teamDataStore.actions.createTrainingGroup(name);
          targetGroupId = String(created?.id ?? "").trim();
          console.log("[TrainingGroups] create success", {
            groupId: created?.id,
            groupName: created?.name,
          });
        } catch (error) {
          console.error("[TrainingGroups] create failed", error);
          throw new Error(`Create group failed: ${getErrorMessage(error)}`);
        }
      }

      if (!targetGroupId) {
        throw new Error("Could not resolve training group id for membership save.");
      }

      console.log("[TrainingGroups] replace members start", {
        groupId: targetGroupId,
        selectedAthleteCount: cleanAthleteIds.length,
        selectedAthleteSample: cleanAthleteIds.slice(0, 10),
      });
      try {
        await teamDataStore.actions.replaceTrainingGroupMembers(targetGroupId, cleanAthleteIds);
        console.log("[TrainingGroups] replace members success", {
          groupId: targetGroupId,
          selectedAthleteCount: cleanAthleteIds.length,
        });
      } catch (error) {
        console.error("[TrainingGroups] replace members failed", error);
        throw new Error(`Update group members failed: ${getErrorMessage(error)}`);
      }

      console.log("[TrainingGroups] reload groups start");
      try {
        await teamDataStore.actions.loadTrainingGroups(true);
      } catch (error) {
        console.error("[TrainingGroups] reload groups failed", error);
        throw new Error(`Reload groups failed: ${getErrorMessage(error)}`);
      }
      const latestMembershipCount = teamDataStore
        .getState()
        .trainingGroupMemberships.filter(
          (row) =>
            String(row.group_id ?? "").trim() === targetGroupId &&
            isActiveTrainingGroupMembership(row)
        ).length;
      console.log("[settings][training-groups] post-save reload complete", {
        groupId: targetGroupId,
        activeMembershipCount: latestMembershipCount,
      });

      setGroupSaveSuccess(
        editingGroupId
          ? `Group updated (${latestMembershipCount} athlete${latestMembershipCount === 1 ? "" : "s"}).`
          : `Group created (${latestMembershipCount} athlete${latestMembershipCount === 1 ? "" : "s"}).`
      );
      resetGroupEditor();
    } catch (error: any) {
      const message = getErrorMessage(error);
      console.error("[TrainingGroups] save failed", error);
      console.error("[settings][training-groups] save failed", {
        groupId: editingGroupId,
        groupName: name,
        selectedAthleteCount: draftAthleteIds.length,
        error,
      });
      setGroupSaveError(message);
      Alert.alert("Training group save failed", message);
    } finally {
      setGroupSaveBusy(false);
    }
  }

  async function archiveGroup(groupId: string, archived: boolean) {
    Alert.alert(archived ? "Archive group?" : "Restore group?", archived ? "This hides the training group from default selection." : "This restores the training group.", [
      { text: "Cancel", style: "cancel" },
      {
        text: archived ? "Archive" : "Restore",
        style: archived ? "destructive" : "default",
        onPress: async () => {
          await teamDataStore.actions.setTrainingGroupArchived(groupId, archived);
          if (editingGroupId === groupId) resetGroupEditor();
        },
      },
    ]);
  }

  function isValidDateOnlyISO(value: string): boolean {
    const text = String(value ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const atMidnight = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(atMidnight.getTime())) return false;
    return atMidnight.toISOString().slice(0, 10) === text;
  }

  function resetSeasonEditor() {
    setEditingSeasonId(null);
    setSeasonNameText("");
    setSeasonStartDateText("");
    setSeasonEndDateText("");
    setSeasonColorText("");
  }

  function startEditSeason(season: TeamSeason) {
    setEditingSeasonId(season.id);
    setSeasonNameText(String(season.name ?? ""));
    setSeasonStartDateText(String(season.start_date ?? ""));
    setSeasonEndDateText(String(season.end_date ?? ""));
    setSeasonColorText(String(season.color ?? ""));
    setSeasonsOpen(true);
  }

  async function saveSeason() {
    const name = String(seasonNameText ?? "").trim();
    const startDate = String(seasonStartDateText ?? "").trim();
    const endDate = String(seasonEndDateText ?? "").trim();
    const color = String(seasonColorText ?? "").trim();
    if (!name) {
      Alert.alert("Season name required", "Enter a name for this season.");
      return;
    }
    if (!isValidDateOnlyISO(startDate) || !isValidDateOnlyISO(endDate)) {
      Alert.alert("Invalid dates", "Use YYYY-MM-DD for start and end date.");
      return;
    }
    if (endDate < startDate) {
      Alert.alert("Invalid date range", "End date must be on or after start date.");
      return;
    }

    if (editingSeasonId) {
      await teamDataStore.actions.updateTeamSeason(editingSeasonId, {
        name,
        start_date: startDate,
        end_date: endDate,
        color: color || null,
      });
    } else {
      const maxSortOrder = sortedSeasons.reduce((max, row) => {
        const value = Number(row.sort_order);
        if (!Number.isFinite(value)) return max;
        return Math.max(max, value);
      }, 0);
      await teamDataStore.actions.createTeamSeason({
        name,
        start_date: startDate,
        end_date: endDate,
        color: color || null,
        sort_order: maxSortOrder + 1,
      });
    }
    resetSeasonEditor();
  }

  async function archiveSeason(seasonId: string, archived: boolean) {
    Alert.alert(
      archived ? "Archive season?" : "Restore season?",
      archived ? "This hides the season from default selection." : "This restores the season.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: archived ? "Archive" : "Restore",
          style: archived ? "destructive" : "default",
          onPress: async () => {
            await teamDataStore.actions.setTeamSeasonArchived(seasonId, archived);
            if (editingSeasonId === seasonId) resetSeasonEditor();
          },
        },
      ]
    );
  }

  async function inviteCoachAccount() {
    const cleanEmail = coachInviteEmail.trim().toLowerCase();
    if (!cleanEmail) {
      Alert.alert("Email required", "Enter the coach email for this invite.");
      return;
    }
    setStaffBusy(true);
    setStaffStatus(null);
    try {
      const token = await createCoachInvite(cleanEmail, coachInviteRole);
      setLastCoachInviteToken(token);
      setCoachInviteEmail("");
      setStaffStatus(`Invite created for ${cleanEmail}. Share the token with that coach.`);
      await loadStaffAccess();
      Alert.alert("Coach invite created", "Share the invite token with the coach.");
    } catch (error: any) {
      const message = getErrorMessage(error);
      setStaffStatus(message);
      Alert.alert("Invite failed", message);
    } finally {
      setStaffBusy(false);
    }
  }

  async function changeStaffRole(userId: string, role: CoachInviteRole) {
    setStaffBusy(true);
    setStaffStatus(null);
    try {
      await updateTeamStaffRole(userId, role);
      await loadStaffAccess();
      setStaffStatus("Coach role updated.");
    } catch (error: any) {
      const message = getErrorMessage(error);
      setStaffStatus(message);
      Alert.alert("Role update failed", message);
    } finally {
      setStaffBusy(false);
    }
  }

  function confirmRemoveStaffMember(member: TeamStaffMember) {
    if (member.is_owner) {
      Alert.alert("Owner cannot be removed", "Transfer ownership before removing the team owner.");
      return;
    }
    Alert.alert("Remove coach?", "This removes coach workspace access for this account.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setStaffBusy(true);
          setStaffStatus(null);
          try {
            await removeTeamStaffMember(member.user_id);
            await loadStaffAccess();
            setStaffStatus("Coach removed.");
          } catch (error: any) {
            const message = getErrorMessage(error);
            setStaffStatus(message);
            Alert.alert("Remove failed", message);
          } finally {
            setStaffBusy(false);
          }
        },
      },
    ]);
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/(auth)/login");
  }

  if (settingsReadOnly) {
    return (
      <View style={styles.container}>
        <View style={styles.pageHeader}>
          <View style={styles.pageHeaderTextWrap}>
            <Text style={styles.title}>Settings</Text>
            <Text style={styles.subtitle}>View team access and account details.</Text>
          </View>
          <Pressable onPress={() => router.push("/(auth)/choose-account")} style={styles.utilityBtn}>
            <Text style={styles.utilityBtnText}>Switch account/team</Text>
          </Pressable>
        </View>

        <ScrollView
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          contentContainerStyle={styles.scrollContent}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
        >
          <View style={isDesktopWeb ? styles.desktopWorkspace : undefined}>
            <View style={[styles.card, styles.sectionCard, styles.primarySectionCard, isDesktopWeb && styles.desktopCard]}>
              <Text style={styles.cardTitle}>Coach Accounts</Text>
              <Text style={styles.cardHint}>Viewer access: editing is disabled.</Text>

              <View style={styles.staffRoleSummary}>
                <Text style={styles.staffRoleSummaryText}>
                  Your access: {currentTeamRole ? currentTeamRole.toUpperCase() : "VIEWER"}
                </Text>
              </View>

              <View style={styles.staffList}>
                <Text style={styles.label}>Current staff</Text>
                {staffMembers.length === 0 ? (
                  <Text style={styles.cardHint}>No staff rows found for this team.</Text>
                ) : (
                  staffMembers.map((member) => {
                    const normalizedRole = member.is_owner ? "owner" : normalizeTeamRole(member.raw_role);
                    return (
                      <View key={`${member.team_id}-${member.user_id}`} style={styles.staffRow}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.staffName} numberOfLines={1}>
                            {member.user_id}
                          </Text>
                          <Text style={styles.groupMeta}>
                            {member.is_owner ? "Owner" : normalizedRole === "editor" ? "Editor" : "Viewer"}
                            {member.raw_role && !member.is_owner ? ` - stored as ${member.raw_role}` : ""}
                          </Text>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>

              {staffStatus ? <Text style={styles.successText}>{staffStatus}</Text> : null}
            </View>

            <View style={[styles.card, styles.sectionCard, styles.secondarySectionCard, isDesktopWeb && styles.desktopCard]}>
              <Text style={styles.cardTitle}>Team Settings</Text>
              <Text style={styles.cardHint}>
                Team defaults, categories, routines, training groups, and seasons are editable by Owners and Editors.
              </Text>
            </View>

            <View style={styles.signOutWrap}>
              <Pressable
                onPress={signOut}
                style={[
                  styles.signOutBtn,
                  isDesktopWeb ? styles.signOutBtnDesktop : null,
                ]}
              >
                <Text style={styles.signOutBtnText}>Sign Out</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.pageHeader}>
        <View style={styles.pageHeaderTextWrap}>
          <Text style={styles.title}>Settings</Text>
          <Text style={styles.subtitle}>Manage app preferences and coaching tools.</Text>
        </View>
        <Pressable onPress={() => router.push("/(auth)/choose-account")} style={styles.utilityBtn}>
          <Text style={styles.utilityBtnText}>Switch account/team</Text>
        </Pressable>
      </View>

      <ScrollView
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        contentContainerStyle={styles.scrollContent}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
      >
        <View style={isDesktopWeb ? styles.desktopWorkspace : undefined}>
        <View style={[styles.card, styles.sectionCard, styles.primarySectionCard, isDesktopWeb && styles.desktopCard]}>
          <Text style={styles.cardTitle}>General</Text>
          <Text style={styles.cardHint}>Core planning preferences used across the app.</Text>

          <View style={styles.settingsRows}>
            <View style={[styles.lineRow, styles.lineRowFirst]}>
              <Text style={styles.lineLabel}>Distance unit</Text>
              <View style={styles.lineValueWrap}>
                {(["mi", "km"] as DistanceUnit[]).map((u) => {
                  const active = u === distanceUnit;
                  return (
                    <Pressable
                      key={u}
                      onPress={() => switchDistanceUnit(u)}
                      style={[styles.unitBtn, active && styles.unitBtnActive]}
                    >
                      <Text style={[styles.unitBtnText, active && styles.unitBtnTextActive]}>{u.toUpperCase()}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={[styles.lineRow, styles.lineDropdownRow]}>
              <Pressable
                onPress={() => setWeekStartMenuOpen((prev) => !prev)}
                hitSlop={10}
                style={styles.dropdownTrigger}
              >
                <Text style={styles.lineLabel}>First day of week</Text>
                <View style={styles.dropdownValueWrap}>
                  <Text style={styles.dropdownValue}>{weekStartSetting === "sunday" ? "Sunday" : "Monday"}</Text>
                  <View style={styles.chevronTapTarget}>
                    <Text style={styles.dropdownChevron}>{weekStartMenuOpen ? "▴" : "▾"}</Text>
                  </View>
                </View>
              </Pressable>
              {weekStartMenuOpen ? (
                <View style={styles.dropdownPanel}>
                  {WEEK_START_OPTIONS.map((value, idx) => {
                    const label = value === "sunday" ? "Sunday" : "Monday";
                    const active = value === weekStartSetting;
                    return (
                      <Pressable
                        key={`settings-week-start-${value}`}
                        onPress={async () => {
                          await saveWeekStart(value);
                          setWeekStartMenuOpen(false);
                        }}
                        style={[
                          styles.dropdownOption,
                          idx > 0 && styles.dropdownOptionBorder,
                          active && styles.dropdownOptionActive,
                        ]}
                      >
                        <Text style={[styles.dropdownOptionText, active && styles.dropdownOptionTextActive]}>{label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>

            <View style={[styles.lineRow, styles.lineDropdownRow]}>
              <Pressable
                onPress={() => setPaceMenuOpen((prev) => !prev)}
                hitSlop={10}
                style={styles.dropdownTrigger}
              >
                <Text style={styles.lineLabel}>Time → Distance</Text>
                <View style={styles.dropdownValueWrap}>
                  <Text style={styles.dropdownValue}>
                    {formatPace(parsePace(paceText) ?? 0)} / {paceUnitLongLabel(distanceUnit)}
                  </Text>
                  <View style={styles.chevronTapTarget}>
                    <Text style={styles.dropdownChevron}>{paceMenuOpen ? "▴" : "▾"}</Text>
                  </View>
                </View>
              </Pressable>

              {paceMenuOpen ? (
                <View style={styles.dropdownPanel}>
                  <Text style={styles.label}>Team default pace</Text>
                  <TextInput
                    value={paceText}
                    onChangeText={setPaceText}
                    placeholder="8:00"
                    style={styles.input}
                    autoCapitalize="none"
                  />
                  <Text style={styles.cardHint}>
                    Use `8:00` or `8` (minutes per {paceUnitLongLabel(distanceUnit)}).
                  </Text>

                  <Pressable
                    onPress={async () => {
                      const parsed = parsePace(paceText);
                      if (parsed == null) {
                        Alert.alert("Invalid pace", "Enter pace as mm:ss or minutes (e.g. 8:00 or 8).");
                        return;
                      }
                      await savePaceSecondsPerMile(parsed);
                      setPaceText(formatPace(parsed));
                      Alert.alert("Saved", `Pace setting updated for ${distanceUnitLabel(distanceUnit)}.`);
                    }}
                    style={styles.saveBtn}
                  >
                    <Text style={styles.saveBtnText}>Save Team Pace</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => setIndividualPaceOpen((prev) => !prev)}
                    style={[styles.groupActionBtn, { marginTop: 10, alignSelf: "flex-start" }]}
                  >
                    <Text style={styles.groupActionBtnText}>
                      {individualPaceOpen ? "Hide individual conversion" : "Individualize conversion by athlete"}
                    </Text>
                  </Pressable>

                  {individualPaceOpen ? (
                    <View style={{ marginTop: 10 }}>
                      <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                        <Pressable onPress={saveIndividualPaceOverrides} style={styles.groupActionBtn}>
                          <Text style={styles.groupActionBtnText}>Save athlete paces</Text>
                        </Pressable>
                        <Pressable onPress={clearAllIndividualOverrides} style={styles.groupDeleteBtn}>
                          <Text style={styles.groupDeleteBtnText}>Use team default for all</Text>
                        </Pressable>
                      </View>

                      <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 12, maxHeight: 300 }}>
                        <ScrollView nestedScrollEnabled>
                          {sortedRoster.map((athlete) => {
                            const hasOverride = Number.isFinite(athletePaceOverrides[athlete.id]);
                            return (
                              <View
                                key={athlete.id}
                                style={{
                                  paddingHorizontal: 10,
                                  paddingVertical: 10,
                                  borderBottomWidth: 1,
                                  borderBottomColor: "#f1f1f1",
                                  backgroundColor: "#fff",
                                }}
                              >
                                <Text style={{ fontWeight: "800", color: "#111" }}>{athlete.displayName}</Text>
                                <Text style={{ marginTop: 2, marginBottom: 6, fontSize: 11, color: "#666", fontWeight: "700" }}>
                                  {hasOverride
                                    ? `Override: ${formatPace(athletePaceOverrides[athlete.id])} per ${paceUnitLongLabel(distanceUnit)}`
                                    : `Using team default: ${formatPace(parsePace(paceText) ?? 0)} per ${paceUnitLongLabel(distanceUnit)}`}
                                </Text>
                                <TextInput
                                  value={athletePaceTextById[athlete.id] ?? ""}
                                  onChangeText={(t) =>
                                    setAthletePaceTextById((prev) => ({ ...prev, [athlete.id]: t }))
                                  }
                                  placeholder={`Default (${formatPace(parsePace(paceText) ?? 0)})`}
                                  style={styles.input}
                                  autoCapitalize="none"
                                />
                              </View>
                            );
                          })}
                        </ScrollView>
                      </View>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>

            <View style={[styles.lineRow, styles.lineRowLast]}>
              <Text style={styles.lineLabel}>Flag missing athlete feedback (past days)</Text>
              <Switch
                value={feedbackFlagsEnabled}
                onValueChange={(value) => {
                  toggleFeedbackFlags(value).catch(() => {});
                }}
              />
            </View>

            {feedbackFlagsEnabled ? (
              <View style={[styles.lineRow, styles.lineDropdownRow]}>
                <Pressable
                  onPress={() => setFeedbackWindowMenuOpen((prev) => !prev)}
                  hitSlop={10}
                  style={styles.dropdownTrigger}
                >
                  <Text style={styles.lineLabel}>Warning window</Text>
                  <View style={styles.dropdownValueWrap}>
                    <Text style={styles.dropdownValue}>
                      {FEEDBACK_WINDOW_OPTIONS.find((opt) => opt.mode === feedbackWarningMode)?.label ?? "All past days"}
                    </Text>
                    <View style={styles.chevronTapTarget}>
                      <Text style={styles.dropdownChevron}>{feedbackWindowMenuOpen ? "▴" : "▾"}</Text>
                    </View>
                  </View>
                </Pressable>

                {feedbackWindowMenuOpen ? (
                  <View style={styles.dropdownPanel}>
                    {FEEDBACK_WINDOW_OPTIONS.map((opt, idx) => {
                      const active = opt.mode === feedbackWarningMode;
                      return (
                        <Pressable
                          key={`feedback-window-${opt.mode}`}
                          onPress={() => {
                            saveFeedbackWindow(opt.mode, feedbackStartDateText).catch(() => {});
                            setFeedbackWindowMenuOpen(false);
                          }}
                          style={[
                            styles.dropdownOption,
                            idx > 0 && styles.dropdownOptionBorder,
                            active && styles.dropdownOptionActive,
                          ]}
                        >
                          <Text style={[styles.dropdownOptionText, active && styles.dropdownOptionTextActive]}>
                            {opt.label}
                          </Text>
                        </Pressable>
                      );
                    })}

                    {feedbackWarningMode === "since_date" ? (
                      <View style={{ marginTop: 10 }}>
                        <Text style={styles.label}>Start date (YYYY-MM-DD)</Text>
                        <TextInput
                          value={feedbackStartDateText}
                          onChangeText={setFeedbackStartDateText}
                          placeholder="2026-03-01"
                          style={styles.input}
                          autoCapitalize="none"
                        />
                        <Pressable
                          onPress={() => {
                            saveFeedbackWindow("since_date", feedbackStartDateText).catch(() => {});
                          }}
                          style={[styles.groupActionBtn, { marginTop: 8, alignSelf: "flex-start" }]}
                        >
                          <Text style={styles.groupActionBtnText}>Save start date</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>

        <View style={[styles.card, styles.sectionCard, styles.primarySectionCard, isDesktopWeb && styles.desktopCard]}>
          <Text style={styles.cardTitle}>Coach Accounts</Text>
          <Text style={styles.cardHint}>
            {canManageCoaches(currentTeamRole)
              ? "Invite staff and manage coach workspace permissions."
              : "Only the team owner can manage coach accounts."}
          </Text>

          <View style={styles.staffRoleSummary}>
            <Text style={styles.staffRoleSummaryText}>
              Your access: {currentTeamRole ? currentTeamRole.toUpperCase() : "UNKNOWN"}
            </Text>
          </View>

          {canManageCoaches(currentTeamRole) ? (
            <View style={styles.staffInviteBox}>
              <Text style={styles.label}>Invite coach by email</Text>
              <TextInput
                value={coachInviteEmail}
                onChangeText={setCoachInviteEmail}
                placeholder="coach@example.com"
                style={styles.input}
                autoCapitalize="none"
                keyboardType="email-address"
              />

              <Text style={[styles.label, { marginTop: 10 }]}>Permission</Text>
              <View style={styles.staffRoleToggle}>
                {(["viewer", "editor"] as CoachInviteRole[]).map((role) => {
                  const active = coachInviteRole === role;
                  return (
                    <Pressable
                      key={`coach-invite-role-${role}`}
                      disabled={staffBusy}
                      onPress={() => setCoachInviteRole(role)}
                      style={[styles.staffRoleBtn, active && styles.staffRoleBtnActive, staffBusy && styles.disabledBtn]}
                    >
                      <Text style={[styles.staffRoleBtnText, active && styles.staffRoleBtnTextActive]}>
                        {role === "viewer" ? "Viewer" : "Editor"}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.cardHint}>
                Viewer is read-only. Editor can edit training, mileage, roster, catalog, and plans.
              </Text>

              <Pressable
                disabled={staffBusy}
                onPress={inviteCoachAccount}
                style={[styles.saveBtn, staffBusy && styles.disabledBtn]}
              >
                <Text style={styles.saveBtnText}>{staffBusy ? "Working..." : "Create Coach Invite"}</Text>
              </Pressable>

              {lastCoachInviteToken ? (
                <View style={styles.inviteTokenBox}>
                  <Text style={styles.label}>Latest invite token</Text>
                  <Text selectable style={styles.inviteTokenText}>{lastCoachInviteToken}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          <View style={styles.staffList}>
            <Text style={styles.label}>Current staff</Text>
            {staffMembers.length === 0 ? (
              <Text style={styles.cardHint}>No staff rows found for this team.</Text>
            ) : (
              staffMembers.map((member) => {
                const normalizedRole = member.is_owner ? "owner" : normalizeTeamRole(member.raw_role);
                return (
                  <View key={`${member.team_id}-${member.user_id}`} style={styles.staffRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.staffName} numberOfLines={1}>
                        {member.user_id}
                      </Text>
                      <Text style={styles.groupMeta}>
                        {member.is_owner ? "Owner" : normalizedRole === "editor" ? "Editor" : "Viewer"}
                        {member.raw_role && !member.is_owner ? ` • stored as ${member.raw_role}` : ""}
                      </Text>
                    </View>
                    {canManageCoaches(currentTeamRole) && !member.is_owner ? (
                      <View style={styles.staffActions}>
                        {(["viewer", "editor"] as CoachInviteRole[]).map((role) => {
                          const active = normalizedRole === role;
                          return (
                            <Pressable
                              key={`${member.user_id}-${role}`}
                              disabled={staffBusy || active}
                              onPress={() => changeStaffRole(member.user_id, role)}
                              style={[styles.staffMiniBtn, active && styles.staffMiniBtnActive, staffBusy && styles.disabledBtn]}
                            >
                              <Text style={[styles.staffMiniBtnText, active && styles.staffMiniBtnTextActive]}>
                                {role === "viewer" ? "Viewer" : "Editor"}
                              </Text>
                            </Pressable>
                          );
                        })}
                        <Pressable
                          disabled={staffBusy}
                          onPress={() => confirmRemoveStaffMember(member)}
                          style={[styles.groupDeleteBtn, staffBusy && styles.disabledBtn]}
                        >
                          <Text style={styles.groupDeleteBtnText}>Remove</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                );
              })
            )}
          </View>

          {canManageCoaches(currentTeamRole) ? (
            <View style={styles.staffList}>
              <Text style={styles.label}>Recent coach invites</Text>
              {coachInvites.length === 0 ? (
                <Text style={styles.cardHint}>No coach invites yet.</Text>
              ) : (
                coachInvites.slice(0, 6).map((invite) => (
                  <View key={invite.token} style={styles.inviteRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.staffName} numberOfLines={1}>{invite.email || "Coach invite"}</Text>
                      <Text style={styles.groupMeta}>
                        {invite.role === "viewer" ? "Viewer" : "Editor"}
                        {invite.expires_at ? ` • expires ${invite.expires_at.slice(0, 10)}` : ""}
                      </Text>
                    </View>
                    <Text selectable style={styles.inviteTokenInline}>{invite.token}</Text>
                  </View>
                ))
              )}
            </View>
          ) : null}

          {staffStatus ? <Text style={styles.successText}>{staffStatus}</Text> : null}
        </View>

        <View style={[styles.card, styles.sectionCard, styles.primarySectionCard, isDesktopWeb && styles.desktopCard]}> 
          <Pressable
            style={styles.sectionHeader}
            hitSlop={10}
            onPress={() => void toggleSettingsSection("practice-defaults-section-toggle", setPracticeDefaultsOpen)}
          >
            <Text style={styles.cardTitle}>Default Practice Times</Text>
            <View style={styles.chevronTapTarget}>
              <Text style={styles.chev}>{practiceDefaultsOpen ? "▾" : "▸"}</Text>
            </View>
          </Pressable>
          <Text style={styles.cardHint}>Set default AM/PM times by weekday (optional).</Text>

          {practiceDefaultsOpen ? (
            <View style={styles.collapsibleBody}>
              <View style={styles.placeholder}>
                {WEEKDAY_LABELS.map((label, dayIdx) => {
                  const key = String(dayIdx);
                  return (
                    <View
                      key={`default-time-${key}`}
                      style={[
                        styles.practiceDayRow,
                        dayIdx === WEEKDAY_LABELS.length - 1 && styles.practiceDayRowLast,
                      ]}
                    >
                      <Text style={styles.label}>{label}</Text>
                      <View style={styles.practiceDayInputs}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.practiceFieldLabel}>AM</Text>
                          <TextInput
                            value={practiceDefaults[key]?.am ?? ""}
                            onChangeText={(t) => updatePracticeDefault(dayIdx, "am", t)}
                            onBlur={() => normalizePracticeDefaultInput(dayIdx, "am")}
                            placeholder="Optional"
                            style={styles.input}
                            autoCapitalize="none"
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.practiceFieldLabel}>PM</Text>
                          <TextInput
                            value={practiceDefaults[key]?.pm ?? ""}
                            onChangeText={(t) => updatePracticeDefault(dayIdx, "pm", t)}
                            onBlur={() => normalizePracticeDefaultInput(dayIdx, "pm")}
                            placeholder="Optional"
                            style={styles.input}
                            autoCapitalize="none"
                          />
                        </View>
                      </View>
                    </View>
                  );
                })}

                <Text style={styles.cardHint}>
                  Accepts entries like `8a`, `12p`, `8:00am`, `20:00`. Leave blank for no default.
                </Text>

                <Pressable onPress={savePracticeDefaults} style={styles.saveBtn}>
                  <Text style={styles.saveBtnText}>Save Default Times</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>

        <View style={[styles.card, styles.sectionCard, styles.secondarySectionCard, isDesktopWeb && styles.desktopCard]}> 
          <Pressable
            style={styles.sectionHeader}
            hitSlop={10}
            onPress={() => void toggleSettingsSection("workout-categories-section-toggle", setWorkoutTypesOpen)}
          >
            <Text style={styles.cardTitle}>Workout Categories</Text>
            <View style={styles.chevronTapTarget}>
              <Text style={styles.chev}>{workoutTypesOpen ? "▾" : "▸"}</Text>
            </View>
          </Pressable>
          <Text style={styles.cardHint}>Manage category names, colors, and ordering.</Text>

          {workoutTypesOpen ? (
            <View style={styles.collapsibleBody}>
              <View
                style={{
                  maxHeight: 460,
                  borderWidth: 1,
                  borderColor: "#e8e8e8",
                  borderRadius: 12,
                  overflow: "hidden",
                  backgroundColor: "#fff",
                }}
              >
                <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  <CategoriesContent useVirtualizedList />
                </ScrollView>
              </View>
            </View>
          ) : null}
        </View>

        <View style={[styles.card, styles.sectionCard, styles.secondarySectionCard, isDesktopWeb && styles.desktopCard]}>
          <Text style={styles.cardTitle}>Auxiliary Routines</Text>
          <Text style={styles.cardHint}>
            Warmups, cooldowns, drills, mobility work, plyos, and strength routines now live in their own coach tab.
          </Text>
          <Pressable
            onPress={() => router.push("/(coach)/(tabs)/auxiliary-routines")}
            style={[styles.groupActionBtn, { alignSelf: "flex-start" }]}
          >
            <Text style={styles.groupActionBtnText}>Open Auxiliary Routines</Text>
          </Pressable>
        </View>

        <View style={[styles.card, styles.sectionCard, styles.secondarySectionCard, isDesktopWeb && styles.desktopCard]}> 
          <Pressable
            style={styles.sectionHeader}
            hitSlop={10}
            onPress={() => void toggleSettingsSection("training-groups-section-toggle", setCustomGroupsOpen)}
          >
          <Text style={styles.cardTitle}>Training Groups</Text>
            <View style={styles.chevronTapTarget}>
              <Text style={styles.chev}>{customGroupsOpen ? "▾" : "▸"}</Text>
            </View>
          </Pressable>
          <Text style={styles.cardHint}>Create team-scoped groups for quick selection in Plan.</Text>

          {customGroupsOpen ? (
            <View style={styles.collapsibleBody}>
              <View style={styles.placeholder}>
                <Text style={styles.label}>Group name</Text>
                <TextInput
                  value={groupNameText}
                  onChangeText={setGroupNameText}
                  placeholder="e.g., Varsity Girls"
                  style={styles.input}
                />

                <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                  <Pressable
                    disabled={groupSaveBusy}
                    onPress={() => setDraftAthleteIds(sortedRoster.filter((a) => a.isActive !== false).map((a) => a.id))}
                    style={[styles.groupActionBtn, groupSaveBusy && styles.disabledBtn]}
                  >
                  <Text style={styles.groupActionBtnText}>Select active</Text>
                  </Pressable>
                  <Pressable
                    disabled={groupSaveBusy}
                    onPress={() => setDraftAthleteIds([])}
                    style={[styles.groupActionBtn, groupSaveBusy && styles.disabledBtn]}
                  >
                    <Text style={styles.groupActionBtnText}>Clear</Text>
                  </Pressable>
                  {(editingGroupId || groupNameText || draftAthleteIds.length > 0) ? (
                    <Pressable
                      disabled={groupSaveBusy}
                      onPress={() => {
                        setGroupSaveError(null);
                        setGroupSaveSuccess(null);
                        resetGroupEditor();
                      }}
                      style={[styles.groupActionBtn, groupSaveBusy && styles.disabledBtn]}
                    >
                      <Text style={styles.groupActionBtnText}>Cancel</Text>
                    </Pressable>
                  ) : null}
                </View>

                <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 12, maxHeight: 220 }}>
                  <ScrollView nestedScrollEnabled>
                    {sortedRoster.filter((athlete) => athlete.isActive !== false).map((athlete) => {
                      const active = draftAthleteIds.includes(athlete.id);
                      return (
                        <Pressable
                          key={athlete.id}
                          disabled={groupSaveBusy}
                          onPress={() => toggleDraftAthlete(athlete.id)}
                          style={{
                            flexDirection: "row",
                            justifyContent: "space-between",
                            alignItems: "center",
                            paddingVertical: 10,
                            paddingHorizontal: 10,
                            borderBottomWidth: 1,
                            borderBottomColor: "#f1f1f1",
                            backgroundColor: active ? "rgba(0,0,0,0.04)" : "#fff",
                          }}
                        >
                          <Text style={{ fontWeight: "700", color: "#111", flex: 1, paddingRight: 8 }}>
                            {athlete.displayName}
                          </Text>
                          <Text style={{ fontWeight: "900", color: active ? "#111" : "#999" }}>
                            {active ? "✓" : "○"}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>

                <Pressable
                  disabled={groupSaveBusy}
                  onPress={saveGroup}
                  style={[styles.saveBtn, { marginTop: 10 }, groupSaveBusy && styles.disabledBtn]}
                >
                  <Text style={styles.saveBtnText}>
                    {groupSaveBusy ? "Saving..." : editingGroupId ? "Update Group" : "Create Group"}
                  </Text>
                </Pressable>
                {groupSaveError ? (
                  <Text style={styles.errorText}>{groupSaveError}</Text>
                ) : null}
                {groupSaveSuccess ? (
                  <Text style={styles.successText}>{groupSaveSuccess}</Text>
                ) : null}
              </View>

              <View style={{ marginTop: 12 }}>
                {sortedGroups.length === 0 ? (
                  <Text style={{ color: "#666", fontWeight: "700" }}>No training groups yet.</Text>
                ) : (
                  sortedGroups.map((group) => {
                    const memberIds = teamStore.trainingGroupMemberships
                      .filter(
                        (row) =>
                          String(row.group_id ?? "").trim() === group.id &&
                          isActiveTrainingGroupMembership(row)
                      )
                      .map((row) => String(row.athlete_profile_id ?? "").trim())
                      .filter(Boolean);
                    const names = memberIds
                      .map((id) => rosterById.get(id))
                      .filter((a): a is TeamRosterAthlete => !!a)
                      .map((a) => a.displayName)
                      .slice(0, 3);
                    const extra = Math.max(0, memberIds.length - names.length);
                    const archived = !!group.archived_at;

                    return (
                      <View key={group.id} style={styles.groupCard}>
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <Text style={styles.groupName}>{group.name}{archived ? " (Archived)" : ""}</Text>
                          <Text style={styles.groupMeta}>
                            {memberIds.length} athlete{memberIds.length === 1 ? "" : "s"}
                            {names.length > 0 ? ` • ${names.join(", ")}${extra > 0 ? ` +${extra} more` : ""}` : ""}
                          </Text>
                        </View>
                        <View style={{ flexDirection: "row", gap: 8 }}>
                          <Pressable onPress={() => startEditGroup(group)} style={styles.groupActionBtn}>
                            <Text style={styles.groupActionBtnText}>Edit</Text>
                          </Pressable>
                          <Pressable
                            onPress={() => archiveGroup(group.id, !archived)}
                            style={archived ? styles.groupActionBtn : styles.groupDeleteBtn}
                          >
                            <Text style={archived ? styles.groupActionBtnText : styles.groupDeleteBtnText}>
                              {archived ? "Restore" : "Archive"}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            </View>
          ) : null}
        </View>

        <View style={[styles.card, styles.sectionCard, styles.secondarySectionCard, isDesktopWeb && styles.desktopCard]}>
          <Pressable
            style={styles.sectionHeader}
            hitSlop={10}
            onPress={() => void toggleSettingsSection("seasons-section-toggle", setSeasonsOpen)}
          >
            <Text style={styles.cardTitle}>Seasons</Text>
            <View style={styles.chevronTapTarget}>
              <Text style={styles.chev}>{seasonsOpen ? "▾" : "▸"}</Text>
            </View>
          </Pressable>
          <Text style={styles.cardHint}>Create team-level season date ranges for future filtering and reporting.</Text>

          {seasonsOpen ? (
            <View style={styles.collapsibleBody}>
              <View style={styles.placeholder}>
                <Text style={styles.label}>Season name</Text>
                <TextInput
                  value={seasonNameText}
                  onChangeText={setSeasonNameText}
                  placeholder="e.g., Summer Conditioning"
                  style={styles.input}
                />

                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.label, { marginTop: 8 }]}>Start date (YYYY-MM-DD)</Text>
                    <TextInput
                      value={seasonStartDateText}
                      onChangeText={setSeasonStartDateText}
                      placeholder="2026-06-01"
                      style={styles.input}
                      autoCapitalize="none"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.label, { marginTop: 8 }]}>End date (YYYY-MM-DD)</Text>
                    <TextInput
                      value={seasonEndDateText}
                      onChangeText={setSeasonEndDateText}
                      placeholder="2026-08-31"
                      style={styles.input}
                      autoCapitalize="none"
                    />
                  </View>
                </View>

                <Text style={[styles.label, { marginTop: 8 }]}>Color (optional)</Text>
                <TextInput
                  value={seasonColorText}
                  onChangeText={setSeasonColorText}
                  placeholder="#2A7FFF"
                  style={styles.input}
                  autoCapitalize="none"
                />

                <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                  <Pressable onPress={saveSeason} style={styles.saveBtn}>
                    <Text style={styles.saveBtnText}>{editingSeasonId ? "Update Season" : "Create Season"}</Text>
                  </Pressable>
                  {(editingSeasonId || seasonNameText || seasonStartDateText || seasonEndDateText || seasonColorText) ? (
                    <Pressable onPress={resetSeasonEditor} style={styles.groupActionBtn}>
                      <Text style={styles.groupActionBtnText}>Cancel</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

              <View style={{ marginTop: 12 }}>
                {sortedSeasons.length === 0 ? (
                  <Text style={{ color: "#666", fontWeight: "700" }}>No seasons yet.</Text>
                ) : (
                  sortedSeasons.map((season) => {
                    const archived = !!season.archived_at;
                    const colorDot = String(season.color ?? "").trim();
                    const overrideCount = overrideCountBySeasonId.get(String(season.id ?? "").trim()) ?? 0;
                    return (
                      <View key={season.id} style={styles.groupCard}>
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <Text style={styles.groupName}>{season.name}{archived ? " (Archived)" : ""}</Text>
                          <Text style={styles.groupMeta}>
                            {season.start_date} to {season.end_date}
                            {` • ${overrideCount > 0 ? `${overrideCount} override${overrideCount === 1 ? "" : "s"}` : "No overrides"}`}
                            {colorDot ? ` • ${colorDot}` : ""}
                          </Text>
                        </View>
                        <View style={{ flexDirection: "row", gap: 8 }}>
                          <Pressable onPress={() => startEditSeason(season)} style={styles.groupActionBtn}>
                            <Text style={styles.groupActionBtnText}>Edit</Text>
                          </Pressable>
                          <Pressable
                            onPress={() => archiveSeason(season.id, !archived)}
                            style={archived ? styles.groupActionBtn : styles.groupDeleteBtn}
                          >
                            <Text style={archived ? styles.groupActionBtnText : styles.groupDeleteBtnText}>
                              {archived ? "Restore" : "Archive"}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.signOutWrap}>
          <Pressable
            onPress={signOut}
            style={[
              styles.signOutBtn,
              isDesktopWeb ? styles.signOutBtnDesktop : null,
            ]}
          >
            <Text style={styles.signOutBtnText}>Sign Out</Text>
          </Pressable>
        </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 12, backgroundColor: "#f4f6fb" },
  pageHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e2e7f0",
    borderRadius: 14,
    backgroundColor: "#ffffff",
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  pageHeaderTextWrap: {
    flex: 1,
    minWidth: 0,
    paddingTop: 2,
  },
  title: { fontSize: 22, fontWeight: "900", color: "#111" },
  subtitle: { marginTop: 2, color: "#596071", fontWeight: "700" },
  utilityBtn: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#d6dce6",
    borderRadius: 10,
    backgroundColor: "#f7f9fc",
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 0,
  },
  utilityBtnText: { fontWeight: "900", color: "#1d2433", fontSize: 12 },
  scrollContent: { paddingBottom: 22, paddingTop: 4 },
  desktopWorkspace: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: 12,
  },
  desktopCard: {
    flexBasis: "49%",
    flexGrow: 1,
    marginTop: 0,
  },

  card: {
    borderWidth: 1,
    borderColor: "#e0e6ef",
    backgroundColor: "#ffffff",
    borderRadius: 14,
    padding: 12,
    shadowColor: "#111827",
    shadowOpacity: Platform.OS === "web" ? 0.05 : 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  sectionCard: { marginTop: 10 },
  primarySectionCard: {
    borderColor: "#dbe3f2",
  },
  secondarySectionCard: {
    backgroundColor: "#fcfdff",
  },
  cardTitle: { fontSize: 16, fontWeight: "900", color: "#111" },
  cardHint: { marginTop: 4, marginBottom: 9, color: "#5e6678", fontWeight: "700", fontSize: 12 },
  settingsRows: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e1e7f2",
    backgroundColor: "#fbfcff",
    overflow: "hidden",
  },
  lineRow: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: "#edf1f7",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  lineRowFirst: { borderTopWidth: 0 },
  lineRowLast: {},
  lineDropdownRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 0,
  },
  lineLabel: { fontSize: 14, fontWeight: "900", color: "#111" },
  lineValueWrap: { minWidth: 148, flexDirection: "row", gap: 8 },
  dropdownTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 40,
  },
  dropdownValueWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  dropdownValue: { fontSize: 13, fontWeight: "800", color: "#384054" },
  dropdownChevron: { fontWeight: "900", color: "#66708a", fontSize: 14 },
  dropdownPanel: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#dce3ef",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#f8faff",
  },
  dropdownOption: { paddingVertical: 10, paddingHorizontal: 10, backgroundColor: "#fff" },
  dropdownOptionBorder: { borderTopWidth: 1, borderTopColor: "#ecf1f8" },
  dropdownOptionActive: { backgroundColor: "rgba(10,132,255,0.10)" },
  dropdownOptionText: { fontWeight: "800", color: "#111" },
  dropdownOptionTextActive: { color: "#0a84ff" },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 36 },
  chev: { fontSize: 16, fontWeight: "900", color: "#66708a" },
  chevronTapTarget: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  collapsibleBody: { marginTop: 2 },
  auxWorkspaceDesktop: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 12,
  },
  auxListPane: {
    borderWidth: 1,
    borderColor: "#e8e8e8",
    borderRadius: 12,
    backgroundColor: "#fff",
    padding: 10,
    marginBottom: 10,
  },
  auxListPaneDesktop: {
    flex: 1,
    marginBottom: 0,
    minHeight: 420,
  },
  auxEditorPane: {
    borderWidth: 1,
    borderColor: "#e8e8e8",
    borderRadius: 12,
    backgroundColor: "#fff",
    padding: 10,
  },
  auxEditorPaneDesktop: {
    flex: 1.3,
    minHeight: 420,
  },
  auxListHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  auxListTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: "#111",
  },
  auxListBody: {
    gap: 8,
  },
  auxListRow: {
    borderWidth: 1,
    borderColor: "#ececec",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    backgroundColor: "#fafafa",
  },
  auxListRowActive: {
    borderColor: "#111",
    backgroundColor: "#f0f0f0",
  },
  auxListRowTitle: {
    fontSize: 13,
    fontWeight: "900",
    color: "#111",
  },
  auxListRowTitleActive: {
    color: "#000",
  },
  auxListRowMeta: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: "700",
    color: "#666",
  },
  auxEditorTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: "#111",
    marginBottom: 8,
  },
  auxChipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  auxEmpty: {
    paddingVertical: 20,
  },

  placeholder: { borderRadius: 12, borderWidth: 1, borderColor: "#e1e7f2", backgroundColor: "#fff", padding: 10 },
  practiceDayRow: {
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
    paddingBottom: 8,
    marginBottom: 8,
  },
  practiceDayRowLast: {
    borderBottomWidth: 0,
    paddingBottom: 0,
    marginBottom: 8,
  },
  practiceDayInputs: {
    flexDirection: "row",
    gap: 8,
  },
  practiceFieldLabel: {
    color: "#666",
    fontWeight: "800",
    fontSize: 11,
    marginBottom: 3,
  },
  label: { fontSize: 12, fontWeight: "900", color: "#666", marginBottom: 6 },
  unitBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: "center",
    backgroundColor: "#fff",
  },
  unitBtnActive: { borderColor: "#111", backgroundColor: "#111" },
  unitBtnText: { fontWeight: "900", color: "#111" },
  unitBtnTextActive: { color: "#fff" },
  input: {
    borderWidth: 1,
    borderColor: "#d3dbe8",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
    fontWeight: "800",
  },
  saveBtn: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#10131a",
    borderRadius: 12,
    backgroundColor: "#10131a",
    alignItems: "center",
    paddingVertical: 10,
  },
  saveBtnText: { fontWeight: "900", color: "white" },
  disabledBtn: {
    opacity: 0.6,
  },
  errorText: {
    marginTop: 8,
    color: "#b00020",
    fontWeight: "700",
    fontSize: 12,
  },
  successText: {
    marginTop: 8,
    color: "#0a7a32",
    fontWeight: "700",
    fontSize: 12,
  },
  staffRoleSummary: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#dbe3f2",
    borderRadius: 999,
    backgroundColor: "#f7f9fc",
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 10,
  },
  staffRoleSummaryText: { fontSize: 11, fontWeight: "900", color: "#1d2433" },
  staffInviteBox: {
    borderWidth: 1,
    borderColor: "#e1e7f2",
    borderRadius: 12,
    backgroundColor: "#fbfcff",
    padding: 10,
    marginBottom: 10,
  },
  staffRoleToggle: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  staffRoleBtn: {
    borderWidth: 1,
    borderColor: "#d3dbe8",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#fff",
  },
  staffRoleBtnActive: {
    borderColor: "#10131a",
    backgroundColor: "#10131a",
  },
  staffRoleBtnText: { fontWeight: "900", color: "#1d2433" },
  staffRoleBtnTextActive: { color: "#fff" },
  inviteTokenBox: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#dbe3f2",
    borderRadius: 10,
    backgroundColor: "#fff",
    padding: 10,
  },
  inviteTokenText: { fontSize: 12, fontWeight: "800", color: "#111" },
  staffList: { marginTop: 8 },
  staffRow: {
    borderWidth: 1,
    borderColor: "#e3e8f2",
    borderRadius: 12,
    padding: 10,
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 8,
  },
  staffName: { fontWeight: "900", color: "#111", fontSize: 13 },
  staffActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 6,
    maxWidth: 260,
  },
  staffMiniBtn: {
    borderWidth: 1,
    borderColor: "#d3dbe8",
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 8,
    backgroundColor: "#f8faff",
  },
  staffMiniBtnActive: {
    borderColor: "#10131a",
    backgroundColor: "#10131a",
  },
  staffMiniBtnText: { fontSize: 12, fontWeight: "900", color: "#1d2433" },
  staffMiniBtnTextActive: { color: "#fff" },
  inviteRow: {
    borderWidth: 1,
    borderColor: "#e3e8f2",
    borderRadius: 12,
    padding: 10,
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 8,
  },
  inviteTokenInline: {
    maxWidth: 180,
    fontSize: 11,
    fontWeight: "800",
    color: "#384054",
  },

  groupCard: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#e3e8f2",
    borderRadius: 12,
    padding: 10,
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
  },
  groupName: { fontWeight: "900", color: "#111" },
  groupMeta: { marginTop: 3, color: "#5f677a", fontWeight: "700", fontSize: 12 },
  groupActionBtn: {
    borderWidth: 1,
    borderColor: "#d3dbe8",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#f8faff",
  },
  groupActionBtnText: { fontWeight: "900", color: "#111" },
  groupDeleteBtn: {
    borderWidth: 1,
    borderColor: "#f1c3c3",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#fff",
  },
  groupDeleteBtnText: { fontWeight: "900", color: "#b00020" },
  autoRoutineChip: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "#fff",
  },
  autoRoutineChipActive: {
    borderColor: "#111",
    backgroundColor: "#111",
  },
  autoRoutineChipText: { fontWeight: "800", color: "#222" },
  autoRoutineChipTextActive: { color: "#fff" },
  signOutWrap: {
    marginTop: 14,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#e1e7f2",
    width: "100%",
  },
  signOutBtn: {
    backgroundColor: "#c33",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  signOutBtnDesktop: {
    alignSelf: "stretch",
  },
  signOutBtnText: {
    color: "white",
    fontWeight: "700",
    fontSize: 15,
  },
});
