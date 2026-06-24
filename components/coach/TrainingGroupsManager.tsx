import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  isActiveTrainingGroupMembership,
  teamDataStore,
  type TeamTrainingGroup,
} from "../../lib/teamDataStore";
import { getSortableRoster, type TeamRosterAthlete } from "../../lib/teamRoster";

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

export function TrainingGroupsManager() {
  const teamStore = teamDataStore.use();
  const [roster, setRoster] = useState<TeamRosterAthlete[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupNameText, setGroupNameText] = useState("");
  const [draftAthleteIds, setDraftAthleteIds] = useState<string[]>([]);
  const [groupSaveBusy, setGroupSaveBusy] = useState(false);
  const [groupSaveError, setGroupSaveError] = useState<string | null>(null);
  const [groupSaveSuccess, setGroupSaveSuccess] = useState<string | null>(null);

  const loadManagerData = useCallback(async () => {
    try {
      const [loadedRoster] = await Promise.all([
        getSortableRoster(),
        teamDataStore.actions.loadTrainingGroups(true),
      ]);
      setRoster(loadedRoster);
    } catch (error) {
      Alert.alert("Training Groups load failed", getErrorMessage(error));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadManagerData();
    }, [loadManagerData])
  );

  useEffect(() => {
    void loadManagerData();
  }, [loadManagerData]);

  const rosterById = useMemo(() => {
    const map = new Map<string, TeamRosterAthlete>();
    for (const athlete of roster) map.set(athlete.id, athlete);
    return map;
  }, [roster]);

  const activeRoster = useMemo(
    () => roster.filter((athlete) => athlete.isActive !== false),
    [roster]
  );

  const sortedGroups = useMemo(
    () => [...(Array.isArray(teamStore.trainingGroups) ? teamStore.trainingGroups : [])].sort((a, b) => a.name.localeCompare(b.name)),
    [teamStore.trainingGroups]
  );

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
      console.log("[training-groups] save start", {
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
      console.log("[training-groups] post-save reload complete", {
        groupId: targetGroupId,
        activeMembershipCount: latestMembershipCount,
      });

      setGroupSaveSuccess(
        editingGroupId
          ? `Group updated (${latestMembershipCount} athlete${latestMembershipCount === 1 ? "" : "s"}).`
          : `Group created (${latestMembershipCount} athlete${latestMembershipCount === 1 ? "" : "s"}).`
      );
      resetGroupEditor();
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[TrainingGroups] save failed", error);
      console.error("[training-groups] save failed", {
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
    Alert.alert(
      archived ? "Archive group?" : "Restore group?",
      archived ? "This hides the training group from default selection." : "This restores the training group.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: archived ? "Archive" : "Restore",
          style: archived ? "destructive" : "default",
          onPress: async () => {
            await teamDataStore.actions.setTrainingGroupArchived(groupId, archived);
            if (editingGroupId === groupId) resetGroupEditor();
          },
        },
      ]
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Training Groups</Text>
      <Text style={styles.cardHint}>Create team-scoped groups for quick selection in coach planning views.</Text>

      <View style={styles.placeholder}>
        <Text style={styles.label}>Group name</Text>
        <TextInput
          value={groupNameText}
          onChangeText={setGroupNameText}
          placeholder="e.g., Varsity Girls"
          style={styles.input}
        />

        <View style={styles.actionRow}>
          <Pressable
            disabled={groupSaveBusy}
            onPress={() => setDraftAthleteIds(activeRoster.map((athlete) => athlete.id))}
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
          {editingGroupId || groupNameText || draftAthleteIds.length > 0 ? (
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

        <View style={styles.athletePicker}>
          <ScrollView nestedScrollEnabled>
            {activeRoster.map((athlete) => {
              const active = draftAthleteIds.includes(athlete.id);
              return (
                <Pressable
                  key={athlete.id}
                  disabled={groupSaveBusy}
                  onPress={() => toggleDraftAthlete(athlete.id)}
                  style={[styles.athleteRow, active && styles.athleteRowActive]}
                >
                  <Text style={styles.athleteName}>{athlete.displayName}</Text>
                  <Text style={[styles.athleteCheck, active && styles.athleteCheckActive]}>
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
          style={[styles.saveBtn, groupSaveBusy && styles.disabledBtn]}
        >
          <Text style={styles.saveBtnText}>
            {groupSaveBusy ? "Saving..." : editingGroupId ? "Update Group" : "Create Group"}
          </Text>
        </Pressable>
        {groupSaveError ? <Text style={styles.errorText}>{groupSaveError}</Text> : null}
        {groupSaveSuccess ? <Text style={styles.successText}>{groupSaveSuccess}</Text> : null}
      </View>

      <View style={styles.groupList}>
        {sortedGroups.length === 0 ? (
          <Text style={styles.emptyText}>No training groups yet.</Text>
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
              .filter((athlete): athlete is TeamRosterAthlete => !!athlete)
              .map((athlete) => athlete.displayName)
              .slice(0, 3);
            const extra = Math.max(0, memberIds.length - names.length);
            const archived = !!group.archived_at;

            return (
              <View key={group.id} style={styles.groupCard}>
                <View style={styles.groupText}>
                  <Text style={styles.groupName}>{group.name}{archived ? " (Archived)" : ""}</Text>
                  <Text style={styles.groupMeta}>
                    {memberIds.length} athlete{memberIds.length === 1 ? "" : "s"}
                    {names.length > 0 ? ` • ${names.join(", ")}${extra > 0 ? ` +${extra} more` : ""}` : ""}
                  </Text>
                </View>
                <View style={styles.groupActions}>
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
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: "#e0e6ef",
    backgroundColor: "#ffffff",
    borderRadius: 14,
    padding: 12,
    gap: 10,
  },
  cardTitle: { fontSize: 16, fontWeight: "900", color: "#111" },
  cardHint: { color: "#5e6678", fontWeight: "700", fontSize: 12 },
  placeholder: { borderRadius: 12, borderWidth: 1, borderColor: "#e1e7f2", backgroundColor: "#fff", padding: 10 },
  label: { fontSize: 12, fontWeight: "900", color: "#666", marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: "#d3dbe8",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
    fontWeight: "800",
  },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 8 },
  athletePicker: { borderWidth: 1, borderColor: "#eee", borderRadius: 12, maxHeight: 260 },
  athleteRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f1f1",
    backgroundColor: "#fff",
  },
  athleteRowActive: { backgroundColor: "rgba(0,0,0,0.04)" },
  athleteName: { fontWeight: "700", color: "#111", flex: 1, paddingRight: 8 },
  athleteCheck: { fontWeight: "900", color: "#999" },
  athleteCheckActive: { color: "#111" },
  saveBtn: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#10131a",
    borderRadius: 12,
    backgroundColor: "#10131a",
    alignItems: "center",
    paddingVertical: 10,
  },
  saveBtnText: { fontWeight: "900", color: "white" },
  disabledBtn: { opacity: 0.6 },
  errorText: { marginTop: 8, color: "#b00020", fontWeight: "700", fontSize: 12 },
  successText: { marginTop: 8, color: "#0a7a32", fontWeight: "700", fontSize: 12 },
  groupList: { marginTop: 2 },
  emptyText: { color: "#666", fontWeight: "700" },
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
  groupText: { flex: 1, paddingRight: 8 },
  groupName: { fontWeight: "900", color: "#111" },
  groupMeta: { marginTop: 3, color: "#5f677a", fontWeight: "700", fontSize: 12 },
  groupActions: { flexDirection: "row", gap: 8 },
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
});
