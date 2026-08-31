import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { getRoutinePreviewText } from "../../athlete/AthleteRoutineDetails";
import type { AuxiliaryRoutine } from "../../../lib/auxiliaryRoutines";
import type { DrillLibraryItem, RoutineFolder } from "../../../lib/drillLibrary";
import { sortByFolderThenName, sortFoldersForDisplay } from "../../../lib/sortHelpers";
import { CoachMobileRoutineDetail } from "./coach-mobile-routine-detail";

const UNCATEGORIZED_LABEL = "Uncategorized";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function routineSummary(routine: AuxiliaryRoutine, drillById: Map<string, DrillLibraryItem>) {
  return cleanText(routine.description) || cleanText(routine.details) || cleanText(getRoutinePreviewText(routine, drillById));
}

export function CoachMobileRoutineBrowser({
  routines,
  folders,
  drillById,
  loading,
  error,
}: {
  routines: AuxiliaryRoutine[];
  folders: RoutineFolder[];
  drillById: Map<string, DrillLibraryItem>;
  loading: boolean;
  error?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [selectedRoutine, setSelectedRoutine] = useState<AuxiliaryRoutine | null>(null);
  const sortedFolders = useMemo(() => sortFoldersForDisplay(folders), [folders]);
  const folderNameById = useMemo(
    () => new Map(sortedFolders.map((folder) => [cleanText(folder.id), cleanText(folder.name)] as const)),
    [sortedFolders]
  );
  const filteredRoutines = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const sorted = sortByFolderThenName(routines, sortedFolders);
    if (!needle) return sorted;
    return sorted.filter((routine) => {
      const folderName = folderNameById.get(cleanText(routine.folderId)) || UNCATEGORIZED_LABEL;
      const haystack = [
        routine.title,
        routine.description,
        routine.details,
        folderName,
        getRoutinePreviewText(routine, drillById),
      ]
        .map(cleanText)
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(needle);
    });
  }, [drillById, folderNameById, query, routines, sortedFolders]);
  const routineGroups = useMemo(() => {
    const knownFolderIds = new Set(sortedFolders.map((folder) => cleanText(folder.id)).filter(Boolean));
    const groups = sortedFolders
      .map((folder) => ({
        id: cleanText(folder.id),
        name: cleanText(folder.name),
        routines: filteredRoutines.filter((routine) => cleanText(routine.folderId) === cleanText(folder.id)),
      }))
      .filter((group) => group.routines.length > 0);
    const uncategorized = filteredRoutines.filter((routine) => !knownFolderIds.has(cleanText(routine.folderId)));
    if (uncategorized.length > 0) {
      groups.push({ id: "__uncategorized__", name: UNCATEGORIZED_LABEL, routines: uncategorized });
    }
    return groups;
  }, [filteredRoutines, sortedFolders]);
  const selectedFolderName = selectedRoutine
    ? folderNameById.get(cleanText(selectedRoutine.folderId)) || UNCATEGORIZED_LABEL
    : UNCATEGORIZED_LABEL;

  return (
    <View style={{ gap: 12, width: "100%" }}>
      <TextInput
        accessibilityLabel="Search drill routines"
        value={query}
        onChangeText={setQuery}
        placeholder="Search routines"
        placeholderTextColor="#94a3b8"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={{
          width: "100%",
          height: 44,
          borderWidth: 1,
          borderColor: "#dbe3ef",
          borderRadius: 12,
          paddingHorizontal: 12,
          backgroundColor: "#fff",
          color: "#172033",
          fontWeight: "800",
        }}
      />

      {loading ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator />
          <Text style={{ color: "#64748b", fontWeight: "800" }}>Loading routines...</Text>
        </View>
      ) : null}

      {error ? (
        <View style={{ borderWidth: 1, borderColor: "#fecaca", backgroundColor: "#fff1f2", borderRadius: 12, padding: 10 }}>
          <Text selectable style={{ color: "#991b1b", fontWeight: "800", lineHeight: 19 }}>{error}</Text>
        </View>
      ) : null}

      {!loading && !error && routines.length === 0 ? (
        <View style={emptyStateStyle}>
          <Text style={emptyStateTitleStyle}>No routines have been created yet.</Text>
        </View>
      ) : null}

      {!loading && routines.length > 0 && filteredRoutines.length === 0 ? (
        <View style={emptyStateStyle}>
          <Text style={emptyStateTitleStyle}>No routines match this search.</Text>
        </View>
      ) : null}

      {routineGroups.map((group) => (
        <View key={group.id} style={{ gap: 8, width: "100%" }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ flex: 1, minWidth: 0, color: "#475569", fontSize: 13, fontWeight: "900" }}>{group.name}</Text>
            <Text style={{ color: "#94a3b8", fontSize: 12, fontWeight: "900" }}>{group.routines.length}</Text>
          </View>
          {group.routines.map((routine) => {
            const summary = routineSummary(routine, drillById).replace(/\s+/g, " ");
            const itemCount = Array.isArray(routine.items) ? routine.items.length : 0;
            return (
              <Pressable
                key={routine.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${routine.title || "routine"}`}
                onPress={() => setSelectedRoutine(routine)}
                style={({ pressed }) => ({
                  width: "100%",
                  borderWidth: 1,
                  borderColor: "#dbe3ef",
                  backgroundColor: pressed ? "#f8fafc" : "#fff",
                  borderRadius: 14,
                  padding: 12,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                })}
              >
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Text style={{ color: "#172033", fontSize: 16, fontWeight: "900" }}>{routine.title || "Routine"}</Text>
                  {summary ? (
                    <Text numberOfLines={2} style={{ color: "#64748b", fontWeight: "700", lineHeight: 18 }}>
                      {summary}
                    </Text>
                  ) : null}
                  <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "900" }}>
                    {itemCount > 0 ? `${itemCount} item${itemCount === 1 ? "" : "s"}` : "View details"}
                  </Text>
                </View>
                <Text style={{ color: "#2563eb", fontSize: 20, fontWeight: "900" }}>›</Text>
              </Pressable>
            );
          })}
        </View>
      ))}

      <CoachMobileRoutineDetail
        routine={selectedRoutine}
        folderName={selectedFolderName}
        drillById={drillById}
        onClose={() => setSelectedRoutine(null)}
      />
    </View>
  );
}

const emptyStateStyle = {
  width: "100%" as const,
  borderWidth: 1,
  borderColor: "#dbe3ef",
  backgroundColor: "#fff",
  borderRadius: 12,
  padding: 12,
};

const emptyStateTitleStyle = {
  color: "#475569",
  fontWeight: "800" as const,
  lineHeight: 19,
};
