import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Screen } from "../../../components/ui/Screen";
import { Card } from "../../../components/ui/Card";
import {
  createTeamWorkoutBatch,
  listTeamWorkoutsInRange,
  type TeamWorkoutInsertInput,
  type TeamWorkoutRow,
} from "../../../lib/teamWorkoutsCloud";
import { loadCoreCoachSettings } from "../../../lib/settings";

const HISTORY_START_ISO = "2000-01-01";
const HISTORY_END_ISO = "2100-12-31";

type CatalogEntry = {
  signature: string;
  sourceBatchId: string;
  sourceDateISO: string;
  latestDateISO: string;
  title: string;
  details: string;
  session: "AM" | "PM";
  timeText: string;
  location: string;
  categories: string[];
  preRoutineIds: string[];
  postRoutineIds: string[];
  athleteCount: number;
  rowCount: number;
  rowSignatures: string[];
  rowsForAssign: TeamWorkoutRow[];
  occurrenceCount: number;
};

function normalizeText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function createBatchId(dateISO: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `bat_${dateISO}_${suffix}`;
}

function isISODateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim());
}

function todayISODate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toCatalogEntryFromBatch(batchRowsRaw: TeamWorkoutRow[]): CatalogEntry | null {
  const batchRows = [...batchRowsRaw];
  if (batchRows.length === 0) return null;
  const sourceBatchId = String(batchRows[0]?.batch_id ?? "").trim();
  if (!sourceBatchId) return null;

  batchRows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sample = batchRows[0];
  const sourceDateISO = String(sample.date_iso ?? "").trim();
  const latestDateISO = batchRows.reduce((latest, row) => {
    const dateISO = String(row.date_iso ?? "").trim();
    return dateISO > latest ? dateISO : latest;
  }, sourceDateISO);

  const categorySet = new Set<string>();
  const preRoutineSet = new Set<string>();
  const postRoutineSet = new Set<string>();
  const rowSignatures = new Set<string>();
  const athleteIdSet = new Set<string>();

  batchRows.forEach((row) => {
    const athleteId = String(row.athlete_profile_id ?? "").trim();
    if (athleteId) athleteIdSet.add(athleteId);

    const primary = String(row.primary_category ?? "").trim();
    if (primary) categorySet.add(primary);
    (Array.isArray(row.categories) ? row.categories : [])
      .map((c) => String(c ?? "").trim())
      .filter(Boolean)
      .forEach((c) => categorySet.add(c));
    (Array.isArray(row.pre_routine_ids) ? row.pre_routine_ids : [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean)
      .forEach((id) => preRoutineSet.add(id));
    (Array.isArray(row.post_routine_ids) ? row.post_routine_ids : [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean)
      .forEach((id) => postRoutineSet.add(id));

    const normalizedCategories = (Array.isArray(row.categories) ? row.categories : [])
      .map((c) => normalizeText(c))
      .filter(Boolean)
      .sort();
    rowSignatures.add(
      JSON.stringify({
        group: normalizeText(row.group_id),
        session: normalizeText(row.session),
        time: normalizeText(row.time_text),
        location: normalizeText(row.location),
        title: normalizeText(row.title),
        details: normalizeText(row.details),
        primary: normalizeText(row.primary_category),
        categories: normalizedCategories,
      })
    );
  });

  const categories = Array.from(categorySet).sort((a, b) => a.localeCompare(b));
  const preRoutineIds = Array.from(preRoutineSet);
  const postRoutineIds = Array.from(postRoutineSet);
  const rowSignatureList = Array.from(rowSignatures).sort();

  const signature = JSON.stringify({
    session: normalizeText(sample.session),
    time: normalizeText(sample.time_text),
    location: normalizeText(sample.location),
    title: normalizeText(sample.title),
    details: normalizeText(sample.details),
    categories: categories.map((c) => normalizeText(c)).sort(),
    preRoutineIds: preRoutineIds.map((id) => normalizeText(id)).sort(),
    postRoutineIds: postRoutineIds.map((id) => normalizeText(id)).sort(),
    rowSignatures: rowSignatureList,
  });

  return {
    signature,
    sourceBatchId,
    sourceDateISO,
    latestDateISO,
    title: String(sample.title ?? "").trim() || "Workout",
    details: String(sample.details ?? "").trim(),
    session: String(sample.session ?? "").toUpperCase() === "AM" ? "AM" : "PM",
    timeText: String(sample.time_text ?? "").trim(),
    location: String(sample.location ?? "").trim(),
    categories,
    preRoutineIds,
    postRoutineIds,
    athleteCount: athleteIdSet.size,
    rowCount: batchRows.length,
    rowSignatures: rowSignatureList,
    rowsForAssign: batchRows,
    occurrenceCount: 1,
  };
}

export default function CoachWorkoutCatalogTab() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [assignDateISO, setAssignDateISO] = useState(() => todayISODate());
  const [assigningSignature, setAssigningSignature] = useState<string | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, coreSettings] = await Promise.all([
        listTeamWorkoutsInRange(HISTORY_START_ISO, HISTORY_END_ISO),
        loadCoreCoachSettings(),
      ]);

      const categoriesFromSettings = (Array.isArray(coreSettings.categories) ? coreSettings.categories : [])
        .map((c) => String(c?.name ?? "").trim())
        .filter(Boolean);
      setCategoryOrder(categoriesFromSettings);

      const byBatchId = new Map<string, TeamWorkoutRow[]>();
      rows.forEach((row) => {
        const batchId = String(row.batch_id ?? "").trim();
        if (!batchId) return;
        const list = byBatchId.get(batchId) ?? [];
        list.push(row);
        byBatchId.set(batchId, list);
      });

      const dedupedBySignature = new Map<string, CatalogEntry>();
      Array.from(byBatchId.values()).forEach((batchRows) => {
        const nextEntry = toCatalogEntryFromBatch(batchRows);
        if (!nextEntry) return;
        const existing = dedupedBySignature.get(nextEntry.signature);
        if (!existing) {
          dedupedBySignature.set(nextEntry.signature, nextEntry);
          return;
        }
        const useNextAsPrimary = nextEntry.latestDateISO > existing.latestDateISO;
        const merged: CatalogEntry = {
          ...(useNextAsPrimary ? nextEntry : existing),
          occurrenceCount: existing.occurrenceCount + 1,
          latestDateISO: useNextAsPrimary ? nextEntry.latestDateISO : existing.latestDateISO,
        };
        dedupedBySignature.set(nextEntry.signature, merged);
      });

      const nextEntries = Array.from(dedupedBySignature.values()).sort((a, b) => {
        if (a.title !== b.title) return a.title.localeCompare(b.title);
        if (a.session !== b.session) return a.session.localeCompare(b.session);
        return a.latestDateISO.localeCompare(b.latestDateISO);
      });
      setEntries(nextEntries);
    } catch (error: any) {
      Alert.alert("Workout Catalog", String(error?.message ?? "Could not load workout history."));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload])
  );

  const filteredEntries = useMemo(() => {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return entries;
    return entries.filter((entry) => {
      const haystack = [
        entry.title,
        entry.details,
        entry.location,
        entry.session,
        entry.timeText,
        ...entry.categories,
      ]
        .map((part) => normalizeText(part))
        .join(" ");
      return haystack.includes(normalizedQuery);
    });
  }, [entries, query]);

  const sections = useMemo(() => {
    const byCategory = new Map<string, CatalogEntry[]>();
    filteredEntries.forEach((entry) => {
      const categories = entry.categories.length > 0 ? entry.categories : ["Uncategorized"];
      categories.forEach((categoryName) => {
        const key = String(categoryName ?? "").trim() || "Uncategorized";
        const list = byCategory.get(key) ?? [];
        list.push(entry);
        byCategory.set(key, list);
      });
    });

    const knownOrder = categoryOrder
      .map((name) => String(name ?? "").trim())
      .filter((name) => byCategory.has(name));
    const extraOrder = Array.from(byCategory.keys())
      .filter((name) => !knownOrder.includes(name))
      .sort((a, b) => a.localeCompare(b));
    const orderedCategories = [...knownOrder, ...extraOrder];

    return orderedCategories.map((categoryName) => ({
      categoryName,
      entries: (byCategory.get(categoryName) ?? []).sort((a, b) => {
        if (a.title !== b.title) return a.title.localeCompare(b.title);
        return b.latestDateISO.localeCompare(a.latestDateISO);
      }),
    }));
  }, [categoryOrder, filteredEntries]);

  const handleAssign = useCallback(
    async (entry: CatalogEntry) => {
      const targetDateISO = String(assignDateISO ?? "").trim();
      if (!isISODateOnly(targetDateISO)) {
        Alert.alert("Assign", "Please enter a valid date in YYYY-MM-DD format.");
        return;
      }
      if (!entry.rowsForAssign.length) {
        Alert.alert("Assign", "No source rows available for this catalog entry.");
        return;
      }

      const newBatchId = createBatchId(targetDateISO);
      const payload: TeamWorkoutInsertInput[] = entry.rowsForAssign.map((row) => ({
        team_id: row.team_id,
        athlete_profile_id: row.athlete_profile_id,
        created_by: row.created_by ?? null,
        date_iso: targetDateISO,
        session: row.session,
        location: row.location,
        time_text: row.time_text,
        title: row.title,
        details: row.details,
        primary_category: row.primary_category,
        categories: Array.isArray(row.categories) ? row.categories : [],
        batch_id: newBatchId,
        group_id: row.group_id,
        pre_routine_ids: Array.isArray(row.pre_routine_ids) ? row.pre_routine_ids : null,
        post_routine_ids: Array.isArray(row.post_routine_ids) ? row.post_routine_ids : null,
        planned_distance: row.planned_distance,
        planned_distance_unit: row.planned_distance_unit,
      }));

      setAssigningSignature(entry.signature);
      try {
        await createTeamWorkoutBatch(payload);
        router.push({
          pathname: "/(coach)/workouts",
          params: { date: targetDateISO, batch: newBatchId },
        });
      } catch (error: any) {
        Alert.alert("Assign failed", String(error?.message ?? "Could not assign workout batch."));
      } finally {
        setAssigningSignature((prev) => (prev === entry.signature ? null : prev));
      }
    },
    [assignDateISO, router]
  );

  return (
    <Screen>
      <View style={{ flex: 1, gap: 10 }}>
        <View style={{ gap: 5 }}>
          <Text style={{ fontSize: 22, fontWeight: "900", color: "#0f172a" }}>Workout Catalog</Text>
          <Text style={{ fontSize: 13, fontWeight: "600", color: "#64748b" }}>
            Derived catalog from historical coach-created workout batches.
          </Text>
        </View>

        <Card style={{ borderColor: "#dfe6f2", borderRadius: 14, padding: 12, gap: 10 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
            <View style={{ minWidth: 220, flex: 1 }}>
              <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Search</Text>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search title, notes, location, category..."
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  borderWidth: 1,
                  borderColor: "#d5deea",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  backgroundColor: "#fff",
                  fontSize: 13,
                  fontWeight: "600",
                  color: "#1f2937",
                }}
              />
            </View>
            <View style={{ width: 180 }}>
              <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Assign date</Text>
              <TextInput
                value={assignDateISO}
                onChangeText={setAssignDateISO}
                placeholder="YYYY-MM-DD"
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  borderWidth: 1,
                  borderColor: "#d5deea",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  backgroundColor: "#fff",
                  fontSize: 13,
                  fontWeight: "600",
                  color: "#1f2937",
                }}
              />
            </View>
            <Pressable
              onPress={() => void reload()}
              style={{
                borderWidth: 1,
                borderColor: "#d5deea",
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 9,
                backgroundColor: "#fff",
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>Refresh</Text>
            </Pressable>
          </View>
          <Text style={{ fontSize: 11, fontWeight: "700", color: "#64748b" }}>
            {loading
              ? "Loading historical batches..."
              : `${filteredEntries.length} unique catalog entries from ${entries.length} deduplicated workouts`}
          </Text>
        </Card>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10, paddingBottom: 18 }}>
          {!loading && sections.length === 0 ? (
            <Card style={{ borderColor: "#dfe6f2", borderRadius: 14, padding: 14 }}>
              <Text style={{ fontSize: 14, fontWeight: "800", color: "#334155" }}>No catalog entries found</Text>
              <Text style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
                Create a workout batch first, then it will appear here after deduplication.
              </Text>
            </Card>
          ) : null}

          {sections.map((section) => (
            <Card key={section.categoryName} style={{ borderColor: "#dfe6f2", borderRadius: 14, padding: 12, gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <Text style={{ fontSize: 15, fontWeight: "900", color: "#0f172a" }}>{section.categoryName}</Text>
                <Text style={{ fontSize: 11, fontWeight: "700", color: "#64748b" }}>
                  {section.entries.length} item{section.entries.length === 1 ? "" : "s"}
                </Text>
              </View>

              {section.entries.map((entry) => {
                const assigning = assigningSignature === entry.signature;
                return (
                  <View
                    key={`${section.categoryName}::${entry.signature}`}
                    style={{
                      borderWidth: 1,
                      borderColor: "#e2e8f0",
                      borderRadius: 10,
                      paddingHorizontal: 10,
                      paddingVertical: 9,
                      backgroundColor: "#fff",
                      gap: 6,
                    }}
                  >
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>{entry.title}</Text>
                        <Text style={{ marginTop: 2, fontSize: 12, fontWeight: "700", color: "#475569" }}>
                          {entry.session}
                          {entry.timeText ? ` • ${entry.timeText}` : ""}
                          {entry.location ? ` • ${entry.location}` : ""}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => void handleAssign(entry)}
                        disabled={assigning}
                        style={{
                          borderWidth: 1,
                          borderColor: "#cdd7e6",
                          borderRadius: 8,
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          backgroundColor: "#f8fafc",
                          opacity: assigning ? 0.65 : 1,
                        }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: "900", color: "#1e293b" }}>
                          {assigning ? "Assigning..." : "Assign"}
                        </Text>
                      </Pressable>
                    </View>

                    {entry.details ? (
                      <Text style={{ fontSize: 12, lineHeight: 18, color: "#334155" }}>{entry.details}</Text>
                    ) : null}

                    <Text style={{ fontSize: 11, color: "#64748b" }}>
                      Categories: {entry.categories.length > 0 ? entry.categories.join(", ") : "Uncategorized"}
                    </Text>
                    <Text style={{ fontSize: 11, color: "#64748b" }}>
                      Athletes: {entry.athleteCount} • Rows: {entry.rowCount} • Seen: {entry.occurrenceCount} • Latest: {entry.latestDateISO}
                    </Text>
                  </View>
                );
              })}
            </Card>
          ))}
        </ScrollView>
      </View>
    </Screen>
  );
}
