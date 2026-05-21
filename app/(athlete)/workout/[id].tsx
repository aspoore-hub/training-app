import { useEffect, useRef, useState } from "react";
import {
  InputAccessoryView,
  View,
  Text,
  TextInput,
  Pressable,
  Alert,
  ScrollView,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { InlineSaveStatus } from "../../../components/shared/InlineSaveStatus";
import type { AthleteWorkout, WeekStartDay } from "../../../lib/types";
import {
  buildMileageFeedbackId,
  getMileageFeedbackById,
  type MileageSessionFeedback,
  upsertMileageFeedback,
} from "../../../lib/mileageFeedback";
import { distanceUnitLabel, loadDistanceUnit, type DistanceUnit } from "../../../lib/units";
import { loadAuxiliaryRoutines } from "../../../lib/auxiliaryRoutines";
import { parseNumericLike } from "../../../lib/feedbackParsing";
import { getCurrentTeamId } from "../../../lib/team";
import { loadRosterNameMapForTeam } from "../../../lib/rosterNameMap";
import { getTeamWorkoutById, listTeamWorkoutsInRange, updateTeamWorkoutById, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";
import { teamDataStore } from "../../../lib/teamDataStore";
import {
  getWeekIndex,
  getWeekStartISO,
} from "../../../lib/mileagePlan";
import { formatParsedWorkoutEntry, parseWorkoutEntryValue } from "../../../lib/workoutEntryParser";
import { loadWeekStartSetting } from "../../../lib/settings";

const IOS_ACCESSORY_ID = "athlete-workout-accessory";

function normalizeGroupId(groupId?: string): string {
  const normalized = String(groupId ?? "").trim().toUpperCase();
  return normalized || "A";
}

function normalizeSession(value: string | undefined): "AM" | "PM" {
  return String(value ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
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
    mileageCellsByWeek: ReturnType<typeof teamDataStore.use>["mileageCellsByWeek"];
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

  const cells = state.mileageCellsByWeek[weekStartISO] ?? [];
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
  } = useLocalSearchParams<{
    id: string;
    name?: string;
    synthetic?: string;
    date?: string;
    session?: string;
    prescribed?: string;
    athleteId?: string;
  }>();
  const router = useRouter();

  const isSynthetic = String(synthetic ?? "") === "1";

  const distanceRef = useRef<TextInput>(null);
  const timeRef = useRef<TextInput>(null);
  const splitsRef = useRef<TextInput>(null);
  const feedbackRef = useRef<TextInput>(null);

  const [workout, setWorkout] = useState<AthleteWorkout | null>(null);
  const [groupMateNames, setGroupMateNames] = useState<string[]>([]);
  const [routineTitleById, setRoutineTitleById] = useState<Map<string, string>>(new Map());
  const [completedMilesText, setCompletedMilesText] = useState("");
  const [completedTimeText, setCompletedTimeText] = useState("");
  const [splitsText, setSplitsText] = useState("");
  const [additionalFeedbackText, setAdditionalFeedbackText] = useState("");
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [loading, setLoading] = useState(true);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [submitStatus, setSubmitStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rosterMap, setRosterMap] = useState<Map<string, string>>(new Map());
  const store = teamDataStore.use();

  function dismissKeyboard() {
    distanceRef.current?.blur();
    timeRef.current?.blur();
    splitsRef.current?.blur();
    feedbackRef.current?.blur();
    Keyboard.dismiss();
  }

  function focusByOffset(delta: -1 | 1) {
    const fields = [distanceRef.current, timeRef.current, splitsRef.current, feedbackRef.current];
    const focused = fields.findIndex((ref) => ref?.isFocused?.());
    if (focused < 0) return;
    const next = focused + delta;
    if (next < 0 || next >= fields.length) return;
    fields[next]?.focus();
  }

  useEffect(() => {
    (async () => {
      const [rosterMap, unit, routines, weekStartResult] = await Promise.all([
        loadRosterAny(),
        loadDistanceUnit(),
        loadAuxiliaryRoutines(),
        loadWeekStartSetting(),
      ]);
      const resolvedWeekStart: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
      console.log("[athlete-workout] week start loaded via shared helper", {
        raw: weekStartResult.raw,
        normalized: resolvedWeekStart,
      });
      setRosterMap(rosterMap);
      setDistanceUnit(unit);
      setRoutineTitleById(new Map(routines.map((routine) => [routine.id, routine.title] as const)));
      setWeekStartsOn(resolvedWeekStart);

      const foundRow = await getTeamWorkoutById(String(id));
      const found = foundRow ? toAthleteWorkout(foundRow, rosterMap) : null;

      if (!isSynthetic && found) {
        setWorkout(found);
        setCompletedMilesText(found.completedMiles != null ? String(found.completedMiles) : "");
        setCompletedTimeText(String(found.completedTime ?? ""));
        setSplitsText(String(found.splitsOrPace ?? ""));
        setAdditionalFeedbackText(String(found.additionalFeedback ?? found.feedback ?? ""));

        if (found.batchId) {
          const groupId = normalizeGroupId(found.groupId);
          const peerRows = await listTeamWorkoutsInRange(String(found.dateISO), String(found.dateISO));
          const peers = peerRows
            .map((row) => toAthleteWorkout(row, rosterMap))
            .filter(
              (w) =>
                w.batchId === found.batchId &&
                normalizeGroupId(w.groupId) === groupId &&
                w.id !== found.id
            );
          const names = Array.from(
            new Set(
              peers
                .map((peer) => {
                  if (peer.athleteId) return rosterMap.get(peer.athleteId) ?? peer.athleteName;
                  return peer.athleteName;
                })
                .filter((value): value is string => Boolean(value && value.trim()))
            )
          );
          setGroupMateNames(names);
        } else {
          setGroupMateNames([]);
        }

        if (found?.athleteId && found?.dateISO) {
          void teamDataStore.actions.loadMileageWeek(
            getWeekStartISO(String(found.dateISO), resolvedWeekStart)
          );
        }
      }

      if (isSynthetic) {
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

        const refreshedRow = await getTeamWorkoutById(workout.id);
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
      Alert.alert("Submitted", "Your feedback was saved.", [
        {
          text: "OK",
          onPress: () => router.back(),
        },
      ]);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? "Could not save feedback.");
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
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <Text>Workout not found.</Text>
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
  const preRoutines = Array.from(
    new Set(
      (Array.isArray(workout?.preRoutineIds) ? workout?.preRoutineIds : [])
        .map((routineId) => routineTitleById.get(String(routineId ?? "").trim()) ?? null)
        .filter((value): value is string => Boolean(value))
    )
  );
  const postRoutines = Array.from(
    new Set(
      (Array.isArray(workout?.postRoutineIds) ? workout?.postRoutineIds : [])
        .map((routineId) => routineTitleById.get(String(routineId ?? "").trim()) ?? null)
        .filter((value): value is string => Boolean(value))
    )
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: "Workout",
          headerRight: () => (
            <Pressable
              onPress={() => {
                dismissKeyboard();
                router.back();
              }}
              style={{ paddingHorizontal: 12 }}
            >
              <Text style={{ fontSize: 16, fontWeight: "600" }}>Done</Text>
            </Pressable>
          ),
        }}
      />

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          contentContainerStyle={{ padding: 14, paddingBottom: 28, backgroundColor: "#f6f8fb" }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <View
            style={{
              borderWidth: 1,
              borderColor: "#e2e8f0",
              borderRadius: 16,
              backgroundColor: "#ffffff",
              padding: 12,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "900", letterSpacing: 0.6, color: "#64748b" }}>WORKOUT</Text>
            <Text style={{ marginTop: 4, fontSize: 21, fontWeight: "900", color: "#0f172a" }}>
              {isSynthetic ? `${displaySession} Session` : workout?.title || "Workout"}
            </Text>
            <Text style={{ marginTop: 5, color: "#475569", fontWeight: "700" }}>
              {formatDisplayDate(displayDate)} • {displaySession}
              {!isSynthetic && workout?.time ? ` • ${workout.time}` : ""}
              {!isSynthetic ? ` • ${workout?.category ?? ""}` : ""}
            </Text>
            <Text style={{ marginTop: 8, color: "#334155", fontWeight: "700" }}>
              {String(isSynthetic ? prescribed : prescribedFromMileage).trim()
                ? `Prescribed: ${String(isSynthetic ? prescribed : prescribedFromMileage).trim()}`
                : "Prescribed from mileage plan"}
            </Text>
            {!isSynthetic && workout?.details ? (
              <Text style={{ marginTop: 8, color: "#111827", lineHeight: 20 }}>{workout.details}</Text>
            ) : null}
            {preRoutines.length > 0 ? (
              <Text style={{ marginTop: 8, color: "#1f2937", fontWeight: "700" }}>Pre-run: {preRoutines.join(", ")}</Text>
            ) : null}
            {postRoutines.length > 0 ? (
              <Text style={{ marginTop: 4, color: "#1f2937", fontWeight: "700" }}>Post-run: {postRoutines.join(", ")}</Text>
            ) : null}
            {groupMateNames.length > 0 ? (
              <Text style={{ marginTop: 7, color: "#444", fontWeight: "600" }}>
                Working out with: {groupMatePreview}
                {hiddenGroupMateCount > 0 ? ` +${hiddenGroupMateCount} more` : ""}
              </Text>
            ) : null}
          </View>

          <View
            style={{
              marginTop: 10,
              borderWidth: 1,
              borderColor: "#dbeafe",
              borderRadius: 14,
              padding: 10,
              backgroundColor: "#f8fafc",
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "900", letterSpacing: 0.4, color: "#475569" }}>
              FEEDBACK SUMMARY
            </Text>
            <Text style={{ marginTop: 6, fontSize: 13, fontWeight: "700", color: "#0f172a" }}>
              Prescribed: {prescribedLabel || "Not set"}
            </Text>
            <Text style={{ marginTop: 2, fontSize: 13, color: "#334155" }}>
              Completed: {completedSummary}
            </Text>
            <View style={{ marginTop: 6 }}>
              <InlineSaveStatus status={submitStatus} message={submitError} size="md" />
            </View>
          </View>

          <View
            style={{
              marginTop: 10,
              borderWidth: 1,
              borderColor: "#e2e8f0",
              borderRadius: 16,
              backgroundColor: "#ffffff",
              padding: 12,
            }}
          >
          <Text style={{ fontSize: 12, fontWeight: "900", letterSpacing: 0.6, color: "#64748b" }}>YOUR FEEDBACK</Text>
          <Text style={{ marginTop: 6, fontWeight: "700", color: "#0f172a" }}>Distance Completed ({distanceUnitLabel(distanceUnit).toUpperCase()})</Text>
          <TextInput
            ref={distanceRef}
            inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
            value={completedMilesText}
            onChangeText={onChangeCompletedMiles}
            keyboardType="decimal-pad"
            placeholder="e.g. 6.25"
            style={{
              borderWidth: 1,
              borderColor: "#cbd5e1",
              padding: 10,
              borderRadius: 10,
              marginTop: 5,
              marginBottom: 10,
              backgroundColor: "white",
            }}
          />

          <Text style={{ fontWeight: "700", color: "#0f172a" }}>Time Completed</Text>
          <TextInput
            ref={timeRef}
            inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
            value={completedTimeText}
            onChangeText={setCompletedTimeText}
            placeholder="e.g. 42:30"
            style={{
              borderWidth: 1,
              borderColor: "#cbd5e1",
              padding: 10,
              borderRadius: 10,
              marginTop: 5,
              marginBottom: 10,
              backgroundColor: "white",
            }}
          />

          <Text style={{ fontWeight: "700", color: "#0f172a" }}>Workout Splits / Pace</Text>
          <TextInput
            ref={splitsRef}
            inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
            value={splitsText}
            onChangeText={setSplitsText}
            multiline
            placeholder="Example: 5x1k @ 3:04, 3:03, 3:02, 3:03, 3:01"
            style={{
              borderWidth: 1,
              borderColor: "#cbd5e1",
              padding: 10,
              borderRadius: 10,
              minHeight: 88,
              marginTop: 5,
              marginBottom: 10,
              textAlignVertical: "top",
              backgroundColor: "white",
            }}
          />

          <Text style={{ fontWeight: "700", color: "#0f172a" }}>Additional Feedback</Text>
          <TextInput
            ref={feedbackRef}
            inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
            value={additionalFeedbackText}
            onChangeText={setAdditionalFeedbackText}
            multiline
            placeholder="How did it feel? Anything your coach should know?"
            style={{
              borderWidth: 1,
              borderColor: "#cbd5e1",
              padding: 10,
              borderRadius: 10,
              minHeight: 104,
              marginTop: 5,
              marginBottom: 10,
              textAlignVertical: "top",
              backgroundColor: "white",
            }}
          />

          <Pressable
            onPress={() => {
              dismissKeyboard();
              submitFeedback();
            }}
            disabled={submitStatus === "saving"}
            style={{
              backgroundColor: "#0f172a",
              paddingVertical: 13,
              borderRadius: 12,
              alignItems: "center",
              opacity: submitStatus === "saving" ? 0.7 : 1,
            }}
          >
            <Text style={{ color: "white", fontWeight: "800", fontSize: 16 }}>Submit Feedback</Text>
          </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {Platform.OS === "ios" ? (
        <InputAccessoryView nativeID={IOS_ACCESSORY_ID}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderTopWidth: 1,
              borderTopColor: "#e5e5e5",
              backgroundColor: "#f8f8f8",
            }}
          >
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable onPress={() => focusByOffset(-1)} style={{ paddingVertical: 6, paddingHorizontal: 10 }}>
                <Text style={{ fontWeight: "800", color: "#111" }}>↑</Text>
              </Pressable>
              <Pressable onPress={() => focusByOffset(1)} style={{ paddingVertical: 6, paddingHorizontal: 10 }}>
                <Text style={{ fontWeight: "800", color: "#111" }}>↓</Text>
              </Pressable>
            </View>
            <Pressable onPress={dismissKeyboard} style={{ paddingVertical: 6, paddingHorizontal: 10 }}>
              <Text style={{ fontWeight: "900", color: "#111" }}>Done</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </>
  );
}
