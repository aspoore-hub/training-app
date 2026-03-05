import { useEffect, useMemo, useState } from "react";
import { View, Text, FlatList, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AthleteWorkout } from "../../lib/types";
import { getCurrentTeamId, getMyClaimedAthleteProfileId } from "../../lib/team";
import { loadRosterNameMapForTeam } from "../../lib/rosterNameMap";
import { listAthleteWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";

function categoryColor(cat: string) {
  // simple palette for now
  switch (cat) {
    case "Easy":
      return "#E6F4EA";
    case "Moderate":
      return "#E8F0FE";
    case "Threshold":
      return "#FFF4E5";
    case "VO2":
      return "#FDE7E9";
    case "5K":
      return "#EDE7F6";
    case "10K":
      return "#E0F7FA";
    case "Speed Endurance":
      return "#FFF0F6";
    case "Speed Development":
      return "#F3F4F6";
    default:
      return "#F5F5F5";
  }
}

function startOfWeekISO(dateISO: string) {
  // Monday as start
  const d = new Date(dateISO + "T00:00:00");
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0 ? -6 : 1) - day; // move to Monday
  d.setDate(d.getDate() + diff);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysISO(dateISO: string, days: number) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fallbackAthleteName(athleteId: string) {
  const clean = String(athleteId ?? "").trim();
  if (!clean) return "Athlete";
  return `Athlete (${clean.slice(-6)})`;
}

function toAthleteWorkout(row: TeamWorkoutRow, nameByAthleteId: Map<string, string>): AthleteWorkout {
  const athleteId = String(row.athlete_profile_id ?? "").trim();
  const athleteName =
    String(nameByAthleteId.get(athleteId) ?? "").trim() ||
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

export default function AthleteCalendar() {
  const router = useRouter();
  const { name } = useLocalSearchParams<{ name: string }>();
  const athleteNameParam = name ?? "";
  const [athleteName, setAthleteName] = useState<string>(athleteNameParam);

  const [allWorkouts, setAllWorkouts] = useState<AthleteWorkout[]>([]);

  useEffect(() => {
    (async () => {
      const teamId = await getCurrentTeamId();
      const [claimedAthleteId, rosterMap] = await Promise.all([
        getMyClaimedAthleteProfileId(teamId),
        loadRosterNameMapForTeam(teamId),
      ]);
      const athleteId = String(claimedAthleteId ?? "").trim();
      if (!athleteId) {
        setAllWorkouts([]);
        return;
      }
      setAthleteName(String(rosterMap.get(athleteId) ?? "").trim() || athleteNameParam || fallbackAthleteName(athleteId));
      const rows = await listAthleteWorkoutsInRange(athleteId, "1900-01-01", "9999-12-31");
      setAllWorkouts(rows.map((row) => toAthleteWorkout(row, rosterMap)));
    })();
  }, [athleteNameParam]);

  const workouts = useMemo(() => {
    return [...allWorkouts].sort((a, b) => (a.dateISO < b.dateISO ? 1 : -1)); // newest first
  }, [allWorkouts]);

  const dailyMiles = useMemo(() => {
    const map: Record<string, number> = {};
    for (const w of workouts) {
      const m = w.plannedMiles ?? 0;
      map[w.dateISO] = (map[w.dateISO] ?? 0) + m;
    }
    return map;
  }, [workouts]);

  const weekSummary = useMemo(() => {
    if (workouts.length === 0) {
      return { weekStart: "", weekEnd: "", am: 0, pm: 0, total: 0 };
    }

    // use newest workout’s date as "current week"
    const currentWeekStart = startOfWeekISO(workouts[0].dateISO);
    const currentWeekEnd = addDaysISO(currentWeekStart, 6);

    let am = 0;
    let pm = 0;

    for (const w of workouts) {
      if (w.dateISO < currentWeekStart || w.dateISO > currentWeekEnd) continue;
      const miles = w.plannedMiles ?? 0;
      if (w.session === "AM") am += miles;
      else pm += miles;
    }

    return {
      weekStart: currentWeekStart,
      weekEnd: currentWeekEnd,
      am,
      pm,
      total: am + pm,
    };
  }, [workouts]);

  return (
    <View style={{ flex: 1, padding: 20 }}>
      <Text style={{ fontSize: 22, fontWeight: "600", marginBottom: 6 }}>
        {athleteName}
      </Text>
      <Text style={{ opacity: 0.7, marginBottom: 12 }}>
        Training Calendar (planned)
      </Text>

      <Pressable
        onPress={() => router.replace("/(auth)/login")}
        style={{
          marginBottom: 12,
          paddingVertical: 10,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: "#ddd",
          alignItems: "center",
          backgroundColor: "white",
        }}
      >
        <Text style={{ fontWeight: "700" }}>Back to Role Select</Text>
      </Pressable>

      {weekSummary.weekStart ? (
        <View
          style={{
            padding: 12,
            borderWidth: 1,
            borderColor: "#eee",
            borderRadius: 12,
            marginBottom: 14,
            backgroundColor: "#fafafa",
          }}
        >
          <Text style={{ fontWeight: "700" }}>
            Week: {weekSummary.weekStart} – {weekSummary.weekEnd}
          </Text>
          <Text style={{ marginTop: 6 }}>
            AM: {weekSummary.am.toFixed(1)} mi   •   PM: {weekSummary.pm.toFixed(1)} mi
          </Text>
          <Text style={{ marginTop: 4, fontWeight: "700" }}>
            Total: {weekSummary.total.toFixed(1)} mi
          </Text>
        </View>
      ) : null}

      <FlatList
        data={workouts}
        keyExtractor={(w) => w.id}
        renderItem={({ item }) => (
          <View
            style={{
              padding: 12,
              borderWidth: 1,
              borderColor: "#eee",
              borderRadius: 12,
              marginBottom: 10,
              backgroundColor: categoryColor(item.category),
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontWeight: "700" }}>
                {formatDisplayDate(item.dateISO)} • {item.session}
              </Text>
              <Text style={{ fontWeight: "700" }}>{item.category}</Text>
            </View>

            <Text style={{ marginTop: 6, fontWeight: "700" }}>{item.title}</Text>
            <Text style={{ marginTop: 6 }}>{item.details}</Text>

            <Text style={{ marginTop: 8, opacity: 0.8 }}>
              Planned miles: {item.plannedMiles ?? "—"} | Daily total:{" "}
              {dailyMiles[item.dateISO] ?? 0}
            </Text>

            <Pressable
              onPress={() =>
                router.push({
                  pathname: "/(athlete)/workout/" + item.id,
                  params: { name: athleteName },
                })
              }
              style={{
                marginTop: 10,
                paddingVertical: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: "#000",
                alignItems: "center",
                backgroundColor: "white",
              }}
            >
              <Text style={{ fontWeight: "700" }}>
                {item.feedback || item.completedMiles != null ? "View / Edit Feedback" : "Add Feedback"}
              </Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <Text style={{ marginTop: 20, opacity: 0.7 }}>
            No workouts found yet.
          </Text>
        }
      />
    </View>
  );
}
