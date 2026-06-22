import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AccountContextSelector } from "../../components/account/AccountContextSelector";
import { AthleteRoutineDetails, getRoutinePreviewText } from "../../components/athlete/AthleteRoutineDetails";
import { LinkifiedText } from "../../components/ui/LinkifiedText";
import { getActiveAccountContext } from "../../lib/accountContexts";
import { loadAuxiliaryRoutineDefinitions, type AuxiliaryRoutine } from "../../lib/auxiliaryRoutines";
import { resolveAthleteSessionContext } from "../../lib/athleteSession";
import {
  loadDrillFolders,
  loadDrillLibraryDefinitions,
  loadRoutineFolders,
  type DrillFolder,
  type DrillLibraryItem,
  type RoutineFolder,
} from "../../lib/drillLibrary";
import { supabase } from "../../lib/supabase";

type LibraryTab = "routines" | "drills";

const ALL_FOLDERS_ID = "__all__";
const UNCATEGORIZED_FOLDER_ID = "__uncategorized__";

function uniqueRoutineTags(routine: AuxiliaryRoutine): string[] {
  return Array.from(
    new Set([
      ...(routine.preCategoryNames ?? []),
      ...(routine.postCategoryNames ?? []),
      ...(routine.categoryNames ?? []),
    ].map((tag) => String(tag ?? "").trim()).filter(Boolean))
  );
}

