import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Screen } from "../../../components/ui/Screen";
import { Card } from "../../../components/ui/Card";
import {
  buildTeamWorkoutInsertRows,
  createTeamWorkoutBatch,
  listTeamWorkoutsInRange,
  type TeamWorkoutRow,
} from "../../../lib/teamWorkoutsCloud";
import {
  listTeamWorkoutBatchHeadersForDate,
  saveTeamWorkoutBatchHeaderNotes,
} from "../../../lib/teamWorkoutBatchHeadersCloud";
import { loadCoreCoachSettings } from "../../../lib/settings";
import { loadAuxiliaryRoutines } from "../../../lib/auxiliaryRoutines";
import { loadJSON, saveJSON } from "../../../lib/storage";
import {
  compareAthleteDisplayNamesByLastName,
  getCurrentTeamRoster,
  type TeamRosterAthlete,
} from "../../../lib/teamRoster";

const HISTORY_START_ISO = "2000-01-01";
const HISTORY_END_ISO = "2100-12-31";
const WORKOUT_CATALOG_UI_STATE_KEY = "training_app_workout_catalog_ui_state_v1";

type CatalogEntry = {
  signature: string;
  sourceBatchId: string;
  sourceDateISO: string;
  latestDateISO: string;
  title: string;
  details: string;
  primaryCategory: string | null;
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

type SearchEntryMeta = {
  score: number;
  matchedCount: number;
  totalTokens: number;
};

type CatalogTitleGroup = {
  titleKey: string;
  title: string;
  versions: CatalogEntry[];
  primaryEntry: CatalogEntry;
  categories: string[];
  preRoutineIds: string[];
  postRoutineIds: string[];
  latestDateISO: string;
  athleteCountMax: number;
  rowCountMax: number;
};

type WorkoutCatalogUiState = {
  query?: string;
  selectedCategoryFilter?: string;
  expandedCategories?: string[];
  expandedTitleGroups?: string[];
  scrollY?: number;
};

function normalizeText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[×✕]/g, "x")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchQuery(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(" ").map((part) => part.trim()).filter(Boolean)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlightedText(value: string, tokens: string[]): ReactNode {
  const text = String(value ?? "");
  const cleanTokens = Array.from(
    new Set(
      (Array.isArray(tokens) ? tokens : [])
        .map((token) => String(token ?? "").trim())
        .filter((token) => token.length >= 2)
        .sort((a, b) => b.length - a.length)
    )
  );
  if (!text || cleanTokens.length === 0) return text;

  const regex = new RegExp(`(${cleanTokens.map((token) => escapeRegExp(token)).join("|")})`, "gi");
  const parts = text.split(regex);
  if (parts.length <= 1) return text;

  return parts.map((part, index) => {
    const matched = cleanTokens.some((token) => token.toLowerCase() === part.toLowerCase());
    if (!matched) return <Text key={`plain-${index}`}>{part}</Text>;
    return (
      <Text
        key={`hit-${index}`}
        style={{
          backgroundColor: "#fef3c7",
          color: "#1f2937",
          fontWeight: "800",
        }}
      >
        {part}
      </Text>
    );
  });
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

function normalizeTitleKey(value: unknown): string {
  return normalizeSearchText(value) || "untitled";
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
    primaryCategory: String(sample.primary_category ?? "").trim() || null,
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
  const [roster, setRoster] = useState<TeamRosterAthlete[]>([]);
  const [assignDateISO, setAssignDateISO] = useState(() => todayISODate());
  const [assignModalEntry, setAssignModalEntry] = useState<CatalogEntry | null>(null);
  const [assignAthleteSearch, setAssignAthleteSearch] = useState("");
  const [selectedAssignAthleteIds, setSelectedAssignAthleteIds] = useState<string[]>([]);
  const [assigningSignature, setAssigningSignature] = useState<string | null>(null);
  const [titleGroups, setTitleGroups] = useState<CatalogTitleGroup[]>([]);
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);
  const [routineTitleById, setRoutineTitleById] = useState<Map<string, string>>(new Map());
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>("All");
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);
  const [expandedTitleGroups, setExpandedTitleGroups] = useState<string[]>([]);
  const [catalogScrollY, setCatalogScrollY] = useState(0);
  const [uiHydrated, setUiHydrated] = useState(false);
  const listScrollRef = useRef<ScrollView>(null);
  const restoredScrollAppliedRef = useRef(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, coreSettings, rosterRows, routines] = await Promise.all([
        listTeamWorkoutsInRange(HISTORY_START_ISO, HISTORY_END_ISO),
        loadCoreCoachSettings(),
        getCurrentTeamRoster(),
        loadAuxiliaryRoutines(),
      ]);

      const categoriesFromSettings = (Array.isArray(coreSettings.categories) ? coreSettings.categories : [])
        .map((c) => String(c?.name ?? "").trim())
        .filter(Boolean);
      setCategoryOrder(categoriesFromSettings);
      setRoster(
        [...(Array.isArray(rosterRows) ? rosterRows : [])].sort((a, b) =>
          compareAthleteDisplayNamesByLastName(a.displayName, b.displayName)
        )
      );
      const routineMap = new Map<string, string>();
      (Array.isArray(routines) ? routines : []).forEach((routine) => {
        const id = String(routine.id ?? "").trim();
        const title = String(routine.title ?? "").trim();
        if (!id || !title) return;
        routineMap.set(id, title);
      });
      setRoutineTitleById(routineMap);

      const byBatchId = new Map<string, TeamWorkoutRow[]>();
      rows.forEach((row) => {
        const batchId = String(row.batch_id ?? "").trim();
        if (!batchId) return;
        const list = byBatchId.get(batchId) ?? [];
        list.push(row);
        byBatchId.set(batchId, list);
      });

      const allBatchEntries: CatalogEntry[] = [];
      Array.from(byBatchId.values()).forEach((batchRows) => {
        const entry = toCatalogEntryFromBatch(batchRows);
        if (!entry) return;
        allBatchEntries.push(entry);
      });

      const groupsByTitle = new Map<string, CatalogEntry[]>();
      allBatchEntries.forEach((entry) => {
        const titleKey = normalizeTitleKey(entry.title);
        const list = groupsByTitle.get(titleKey) ?? [];
        list.push(entry);
        groupsByTitle.set(titleKey, list);
      });

      const nextGroups: CatalogTitleGroup[] = Array.from(groupsByTitle.entries()).map(([titleKey, versionsRaw]) => {
        const versions = [...versionsRaw].sort((a, b) => {
          if (a.latestDateISO !== b.latestDateISO) return b.latestDateISO.localeCompare(a.latestDateISO);
          if (a.sourceDateISO !== b.sourceDateISO) return b.sourceDateISO.localeCompare(a.sourceDateISO);
          return String(a.sourceBatchId ?? "").localeCompare(String(b.sourceBatchId ?? ""));
        });
        const primaryEntry = versions[0]!;
        const categorySet = new Set<string>();
        const preSet = new Set<string>();
        const postSet = new Set<string>();
        let athleteCountMax = 0;
        let rowCountMax = 0;
        versions.forEach((entry) => {
          (entry.categories.length > 0 ? entry.categories : ["Uncategorized"]).forEach((name) => {
            const key = String(name ?? "").trim() || "Uncategorized";
            categorySet.add(key);
          });
          entry.preRoutineIds.forEach((id) => preSet.add(String(id ?? "").trim()));
          entry.postRoutineIds.forEach((id) => postSet.add(String(id ?? "").trim()));
          athleteCountMax = Math.max(athleteCountMax, entry.athleteCount);
          rowCountMax = Math.max(rowCountMax, entry.rowCount);
        });

        return {
          titleKey,
          title: primaryEntry.title,
          versions,
          primaryEntry,
          categories: Array.from(categorySet).filter(Boolean).sort((a, b) => a.localeCompare(b)),
          preRoutineIds: Array.from(preSet).filter(Boolean),
          postRoutineIds: Array.from(postSet).filter(Boolean),
          latestDateISO: primaryEntry.latestDateISO,
          athleteCountMax,
          rowCountMax,
        };
      });

      nextGroups.sort((a, b) => {
        if (a.title !== b.title) return a.title.localeCompare(b.title);
        return b.latestDateISO.localeCompare(a.latestDateISO);
      });
      setTitleGroups(nextGroups);
    } catch (error: any) {
      Alert.alert("Workout Catalog", String(error?.message ?? "Could not load workout history."));
      setTitleGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload])
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      const saved = await loadJSON<WorkoutCatalogUiState>(WORKOUT_CATALOG_UI_STATE_KEY, {});
      if (!mounted) return;
      const nextQuery = String(saved?.query ?? "");
      const nextFilter = String(saved?.selectedCategoryFilter ?? "All").trim() || "All";
      const nextExpanded = Array.isArray(saved?.expandedCategories)
        ? saved.expandedCategories.map((name) => String(name ?? "").trim()).filter(Boolean)
        : [];
      const nextExpandedTitleGroups = Array.isArray(saved?.expandedTitleGroups)
        ? saved.expandedTitleGroups.map((key) => String(key ?? "").trim()).filter(Boolean)
        : [];
      const nextScrollY =
        typeof saved?.scrollY === "number" && Number.isFinite(saved.scrollY) && saved.scrollY >= 0
          ? saved.scrollY
          : 0;
      setQuery(nextQuery);
      setSelectedCategoryFilter(nextFilter);
      setExpandedCategories(nextExpanded);
      setExpandedTitleGroups(nextExpandedTitleGroups);
      setCatalogScrollY(nextScrollY);
      setUiHydrated(true);
    })().catch(() => {
      if (!mounted) return;
      setUiHydrated(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const categoryFilterOptions = useMemo(() => {
    const names = new Set<string>();
    titleGroups.forEach((group) => {
      const categories = group.categories.length > 0 ? group.categories : ["Uncategorized"];
      categories.forEach((name) => names.add(String(name ?? "").trim() || "Uncategorized"));
    });
    const orderedKnown = categoryOrder.filter((name) => names.has(name));
    const extras = Array.from(names).filter((name) => !orderedKnown.includes(name)).sort((a, b) => a.localeCompare(b));
    return ["All", ...orderedKnown, ...extras];
  }, [categoryOrder, titleGroups]);

  useEffect(() => {
    if (selectedCategoryFilter === "All") return;
    if (categoryFilterOptions.includes(selectedCategoryFilter)) return;
    setSelectedCategoryFilter("All");
  }, [categoryFilterOptions, selectedCategoryFilter]);

  const { filteredGroups, scoreByTitleKey, hasQuery } = useMemo<{
    filteredGroups: CatalogTitleGroup[];
    scoreByTitleKey: Map<string, SearchEntryMeta>;
    hasQuery: boolean;
  }>(() => {
    const tokens = tokenizeSearchQuery(query);
    const normalizedQuery = normalizeSearchText(query);
    const byCategory = selectedCategoryFilter === "All"
      ? titleGroups
      : titleGroups.filter((group) => {
          const categories = group.categories.length > 0 ? group.categories : ["Uncategorized"];
          return categories.some((name) => (String(name ?? "").trim() || "Uncategorized") === selectedCategoryFilter);
        });
    if (!normalizedQuery || tokens.length === 0) {
      return {
        filteredGroups: byCategory,
        scoreByTitleKey: new Map<string, SearchEntryMeta>(),
        hasQuery: false,
      };
    }

    const scored = byCategory
      .map((group) => {
        const primary = group.primaryEntry;
        const historyText = group.versions
          .map((entry) =>
            `${entry.details ?? ""} ${entry.location ?? ""} ${entry.session ?? ""} ${entry.timeText ?? ""} ${(entry.categories ?? []).join(" ")}`
          )
          .join(" ");
        const title = normalizeSearchText(group.title);
        const details = normalizeSearchText(primary.details);
        const location = normalizeSearchText(primary.location);
        const categories = (Array.isArray(group.categories) ? group.categories : []).map((c) => normalizeSearchText(c)).join(" ");
        const routineIds = [...group.preRoutineIds, ...group.postRoutineIds].map((id) => normalizeSearchText(id)).join(" ");
        const routineNames = [...group.preRoutineIds, ...group.postRoutineIds]
          .map((id) => normalizeSearchText(routineTitleById.get(String(id ?? "").trim()) ?? ""))
          .filter(Boolean)
          .join(" ");
        const metadata = normalizeSearchText(`${primary.session} ${primary.timeText} ${primary.primaryCategory ?? ""} ${historyText}`);
        const fullIndex = [title, details, location, categories, routineNames, routineIds, metadata].join(" ").trim();
        const requiredMatches = tokens.length <= 2 ? tokens.length : tokens.length - 1;

        let matchedCount = 0;
        const tokenMatches = new Set<string>();
        tokens.forEach((token) => {
          if (fullIndex.includes(token)) {
            matchedCount += 1;
            tokenMatches.add(token);
          }
        });
        if (matchedCount < requiredMatches) return null;

        let score = 0;
        tokens.forEach((token) => {
          if (title.includes(token)) score += 80;
          if (categories.includes(token)) score += 60;
          if (details.includes(token)) score += 35;
          if (location.includes(token)) score += 20;
          if (routineNames.includes(token)) score += 22;
          if (routineIds.includes(token)) score += 8;
          if (metadata.includes(token)) score += 10;
        });

        if (normalizedQuery && title.includes(normalizedQuery)) score += 120;
        if (normalizedQuery && categories.includes(normalizedQuery)) score += 90;
        if (normalizedQuery && details.includes(normalizedQuery)) score += 50;
        if (normalizedQuery && location.includes(normalizedQuery)) score += 25;
        if (normalizedQuery && routineNames.includes(normalizedQuery)) score += 26;
        if (normalizedQuery && routineIds.includes(normalizedQuery)) score += 8;
        if (normalizedQuery && metadata.includes(normalizedQuery)) score += 12;

        return { group, score, matchedCount, totalTokens: tokens.length, tokenMatches };
      })
      .filter((value): value is { group: CatalogTitleGroup; score: number; matchedCount: number; totalTokens: number; tokenMatches: Set<string> } => !!value)
      .sort((a, b) => {
        if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
        if (b.score !== a.score) return b.score - a.score;
        if (a.group.latestDateISO !== b.group.latestDateISO) return b.group.latestDateISO.localeCompare(a.group.latestDateISO);
        return a.group.title.localeCompare(b.group.title);
      });

    return {
      filteredGroups: scored.map((item) => item.group),
      scoreByTitleKey: new Map<string, SearchEntryMeta>(
        scored.map((item) => [item.group.titleKey, { score: item.score, matchedCount: item.matchedCount, totalTokens: item.totalTokens }])
      ),
      hasQuery: true,
    };
  }, [query, routineTitleById, selectedCategoryFilter, titleGroups]);

  const highlightTokens = useMemo(() => tokenizeSearchQuery(query), [query]);

  const sections = useMemo(() => {
    const byCategory = new Map<string, CatalogTitleGroup[]>();
    filteredGroups.forEach((group) => {
      const categories = group.categories.length > 0 ? group.categories : ["Uncategorized"];
      categories.forEach((categoryName) => {
        const key = String(categoryName ?? "").trim() || "Uncategorized";
        const list = byCategory.get(key) ?? [];
        list.push(group);
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
        if (hasQuery) {
          const aMeta = scoreByTitleKey.get(a.titleKey) ?? { score: 0, matchedCount: 0, totalTokens: 0 };
          const bMeta = scoreByTitleKey.get(b.titleKey) ?? { score: 0, matchedCount: 0, totalTokens: 0 };
          const coverageDiff = bMeta.matchedCount - aMeta.matchedCount;
          if (coverageDiff !== 0) return coverageDiff;
          const scoreDiff = bMeta.score - aMeta.score;
          if (scoreDiff !== 0) return scoreDiff;
        }
        if (a.title !== b.title) return a.title.localeCompare(b.title);
        return b.latestDateISO.localeCompare(a.latestDateISO);
      }),
    }));
  }, [categoryOrder, filteredGroups, hasQuery, scoreByTitleKey]);

  useEffect(() => {
    if (!uiHydrated) return;
    const timer = setTimeout(() => {
      void saveJSON<WorkoutCatalogUiState>(WORKOUT_CATALOG_UI_STATE_KEY, {
        query,
        selectedCategoryFilter,
        expandedCategories,
        expandedTitleGroups,
        scrollY: catalogScrollY,
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [catalogScrollY, expandedCategories, expandedTitleGroups, query, selectedCategoryFilter, uiHydrated]);

  useEffect(() => {
    if (!uiHydrated) return;
    if (loading) return;
    if (restoredScrollAppliedRef.current) return;
    if (!listScrollRef.current) return;
    restoredScrollAppliedRef.current = true;
    requestAnimationFrame(() => {
      listScrollRef.current?.scrollTo({ y: catalogScrollY, animated: false });
    });
  }, [catalogScrollY, loading, uiHydrated]);

  const expandedCategorySet = useMemo(
    () => new Set(expandedCategories.map((name) => String(name ?? "").trim()).filter(Boolean)),
    [expandedCategories]
  );

  const toggleCategoryExpanded = useCallback((categoryName: string) => {
    const key = String(categoryName ?? "").trim();
    if (!key) return;
    setExpandedCategories((prev) => {
      const set = new Set(prev.map((name) => String(name ?? "").trim()).filter(Boolean));
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return Array.from(set);
    });
  }, []);

  const expandedTitleGroupSet = useMemo(
    () => new Set(expandedTitleGroups.map((value) => String(value ?? "").trim()).filter(Boolean)),
    [expandedTitleGroups]
  );

  const toggleTitleGroupExpanded = useCallback((titleKey: string) => {
    const key = String(titleKey ?? "").trim();
    if (!key) return;
    setExpandedTitleGroups((prev) => {
      const set = new Set(prev.map((value) => String(value ?? "").trim()).filter(Boolean));
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return Array.from(set);
    });
  }, []);

  const openCatalogEntry = useCallback(
    (entry: CatalogEntry) => {
      const batchId = String(entry.sourceBatchId ?? "").trim();
      const dateISO = String(entry.sourceDateISO ?? entry.latestDateISO ?? "").trim();
      if (!batchId || !dateISO || !isISODateOnly(dateISO)) {
        Alert.alert("Open workout", "No valid source batch/date available for this catalog entry.");
        return;
      }
      router.push({
        pathname: "/(coach)/workouts",
        params: { date: dateISO, batch: batchId },
      });
    },
    [router]
  );

  const handleAssign = useCallback(
    async () => {
      const entry = assignModalEntry;
      if (!entry) return;
      const targetDateISO = String(assignDateISO ?? "").trim();
      if (!isISODateOnly(targetDateISO)) {
        Alert.alert("Assign", "Please enter a valid date in YYYY-MM-DD format.");
        return;
      }
      const selectedSet = new Set(
        selectedAssignAthleteIds
          .map((id) => String(id ?? "").trim())
          .filter(Boolean)
      );
      if (selectedSet.size === 0) {
        Alert.alert("Assign", "Select at least one athlete.");
        return;
      }
      if (!entry.rowsForAssign.length) {
        Alert.alert("Assign", "No source rows available for this catalog entry.");
        return;
      }

      const newBatchId = createBatchId(targetDateISO);
      const rowsSorted = [...entry.rowsForAssign].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const template = rowsSorted[0];
      if (!template) {
        Alert.alert("Assign", "No source template row available for this catalog entry.");
        return;
      }

      const selectedOrdered = roster
        .map((athlete) => String(athlete.id ?? "").trim())
        .filter((id) => selectedSet.has(id));
      if (selectedOrdered.length === 0) {
        Alert.alert("Assign", "Selected athletes are not available on the active roster.");
        return;
      }

      const payload = buildTeamWorkoutInsertRows({
        selectedAthleteIds: selectedOrdered,
        date_iso: targetDateISO,
        session: entry.session,
        location: entry.location || null,
        time_text: entry.timeText || "",
        title: entry.title,
        details: entry.details || null,
        primary_category: entry.primaryCategory,
        categories: Array.isArray(entry.categories) ? entry.categories : [],
        plannedDistanceUnit: template.planned_distance_unit,
        batch_id: newBatchId,
        group_id: "1",
        team_id: template.team_id,
        created_by: template.created_by ?? null,
        pre_routine_ids: entry.preRoutineIds.length > 0 ? entry.preRoutineIds : null,
        post_routine_ids: entry.postRoutineIds.length > 0 ? entry.postRoutineIds : null,
      });
      if (payload.length === 0) {
        Alert.alert("Assign", "No rows were generated for this assignment.");
        return;
      }

      let sourceMainNotes: string | null = null;
      const sourceBatchId = String(entry.sourceBatchId ?? "").trim();
      const sourceDateISO = String(entry.sourceDateISO ?? "").trim();
      if (sourceBatchId && sourceDateISO && isISODateOnly(sourceDateISO)) {
        const sourceHeaderRows = await listTeamWorkoutBatchHeadersForDate(sourceDateISO);
        const match = (Array.isArray(sourceHeaderRows) ? sourceHeaderRows : []).find((headerRow) => {
          const headerBatchId = String(headerRow.batch_id ?? "").trim();
          const headerDate = String(headerRow.date_iso ?? "").trim();
          return headerBatchId === sourceBatchId && headerDate === sourceDateISO;
        });
        const headerNotes = String(match?.header_notes ?? "").trim();
        sourceMainNotes = headerNotes || null;
      }
      if (!sourceMainNotes) {
        sourceMainNotes = String(entry.details ?? "").trim() || null;
      }

      console.log("[workout-catalog] assignBatchFromCatalog", {
        sourceBatchId: sourceBatchId || null,
        sourceDateISO: sourceDateISO || null,
        sourceTitle: String(entry.title ?? "").trim(),
        sourceMainNotes: sourceMainNotes ?? null,
        newBatchId,
        selectedAthleteCount: selectedOrdered.length,
      });

      setAssigningSignature(entry.signature);
      try {
        await createTeamWorkoutBatch(payload);
        if (sourceMainNotes) {
          await Promise.all([
            saveTeamWorkoutBatchHeaderNotes({
              batch_id: newBatchId,
              date_iso: targetDateISO,
              session: "AM",
              header_notes: sourceMainNotes,
            }),
            saveTeamWorkoutBatchHeaderNotes({
              batch_id: newBatchId,
              date_iso: targetDateISO,
              session: "PM",
              header_notes: sourceMainNotes,
            }),
          ]);
        }
        setAssignModalEntry(null);
        setAssignAthleteSearch("");
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
    [assignDateISO, assignModalEntry, roster, router, selectedAssignAthleteIds]
  );

  const openAssignFlow = useCallback(
    (entry: CatalogEntry) => {
      const rosterIds = new Set(
        roster.map((athlete) => String(athlete.id ?? "").trim()).filter(Boolean)
      );
      const sourceAthleteIds = Array.from(
        new Set(
          entry.rowsForAssign
            .map((row) => String(row.athlete_profile_id ?? "").trim())
            .filter((id) => rosterIds.has(id))
        )
      );
      const fallbackSelection = roster
        .map((athlete) => String(athlete.id ?? "").trim())
        .filter(Boolean);
      setAssignDateISO(todayISODate());
      setAssignAthleteSearch("");
      setSelectedAssignAthleteIds(sourceAthleteIds.length > 0 ? sourceAthleteIds : fallbackSelection);
      setAssignModalEntry(entry);
    },
    [roster]
  );

  const assignRosterForPicker = useMemo(() => {
    const q = String(assignAthleteSearch ?? "").trim().toLowerCase();
    const cleanRoster = Array.isArray(roster) ? roster : [];
    return cleanRoster.filter((athlete) => {
      if (!q) return true;
      const haystack = `${String(athlete.displayName ?? "")} ${String(athlete.searchText ?? "")}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [assignAthleteSearch, roster]);

  const selectedAssignAthleteIdSet = useMemo(
    () =>
      new Set(
        selectedAssignAthleteIds
          .map((id) => String(id ?? "").trim())
          .filter(Boolean)
      ),
    [selectedAssignAthleteIds]
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
                placeholder="Search title, notes, location, category, routines..."
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
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {categoryFilterOptions.map((option) => {
              const active = option === selectedCategoryFilter;
              return (
                <Pressable
                  key={option}
                  onPress={() => setSelectedCategoryFilter(option)}
                  style={{
                    borderWidth: 1,
                    borderColor: active ? "#93c5fd" : "#d5deea",
                    borderRadius: 999,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    backgroundColor: active ? "#eff6ff" : "#fff",
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: "800", color: active ? "#1d4ed8" : "#334155" }}>
                    {option}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Text style={{ fontSize: 11, fontWeight: "700", color: "#64748b" }}>
            {loading
              ? "Loading historical batches..."
              : `${filteredGroups.length} title groups from ${titleGroups.length} grouped workouts`}
          </Text>
        </Card>

        <ScrollView
          ref={listScrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: 10, paddingBottom: 18 }}
          onScrollEndDrag={(event) => {
            const nextY = Number(event?.nativeEvent?.contentOffset?.y ?? 0);
            setCatalogScrollY(Number.isFinite(nextY) && nextY > 0 ? nextY : 0);
          }}
          onMomentumScrollEnd={(event) => {
            const nextY = Number(event?.nativeEvent?.contentOffset?.y ?? 0);
            setCatalogScrollY(Number.isFinite(nextY) && nextY > 0 ? nextY : 0);
          }}
          scrollEventThrottle={16}
        >
          {!loading && sections.length === 0 ? (
            <Card style={{ borderColor: "#dfe6f2", borderRadius: 14, padding: 14 }}>
              <Text style={{ fontSize: 14, fontWeight: "800", color: "#334155" }}>No catalog entries found</Text>
              <Text style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
                Create a workout batch first, then it will appear here after deduplication.
              </Text>
            </Card>
          ) : null}

          {sections.map((section) => {
            const expanded = expandedCategorySet.has(section.categoryName);
            return (
            <Card key={section.categoryName} style={{ borderColor: "#dfe6f2", borderRadius: 14, padding: 12, gap: 8 }}>
              <Pressable
                onPress={() => toggleCategoryExpanded(section.categoryName)}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}
              >
                <Text style={{ fontSize: 15, fontWeight: "900", color: "#0f172a" }}>
                  {expanded ? "▾ " : "▸ "}
                  {section.categoryName}
                </Text>
                <Text style={{ fontSize: 11, fontWeight: "700", color: "#64748b" }}>
                  {section.entries.length} item{section.entries.length === 1 ? "" : "s"}
                </Text>
              </Pressable>

              {expanded
                ? section.entries.map((group) => {
                const latest = group.primaryEntry;
                const assigning = assigningSignature === latest.signature;
                const historyExpanded = expandedTitleGroupSet.has(group.titleKey);
                return (
                  <Pressable
                    key={`${section.categoryName}::${group.titleKey}`}
                    onPress={() => openCatalogEntry(latest)}
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
                        <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>
                          {renderHighlightedText(group.title, highlightTokens)}
                        </Text>
                        <Text style={{ marginTop: 2, fontSize: 12, fontWeight: "700", color: "#475569" }}>
                          {latest.session}
                          {latest.timeText ? ` • ${latest.timeText}` : ""}
                          {latest.location ? " • " : ""}
                          {latest.location ? renderHighlightedText(latest.location, highlightTokens) : null}
                        </Text>
                      </View>
                      <View style={{ flexDirection: "row", gap: 6 }}>
                        {group.versions.length > 1 ? (
                          <Pressable
                            onPress={(event) => {
                              event?.stopPropagation?.();
                              toggleTitleGroupExpanded(group.titleKey);
                            }}
                            style={{
                              borderWidth: 1,
                              borderColor: "#d5deea",
                              borderRadius: 8,
                              paddingHorizontal: 10,
                              paddingVertical: 6,
                              backgroundColor: "#fff",
                            }}
                          >
                            <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>
                              {historyExpanded ? "Hide History" : `History (${group.versions.length})`}
                            </Text>
                          </Pressable>
                        ) : null}
                        <Pressable
                          onPress={(event) => {
                            event?.stopPropagation?.();
                            openAssignFlow(latest);
                          }}
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
                    </View>

                    {latest.details ? (
                      <Text style={{ fontSize: 12, lineHeight: 18, color: "#334155" }}>
                        {renderHighlightedText(latest.details, highlightTokens)}
                      </Text>
                    ) : null}

                    <Text style={{ fontSize: 11, color: "#64748b" }}>
                      Categories: {renderHighlightedText(group.categories.length > 0 ? group.categories.join(", ") : "Uncategorized", highlightTokens)}
                    </Text>
                    <Text style={{ fontSize: 11, color: "#64748b" }}>
                      Latest: {latest.sourceDateISO} • Versions: {group.versions.length} • Athletes: {group.athleteCountMax} • Rows: {group.rowCountMax}
                    </Text>

                    {historyExpanded ? (
                      <View style={{ marginTop: 4, gap: 6 }}>
                        {group.versions.map((version, versionIndex) => {
                          const versionAssigning = assigningSignature === version.signature;
                          const isLatest = versionIndex === 0;
                          return (
                            <Pressable
                              key={`${group.titleKey}::version::${version.signature}`}
                              onPress={(event) => {
                                event?.stopPropagation?.();
                                openCatalogEntry(version);
                              }}
                              style={{
                                borderWidth: 1,
                                borderColor: "#e5eaf3",
                                borderRadius: 8,
                                paddingHorizontal: 8,
                                paddingVertical: 7,
                                backgroundColor: isLatest ? "#f8fafc" : "#fff",
                                gap: 4,
                              }}
                            >
                              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>
                                  {isLatest ? "Latest • " : ""}
                                  {version.sourceDateISO} • {version.session}
                                  {version.timeText ? ` • ${version.timeText}` : ""}
                                  {version.location ? ` • ${version.location}` : ""}
                                </Text>
                                <Pressable
                                  onPress={(event) => {
                                    event?.stopPropagation?.();
                                    openAssignFlow(version);
                                  }}
                                  disabled={versionAssigning}
                                  style={{
                                    borderWidth: 1,
                                    borderColor: "#d5deea",
                                    borderRadius: 7,
                                    paddingHorizontal: 8,
                                    paddingVertical: 5,
                                    backgroundColor: "#fff",
                                    opacity: versionAssigning ? 0.65 : 1,
                                  }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#1e293b" }}>
                                    {versionAssigning ? "Assigning..." : "Assign"}
                                  </Text>
                                </Pressable>
                              </View>
                              {version.details ? (
                                <Text style={{ fontSize: 11, lineHeight: 16, color: "#475569" }}>
                                  {renderHighlightedText(version.details, highlightTokens)}
                                </Text>
                              ) : null}
                            </Pressable>
                          );
                        })}
                      </View>
                    ) : null}
                  </Pressable>
                );
              })
                : null}
            </Card>
          );
          })}
        </ScrollView>

        <Modal
          visible={!!assignModalEntry}
          animationType="fade"
          transparent
          onRequestClose={() => setAssignModalEntry(null)}
        >
          <View
            style={{
              flex: 1,
              backgroundColor: "rgba(15, 23, 42, 0.34)",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <View
              style={{
                width: "100%",
                maxWidth: 720,
                maxHeight: "88%",
                borderRadius: 14,
                borderWidth: 1,
                borderColor: "#d8e1ee",
                backgroundColor: "#fff",
                padding: 12,
                gap: 10,
              }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 16, fontWeight: "900", color: "#0f172a" }}>Assign Workout Catalog Entry</Text>
                  <Text style={{ marginTop: 2, fontSize: 12, color: "#64748b" }}>
                    {assignModalEntry?.title ?? "Workout"}
                  </Text>
                </View>
                <Pressable
                  onPress={() => setAssignModalEntry(null)}
                  style={{
                    borderWidth: 1,
                    borderColor: "#d5deea",
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    backgroundColor: "#f8fafc",
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>Close</Text>
                </Pressable>
              </View>

              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                <View style={{ width: 170 }}>
                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Date</Text>
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
                <View style={{ minWidth: 220, flex: 1 }}>
                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Athlete search</Text>
                  <TextInput
                    value={assignAthleteSearch}
                    onChangeText={setAssignAthleteSearch}
                    placeholder="Search athlete..."
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
              </View>

              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: "#475569" }}>
                  {selectedAssignAthleteIds.length} selected
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable
                    onPress={() =>
                      setSelectedAssignAthleteIds(
                        roster
                          .map((athlete) => String(athlete.id ?? "").trim())
                          .filter(Boolean)
                      )
                    }
                    style={{
                      borderWidth: 1,
                      borderColor: "#d5deea",
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      backgroundColor: "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>Select all</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setSelectedAssignAthleteIds([])}
                    style={{
                      borderWidth: 1,
                      borderColor: "#d5deea",
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      backgroundColor: "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>Clear</Text>
                  </Pressable>
                </View>
              </View>

              <ScrollView
                style={{ maxHeight: 320 }}
                contentContainerStyle={{ gap: 6, paddingBottom: 4 }}
              >
                {assignRosterForPicker.length === 0 ? (
                  <Text style={{ fontSize: 12, color: "#64748b" }}>No athletes found.</Text>
                ) : (
                  assignRosterForPicker.map((athlete) => {
                    const athleteId = String(athlete.id ?? "").trim();
                    const selected = selectedAssignAthleteIdSet.has(athleteId);
                    return (
                      <Pressable
                        key={athleteId}
                        onPress={() =>
                          setSelectedAssignAthleteIds((prev) => {
                            const current = new Set(prev.map((id) => String(id ?? "").trim()).filter(Boolean));
                            if (selected) current.delete(athleteId);
                            else current.add(athleteId);
                            const order = roster
                              .map((item) => String(item.id ?? "").trim())
                              .filter((id) => current.has(id));
                            return order;
                          })
                        }
                        style={{
                          borderWidth: 1,
                          borderColor: selected ? "#93c5fd" : "#d8e1ee",
                          borderRadius: 8,
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                          backgroundColor: selected ? "#eff6ff" : "#fff",
                        }}
                      >
                        <Text style={{ fontSize: 13, fontWeight: "800", color: "#0f172a" }}>
                          {athlete.displayName}
                        </Text>
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>

              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
                <Pressable
                  onPress={() => setAssignModalEntry(null)}
                  style={{
                    borderWidth: 1,
                    borderColor: "#d5deea",
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    backgroundColor: "#fff",
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => void handleAssign()}
                  disabled={
                    !assignModalEntry ||
                    selectedAssignAthleteIds.length === 0 ||
                    assigningSignature === assignModalEntry.signature
                  }
                  style={{
                    borderWidth: 1,
                    borderColor: "#cdd7e6",
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    backgroundColor: "#f8fafc",
                    opacity:
                      !assignModalEntry ||
                      selectedAssignAthleteIds.length === 0 ||
                      assigningSignature === assignModalEntry?.signature
                        ? 0.5
                        : 1,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "900", color: "#1e293b" }}>
                    {assignModalEntry && assigningSignature === assignModalEntry.signature ? "Assigning..." : "Assign"}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </Screen>
  );
}
