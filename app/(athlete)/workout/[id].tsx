import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  Alert,
  ScrollView,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { InlineSaveStatus } from "../../../components/shared/InlineSaveStatus";
import { AthleteQuickFeedbackSheet } from "../../../components/athlete/AthleteQuickFeedbackSheet";
import type { AthleteWorkout, WeekStartDay } from "../../../lib/types";
import {
  buildMileageFeedbackId,
  getMileageFeedbackById,
  migrateLocalMileageFeedbackToTeamForAthlete,
  type MileageSessionFeedback,
  upsertMileageFeedback,
} from "../../../lib/mileageFeedback";
import { distanceUnitLabel, loadDistanceUnit, type DistanceUnit } from "../../../lib/units";
import { loadAuxiliaryRoutines, type AuxiliaryRoutine } from "../../../lib/auxiliaryRoutines";
import { parseNumericLike } from "../../../lib/feedbackParsing";
import { getCurrentTeamId } from "../../../lib/team";
import { resolveAthleteSessionContext } from "../../../lib/athleteSession";
import { loadRosterNameMapForTeam } from "../../../lib/rosterNameMap";
import {
  getVisibleAthleteWorkoutById,
  listTeamWorkoutsByBatch,
  updateTeamWorkoutById,
  type TeamWorkoutRow,
} from "../../../lib/teamWorkoutsCloud";
import { listTeamWorkoutBatchHeadersForDate } from "../../../lib/teamWorkoutBatchHeadersCloud";
import { teamDataStore, visibleMileageAthleteWeekKey } from "../../../lib/teamDataStore";
import {
  getWeekIndex,
  getWeekStartISO,
} from "../../../lib/mileagePlan";
import { formatParsedWorkoutEntry, parseWorkoutEntryValue } from "../../../lib/workoutEntryParser";
import { loadWeekStartSetting } from "../../../lib/settings";
import { loadJSON } from "../../../lib/storage";
import { CATEGORIES_KEY, categoryColorByName, normalizeCategories } from "../../../lib/categories";
import type { WorkoutCategory } from "../../../lib/types";

function normalizeGroupId(groupId?: string): string {
  const normalized = String(groupId ?? "").trim().toUpperCase();
  return normalized || "A";
}

function normalizeSession(value: string | undefined): "AM" | "PM" {
  return String(value ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
}

function firstParam(value: string | string[] | undefined): string {
  return String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
}

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
}

async function loadRosterAny(): Promise<Map<string, string>> {
  const teamId = await getCurrentTeamId();
  const map = await loadRosterNameMapForTeam(teamId);
  return map;
}

function fallbackAthleteName(athleteId: string) {
  const clean = String(athleteId ?? "").trim();
  if (!clean) return "Athlete";
  return `Athlete (${clean.slice(-6)})`;
}

function toAthleteWorkout(row: TeamWorkoutRow, rosterMap: Map<string, string>): AthleteWorkout {
  const athleteId = String(row.athlete_profile_id ?? "").trim();
  const athleteName =
    String(rosterMap.get(athleteId) ?? "").trim() ||
    String((row as any).athlete_name ?? "").trim() ||
    fallbackAthleteName(athleteId);
  return {
    id: String(row.id),
    athleteId,
    athleteName,
    batchId: row.batch_id ?? undefined,
    groupId: row.group_id ?? undefined,
    dateISO: String(row.date_iso),
    session: row.session === "AM" ? "AM" : "PM",
    time: row.time_text ?? undefined,
    location: row.location ?? undefined,
    preRoutineIds: row.pre_routine_ids ?? undefined,
    postRoutineIds: row.post_routine_ids ?? undefined,
    category: String(row.primary_category ?? "Other"),
    categories: row.categories ?? undefined,
    title: row.title ?? "Workout",
    details: row.details ?? undefined,
    completedMiles: parseNumericLike(row.completed_miles),
    completedTime: String(row.completed_time_text ?? "").trim() || undefined,
    splitsOrPace: String(row.splits_or_pace ?? "").trim() || undefined,
    additionalFeedback: String(row.additional_feedback ?? "").trim() || undefined,
    feedback: String(row.additional_feedback ?? "").trim() || undefined,
  };
}