function formatUpdatedAt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function AthleteWarmupsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<LibraryTab>("routines");
  const [routines, setRoutines] = useState<AuxiliaryRoutine[]>([]);
  const [routineFolders, setRoutineFolders] = useState<RoutineFolder[]>([]);
  const [drillFolders, setDrillFolders] = useState<DrillFolder[]>([]);
  const [drillItems, setDrillItems] = useState<DrillLibraryItem[]>([]);
  const [drillById, setDrillById] = useState<Map<string, DrillLibraryItem>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [routineFolderFilterId, setRoutineFolderFilterId] = useState(ALL_FOLDERS_ID);
  const [drillFolderFilterId, setDrillFolderFilterId] = useState(ALL_FOLDERS_ID);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expandedDrillIds, setExpandedDrillIds] = useState<Set<string>>(new Set());
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [athleteName, setAthleteName] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);

  const loadScreen = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [session, userResult, routineList, routineFolderList, drillFolderList, loadedDrillItems] = await Promise.all([
        resolveAthleteSessionContext(true),
        supabase.auth.getUser(),
        loadAuxiliaryRoutineDefinitions(),
        loadRoutineFolders(),
        loadDrillFolders(),
        loadDrillLibraryDefinitions(),
      ]);
      const accountContext = await getActiveAccountContext();
      setAthleteName(session.athleteName);
      setAccountEmail(userResult.data.user?.email ?? null);
      setTeamName(String(accountContext?.teamName ?? "").trim() || null);
      setRoutines(routineList);
      setRoutineFolders(routineFolderList);
      setDrillFolders(drillFolderList);
      setDrillItems(loadedDrillItems);
      setDrillById(new Map(loadedDrillItems.map((drill) => [drill.id, drill] as const)));
    } catch (err: any) {
      setError(String(err?.message ?? err ?? "Could not load warmups and drills."));
      setRoutines([]);
      setDrillItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  function routineFolderName(folderId?: string | null) {
    const id = String(folderId ?? "").trim();
    if (!id) return "Uncategorized";
    return routineFolders.find((folder) => folder.id === id)?.name ?? "Uncategorized";
  }

  function drillFolderName(folderId?: string | null) {
    const id = String(folderId ?? "").trim();
    if (!id) return "Uncategorized";
    return drillFolders.find((folder) => folder.id === id)?.name ?? "Uncategorized";
  }

  useFocusEffect(
    useCallback(() => {
      void loadScreen();
    }, [loadScreen])
  );

  const filteredRoutines = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return routines.filter((routine) => {
      const folderId = String(routine.folderId ?? "").trim();
      const folderMatches =
        routineFolderFilterId === ALL_FOLDERS_ID ||
        (routineFolderFilterId === UNCATEGORIZED_FOLDER_ID ? !folderId : folderId === routineFolderFilterId);
      if (!folderMatches) return false;
      if (!needle) return true;
      const haystack = [
        routine.title,
        routine.description,
        routine.details,
        routineFolderName(routine.folderId),
        getRoutinePreviewText(routine, drillById),
        ...uniqueRoutineTags(routine),
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [drillById, query, routineFolderFilterId, routineFolders, routines]);

  const filteredDrills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return drillItems.filter((drill) => {
      const folderId = String(drill.folderId ?? "").trim();
      const folderMatches =
        drillFolderFilterId === ALL_FOLDERS_ID ||
        (drillFolderFilterId === UNCATEGORIZED_FOLDER_ID ? !folderId : folderId === drillFolderFilterId);
      if (!folderMatches) return false;
      if (!needle) return true;
      const haystack = [
        drill.name,
        drill.defaultDetails,
        drill.videoUrl,
        drillFolderName(drill.folderId),
        ...(drill.categoryNames ?? []),
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [drillFolderFilterId, drillFolders, drillItems, query]);

  const allTags = useMemo(() => {
    return Array.from(new Set(routines.flatMap((routine) => uniqueRoutineTags(routine)))).sort((a, b) => a.localeCompare(b));
  }, [routines]);

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleDrillExpanded(id: string) {
    setExpandedDrillIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function logOut() {
    try {
      await supabase.auth.signOut();
      router.replace("/(auth)/login");
    } catch (err: any) {
      Alert.alert("Log out failed", String(err?.message ?? "Please try again."));
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "#f6f8fb" }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
    >
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 28, fontWeight: "900", color: "#0f172a" }}>Warmups & Drills</Text>
        <Text style={{ color: "#475569", lineHeight: 20 }}>
          Coach-created warmups, cooldowns, drills, plyos, strength, and mobility routines.
        </Text>
      </View>

      <View
        style={{
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#dbeafe",
          backgroundColor: "#ffffff",
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Ionicons name="search" size={18} color="#64748b" />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search warmups or drills"
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
          style={{ flex: 1, color: "#0f172a", fontSize: 15, fontWeight: "700" }}
        />
        {query.trim() ? (
          <Pressable onPress={() => setQuery("")} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color="#94a3b8" />
          </Pressable>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {([
          ["routines", "Routines"],
          ["drills", "Drills"],
        ] as Array<[LibraryTab, string]>).map(([tab, label]) => {
          const active = activeTab === tab;
          return (
            <Pressable
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={{
                borderRadius: 12,
                borderWidth: 1,
                borderColor: active ? "#1d4ed8" : "#cbd5e1",
                backgroundColor: active ? "#1d4ed8" : "#ffffff",
                paddingHorizontal: 14,
                paddingVertical: 9,
              }}
            >
              <Text style={{ color: active ? "#ffffff" : "#334155", fontSize: 13, fontWeight: "900" }}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {[
          { id: ALL_FOLDERS_ID, name: "All" },
          { id: UNCATEGORIZED_FOLDER_ID, name: "Uncategorized" },
          ...(activeTab === "routines" ? routineFolders : drillFolders),
        ].map((folder) => {
          const active =
            activeTab === "routines"
              ? routineFolderFilterId === folder.id
              : drillFolderFilterId === folder.id;
          return (
            <Pressable
              key={`${activeTab}-folder-${folder.id}`}
              onPress={() => {
                if (activeTab === "routines") setRoutineFolderFilterId(folder.id);
                else setDrillFolderFilterId(folder.id);
              }}
              style={{
                borderRadius: 999,
                borderWidth: 1,
                borderColor: active ? "#2563eb" : "#cbd5e1",
                backgroundColor: active ? "#eff6ff" : "#ffffff",
                paddingHorizontal: 10,
                paddingVertical: 7,
              }}
            >
              <Text style={{ color: "#334155", fontSize: 12, fontWeight: "900" }}>{folder.name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {activeTab === "routines" && allTags.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {allTags.slice(0, 12).map((tag) => (
            <Pressable
              key={tag}
              onPress={() => setQuery(tag)}
              style={{
                borderRadius: 999,
                borderWidth: 1,
                borderColor: query.trim().toLowerCase() === tag.toLowerCase() ? "#2563eb" : "#cbd5e1",
                backgroundColor: query.trim().toLowerCase() === tag.toLowerCase() ? "#eff6ff" : "#ffffff",
                paddingHorizontal: 10,
                paddingVertical: 7,
              }}
            >
              <Text style={{ color: "#334155", fontSize: 12, fontWeight: "900" }}>{tag}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {loading ? (
        <View
          style={{
            borderRadius: 14,
            borderWidth: 1,
            borderColor: "#e2e8f0",
            backgroundColor: "#ffffff",
            padding: 18,
            alignItems: "center",
            gap: 10,
          }}
        >
          <ActivityIndicator />
          <Text style={{ color: "#64748b", fontWeight: "800" }}>Loading warmups...</Text>
        </View>
      ) : error ? (
        <View
          style={{
            borderRadius: 14,
            borderWidth: 1,
            borderColor: "#fecaca",
            backgroundColor: "#fff1f2",
            padding: 14,
            gap: 10,
          }}
        >
          <Text selectable style={{ color: "#991b1b", fontWeight: "900" }}>Could not load routines.</Text>
          <Text selectable style={{ color: "#be123c", lineHeight: 20 }}>{error}</Text>
          <Pressable
            onPress={() => void loadScreen()}
            style={{
              alignSelf: "flex-start",
              borderRadius: 10,
              backgroundColor: "#be123c",
              paddingHorizontal: 12,
              paddingVertical: 9,
            }}
          >
            <Text style={{ color: "#ffffff", fontWeight: "900" }}>Retry</Text>
          </Pressable>
        </View>
      ) : activeTab === "routines" && filteredRoutines.length === 0 ? (
        <View
          style={{
            borderRadius: 14,
            borderWidth: 1,
            borderColor: "#e2e8f0",
            backgroundColor: "#ffffff",
            padding: 18,
            gap: 8,
          }}
        >
          <Text style={{ fontSize: 18, fontWeight: "900", color: "#0f172a" }}>
            {routines.length === 0 ? "No routines have been added yet." : "No routines match that search."}
          </Text>
          <Text style={{ color: "#64748b", lineHeight: 20 }}>
            {routines.length === 0
              ? "When your coach adds routines, they will appear here."
              : "Try searching by routine name, details, folder, or tag."}
          </Text>
        </View>
      ) : activeTab === "drills" && filteredDrills.length === 0 ? (
        <View
          style={{
            borderRadius: 14,
            borderWidth: 1,
            borderColor: "#e2e8f0",
            backgroundColor: "#ffffff",
            padding: 18,
            gap: 8,
          }}
        >
          <Text style={{ fontSize: 18, fontWeight: "900", color: "#0f172a" }}>
            {drillItems.length === 0 ? "No drills have been added yet." : "No drills match that search."}
          </Text>
          <Text style={{ color: "#64748b", lineHeight: 20 }}>
            {drillItems.length === 0
              ? "When your coach adds individual drills, they will appear here."
              : "Try searching by drill name, cues, video link, or folder."}
          </Text>
        </View>
      ) : activeTab === "routines" ? (
        <View style={{ gap: 10 }}>
          {filteredRoutines.map((routine) => {
            const expanded = expandedIds.has(routine.id);
            const tags = uniqueRoutineTags(routine);
            const updatedLabel = formatUpdatedAt(routine.updatedAt);
            const details = getRoutinePreviewText(routine, drillById);
            const folderLabel = routineFolderName(routine.folderId);
            return (
              <View
                key={routine.id}
                style={{
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: expanded ? "#bfdbfe" : "#e2e8f0",
                  backgroundColor: "#ffffff",
                  overflow: "hidden",
                }}
              >
                <Pressable
                  onPress={() => toggleExpanded(routine.id)}
                  style={{ padding: 14, gap: 10 }}
                >
                  <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
                    <View style={{ flex: 1, gap: 5 }}>
                      <Text style={{ fontSize: 17, fontWeight: "900", color: "#0f172a" }}>{routine.title}</Text>
                      <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900" }}>{folderLabel}</Text>
                      {details ? (
                        expanded ? (
                          <AthleteRoutineDetails routine={routine} drillById={drillById} />
                        ) : (
                          <Text numberOfLines={2} style={{ color: "#475569", lineHeight: 20 }}>{details}</Text>
                        )
                      ) : (
                        <Text style={{ color: "#94a3b8", fontWeight: "700" }}>No details added.</Text>
                      )}
                    </View>
                    <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color="#64748b" />
                  </View>

                  {tags.length > 0 || updatedLabel ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                      {tags.map((tag) => (
                        <View
                          key={`${routine.id}-${tag}`}
                          style={{
                            borderRadius: 999,
                            backgroundColor: "#f1f5f9",
                            paddingHorizontal: 8,
                            paddingVertical: 5,
                          }}
                        >
                          <Text style={{ color: "#334155", fontSize: 11, fontWeight: "900" }}>{tag}</Text>
                        </View>
                      ))}
                      {updatedLabel ? (
                        <Text style={{ color: "#94a3b8", fontSize: 11, fontWeight: "800" }}>Updated {updatedLabel}</Text>
                      ) : null}
                    </View>
                  ) : null}
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {filteredDrills.map((drill) => {
            const expanded = expandedDrillIds.has(drill.id);
            const details = String(drill.defaultDetails ?? "").trim();
            const videoUrl = String(drill.videoUrl ?? "").trim();
            const folderLabel = drillFolderName(drill.folderId);
            return (
              <View
                key={drill.id}
                style={{
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: expanded ? "#bfdbfe" : "#e2e8f0",
                  backgroundColor: "#ffffff",
                  overflow: "hidden",
                }}
              >
                <Pressable onPress={() => toggleDrillExpanded(drill.id)} style={{ padding: 14, gap: 10 }}>
                  <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
                    <View style={{ flex: 1, gap: 6 }}>
                      <Text style={{ fontSize: 17, fontWeight: "900", color: "#0f172a" }}>{drill.name}</Text>
                      <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900" }}>{folderLabel}</Text>
                      {details ? (
                        expanded ? (
                          <LinkifiedText text={details} style={{ color: "#475569", lineHeight: 20 }} />
                        ) : (
                          <Text numberOfLines={2} style={{ color: "#475569", lineHeight: 20 }}>{details}</Text>
                        )
                      ) : (
                        <Text style={{ color: "#94a3b8", fontWeight: "700" }}>No cues added.</Text>
                      )}
                      {videoUrl ? <LinkifiedText text={videoUrl} style={{ color: "#2563eb", fontSize: 12, fontWeight: "900" }} /> : null}
                    </View>
                    <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color="#64748b" />
                  </View>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      <View
        style={{
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#e2e8f0",
          backgroundColor: "#ffffff",
          padding: 14,
          gap: 12,
        }}
      >
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 16, fontWeight: "900", color: "#0f172a" }}>Account</Text>
          <Text selectable style={{ color: "#64748b", lineHeight: 20 }}>
            {[athleteName, accountEmail, teamName].filter(Boolean).join(" · ") || "Signed in"}
          </Text>
        </View>
        <View style={{ alignItems: "flex-start" }}>
          <AccountContextSelector />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Pressable
            onPress={() => router.push("/(auth)/choose-account")}
            style={{
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#bfdbfe",
              backgroundColor: "#eff6ff",
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          >
            <Text style={{ fontWeight: "900", color: "#1d4ed8" }}>Switch account/team</Text>
          </Pressable>
          <Pressable
            onPress={logOut}
            style={{
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#fecaca",
              backgroundColor: "#fff1f2",
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          >
            <Text style={{ fontWeight: "900", color: "#b91c1c" }}>Sign out</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}
