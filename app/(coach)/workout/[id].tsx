import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { WorkoutCategory } from "../../../lib/types";
import { type DistanceUnit } from "../../../lib/units";
import { createWorkoutTemplateFromSource } from "../../../lib/workoutTemplates";
import { getCurrentTeamId } from "../../../lib/team";
import { getCategoryOptions, loadCoachSettings } from "../../../lib/settings";

import {
  deleteTeamWorkout,
  getTeamWorkoutById,
  listTeamWorkoutsByBatch,
  updateTeamWorkoutById,
  updateTeamWorkout,
  type TeamWorkoutRow,
} from "../../../lib/teamWorkoutsCloud";
import { loadRosterNameMapForTeam, type RosterMap } from "../../../lib/rosterNameMap";
import { compareAthleteDisplayNamesByLastName, resolveAthleteDisplayName } from "../../../lib/teamRoster";

const IOS_ACCESSORY_ID = "edit-workout-accessory";

function normalizeGroupId(groupId?: string): string {
  const digits = String(groupId ?? "").replace(/[^\d]/g, "");
  if (!digits) return "1";
  const parsed = Number(digits);
  if (!Number.isFinite(parsed) || parsed <= 0) return "1";
  return String(Math.floor(parsed));
}

function splitIntoKGroups<T>(items: T[], k: number): T[][] {
  if (k <= 1) return [items];
  const groups: T[][] = Array.from({ length: k }, () => []);
  items.forEach((item, i) => groups[i % k].push(item));
  return groups.filter((group) => group.length > 0);
}