function resolvePrescribedText(
  state: {
    visibleMileageCellsByAthleteWeek: ReturnType<typeof teamDataStore.use>["visibleMileageCellsByAthleteWeek"];
  },
  athleteId: string,
  dateISO: string,
  session: "AM" | "PM",
  weekStartsOn: WeekStartDay
) {
  const athlete = String(athleteId ?? "").trim();
  if (!athlete || !dateISO) return "";

  const weekStartISO = getWeekStartISO(dateISO, weekStartsOn);
  const dayIdx = getWeekIndex(dateISO, weekStartISO);

  if (!Number.isFinite(dayIdx) || dayIdx < 0 || dayIdx > 6) return "";

  const cells = state.visibleMileageCellsByAthleteWeek[visibleMileageAthleteWeekKey(athlete, weekStartISO)] ?? [];
  const cell = cells.find(
    (row) => row.athlete_profile_id === athlete && row.day_idx === dayIdx && row.session === session
  );

  if (!cell) return "";

  const parsed = parseWorkoutEntryValue(cell.value);
  if (parsed) {
    return formatParsedWorkoutEntry(parsed);
  }

  if (typeof (cell as any).value === "string") {
    return String((cell as any).value).trim();
  }

  return "";
}

export default function AthleteWorkoutDetail() {
  const {
    id,
    name,
    synthetic,
    date,
    session,
    prescribed,
    athleteId,
    returnTo,
  } = useLocalSearchParams<{
    id: string;
    name?: string;
    synthetic?: string;
    date?: string;
    session?: string;
    prescribed?: string;
    athleteId?: string;
    returnTo?: string | string[];
  }>();
  const router = useRouter();

  const isSynthetic = String(synthetic ?? "") === "1";
  const returnTarget = firstParam(returnTo);

  const [workout, setWorkout] = useState<AthleteWorkout | null>(null);
  const [groupMateNames, setGroupMateNames] = useState<string[]>([]);
  const [batchAthleteNames, setBatchAthleteNames] = useState<string[]>([]);
  const [batchHeaderNotes, setBatchHeaderNotes] = useState("");
  const [routineById, setRoutineById] = useState<Map<string, AuxiliaryRoutine>>(new Map());
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [completedMilesText, setCompletedMilesText] = useState("");
  const [completedTimeText, setCompletedTimeText] = useState("");
  const [splitsText, setSplitsText] = useState("");
  const [additionalFeedbackText, setAdditionalFeedbackText] = useState("");
  const [logSheetOpen, setLogSheetOpen] = useState(false);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [loading, setLoading] = useState(true);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [submitStatus, setSubmitStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rosterMap, setRosterMap] = useState<Map<string, string>>(new Map());
  const store = teamDataStore.use();

  function leaveWorkoutDetail() {
    if (returnTarget) {
      router.replace(returnTarget as any);
      return;
    }

    const canGoBack = (() => {
      try {
        return Boolean((router as any).canGoBack?.());
      } catch {
        return false;
      }
    })();

    if (canGoBack) {
      router.back();
      return;
    }

    router.replace("/(athlete)/dashboard");
  }

  useEffect(() => {
    (async () => {
      const athleteSession = await resolveAthleteSessionContext();
      const visibleAthleteId = String(athleteSession.athleteId ?? athleteId ?? "").trim();
      const [rosterMap, unit, routines, weekStartResult, storedCategories] = await Promise.all([
        loadRosterAny(),
        loadDistanceUnit(),
        loadAuxiliaryRoutines(),
        loadWeekStartSetting(),
        loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []),
      ]);
      const resolvedWeekStart: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
      console.log("[athlete-workout] week start loaded via shared helper", {
        raw: weekStartResult.raw,
        normalized: resolvedWeekStart,
      });
      setRosterMap(rosterMap);
      setDistanceUnit(unit);
      setRoutineById(new Map(routines.map((routine) => [routine.id, routine] as const)));
      setCategories(normalizeCategories(storedCategories));
      setWeekStartsOn(resolvedWeekStart);

      const foundRow = visibleAthleteId ? await getVisibleAthleteWorkoutById(String(id), visibleAthleteId) : null;
      const found = foundRow ? toAthleteWorkout(foundRow, rosterMap) : null;

      if (!isSynthetic && found) {
        setWorkout(found);
        setCompletedMilesText(found.completedMiles != null ? String(found.completedMiles) : "");
        setCompletedTimeText(String(found.completedTime ?? ""));
        setSplitsText(String(found.splitsOrPace ?? ""));
        setAdditionalFeedbackText(String(found.additionalFeedback ?? found.feedback ?? ""));

        setGroupMateNames([]);
        setBatchAthleteNames([]);
        setBatchHeaderNotes("");

        if (foundRow?.batch_id) {
          const [batchRows, headerRows] = await Promise.all([
            listTeamWorkoutsByBatch(foundRow.batch_id).catch(() => []),
            listTeamWorkoutBatchHeadersForDate(String(foundRow.date_iso)).catch(() => []),
          ]);
          const visibleBatchRows = batchRows.filter((row) => row.athlete_visible !== false);
          const groupNames = visibleBatchRows
            .filter(
              (row) =>
                String(row.id) !== String(foundRow.id) &&
                normalizeGroupId(row.group_id ?? undefined) === normalizeGroupId(foundRow.group_id ?? undefined)
            )
            .map((row) => rosterMap.get(String(row.athlete_profile_id ?? "").trim()) ?? fallbackAthleteName(String(row.athlete_profile_id ?? "")))
            .filter(Boolean);
          const batchNames = visibleBatchRows
            .map((row) => rosterMap.get(String(row.athlete_profile_id ?? "").trim()) ?? fallbackAthleteName(String(row.athlete_profile_id ?? "")))
            .filter(Boolean);
          setGroupMateNames(Array.from(new Set(groupNames)));
          setBatchAthleteNames(Array.from(new Set(batchNames)));
          const header = headerRows.find(
            (row) =>
              String(row.batch_id ?? "") === String(foundRow.batch_id ?? "") &&
              String(row.session ?? "") === String(foundRow.session ?? "")
          );
          setBatchHeaderNotes(String(header?.header_notes ?? "").trim());
        }

        if (found?.athleteId && found?.dateISO) {
          void teamDataStore.actions.loadVisibleMileageWeekForAthlete(
            String(found.athleteId),
            getWeekStartISO(String(found.dateISO), resolvedWeekStart)
          );
        }
      }

      if (isSynthetic) {
        await migrateLocalMileageFeedbackToTeamForAthlete({
          athleteId: String(athleteId ?? "") || undefined,
          athleteName: String(name ?? "") || undefined,
        });
        const feedbackId = buildMileageFeedbackId({
          athleteId: String(athleteId ?? "") || undefined,
          athleteName: String(name ?? "") || undefined,
          dateISO: String(date ?? ""),
          session: normalizeSession(session),
        });
        const existing = await getMileageFeedbackById(feedbackId);
        if (existing) {
          setCompletedMilesText(existing.completedMiles != null ? String(existing.completedMiles) : "");
          setCompletedTimeText(String(existing.completedTime ?? ""));
          setSplitsText(String(existing.splitsOrPace ?? ""));
          setAdditionalFeedbackText(String(existing.additionalFeedback ?? ""));
        }
      }

      setLoading(false);
    })();
  }, [id, isSynthetic, date, session, athleteId, name]);

  function parseCompletedMiles(text: string): number | undefined {
    const normalized = text.trim().replace(",", ".");
    if (!normalized) return undefined;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return undefined;
    return parsed;
  }

  function onChangeCompletedMiles(text: string) {
    const normalized = text.replace(",", ".");
    if (!/^\d*(?:\.\d{0,2})?$/.test(normalized)) return;
    setCompletedMilesText(normalized);
  }

  async function submitFeedback() {
    if (submitStatus === "saving") return;
    const parsedCompletedMiles = parseCompletedMiles(completedMilesText);
    const hasMilesInput = completedMilesText.trim().length > 0;

    if (hasMilesInput && parsedCompletedMiles === undefined) {
      Alert.alert("Invalid distance", "Enter a valid number up to two decimals.");
      return;
    }

    const hasCompletion = parsedCompletedMiles != null || completedTimeText.trim().length > 0;
    if (!hasCompletion) {
      Alert.alert(
        "Completion required",
        "Enter either distance completed or time completed before submitting."
      );
      return;
    }

    setSubmitError(null);
    setSubmitStatus("saving");
    try {
      if (isSynthetic) {
        const entry: MileageSessionFeedback = {
          id: buildMileageFeedbackId({
            athleteId: String(athleteId ?? "") || undefined,
            athleteName: String(name ?? "") || undefined,
            dateISO: String(date ?? ""),
            session: normalizeSession(session),
          }),
          athleteId: String(athleteId ?? "") || undefined,
          athleteName: String(name ?? "") || undefined,
          dateISO: String(date ?? ""),
          session: normalizeSession(session),
          prescribed: String(prescribed ?? "") || undefined,
          completedMiles: parsedCompletedMiles,
          completedTime: completedTimeText.trim() || undefined,
          splitsOrPace: splitsText.trim() || undefined,
          additionalFeedback: additionalFeedbackText.trim() || undefined,
          updatedAt: Date.now(),
        };
        await upsertMileageFeedback(entry);
      } else {
        if (!workout) return;

        await updateTeamWorkoutById(workout.id, {
          completed_miles: parsedCompletedMiles ?? null,
          completed_time_text: completedTimeText.trim() || null,
          splits_or_pace: splitsText.trim() || null,
          additional_feedback: additionalFeedbackText.trim() || null,
        });

        const refreshedRow = await getVisibleAthleteWorkoutById(workout.id, String(workout.athleteId ?? ""));
        if (!refreshedRow) {
          throw new Error("Saved workout could not be reloaded.");
        }
        const refreshedWorkout = toAthleteWorkout(refreshedRow, rosterMap);
        setWorkout(refreshedWorkout);
        setCompletedMilesText(
          refreshedWorkout.completedMiles != null ? String(refreshedWorkout.completedMiles) : ""
        );
        setCompletedTimeText(String(refreshedWorkout.completedTime ?? ""));
        setSplitsText(String(refreshedWorkout.splitsOrPace ?? ""));
        setAdditionalFeedbackText(
          String(refreshedWorkout.additionalFeedback ?? refreshedWorkout.feedback ?? "")
        );
      }

      setSubmitStatus("saved");
      setLogSheetOpen(false);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? "Could not save log.");
      setSubmitStatus("error");
      setSubmitError(message);
      Alert.alert("Save failed", message);
    }
  }

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <Text>Loading...</Text>
      </View>
    );
  }

  if (!isSynthetic && !workout) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 20 }}>
        <Text style={{ fontWeight: "800", marginBottom: 12 }}>Workout not found.</Text>
        <Pressable
          onPress={leaveWorkoutDetail}
          style={{
            borderRadius: 12,
            backgroundColor: "#0f172a",
            paddingHorizontal: 16,
            paddingVertical: 10,
          }}
        >
          <Text style={{ color: "white", fontWeight: "800" }}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const athleteName = String(name ?? workout?.athleteName ?? "Athlete");
  const displayDate = isSynthetic ? String(date ?? "") : String(workout?.dateISO ?? "");
  const displaySession = isSynthetic ? normalizeSession(session) : String(workout?.session ?? "PM");

  const groupMatePreview = groupMateNames.slice(0, 4).join(", ");
  const hiddenGroupMateCount = Math.max(0, groupMateNames.length - 4);
  const prescribedFromMileage = workout
    ? resolvePrescribedText(store, String(workout.athleteId ?? ""), String(workout.dateISO), String(workout.session ?? "PM") as "AM" | "PM", weekStartsOn)
    : "";
  const prescribedLabel = String(isSynthetic ? String(prescribed ?? "") : prescribedFromMileage).trim();
  const completedSummaryParts: string[] = [];
  if (completedMilesText.trim()) completedSummaryParts.push(`${completedMilesText.trim()} ${distanceUnitLabel(distanceUnit).toUpperCase()}`);
  if (completedTimeText.trim()) completedSummaryParts.push(completedTimeText.trim());
  const completedSummary = completedSummaryParts.length > 0 ? completedSummaryParts.join(" • ") : "Not entered yet";
  const workoutCategoryNames = Array.from(
    new Set(
      (Array.isArray(workout?.categories) ? workout?.categories : [workout?.category ?? "Other"])
        .map((name) => String(name ?? "").trim())
        .filter(Boolean)
    )
  );
  const preRoutines = Array.from(
    new Set(
      (Array.isArray(workout?.preRoutineIds) ? workout?.preRoutineIds : [])
        .map((routineId) => routineById.get(String(routineId ?? "").trim()) ?? null)
        .filter((value): value is AuxiliaryRoutine => Boolean(value))
    )
  );
  const postRoutines = Array.from(
    new Set(
      (Array.isArray(workout?.postRoutineIds) ? workout?.postRoutineIds : [])
        .map((routineId) => routineById.get(String(routineId ?? "").trim()) ?? null)
        .filter((value): value is AuxiliaryRoutine => Boolean(value))
    )
  );
  const individualDetails = String(workout?.details ?? "").trim();
  const batchDetails = String(batchHeaderNotes || individualDetails).trim();
  const showIndividualDetails = Boolean(individualDetails && individualDetails !== batchDetails);

  return (
    <>
      <Stack.Screen
        options={{
          title: "Workout",
          headerRight: () => (
            <Pressable
              onPress={leaveWorkoutDetail}
              style={{ paddingHorizontal: 12 }}
            >
              <Text style={{ fontSize: 16, fontWeight: "600" }}>Done</Text>
            </Pressable>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 28, backgroundColor: "#f6f8fb", gap: 10 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 16, backgroundColor: "#ffffff", padding: 12 }}>
          <Text style={{ fontSize: 12, fontWeight: "900", letterSpacing: 0.6, color: "#64748b" }}>WORKOUT</Text>
          <Text style={{ marginTop: 4, fontSize: 22, fontWeight: "900", color: "#0f172a" }}>
            {isSynthetic ? `${displaySession} Session` : workout?.title || "Workout"}
          </Text>
          <Text style={{ marginTop: 5, color: "#475569", fontWeight: "700", lineHeight: 20 }}>
            {formatDisplayDate(displayDate)} • {displaySession}
            {!isSynthetic && workout?.time ? ` • ${workout.time}` : ""}
          </Text>
          {!isSynthetic && workout?.location ? (
            <Text style={{ marginTop: 4, color: "#334155", fontWeight: "700" }}>Location: {workout.location}</Text>
          ) : null}
          <Text style={{ marginTop: 8, color: "#334155", fontWeight: "800" }}>
            {prescribedLabel ? `Prescribed: ${prescribedLabel}` : "Prescribed from mileage plan"}
          </Text>
        </View>

        {!isSynthetic && workoutCategoryNames.length > 0 ? (
          <View style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 16, backgroundColor: "#ffffff", padding: 12 }}>
            <Text style={{ fontSize: 12, fontWeight: "900", letterSpacing: 0.6, color: "#64748b" }}>CATEGORIES</Text>
            <View style={{ marginTop: 8, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {workoutCategoryNames.map((name) => {
                const color = categoryColorByName(categories, name);
                return (
                  <View key={name} style={{ flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 999, borderWidth: 1, borderColor: color, paddingHorizontal: 9, paddingVertical: 4 }}>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
                    <Text style={{ fontSize: 12, fontWeight: "900", color: "#334155" }}>{name}</Text>
                  </View>
                );
              })}
            </View>
          </View>
        ) : null}

        <View style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 16, backgroundColor: "#ffffff", padding: 12 }}>
          <Text style={{ fontSize: 12, fontWeight: "900", letterSpacing: 0.6, color: "#64748b" }}>DETAILS</Text>
          {batchDetails ? (
            <>
              <Text style={{ marginTop: 8, fontWeight: "900", color: "#0f172a" }}>Workout details</Text>
              <Text style={{ marginTop: 4, color: "#111827", lineHeight: 20 }}>{batchDetails}</Text>
            </>
          ) : null}
          {showIndividualDetails ? (
            <>
              <Text style={{ marginTop: 10, fontWeight: "900", color: "#0f172a" }}>Individual details</Text>
              <Text style={{ marginTop: 4, color: "#111827", lineHeight: 20 }}>{individualDetails}</Text>
            </>
          ) : null}
          {!batchDetails && !showIndividualDetails ? (
            <Text style={{ marginTop: 8, color: "#64748b", fontWeight: "700" }}>No additional workout details.</Text>
          ) : null}
        </View>

        {preRoutines.length > 0 || postRoutines.length > 0 ? (
          <View style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 16, backgroundColor: "#ffffff", padding: 12, gap: 10 }}>
            <Text style={{ fontSize: 12, fontWeight: "900", letterSpacing: 0.6, color: "#64748b" }}>ROUTINES</Text>
            {preRoutines.map((routine) => (
              <View key={`pre-${routine.id}`} style={{ borderTopWidth: 1, borderTopColor: "#f1f5f9", paddingTop: 8 }}>
                <Text style={{ fontWeight: "900", color: "#0f172a" }}>Pre-run: {routine.title}</Text>
                {routine.details ? <Text style={{ marginTop: 4, color: "#475569", lineHeight: 19 }}>{routine.details}</Text> : null}
              </View>
            ))}
            {postRoutines.map((routine) => (
              <View key={`post-${routine.id}`} style={{ borderTopWidth: 1, borderTopColor: "#f1f5f9", paddingTop: 8 }}>
                <Text style={{ fontWeight: "900", color: "#0f172a" }}>Post-run: {routine.title}</Text>
                {routine.details ? <Text style={{ marginTop: 4, color: "#475569", lineHeight: 19 }}>{routine.details}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}

        {!isSynthetic ? (
          <View style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 16, backgroundColor: "#ffffff", padding: 12, gap: 8 }}>
            <Text style={{ fontSize: 12, fontWeight: "900", letterSpacing: 0.6, color: "#64748b" }}>ATHLETES</Text>
            <Text style={{ fontWeight: "900", color: "#0f172a" }}>Your group</Text>
            <Text style={{ color: "#475569", lineHeight: 19 }}>
              {groupMateNames.length > 0
                ? `${athleteName}, ${groupMatePreview}${hiddenGroupMateCount > 0 ? ` +${hiddenGroupMateCount} more` : ""}`
                : athleteName}
            </Text>
            <Text style={{ marginTop: 6, fontWeight: "900", color: "#0f172a" }}>Entire workout batch</Text>
            <Text style={{ color: "#475569", lineHeight: 19 }}>
              {batchAthleteNames.length > 0 ? batchAthleteNames.join(", ") : "Batch roster is not available for this workout."}
            </Text>
          </View>
        ) : null}

        <View style={{ borderWidth: 1, borderColor: "#dbeafe", borderRadius: 14, padding: 10, backgroundColor: "#f8fafc" }}>
          <Text style={{ fontSize: 12, fontWeight: "900", letterSpacing: 0.4, color: "#475569" }}>LOG SUMMARY</Text>
          <Text style={{ marginTop: 6, fontSize: 13, fontWeight: "700", color: "#0f172a" }}>Prescribed: {prescribedLabel || "Not set"}</Text>
          <Text style={{ marginTop: 2, fontSize: 13, color: "#334155" }}>Completed: {completedSummary}</Text>
          <View style={{ marginTop: 6 }}>
            <InlineSaveStatus status={submitStatus} message={submitError} size="md" />
          </View>
        </View>

        <Pressable
          onPress={() => setLogSheetOpen(true)}
          disabled={submitStatus === "saving"}
          style={{
            backgroundColor: "#0f172a",
            paddingVertical: 14,
            borderRadius: 14,
            alignItems: "center",
            opacity: submitStatus === "saving" ? 0.7 : 1,
          }}
        >
          <Text style={{ color: "white", fontWeight: "900", fontSize: 16 }}>
            {completedMilesText.trim() || completedTimeText.trim() || splitsText.trim() || additionalFeedbackText.trim() ? "Edit log" : "Enter log"}
          </Text>
        </Pressable>
      </ScrollView>

      <AthleteQuickFeedbackSheet
        visible={logSheetOpen}
        title={`${displaySession} Log`}
        subtitle={formatDisplayDate(displayDate)}
        planSummary={prescribedLabel ? `Prescribed: ${prescribedLabel}` : ""}
        completedMilesText={completedMilesText}
        completedTimeText={completedTimeText}
        splitsText={splitsText}
        additionalFeedbackText={additionalFeedbackText}
        saving={submitStatus === "saving"}
        error={submitError}
        onChangeCompletedMiles={onChangeCompletedMiles}
        onChangeCompletedTime={setCompletedTimeText}
        onChangeSplits={setSplitsText}
        onChangeAdditionalFeedback={setAdditionalFeedbackText}
        onCancel={() => {
          if (submitStatus !== "saving") setLogSheetOpen(false);
        }}
        onSave={() => void submitFeedback()}
      />
    </>
  );
}
