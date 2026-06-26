import { Ionicons } from "@expo/vector-icons";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { AccountContextSelector } from "../../account/AccountContextSelector";
import { listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";
import { teamDataStore } from "../../../lib/teamDataStore";
import { parseISODate, toISODate } from "../../../lib/mileagePlan";
import { getAthleteDisplayName } from "../../../lib/athleteName";

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

function getWorkoutNotes(rows: TeamWorkoutRow[]) {
  return rows.find((row) => String(row.details ?? "").trim())?.details?.trim() || "";
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

function groupWorkouts(rows: TeamWorkoutRow[]) {
  const map = new Map<string, TeamWorkoutRow[]>();
  rows.forEach((row) => {
    const key = `${row.date_iso}|${row.session}|${row.batch_id || row.id}`;
    map.set(key, [...(map.get(key) ?? []), row]);
  });
  return Array.from(map.entries())
    .map(([key, groupedRows]) => {
      const [dateISO, session] = key.split("|");
      const athleteIds = new Set(groupedRows.map((row) => row.athlete_profile_id).filter(Boolean));
      const visibleCount = groupedRows.filter((row) => row.athlete_visible).length;
      return {
        key,
        dateISO,
        session,
        rows: groupedRows,
        title: getWorkoutTitle(groupedRows),
        notes: getWorkoutNotes(groupedRows),
        categories: getWorkoutCategories(groupedRows),
        athleteCount: athleteIds.size,
        visibleCount,
        hiddenCount: Math.max(0, groupedRows.length - visibleCount),
      };
    })
    .sort((a, b) => `${a.dateISO}-${a.session}`.localeCompare(`${b.dateISO}-${b.session}`));
}

function hasFeedback(row: TeamWorkoutRow) {
  return (
    row.completed_miles != null ||
    !!String(row.completed_time_text ?? "").trim() ||
    !!String(row.splits_or_pace ?? "").trim() ||
    !!String(row.additional_feedback ?? "").trim()
  );
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

function WorkoutCard({ item }: { item: ReturnType<typeof groupWorkouts>[number] }) {
  return (
    <Card>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>{formatDateLabel(item.dateISO)} · {item.session}</Text>
          <Text style={{ marginTop: 3, fontSize: 16, fontWeight: "900", color: "#172033" }}>{item.title}</Text>
        </View>
        <Pill tone={item.hiddenCount > 0 ? "warning" : "success"}>{item.hiddenCount > 0 ? "Mixed" : "Published"}</Pill>
      </View>
      {item.notes ? <Text numberOfLines={3} style={{ color: "#334155", fontSize: 13, lineHeight: 18 }}>{item.notes}</Text> : null}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Pill>{`${item.athleteCount} athlete${item.athleteCount === 1 ? "" : "s"}`}</Pill>
        {item.categories.slice(0, 3).map((category) => <Pill key={`${item.key}-${category}`}>{category}</Pill>)}
      </View>
    </Card>
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
  const [workouts, setWorkouts] = useState<TeamWorkoutRow[]>([]);
  const [loadingWorkouts, setLoadingWorkouts] = useState(false);
  const [workoutError, setWorkoutError] = useState<string | null>(null);
  const [rosterQuery, setRosterQuery] = useState("");

  useEffect(() => {
    void teamDataStore.actions.refreshRoster().catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const startISO = section === "logs" ? addDaysISO(todayISO(), -14) : selectedDateISO;
    const endISO = section === "home" ? addDaysISO(todayISO(), 7) : section === "logs" ? todayISO() : addDaysISO(selectedDateISO, 6);
    setLoadingWorkouts(true);
    setWorkoutError(null);
    listTeamWorkoutsInRange(startISO, endISO)
      .then((rows) => {
        if (!cancelled) setWorkouts(rows);
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
  }, [section, selectedDateISO]);

  const groupedWorkouts = useMemo(() => groupWorkouts(workouts), [workouts]);
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
  const recentLogs = useMemo(
    () =>
      workouts
        .filter(hasFeedback)
        .sort((a, b) => `${b.date_iso}-${b.session}`.localeCompare(`${a.date_iso}-${a.session}`))
        .slice(0, 20),
    [workouts]
  );

  const navigate = (href: string) => router.replace(href as any);

  const renderContent = () => {
    if (section === "home") {
      return (
        <>
          <SectionHeader title="Coach Home" subtitle="A compact mobile view for checking the day and moving around quickly." />
          {loadingWorkouts ? <ActivityIndicator /> : null}
          {workoutError ? <Text style={{ color: "#b91c1c", fontWeight: "800" }}>{workoutError}</Text> : null}
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 13, fontWeight: "900", color: "#475569" }}>Today</Text>
            {(todayWorkouts.length ? todayWorkouts : upcomingWorkouts.slice(0, 3)).map((item) => <WorkoutCard key={item.key} item={item} />)}
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
          {groupedWorkouts.map((item) => <WorkoutCard key={item.key} item={item} />)}
          {!groupedWorkouts.length && !loadingWorkouts ? (
            <DesktopOnlyCard title="No workouts in this range" body="Use desktop for full workout creation, duplication, bulk editing, and weekly copy actions." />
          ) : null}
        </>
      );
    }

    if (section === "logs") {
      return (
        <>
          <SectionHeader title="Training Logs" subtitle="Recent athlete feedback from the last 14 days." />
          {loadingWorkouts ? <ActivityIndicator /> : null}
          {workoutError ? <Text style={{ color: "#b91c1c", fontWeight: "800" }}>{workoutError}</Text> : null}
          {recentLogs.map((row) => {
            const athlete = teamStore.roster.find((item) => item.id === row.athlete_profile_id);
            return (
              <Card key={row.id}>
                <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>{formatDateLabel(row.date_iso)} · {row.session}</Text>
                <Text style={{ fontSize: 16, fontWeight: "900", color: "#172033" }}>{athlete ? getAthleteDisplayName(athlete) : "Athlete"}</Text>
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
          {!recentLogs.length && !loadingWorkouts ? <DesktopOnlyCard title="No recent feedback" body="Recent completed workout feedback will appear here." /> : null}
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

    return (
      <>
        <SectionHeader title="More" subtitle="Mobile-safe links and desktop-only tools." />
        <DesktopOnlyCard title="Mileage" body="The full team mileage grid is best on desktop for now." />
        <DesktopOnlyCard title="Workout Plan Builder" body="Plan Builder remains desktop-only while the mobile viewer is stabilized." />
        <DesktopOnlyCard title="Workout Catalog and Drill Routines" body="Library management tools are available on desktop." />
        <DesktopOnlyCard title="Training Groups, Categories, Settings" body="Administrative setup remains desktop-first for this first mobile coach shell." />
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
