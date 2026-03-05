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
import type { AthleteWorkout } from "../../../lib/types";
import {
  buildMileageFeedbackId,
  getMileageFeedbackById,
  type MileageSessionFeedback,
  upsertMileageFeedback,
} from "../../../lib/mileageFeedback";
import { distanceUnitLabel, loadDistanceUnit, type DistanceUnit } from "../../../lib/units";
import { loadAuxiliaryRoutines } from "../../../lib/auxiliaryRoutines";
import { getCurrentTeamId } from "../../../lib/team";
import { loadRosterNameMapForTeam } from "../../../lib/rosterNameMap";
import { getTeamWorkoutById, listTeamWorkoutsInRange, updateTeamWorkoutById, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";

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
    plannedMiles: typeof row.planned_distance === "number" ? row.planned_distance : undefined,
    completedMiles: typeof (row as any).completed_miles === "number" ? (row as any).completed_miles : undefined,
    completedTime: String((row as any).completed_time_text ?? "").trim() || undefined,
    splitsOrPace: String((row as any).splits_or_pace ?? "").trim() || undefined,
    additionalFeedback: String((row as any).additional_feedback ?? "").trim() || undefined,
    feedback: String((row as any).additional_feedback ?? "").trim() || undefined,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
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
      const [rosterMap, unit, routines] = await Promise.all([
        loadRosterAny(),
        loadDistanceUnit(),
        loadAuxiliaryRoutines(),
      ]);
      setDistanceUnit(unit);
      setRoutineTitleById(new Map(routines.map((routine) => [routine.id, routine.title] as const)));

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
    const parsedCompletedMiles = parseCompletedMiles(completedMilesText);
    const hasMilesInput = completedMilesText.trim().length > 0;

    if (hasMilesInput && parsedCompletedMiles === undefined) {
      Alert.alert("Invalid distance", "Enter a valid number up to two decimals.");
      return;
    }

    const hasAnyFeedback =
      parsedCompletedMiles != null ||
      completedTimeText.trim().length > 0 ||
      splitsText.trim().length > 0 ||
      additionalFeedbackText.trim().length > 0;

    if (!hasAnyFeedback) {
      Alert.alert("Nothing to submit", "Fill in at least one feedback field before submitting.");
      return;
    }

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
      } as any);

      setWorkout({
        ...workout,
        completedMiles: parsedCompletedMiles,
        completedTime: completedTimeText.trim() || undefined,
        splitsOrPace: splitsText.trim() || undefined,
        additionalFeedback: additionalFeedbackText.trim() || undefined,
        feedback: additionalFeedbackText.trim() || undefined,
      });
    }

    Alert.alert("Submitted", "Your feedback was saved.", [
      {
        text: "OK",
        onPress: () => router.back(),
      },
    ]);
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
          title: "Workout Feedback",
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
          contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <Text style={{ fontSize: 22, fontWeight: "700" }}>{athleteName}</Text>
          <Text style={{ marginTop: 6, opacity: 0.75 }}>
            {formatDisplayDate(displayDate)} • {displaySession}
            {!isSynthetic && workout?.time ? ` • ${workout.time}` : ""}
            {!isSynthetic ? ` • ${workout?.category ?? ""}` : ""}
          </Text>

          {isSynthetic ? (
            <>
              <Text style={{ marginTop: 12, fontWeight: "700" }}>{displaySession} Session</Text>
              <Text style={{ marginTop: 8 }}>{String(prescribed ?? "") ? `Prescribed: ${String(prescribed)}` : "Prescribed from mileage plan"}</Text>
            </>
          ) : (
            <>
              <Text style={{ marginTop: 12, fontWeight: "700" }}>{workout?.title || "Workout"}</Text>
              <Text style={{ marginTop: 8 }}>{workout?.details}</Text>
              {preRoutines.length > 0 ? (
                <Text style={{ marginTop: 8, color: "#333", fontWeight: "700" }}>Pre-run: {preRoutines.join(", ")}</Text>
              ) : null}
              {postRoutines.length > 0 ? (
                <Text style={{ marginTop: 4, color: "#333", fontWeight: "700" }}>Post-run: {postRoutines.join(", ")}</Text>
              ) : null}
              {groupMateNames.length > 0 ? (
                <Text style={{ marginTop: 8, color: "#444", fontWeight: "600" }}>
                  Working out with: {groupMatePreview}
                  {hiddenGroupMateCount > 0 ? ` +${hiddenGroupMateCount} more` : ""}
                </Text>
              ) : null}
            </>
          )}

          <View style={{ height: 18 }} />

          <Text style={{ fontWeight: "600" }}>Distance Completed ({distanceUnitLabel(distanceUnit).toUpperCase()})</Text>
          <TextInput
            ref={distanceRef}
            inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
            value={completedMilesText}
            onChangeText={onChangeCompletedMiles}
            keyboardType="decimal-pad"
            placeholder="e.g. 6.25"
            style={{
              borderWidth: 1,
              borderColor: "#ccc",
              padding: 10,
              borderRadius: 8,
              marginTop: 6,
              marginBottom: 14,
              backgroundColor: "white",
            }}
          />

          <Text style={{ fontWeight: "600" }}>Time Completed</Text>
          <TextInput
            ref={timeRef}
            inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
            value={completedTimeText}
            onChangeText={setCompletedTimeText}
            placeholder="e.g. 42:30"
            style={{
              borderWidth: 1,
              borderColor: "#ccc",
              padding: 10,
              borderRadius: 8,
              marginTop: 6,
              marginBottom: 14,
              backgroundColor: "white",
            }}
          />

          <Text style={{ fontWeight: "600" }}>Workout Splits / Pace</Text>
          <TextInput
            ref={splitsRef}
            inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
            value={splitsText}
            onChangeText={setSplitsText}
            multiline
            placeholder="Example: 5x1k @ 3:04, 3:03, 3:02, 3:03, 3:01"
            style={{
              borderWidth: 1,
              borderColor: "#ccc",
              padding: 10,
              borderRadius: 8,
              minHeight: 100,
              marginTop: 6,
              marginBottom: 14,
              textAlignVertical: "top",
              backgroundColor: "white",
            }}
          />

          <Text style={{ fontWeight: "600" }}>Additional Feedback</Text>
          <TextInput
            ref={feedbackRef}
            inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
            value={additionalFeedbackText}
            onChangeText={setAdditionalFeedbackText}
            multiline
            placeholder="How did it feel? Anything your coach should know?"
            style={{
              borderWidth: 1,
              borderColor: "#ccc",
              padding: 10,
              borderRadius: 8,
              minHeight: 120,
              marginTop: 6,
              marginBottom: 18,
              textAlignVertical: "top",
              backgroundColor: "white",
            }}
          />

          <Pressable
            onPress={() => {
              dismissKeyboard();
              submitFeedback();
            }}
            style={{
              backgroundColor: "black",
              padding: 14,
              borderRadius: 12,
              alignItems: "center",
            }}
          >
            <Text style={{ color: "white", fontWeight: "700" }}>Submit Feedback</Text>
          </Pressable>
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
