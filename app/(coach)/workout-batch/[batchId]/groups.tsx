import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";

import { getCurrentTeamId } from "../../../../lib/team";
import {
  compareAthleteDisplayNamesByLastName,
  loadTeamRoster,
  resolveAthleteDisplayName,
  toRosterMapById,
  type TeamRosterAthlete,
} from "../../../../lib/teamRoster";
import {
  listTeamWorkoutsByBatch,
  type TeamWorkoutRow,
  updateTeamWorkoutById,
} from "../../../../lib/teamWorkoutsCloud";

type EditableGroupRow = {
  workoutId: string;
  athleteProfileId: string;
  athleteName: string;
  firstName: string;
  lastName: string;
  groupNumber: number;
};

function parseName(name: string) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function normalizeGroupNumber(raw: unknown) {
  const n = Number(String(raw ?? "").replace(/[^\d]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.floor(n);
}

export default function BatchGroupAssignmentScreen() {
  const { batchId, returnTo, returnDate } = useLocalSearchParams<{
    batchId: string;
    returnTo?: string;
    returnDate?: string;
  }>();

  const router = useRouter();

  const [rows, setRows] = useState<EditableGroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Snapshot of initial groups so we only update changed rows on save
  const initialGroupByWorkoutId = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        setLoading(true);

        const teamId = await getCurrentTeamId();
        const [roster, batch] = await Promise.all([
          loadTeamRoster(teamId),
          listTeamWorkoutsByBatch(String(batchId)),
        ]);
        const rosterMap = toRosterMapById(roster);
        const rosterById = new Map<string, TeamRosterAthlete>(roster.map((item) => [item.id, item]));

        const mapped: EditableGroupRow[] = (batch ?? []).map((w: TeamWorkoutRow) => {
          const athleteProfileId = String(w.athlete_profile_id ?? "").trim();
          const chosenName = resolveAthleteDisplayName(
            athleteProfileId,
            rosterMap,
            String((w as any).athlete_name ?? "").trim()
          );
          const rosterAthlete = rosterById.get(athleteProfileId) ?? null;
          const split = rosterAthlete
            ? { firstName: rosterAthlete.firstName, lastName: rosterAthlete.lastName }
            : parseName(chosenName);
          const groupNumber = normalizeGroupNumber((w as any).group_id);

          return {
            workoutId: String(w.id),
            athleteProfileId,
            athleteName: chosenName,
            firstName: String(split.firstName ?? "").trim(),
            lastName: String(split.lastName ?? "").trim(),
            groupNumber,
          };
        });

        mapped.sort((a, b) => {
          return compareAthleteDisplayNamesByLastName(a.athleteName, b.athleteName);
        });

        if (!mounted) return;

        // Store initial groups for "only update changes"
        initialGroupByWorkoutId.current = new Map(mapped.map((r) => [r.workoutId, r.groupNumber]));

        setRows(mapped);
        setLoading(false);
      } catch (e: any) {
        if (!mounted) return;
        setLoading(false);
        Alert.alert("Load failed", e?.message ?? "Could not load group assignment.");
      }
    })();

    return () => {
      mounted = false;
    };
  }, [batchId]);

  const uniqueGroupCount = useMemo(() => {
    return new Set(rows.map((r) => r.groupNumber)).size;
  }, [rows]);

  function updateGroup(workoutId: string, delta: number) {
    setRows((prev) =>
      prev.map((row) =>
        row.workoutId === workoutId
          ? { ...row, groupNumber: Math.max(1, row.groupNumber + delta) }
          : row
      )
    );
  }

  async function saveGroupAssignments() {
    if (!batchId) return;

    setSaving(true);
    try {
      const teamId = await getCurrentTeamId();

      // Only update changed rows
      const initial = initialGroupByWorkoutId.current;
      const changed = rows.filter((r) => (initial.get(r.workoutId) ?? r.groupNumber) !== r.groupNumber);

      if (changed.length === 0) return;

      await Promise.all(
        changed.map((r) => {
          const nextGroup = String(Math.max(1, r.groupNumber));
          return updateTeamWorkoutById(r.workoutId, { group_id: nextGroup });
        })
      );

      // Refresh snapshot so subsequent saves only push new changes
      initialGroupByWorkoutId.current = new Map(rows.map((r) => [r.workoutId, r.groupNumber]));
    } finally {
      setSaving(false);
    }
  }

  function continueToEditor() {
    router.replace({
      pathname: "/(coach)/workout-batch/[batchId]",
      params: {
        batchId: String(batchId),
        returnTo: String(returnTo ?? ""),
        returnDate: String(returnDate ?? ""),
      },
    });
  }

  async function onSave() {
    try {
      await saveGroupAssignments();
      Alert.alert("Saved", "Group assignments updated.");
    } catch (e: any) {
      Alert.alert("Save failed", e?.message ?? "Could not save group assignments.");
    }
  }

  async function onContinue() {
    try {
      await saveGroupAssignments();
      continueToEditor();
    } catch (e: any) {
      Alert.alert("Save failed", e?.message ?? "Could not save group assignments.");
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Text>Loading...</Text>
      </View>
    );
  }

  if (!batchId || rows.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>Batch not found</Text>
        <Pressable style={styles.primaryBtn} onPress={() => router.back()}>
          <Text style={styles.primaryBtnText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Assign Groups" }} />

      <ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
        <Text style={styles.title}>Assign Groups</Text>
        <Text style={styles.subtitle}>
          {rows.length} athletes • {uniqueGroupCount} group{uniqueGroupCount === 1 ? "" : "s"}
        </Text>

        <View style={styles.card}>
          {rows.map((row) => (
            <View key={row.workoutId} style={styles.row}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={styles.name}>{row.athleteName}</Text>
              </View>

              <View style={styles.stepperWrap}>
                <Pressable style={styles.stepperBtn} onPress={() => updateGroup(row.workoutId, -1)}>
                  <Text style={styles.stepperBtnText}>−</Text>
                </Pressable>
                <View style={styles.stepperValueWrap}>
                  <Text style={styles.stepperValue}>{row.groupNumber}</Text>
                </View>
                <Pressable style={styles.stepperBtn} onPress={() => updateGroup(row.workoutId, 1)}>
                  <Text style={styles.stepperBtnText}>+</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.actionsRow}>
          <Pressable style={styles.secondaryBtn} onPress={onSave} disabled={saving}>
            <Text style={styles.secondaryBtnText}>{saving ? "Saving..." : "Save"}</Text>
          </Pressable>

          <Pressable style={styles.primaryBtn} onPress={onContinue} disabled={saving}>
            <Text style={styles.primaryBtnText}>{saving ? "Saving..." : "Continue To Editor"}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", paddingHorizontal: 16, paddingTop: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  title: { fontSize: 22, fontWeight: "900", color: "#111" },
  subtitle: { marginTop: 4, marginBottom: 12, color: "#666", fontWeight: "700" },
  emptyTitle: { fontWeight: "800", marginBottom: 10 },
  card: { borderWidth: 1, borderColor: "#e8e8e8", borderRadius: 14, backgroundColor: "#fafafa", padding: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ededed",
    borderRadius: 10,
    backgroundColor: "#fff",
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 8,
  },
  name: { fontWeight: "800", color: "#111" },
  stepperWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepperBtn: {
    width: 34,
    height: 34,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#fafafa",
    alignItems: "center",
    justifyContent: "center",
  },
  stepperBtnText: { fontSize: 20, lineHeight: 20, fontWeight: "900", color: "#111" },
  stepperValueWrap: {
    minWidth: 48,
    borderWidth: 1,
    borderColor: "#e4e4e4",
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
    backgroundColor: "#fff",
  },
  stepperValue: { fontWeight: "900", color: "#111", fontSize: 17 },
  primaryBtn: {
    borderWidth: 1,
    borderColor: "#111",
    borderRadius: 12,
    backgroundColor: "#111",
    alignItems: "center",
    paddingVertical: 12,
    flex: 1,
  },
  primaryBtnText: { color: "#fff", fontWeight: "900" },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: "#d4d4d4",
    borderRadius: 12,
    backgroundColor: "#fff",
    alignItems: "center",
    paddingVertical: 12,
    flex: 1,
  },
  secondaryBtnText: { color: "#111", fontWeight: "800" },
  actionsRow: { marginTop: 14, flexDirection: "row", gap: 10 },
});