function splitIntoPairs<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2));
  if (out.length >= 2 && out[out.length - 1].length === 1) {
    out[out.length - 2] = out[out.length - 2].concat(out.pop() as T[]);
  }
  return out;
}

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function EditWorkoutCloud() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const titleRef = useRef<TextInput>(null);
  const detailsRef = useRef<TextInput>(null);

  const [workout, setWorkout] = useState<TeamWorkoutRow | null>(null);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [session, setSession] = useState<"AM" | "PM">("PM");
  const [batchWorkouts, setBatchWorkouts] = useState<TeamWorkoutRow[]>([]);
  const [groupDraftByWorkoutId, setGroupDraftByWorkoutId] = useState<Record<string, string>>({});
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [loading, setLoading] = useState(true);

  const [rosterNameById, setRosterNameById] = useState<RosterMap>(new Map());

  const headerTitle = useMemo(() => {
    if (!workout) return "Edit Workout";
    const name = resolveAthleteDisplayName(workout.athlete_profile_id, rosterNameById);
    return name ? name : "Edit Workout";
  }, [workout, rosterNameById]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        setLoading(true);

        const [settings] = await Promise.all([
          loadCoachSettings(),
        ]);

        const teamId = await getCurrentTeamId();
        const rosterMap = await loadRosterNameMapForTeam(teamId);

        const found = await getTeamWorkoutById(id);
        if (!mounted) return;

        if (!found) {
          setCategories(getCategoryOptions(settings));
          setDistanceUnit(settings.distanceUnit);
          setWorkout(null);
          setBatchWorkouts([]);
          setGroupDraftByWorkoutId({});
          setLoading(false);
          return;
        }

        const inBatch = found.batch_id ? await listTeamWorkoutsByBatch(found.batch_id) : [];
        const groupDraft = inBatch.reduce<Record<string, string>>((acc, item) => {
          acc[item.id] = normalizeGroupId(item.group_id ?? undefined);
          return acc;
        }, {});

        setCategories(getCategoryOptions(settings));
        setDistanceUnit(settings.distanceUnit);
        setRosterNameById(rosterMap);

        setWorkout(found);
        setSession(found.session === "AM" ? "AM" : "PM");
        setBatchWorkouts(inBatch);
        setGroupDraftByWorkoutId(groupDraft);
        setLoading(false);
      } catch (e: any) {
        if (!mounted) return;
        Alert.alert("Load failed", e?.message ?? "Could not load workout.");
        setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [id]);

  const dismissKeyboard = useCallback(() => {
    titleRef.current?.blur();
    detailsRef.current?.blur();
    Keyboard.dismiss();
  }, []);

  const sortedBatchWorkouts = useMemo(() => {
    const nameOf = (w: TeamWorkoutRow) =>
      resolveAthleteDisplayName(w.athlete_profile_id, rosterNameById, String((w as any).athlete_name ?? ""));
    return [...batchWorkouts].sort((a, b) =>
      compareAthleteDisplayNamesByLastName(String(nameOf(a)), String(nameOf(b)))
    );
  }, [batchWorkouts, rosterNameById]);

  async function saveChanges() {
    if (!workout) return;

    const selectedCategoryNames =
      Array.isArray(workout.categories) && workout.categories.length > 0
        ? workout.categories
        : workout.primary_category
          ? [workout.primary_category]
          : ["Other"];

    const patch: Partial<TeamWorkoutRow> = {
      session,
      title: String(workout.title ?? "").trim() || "Workout",
      details: String(workout.details ?? "").trim() || null,
      time_text: String(workout.time_text ?? "").trim() || null,
      categories: selectedCategoryNames,
      primary_category: selectedCategoryNames[0] ?? "Other",
    };

    await updateTeamWorkout(workout.id, patch);

    // refresh the row to remove ambiguity
    const fresh = await getTeamWorkoutById(workout.id);
    setWorkout(fresh);

    Alert.alert("Saved", "Workout updated.");
    router.back();
  }

  function applyGrouping(groups: TeamWorkoutRow[][]) {
    const assignments: Record<string, string> = {};
    groups.forEach((group, idx) => {
      const label = String(idx + 1);
      group.forEach((item) => {
        assignments[item.id] = label;
      });
    });
    setGroupDraftByWorkoutId((prev) => ({ ...prev, ...assignments }));
  }

  async function saveGroupUpdates() {
    if (!workout?.batch_id) return;

    try {
      // Update all batch rows one by one (simple + reliable for now)
      // You can optimize into a single RPC later.
      for (const item of batchWorkouts) {
        const nextGroup = normalizeGroupId(groupDraftByWorkoutId[item.id]);
        await updateTeamWorkoutById(item.id, { group_id: nextGroup });
      }

      const updatedBatch = await listTeamWorkoutsByBatch(workout.batch_id);
      setBatchWorkouts(updatedBatch);

      const updatedWorkout = await getTeamWorkoutById(workout.id);
      setWorkout(updatedWorkout);

      Alert.alert("Groups saved", "Batch groups were updated.");
    } catch (e: any) {
      Alert.alert("Group save failed", e?.message ?? "Could not save groups.");
    }
  }

  async function saveCurrentAsTemplate() {
    if (!workout) return;

    await createWorkoutTemplateFromSource({
      title: String(workout.title ?? "").trim() || "Workout",
      details: String(workout.details ?? "").trim(),
      categories: Array.isArray(workout.categories) ? workout.categories : [],
      primary_category: String(workout.primary_category ?? "").trim() || null,
      location: String(workout.location ?? "").trim() || null,
      session: workout.session,
    });

    Alert.alert("Saved", "Workout template added to Saved Workouts.");
  }

  async function removeWorkout() {
    if (!workout) return;

    Alert.alert("Delete workout?", "This will permanently remove this assigned workout.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteTeamWorkout(workout.id);
            Alert.alert("Deleted", "Workout removed.");
            router.replace("/(coach)/workouts");
          } catch (e: any) {
            Alert.alert("Delete failed", e?.message ?? "Could not delete workout.");
          }
        },
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

  if (!workout) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 20 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 8 }}>Workout not found</Text>
        <Pressable
          onPress={() => router.back()}
          style={{
            backgroundColor: "black",
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: 10,
          }}
        >
          <Text style={{ color: "white", fontWeight: "700" }}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: headerTitle }} />

      <TouchableWithoutFeedback onPress={dismissKeyboard} accessible={false}>
        <KeyboardAvoidingView
          style={{ flex: 1, backgroundColor: "white" }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
            contentContainerStyle={{ padding: 20, paddingBottom: 36 }}
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={{ fontSize: 15, marginBottom: 14, color: "#444" }}>
              {formatDisplayDate(workout.date_iso)} • {session}
              {workout.time_text ? ` • ${workout.time_text}` : ""}
              {" • "}
              {(Array.isArray(workout.categories) && workout.categories.length > 0
                ? workout.categories.join(", ")
                : workout.primary_category) ?? "Other"}
            </Text>

            {workout.batch_id && sortedBatchWorkouts.length > 0 ? (
              <View
                style={{
                  marginBottom: 16,
                  padding: 12,
                  borderWidth: 1,
                  borderColor: "#e4e4e4",
                  borderRadius: 12,
                  backgroundColor: "#fafafa",
                }}
              >
                <Text style={{ fontWeight: "800", fontSize: 16 }}>Groups</Text>
                <Text style={{ marginTop: 4, fontSize: 12, color: "#666" }}>
                  {sortedBatchWorkouts.length} athletes
                </Text>

                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10, marginBottom: 8 }}>
                  <Pressable
                    onPress={() => applyGrouping(splitIntoPairs(sortedBatchWorkouts))}
                    style={{
                      borderWidth: 1,
                      borderColor: "#ddd",
                      borderRadius: 10,
                      paddingVertical: 8,
                      paddingHorizontal: 10,
                      backgroundColor: "white",
                    }}
                  >
                    <Text style={{ fontWeight: "700" }}>Split into pairs</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => applyGrouping(splitIntoKGroups(sortedBatchWorkouts, 3))}
                    style={{
                      borderWidth: 1,
                      borderColor: "#ddd",
                      borderRadius: 10,
                      paddingVertical: 8,
                      paddingHorizontal: 10,
                      backgroundColor: "white",
                    }}
                  >
                    <Text style={{ fontWeight: "700" }}>Split into 3 groups</Text>
                  </Pressable>

                  <Pressable
                    onPress={() =>
                      setGroupDraftByWorkoutId((prev) => {
                        const next = { ...prev };
                        sortedBatchWorkouts.forEach((item) => {
                          next[item.id] = "1";
                        });
                        return next;
                      })
                    }
                    style={{
                      borderWidth: 1,
                      borderColor: "#ddd",
                      borderRadius: 10,
                      paddingVertical: 8,
                      paddingHorizontal: 10,
                      backgroundColor: "white",
                    }}
                  >
                    <Text style={{ fontWeight: "700" }}>Clear groups</Text>
                  </Pressable>
                </View>

                {sortedBatchWorkouts.map((item) => {
                  const displayName = resolveAthleteDisplayName(
                    item.athlete_profile_id,
                    rosterNameById,
                    String((item as any).athlete_name ?? "")
                  );
                  const groupId = normalizeGroupId(groupDraftByWorkoutId[item.id]);
                  return (
                    <View
                      key={item.id}
                      style={{
                        flexDirection: "row",
                        justifyContent: "space-between",
                        alignItems: "center",
                        paddingVertical: 6,
                        borderBottomWidth: 1,
                        borderBottomColor: "#ededed",
                      }}
                    >
                      <Text style={{ fontWeight: "600", color: "#111", flex: 1, marginRight: 10 }}>{displayName}</Text>
                      <Text style={{ fontWeight: "900", color: "#333" }}>Group {groupId}</Text>
                    </View>
                  );
                })}

                <Pressable
                  onPress={saveGroupUpdates}
                  style={{
                    marginTop: 12,
                    backgroundColor: "#111",
                    borderRadius: 10,
                    paddingVertical: 10,
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: "white", fontWeight: "800" }}>Save Group Updates</Text>
                </Pressable>
              </View>
            ) : null}

            <View style={{ flexDirection: "row", gap: 10, marginTop: 12, marginBottom: 12 }}>
              {(["AM", "PM"] as const).map((s) => {
                const active = session === s;
                return (
                  <Pressable
                    key={s}
                    onPress={() => setSession(s)}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: active ? "#111" : "#ddd",
                      backgroundColor: active ? "#111" : "#fff",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ fontWeight: "900", color: active ? "#fff" : "#111" }}>{s}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={{ fontWeight: "600", marginBottom: 6 }}>Title</Text>
            <TextInput
              ref={titleRef}
              value={workout.title ?? ""}
              onChangeText={(text) => setWorkout({ ...workout, title: text })}
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={dismissKeyboard}
              inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
              style={{
                borderWidth: 1,
                borderColor: "#d0d0d0",
                padding: 12,
                borderRadius: 10,
                marginBottom: 14,
                backgroundColor: "white",
              }}
            />

            <Text style={{ fontWeight: "600", marginBottom: 6 }}>Workout Details</Text>
            <TextInput
              ref={detailsRef}
              value={workout.details ?? ""}
              onChangeText={(text) => setWorkout({ ...workout, details: text })}
              multiline
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={dismissKeyboard}
              style={{
                borderWidth: 1,
                borderColor: "#d0d0d0",
                padding: 12,
                borderRadius: 10,
                minHeight: 140,
                marginBottom: 14,
                textAlignVertical: "top",
                backgroundColor: "white",
              }}
              inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
            />

            <Text style={{ fontWeight: "600", marginBottom: 6 }}>Time (optional)</Text>
            <TextInput
              value={workout.time_text ?? ""}
              onChangeText={(text) => setWorkout({ ...workout, time_text: text })}
              placeholder="e.g., 12:00 PM"
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={dismissKeyboard}
              inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
              style={{
                borderWidth: 1,
                borderColor: "#d0d0d0",
                padding: 12,
                borderRadius: 10,
                marginBottom: 14,
                backgroundColor: "white",
              }}
            />

            <Text style={{ fontWeight: "600", marginBottom: 8 }}>Categories</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
              {categories.map((cat) => {
                const selected =
                  Array.isArray(workout.categories) && workout.categories.length > 0
                    ? workout.categories
                    : [String(workout.primary_category ?? "").trim() || "Other"];
                const active = selected.includes(cat.name);
                return (
                  <Pressable
                    key={`edit-cat-${cat.id}`}
                    onPress={() => {
                      const next = active
                        ? selected.filter((name) => name !== cat.name)
                        : [...selected, cat.name];
                      const normalized = next.length > 0 ? next : ["Other"];
                      setWorkout({
                        ...workout,
                        categories: normalized,
                        primary_category: normalized[0],
                      });
                    }}
                    style={{
                      borderWidth: 1,
                      borderColor: active ? (cat.color ?? "#111") : "#ddd",
                      borderRadius: 999,
                      paddingVertical: 8,
                      paddingHorizontal: 10,
                      backgroundColor: active
                        ? (cat.color ? `${cat.color}22` : "rgba(0,0,0,0.08)")
                        : "#fff",
                    }}
                  >
                    <Text style={{ fontWeight: "800", color: "#111" }}>{cat.name}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* NOTE:
                Your team_workouts schema does not currently include completedMiles/feedback fields.
                We'll add an athlete_feedback table later if you want this back on the coach screen. */}

            <Pressable
              onPress={saveCurrentAsTemplate}
              style={{
                marginBottom: 10,
                borderWidth: 1,
                borderColor: "#111",
                backgroundColor: "#fff",
                paddingVertical: 12,
                borderRadius: 12,
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#111", fontWeight: "700" }}>Save As Template</Text>
            </Pressable>

            <Pressable
              onPress={async () => {
                dismissKeyboard();
                await saveChanges();
              }}
              style={{
                backgroundColor: "black",
                paddingVertical: 14,
                borderRadius: 12,
                alignItems: "center",
              }}
            >
              <Text style={{ color: "white", fontWeight: "700" }}>Save Changes</Text>
            </Pressable>

            <Pressable
              onPress={removeWorkout}
              style={{
                marginTop: 10,
                borderWidth: 1,
                borderColor: "#cc0000",
                backgroundColor: "white",
                paddingVertical: 12,
                borderRadius: 12,
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#cc0000", fontWeight: "700" }}>Delete Workout</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </TouchableWithoutFeedback>

      {Platform.OS === "ios" ? (
        <InputAccessoryView nativeID={IOS_ACCESSORY_ID}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-end",
              alignItems: "center",
              borderTopWidth: 1,
              borderColor: "#d6d6d6",
              backgroundColor: "#f2f2f2",
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
            <Pressable onPress={dismissKeyboard}>
              <Text style={{ fontSize: 16, fontWeight: "700", color: "#007aff" }}>Done</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </>
  );
}
