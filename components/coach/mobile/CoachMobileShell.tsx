import { Ionicons } from "@expo/vector-icons";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { AccountContextSelector } from "../../account/AccountContextSelector";
import { listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";
import { listTeamWorkoutBatchHeadersInRange, type TeamWorkoutBatchHeaderRow } from "../../../lib/teamWorkoutBatchHeadersCloud";
import { teamDataStore } from "../../../lib/teamDataStore";
import { parseISODate, toISODate } from "../../../lib/mileagePlan";
import { getAthleteDisplayName } from "../../../lib/athleteName";
import { hasWorkoutFeedback } from "../../../lib/feedbackParsing";
import { clearActiveAccountContext } from "../../../lib/accountContexts";
import { supabase } from "../../../lib/supabase";
import { DateField } from "../../ui/DateField";
import {
  loadAuxiliaryRoutineDefinitionsWithStatus,
  type AuxiliaryRoutine,
} from "../../../lib/auxiliaryRoutines";
import {
  loadDrillLibraryDefinitionsWithStatus,
  loadRoutineFoldersWithStatus,
  type DrillLibraryItem,
  type RoutineFolder,
} from "../../../lib/drillLibrary";
import { CATEGORIES_KEY, normalizeCategories } from "../../../lib/categories";
import { loadJSON } from "../../../lib/storage";
import type { WorkoutCategory } from "../../../lib/types";
import {
  buildBatchNotesByWorkoutId,
  cleanDisplayText,
  formatPlannedDistanceLabel,
  getRoutineTitles,
} from "../../../lib/athleteWorkoutDisplay";
import { CoachMobileWorkoutCard, type CoachMobileWorkoutGroup } from "./CoachMobileWorkoutCard";
import { CoachMobileWorkoutDetail } from "./CoachMobileWorkoutDetail";
import { CoachMobileRoutineBrowser } from "./coach-mobile-routine-browser";

type MobileSection = "home" | "calendar" | "logs" | "roster" | "more";

type MobileNavItem = {
  key: MobileSection;
  label: string;
  icon: ComponentProps<typeof Ionicons>["name"];
  href: string;
};

const MOBILE_NAV_ITEMS: MobileNavItem[] = [
  { key: "home", label: "Home", icon: "home-outline", href: "/(coach)/(tabs)/dashboard" },
  { key: "calendar", label: "Calendar", icon: "calendar-outline", href: "/(coach)/(tabs)/calendar" },
  { key: "logs", label: "Logs", icon: "document-text-outline", href: "/(coach)/(tabs)/training-logs" },
  { key: "roster", label: "Roster", icon: "people-outline", href: "/(coach)/(tabs)/roster" },
  { key: "more", label: "More", icon: "ellipsis-horizontal-circle-outline", href: "/(coach)/(tabs)/settings" },
];

function addDaysISO(dateISO: string, days: number) {
  const date = parseISODate(dateISO);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

function todayISO() {
  return toISODate(new Date());
}

function formatDateLabel(dateISO: string) {
  const date = parseISODate(dateISO);
  if (Number.isNaN(date.getTime())) return dateISO;
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function getDateParam(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const text = String(raw ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function resolveSection(pathname: string): MobileSection {
  const path = String(pathname ?? "");
  if (path.includes("/training-logs")) return "logs";
  if (path.includes("/roster")) return "roster";
  if (path.includes("/calendar") || path.includes("/workouts") || path.includes("/workout/")) return "calendar";
  if (
    path.includes("/settings") ||
    path.includes("/mileage") ||
    path.includes("/workout-catalog") ||
    path.includes("/auxiliary-routines") ||
    path.includes("/training-groups") ||
    path.includes("/categories") ||
    path.includes("/plan-builder") ||
    path.includes("/planner")
  ) {
    return "more";
  }
  return "home";
}

function extractRosterId(pathname: string): string | null {
  const match = String(pathname ?? "").match(/\/roster\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getWorkoutTitle(rows: TeamWorkoutRow[]) {
  return rows.find((row) => String(row.title ?? "").trim())?.title?.trim() || "Untitled workout";
}

function getWorkoutCategories(rows: TeamWorkoutRow[]) {
  const values = new Set<string>();
  rows.forEach((row) => {
    (row.categories ?? []).forEach((category) => {
      const text = String(category ?? "").trim();
      if (text) values.add(text);
    });
    const primary = String(row.primary_category ?? "").trim();
    if (primary) values.add(primary);
  });
  return Array.from(values);
}

function normalizeRoutineIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((id) => cleanDisplayText(id)).filter(Boolean);
}

function firstCleanValue(rows: TeamWorkoutRow[], key: "time_text" | "location") {
  return rows.map((row) => cleanDisplayText(row[key])).find(Boolean) ?? "";
}

function uniqueClean(values: string[]) {
  return Array.from(new Set(values.map((value) => cleanDisplayText(value)).filter(Boolean)));
}

function groupWorkouts(
  rows: TeamWorkoutRow[],
  options: {
    batchNotesByWorkoutId: Map<string, string>;
    routineById: Map<string, AuxiliaryRoutine>;
    rosterById: Map<string, ReturnType<typeof teamDataStore.use>["roster"][number]>;
  }
): CoachMobileWorkoutGroup[] {
  const map = new Map<string, TeamWorkoutRow[]>();
  rows.forEach((row) => {
    const key = `${row.date_iso}|${row.session}|${row.batch_id || row.id}`;
    map.set(key, [...(map.get(key) ?? []), row]);
  });
  return Array.from(map.entries())
    .map(([key, groupedRows]) => {
      const [dateISO, session] = key.split("|");
      const resolvedSession: "AM" | "PM" = session === "AM" ? "AM" : "PM";
      const athleteIds = Array.from(new Set(groupedRows.map((row) => cleanDisplayText(row.athlete_profile_id)).filter(Boolean)));
      const visibleCount = groupedRows.filter((row) => row.athlete_visible).length;
      const firstRow = groupedRows[0];
      const firstWorkoutId = cleanDisplayText(firstRow?.id);
      const batchDetails =
        groupedRows
          .map((row) => options.batchNotesByWorkoutId.get(cleanDisplayText(row.id)) ?? "")
          .map(cleanDisplayText)
          .find(Boolean) ?? "";
      const individualDetails = groupedRows
        .map((row) => {
          const details = cleanDisplayText(row.details);
          if (!details || details === batchDetails) return null;
          const athlete = options.rosterById.get(cleanDisplayText(row.athlete_profile_id));
          return {
            workoutId: cleanDisplayText(row.id),
            athleteName: athlete ? getAthleteDisplayName(athlete) : `Athlete (${cleanDisplayText(row.athlete_profile_id).slice(-6)})`,
            details,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      const athleteNames = athleteIds
        .map((id) => {
          const athlete = options.rosterById.get(id);
          return athlete ? getAthleteDisplayName(athlete) : `Athlete (${id.slice(-6)})`;
        })
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      const preRoutineIds = normalizeRoutineIds(firstRow?.pre_routine_ids);
      const postRoutineIds = normalizeRoutineIds(firstRow?.post_routine_ids);
      return {
        key,
        dateISO: dateISO ?? cleanDisplayText(firstRow?.date_iso),
        session: resolvedSession,
        rows: groupedRows,
        title: getWorkoutTitle(groupedRows),
        batchDetails,
        individualDetails,
        categories: getWorkoutCategories(groupedRows),
        athleteNames,
        athleteCount: athleteIds.length,
        visibleCount,
        hiddenCount: Math.max(0, groupedRows.length - visibleCount),
        time: firstCleanValue(groupedRows, "time_text"),
        location: firstCleanValue(groupedRows, "location"),
        plannedDistanceLabels: uniqueClean(
          groupedRows.map((row) => formatPlannedDistanceLabel(row.planned_distance, row.planned_distance_unit))
        ),
        preRoutineIds,
        postRoutineIds,
        preRoutineTitles: firstWorkoutId ? getRoutineTitles(preRoutineIds, options.routineById) : [],
        postRoutineTitles: firstWorkoutId ? getRoutineTitles(postRoutineIds, options.routineById) : [],
      };
    })
    .sort((a, b) => `${a.dateISO}-${a.session}`.localeCompare(`${b.dateISO}-${b.session}`));
}

function Pill({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "success" | "warning" }) {
  const colors =
    tone === "success"
      ? { bg: "#ecfdf5", fg: "#047857", bd: "#a7f3d0" }
      : tone === "warning"
        ? { bg: "#fff7ed", fg: "#9a3412", bd: "#fed7aa" }
        : { bg: "#f8fafc", fg: "#475569", bd: "#dbe3ef" };
  return (
    <View style={{ borderWidth: 1, borderColor: colors.bd, backgroundColor: colors.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 }}>
      <Text style={{ color: colors.fg, fontWeight: "900", fontSize: 11 }}>{children}</Text>
    </View>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: "#dbe3ef",
        backgroundColor: "#fff",
        borderRadius: 12,
        padding: 12,
        gap: 8,
      }}
    >
      {children}
    </View>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={{ gap: 3 }}>
      <Text style={{ fontSize: 20, fontWeight: "900", color: "#172033" }}>{title}</Text>
      {subtitle ? <Text style={{ fontSize: 12, fontWeight: "700", color: "#64748b" }}>{subtitle}</Text> : null}
    </View>
  );
}

function DesktopOnlyCard({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <Text style={{ fontSize: 15, fontWeight: "900", color: "#172033" }}>{title}</Text>
      <Text style={{ color: "#64748b", fontWeight: "700", lineHeight: 19 }}>{body}</Text>
    </Card>
  );
}

export function CoachMobileShell() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const teamStore = teamDataStore.use();
  const section = resolveSection(pathname);
  const selectedDateISO = getDateParam(params.date) ?? todayISO();
  const [selectedLogDateISO, setSelectedLogDateISO] = useState(() => getDateParam(params.date) ?? todayISO());
  const [selectedLogDateDraft, setSelectedLogDateDraft] = useState(() => getDateParam(params.date) ?? todayISO());
  const [workouts, setWorkouts] = useState<TeamWorkoutRow[]>([]);
  const [batchHeaders, setBatchHeaders] = useState<TeamWorkoutBatchHeaderRow[]>([]);
  const [routineById, setRoutineById] = useState<Map<string, AuxiliaryRoutine>>(new Map());
  const [drillById, setDrillById] = useState<Map<string, DrillLibraryItem>>(new Map());
  const [routineFolders, setRoutineFolders] = useState<RoutineFolder[]>([]);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [routineDataError, setRoutineDataError] = useState<string | null>(null);
  const [loadingRoutineData, setLoadingRoutineData] = useState(false);
  const [loadingWorkouts, setLoadingWorkouts] = useState(false);
  const [workoutError, setWorkoutError] = useState<string | null>(null);
  const [rosterQuery, setRosterQuery] = useState("");
  const [selectedWorkout, setSelectedWorkout] = useState<CoachMobileWorkoutGroup | null>(null);
  const [routineBrowserOpen, setRoutineBrowserOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  useEffect(() => {
    void teamDataStore.actions.refreshRoster().catch(() => {});
  }, []);

  useEffect(() => {
    if (section !== "logs") return;
    const nextDateISO = getDateParam(params.date) ?? todayISO();
    setSelectedLogDateISO(nextDateISO);
    setSelectedLogDateDraft(nextDateISO);
  }, [params.date, section]);

  useEffect(() => {
    if (section !== "more") setRoutineBrowserOpen(false);
  }, [section]);

  useEffect(() => {
    let cancelled = false;
    const startISO = section === "logs" ? selectedLogDateISO : selectedDateISO;
    const endISO = section === "home" ? addDaysISO(todayISO(), 7) : section === "logs" ? selectedLogDateISO : addDaysISO(selectedDateISO, 6);
    setLoadingWorkouts(true);
    setWorkoutError(null);
    Promise.all([
      listTeamWorkoutsInRange(startISO, endISO),
      listTeamWorkoutBatchHeadersInRange(startISO, endISO),
      loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []),
    ])
      .then(([rows, headers, storedCategories]) => {
        if (cancelled) return;
        setWorkouts(rows);
        setBatchHeaders(headers);
        setCategories(normalizeCategories(storedCategories));
      })
      .catch((error) => {
        if (!cancelled) setWorkoutError(error instanceof Error ? error.message : "Could not load workouts.");
      })
      .finally(() => {
        if (!cancelled) setLoadingWorkouts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section, selectedDateISO, selectedLogDateISO]);

  useEffect(() => {
    let cancelled = false;
    setLoadingRoutineData(true);
    setRoutineDataError(null);
    Promise.all([
      loadAuxiliaryRoutineDefinitionsWithStatus(),
      loadRoutineFoldersWithStatus(),
      loadDrillLibraryDefinitionsWithStatus(),
    ])
      .then(([routineResult, folderResult, drillResult]) => {
        if (cancelled) return;
        setRoutineById(new Map(routineResult.items.map((routine) => [routine.id, routine] as const)));
        setRoutineFolders(folderResult.items);
        setDrillById(new Map(drillResult.items.map((drill) => [drill.id, drill] as const)));
        const readErrors = [
          !routineResult.loadedFromCloud ? `routines: ${routineResult.cloudError ?? "cloud read failed"}` : "",
          !folderResult.loadedFromCloud ? `routine folders: ${folderResult.cloudError ?? "cloud read failed"}` : "",
          !drillResult.loadedFromCloud ? `drill library: ${drillResult.cloudError ?? "cloud read failed"}` : "",
        ].filter(Boolean);
        setRoutineDataError(readErrors.length ? `Could not load latest drill routine details. ${readErrors.join("; ")}` : null);
      })
      .catch((error) => {
        if (!cancelled) {
          setRoutineDataError(error instanceof Error ? error.message : "Could not load drill routines.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingRoutineData(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section]);

  const batchNotesByWorkoutId = useMemo(() => buildBatchNotesByWorkoutId(workouts, batchHeaders), [batchHeaders, workouts]);
  const rosterById = useMemo(
    () => new Map(teamStore.roster.map((athlete) => [cleanDisplayText(athlete.id), athlete] as const)),
    [teamStore.roster]
  );
  const groupedWorkouts = useMemo(
    () => groupWorkouts(workouts, { batchNotesByWorkoutId, routineById, rosterById }),
    [batchNotesByWorkoutId, rosterById, routineById, workouts]
  );
  const todayWorkouts = useMemo(() => groupedWorkouts.filter((item) => item.dateISO === todayISO()), [groupedWorkouts]);
  const upcomingWorkouts = useMemo(() => groupedWorkouts.filter((item) => item.dateISO >= todayISO()).slice(0, 8), [groupedWorkouts]);
  const roster = useMemo(
    () =>
      [...teamStore.roster]
        .filter((athlete) => String(athlete.roster_status ?? "active") === "active")
        .sort((a, b) => getAthleteDisplayName(a).localeCompare(getAthleteDisplayName(b))),
    [teamStore.roster]
  );
  const filteredRoster = useMemo(() => {
    const query = rosterQuery.trim().toLowerCase();
    if (!query) return roster;
    return roster.filter((athlete) => getAthleteDisplayName(athlete).toLowerCase().includes(query));
  }, [roster, rosterQuery]);
  const selectedRosterId = extractRosterId(pathname);
  const selectedAthlete = selectedRosterId ? teamStore.roster.find((athlete) => athlete.id === selectedRosterId) ?? null : null;
  const selectedDateLogs = useMemo(() => {
    const athleteNameForRow = (row: TeamWorkoutRow) => {
      const athleteId = cleanDisplayText(row.athlete_profile_id);
      const athlete = rosterById.get(athleteId);
      return athlete ? getAthleteDisplayName(athlete) : `Athlete (${athleteId.slice(-6)})`;
    };
    return [...workouts]
      .filter((row) => cleanDisplayText(row.date_iso) === selectedLogDateISO && hasWorkoutFeedback(row))
      .sort((a, b) => {
        const sessionOrder = (a.session === "AM" ? 0 : 1) - (b.session === "AM" ? 0 : 1);
        if (sessionOrder !== 0) return sessionOrder;
        const athleteOrder = athleteNameForRow(a).localeCompare(athleteNameForRow(b));
        if (athleteOrder !== 0) return athleteOrder;
        return cleanDisplayText(a.title).localeCompare(cleanDisplayText(b.title));
      });
  }, [rosterById, selectedLogDateISO, workouts]);

  const navigate = (href: string) => router.replace(href as any);

  const selectLogDate = (nextDateISO: string) => {
    const validDateISO = getDateParam(nextDateISO);
    if (!validDateISO) return;
    setSelectedLogDateISO(validDateISO);
    setSelectedLogDateDraft(validDateISO);
    navigate(`/(coach)/(tabs)/training-logs?date=${validDateISO}`);
  };

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      await clearActiveAccountContext();
      router.replace("/(auth)/login");
    } catch (error: any) {
      setSignOutError(String(error?.message ?? "Could not sign out. Please try again."));
    } finally {
      setSigningOut(false);
    }
  }

  const renderContent = () => {
    if (section === "home") {
      return (
        <>
          <SectionHeader title="Coach Home" subtitle="A compact mobile view for checking the day and moving around quickly." />
          {loadingWorkouts ? <ActivityIndicator /> : null}
          {workoutError ? <Text style={{ color: "#b91c1c", fontWeight: "800" }}>{workoutError}</Text> : null}
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 13, fontWeight: "900", color: "#475569" }}>Today</Text>
            {(todayWorkouts.length ? todayWorkouts : upcomingWorkouts.slice(0, 3)).map((item) => (
              <CoachMobileWorkoutCard
                key={item.key}
                item={item}
                categoriesSource={categories}
                onPress={() => setSelectedWorkout(item)}
              />
            ))}
            {!todayWorkouts.length && !upcomingWorkouts.length && !loadingWorkouts ? (
              <DesktopOnlyCard title="No workouts found" body="No workouts are scheduled in the next week." />
            ) : null}
          </View>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Pressable onPress={() => navigate("/(coach)/(tabs)/calendar")} style={quickButtonStyle}>
              <Text style={quickButtonTextStyle}>Open Calendar</Text>
            </Pressable>
            <Pressable onPress={() => navigate("/(coach)/(tabs)/roster")} style={quickButtonStyle}>
              <Text style={quickButtonTextStyle}>Roster</Text>
            </Pressable>
          </View>
        </>
      );
    }

    if (section === "calendar") {
      return (
        <>
          <SectionHeader title="Calendar" subtitle={`Compact week starting ${formatDateLabel(selectedDateISO)}`} />
          {loadingWorkouts ? <ActivityIndicator /> : null}
          {workoutError ? <Text style={{ color: "#b91c1c", fontWeight: "800" }}>{workoutError}</Text> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable onPress={() => navigate(`/(coach)/workouts?date=${addDaysISO(selectedDateISO, -1)}`)} style={dateButtonStyle}>
              <Text style={dateButtonTextStyle}>Prev</Text>
            </Pressable>
            <Pressable onPress={() => navigate(`/(coach)/workouts?date=${todayISO()}`)} style={dateButtonStyle}>
              <Text style={dateButtonTextStyle}>Today</Text>
            </Pressable>
            <Pressable onPress={() => navigate(`/(coach)/workouts?date=${addDaysISO(selectedDateISO, 1)}`)} style={dateButtonStyle}>
              <Text style={dateButtonTextStyle}>Next</Text>
            </Pressable>
          </View>
          {groupedWorkouts.map((item) => (
            <CoachMobileWorkoutCard
              key={item.key}
              item={item}
              categoriesSource={categories}
              onPress={() => setSelectedWorkout(item)}
            />
          ))}
          {!groupedWorkouts.length && !loadingWorkouts ? (
            <DesktopOnlyCard title="No workouts in this range" body="Use desktop for full workout creation, duplication, bulk editing, and weekly copy actions." />
          ) : null}
        </>
      );
    }

    if (section === "logs") {
      return (
        <>
          <SectionHeader title="Training Logs" subtitle={formatDateLabel(selectedLogDateISO)} />
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, width: "100%" }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous day"
              onPress={() => selectLogDate(addDaysISO(selectedLogDateISO, -1))}
              style={logDateNavButtonStyle}
            >
              <Ionicons name="chevron-back" size={16} color="#172033" />
              <Text numberOfLines={1} style={logDateNavButtonTextStyle}>Prev Day</Text>
            </Pressable>
            <DateField
              value={selectedLogDateDraft}
              onChangeText={(nextValue) => {
                setSelectedLogDateDraft(nextValue);
                const validDateISO = getDateParam(nextValue);
                if (validDateISO) selectLogDate(validDateISO);
              }}
              style={{ flex: 1, minWidth: 0 }}
              inputStyle={{ fontSize: 13, fontWeight: "800", textAlign: "center", paddingHorizontal: 6 }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next day"
              onPress={() => selectLogDate(addDaysISO(selectedLogDateISO, 1))}
              style={logDateNavButtonStyle}
            >
              <Text numberOfLines={1} style={logDateNavButtonTextStyle}>Next Day</Text>
              <Ionicons name="chevron-forward" size={16} color="#172033" />
            </Pressable>
          </View>
          {loadingWorkouts ? <ActivityIndicator /> : null}
          {workoutError ? <Text style={{ color: "#b91c1c", fontWeight: "800" }}>{workoutError}</Text> : null}
          {selectedDateLogs.map((row) => {
            const athleteId = cleanDisplayText(row.athlete_profile_id);
            const athlete = rosterById.get(athleteId);
            return (
              <Card key={row.id}>
                <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>
                  {[formatDateLabel(row.date_iso), row.session, cleanDisplayText(row.time_text)].filter(Boolean).join(" · ")}
                </Text>
                <Text style={{ fontSize: 16, fontWeight: "900", color: "#172033" }}>
                  {athlete ? getAthleteDisplayName(athlete) : `Athlete (${athleteId.slice(-6)})`}
                </Text>
                <Text style={{ color: "#334155", fontWeight: "700" }}>{row.title}</Text>
                <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                  {row.completed_miles != null ? <Pill>{`${row.completed_miles} mi`}</Pill> : null}
                  {row.completed_time_text ? <Pill>{row.completed_time_text}</Pill> : null}
                  {row.splits_or_pace ? <Pill>{row.splits_or_pace}</Pill> : null}
                </View>
                {row.additional_feedback ? <Text style={{ color: "#475569", lineHeight: 19 }}>{row.additional_feedback}</Text> : null}
              </Card>
            );
          })}
          {!selectedDateLogs.length && !loadingWorkouts && !workoutError ? (
            <DesktopOnlyCard
              title="No logs submitted for this date."
              body={`Athlete workout feedback for ${formatDateLabel(selectedLogDateISO)} will appear here.`}
            />
          ) : null}
        </>
      );
    }

    if (section === "roster") {
      return (
        <>
          <SectionHeader title="Roster" subtitle={`${roster.length} active athletes`} />
          {selectedAthlete ? (
            <Card>
              <Text style={{ fontSize: 20, fontWeight: "900", color: "#172033" }}>{getAthleteDisplayName(selectedAthlete)}</Text>
              <Text style={{ color: "#64748b", fontWeight: "700" }}>{selectedAthlete.email || "No email saved"}</Text>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                <Pill>{selectedAthlete.claimed_user_id ? "Linked login" : "Not linked"}</Pill>
                <Pill>{selectedAthlete.team_start_date ? `Start ${selectedAthlete.team_start_date}` : "No start date"}</Pill>
                {selectedAthlete.team_end_date ? <Pill tone="warning">{`End ${selectedAthlete.team_end_date}`}</Pill> : null}
              </View>
            </Card>
          ) : null}
          <TextInput
            value={rosterQuery}
            onChangeText={setRosterQuery}
            placeholder="Search roster"
            placeholderTextColor="#94a3b8"
            style={{
              height: 44,
              borderWidth: 1,
              borderColor: "#dbe3ef",
              borderRadius: 12,
              paddingHorizontal: 12,
              backgroundColor: "#fff",
              fontWeight: "800",
              color: "#172033",
            }}
          />
          {filteredRoster.map((athlete) => (
            <Pressable key={athlete.id} onPress={() => navigate(`/(coach)/(tabs)/roster/${athlete.id}`)} style={{ opacity: selectedRosterId === athlete.id ? 0.72 : 1 }}>
              <Card>
                <Text style={{ fontSize: 16, fontWeight: "900", color: "#172033" }}>{getAthleteDisplayName(athlete)}</Text>
                <Text style={{ color: "#64748b", fontWeight: "700" }}>{athlete.email || "No email"}</Text>
              </Card>
            </Pressable>
          ))}
          {!filteredRoster.length ? <DesktopOnlyCard title="No athletes found" body="Try a different search or refresh the roster on desktop." /> : null}
        </>
      );
    }

    if (routineBrowserOpen) {
      return (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, width: "100%" }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to More"
              onPress={() => setRoutineBrowserOpen(false)}
              style={{
                minHeight: 40,
                borderWidth: 1,
                borderColor: "#dbe3ef",
                backgroundColor: "#fff",
                borderRadius: 999,
                paddingHorizontal: 12,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: "#172033", fontWeight: "900" }}>Back</Text>
            </Pressable>
            <View style={{ flex: 1, minWidth: 0 }}>
              <SectionHeader title="Drill Routines" subtitle="Browse your team's routines and drill details." />
            </View>
          </View>
          <CoachMobileRoutineBrowser
            routines={Array.from(routineById.values())}
            folders={routineFolders}
            drillById={drillById}
            loading={loadingRoutineData}
            error={routineDataError}
          />
        </>
      );
    }

    return (
      <>
        <SectionHeader title="More" subtitle="Mobile-safe links and desktop-only tools." />
        <Card>
          <Text style={{ fontSize: 15, fontWeight: "900", color: "#172033" }}>Drill Routines</Text>
          <Text style={{ color: "#64748b", fontWeight: "700", lineHeight: 19 }}>
            View warmups, drills, mobility, plyos, and strength routines.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setRoutineBrowserOpen(true)}
            style={({ pressed }) => ({
              minHeight: 44,
              borderRadius: 12,
              paddingHorizontal: 12,
              backgroundColor: pressed ? "#334155" : "#172033",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            })}
          >
            <Text style={{ color: "#fff", fontWeight: "900" }}>Open Routines</Text>
            <Ionicons name="chevron-forward" size={18} color="#fff" />
          </Pressable>
        </Card>
        <DesktopOnlyCard title="Mileage" body="The full team mileage grid is best on desktop for now." />
        <DesktopOnlyCard title="Workout Plan Builder" body="Plan Builder remains desktop-only while the mobile viewer is stabilized." />
        <DesktopOnlyCard title="Workout Catalog" body="Workout catalog management tools are available on desktop." />
        <DesktopOnlyCard title="Training Groups, Categories, Settings" body="Administrative setup remains desktop-first for this first mobile coach shell." />
        <View
          style={{
            marginTop: 8,
            borderTopWidth: 1,
            borderTopColor: "#e2e8f0",
            paddingTop: 14,
            paddingBottom: 18,
            gap: 8,
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>ACCOUNT</Text>
          {signOutError ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: "#fecaca",
                backgroundColor: "#fef2f2",
                borderRadius: 12,
                padding: 10,
              }}
            >
              <Text style={{ color: "#991b1b", fontWeight: "800", lineHeight: 18 }}>{signOutError}</Text>
            </View>
          ) : null}
          <Pressable
            onPress={() => void signOut()}
            disabled={signingOut}
            style={({ pressed }) => ({
              minHeight: 48,
              borderWidth: 1,
              borderColor: "#fecaca",
              backgroundColor: pressed ? "#fee2e2" : "#fff",
              borderRadius: 12,
              paddingHorizontal: 14,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              opacity: signingOut ? 0.65 : 1,
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
              <Ionicons name="log-out-outline" size={20} color="#b91c1c" />
              <Text style={{ color: "#b91c1c", fontSize: 15, fontWeight: "900" }}>
                {signingOut ? "Signing out..." : "Sign out"}
              </Text>
            </View>
            {signingOut ? <ActivityIndicator color="#b91c1c" /> : null}
          </Pressable>
        </View>
      </>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#f3f6fb" }}>
      <View
        style={{
          height: 58,
          borderBottomWidth: 1,
          borderBottomColor: "#dbe2ee",
          backgroundColor: "#fff",
          paddingHorizontal: 12,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: "900", color: "#1f2a44" }}>Coach Mobile</Text>
          <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "800", color: "#64748b" }}>Viewer shell</Text>
        </View>
        <AccountContextSelector compact />
      </View>

      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 12, paddingBottom: 92, gap: 12 }}>
        {renderContent()}
      </ScrollView>

      <CoachMobileWorkoutDetail
        item={selectedWorkout}
        categoriesSource={categories}
        routineById={routineById}
        drillById={drillById}
        routineDataError={routineDataError}
        onClose={() => setSelectedWorkout(null)}
      />

      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          borderTopWidth: 1,
          borderTopColor: "#dbe2ee",
          backgroundColor: "#fff",
          paddingHorizontal: 6,
          paddingTop: 6,
          paddingBottom: 8,
          flexDirection: "row",
          justifyContent: "space-around",
        }}
      >
        {MOBILE_NAV_ITEMS.map((item) => {
          const active = item.key === section;
          return (
            <Pressable key={item.key} onPress={() => navigate(item.href)} style={{ flex: 1, alignItems: "center", gap: 3, paddingVertical: 5 }}>
              <Ionicons name={item.icon} size={20} color={active ? "#172033" : "#64748b"} />
              <Text numberOfLines={1} style={{ fontSize: 10, fontWeight: "900", color: active ? "#172033" : "#64748b" }}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const quickButtonStyle = {
  flexGrow: 1,
  borderWidth: 1,
  borderColor: "#172033",
  backgroundColor: "#172033",
  borderRadius: 12,
  paddingVertical: 11,
  paddingHorizontal: 12,
  alignItems: "center" as const,
};

const quickButtonTextStyle = { color: "#fff", fontWeight: "900" as const };

const dateButtonStyle = {
  flex: 1,
  borderWidth: 1,
  borderColor: "#dbe3ef",
  backgroundColor: "#fff",
  borderRadius: 12,
  paddingVertical: 10,
  alignItems: "center" as const,
};

const dateButtonTextStyle = { color: "#172033", fontWeight: "900" as const };

const logDateNavButtonStyle = {
  height: 44,
  minWidth: 74,
  borderWidth: 1,
  borderColor: "#dbe3ef",
  backgroundColor: "#fff",
  borderRadius: 12,
  paddingHorizontal: 7,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  gap: 2,
};

const logDateNavButtonTextStyle = {
  color: "#172033",
  fontSize: 11,
  fontWeight: "900" as const,
};
