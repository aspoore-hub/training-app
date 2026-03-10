import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Dimensions, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { AthleteWorkout, WeekStartDay, WorkoutCategory } from "../../../lib/types";
import { categoryColorByName } from "../../../lib/categories";
import { WEEK_START_KEY } from "../../../lib/mileagePlan";
import { loadJSON } from "../../../lib/storage";
import { listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";
import { getCategoryOptions, loadCoachSettings } from "../../../lib/settings";
import { getRosterMapById, resolveAthleteDisplayName } from "../../../lib/teamRoster";

const SCREEN_W = Dimensions.get("window").width;

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type MonthCell = {
  dateISO: string;
  dayNumber: number;
  inMonth: boolean;
};

type WeeklyGroupLine = {
  details: string;
  athleteNames: string[];
};

type WeeklyGroupSection = {
  key: string;
  label: string;
  lines: WeeklyGroupLine[];
};

type WeeklyWorkoutSection = {
  key: string;
  dateISO: string;
  title: string;
  session: string;
  time?: string;
  location?: string;
  categories: string[];
  categoryColor: string;
  athleteCount: number;
  groupCount: number;
  groups: WeeklyGroupSection[];
};

type WeeklyDaySection = {
  dateISO: string;
  weekday: string;
  fullDate: string;
  workouts: WeeklyWorkoutSection[];
};

type ParsedDisplayName = {
  full: string;
  last: string;
  first: string;
  firstInitial: string;
  secondInitial: string;
};

function escapePdfHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPdfDateShort(dateISO: string): string {
  const [y, m, d] = String(dateISO ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(dateISO ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(dateISO ?? "");
  return `${dt.getDate()}-${dt.toLocaleDateString(undefined, { month: "short" })}`;
}

function buildWeeklyHandoutHtml(args: {
  weekLabel: string;
  generatedAtLabel?: string;
  days: WeeklyDaySection[];
  categories: WorkoutCategory[];
}): string {
  const rows = (Array.isArray(args.days) ? args.days : [])
    .map((day) => {
      const workoutHtml =
        day.workouts.length === 0
          ? `<div class="off-line">Off / No team workout scheduled</div>`
          : day.workouts
              .map((workout) => {
                const time = String(workout.time ?? "").trim() || String(workout.session ?? "").trim();
                const location = String(workout.location ?? "").trim();
                const headerLine = [time, location ? `@ ${location}` : ""].filter(Boolean).join(" ");
                const title = String(workout.title ?? "").trim();
                const dotsHtml = (Array.isArray(workout.categories) ? workout.categories : [])
                  .map((cat) => {
                    const color = categoryColorByName(args.categories, cat);
                    return `<span class="workout-dot" style="background:${escapePdfHtml(color)};"></span>`;
                  })
                  .join("");
                const groups = (Array.isArray(workout.groups) ? workout.groups : [])
                  .map((group) =>
                    (Array.isArray(group.lines) ? group.lines : [])
                      .map((line) => {
                        const details = String(line.details ?? "").trim();
                        const names = (Array.isArray(line.athleteNames) ? line.athleteNames : []).join(", ");
                        const showDetails = details && details.toLowerCase() !== "no notes";
                        return `
                          ${showDetails ? `<div class="group-details">${escapePdfHtml(details)}</div>` : ""}
                          <div class="group-athletes">${escapePdfHtml(names || "Unknown athlete")}</div>
                        `;
                      })
                      .join("")
                  )
                  .join("");

                return `
                  <div class="workout-block">
                    <div class="workout-header-row">
                      <div class="workout-header">${escapePdfHtml(headerLine || "Workout")}</div>
                      ${dotsHtml ? `<div class="workout-dots">${dotsHtml}</div>` : ""}
                    </div>
                    ${title ? `<div class="workout-title">${escapePdfHtml(title)}</div>` : ""}
                    ${groups}
                  </div>
                `;
              })
              .join("");

      return `
      <div class="day-card">
        <div class="day-head">
          <div class="day-date">${escapePdfHtml(formatPdfDateShort(day.dateISO))}</div>
          <div class="day-name">${escapePdfHtml(day.weekday)}</div>
        </div>
        ${workoutHtml}
      </div>
      `;
    })
    .join("");

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Weekly Training Plan</title>
    <style>
      @page { size: Letter portrait; margin: 0.28in; }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        background: #fff;
        color: #111827;
        font-family: Arial, Helvetica, sans-serif;
      }

      .page {
        width: 100%;
      }

      .title {
        font-size: 15px;
        font-weight: 800;
        margin: 0 0 1px 0;
        line-height: 1.1;
      }

      .subtitle {
        font-size: 9px;
        font-weight: 700;
        margin: 0 0 6px 0;
        color: #374151;
        line-height: 1.1;
      }

      .days-grid {
        column-count: 2;
        column-gap: 8px;
      }

      .day-card {
        break-inside: avoid;
        page-break-inside: avoid;
        border: 1px solid #9ca3af;
        margin: 0 0 8px 0;
        padding: 4px 5px 4px 5px;
        background: #fff;
      }

      .day-head {
        display: flex;
        align-items: baseline;
        gap: 6px;
        border-bottom: 1px solid #d1d5db;
        padding-bottom: 2px;
        margin-bottom: 3px;
      }

      .day-date {
        font-size: 10px;
        font-weight: 800;
        white-space: nowrap;
        line-height: 1.1;
      }

      .day-name {
        font-size: 10px;
        font-weight: 800;
        line-height: 1.1;
      }

      .workout-block {
        break-inside: avoid;
        page-break-inside: avoid;
        margin-bottom: 4px;
      }

      .workout-block:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: 0; }

      .workout-header-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 6px;
        margin: 0 0 1px 0;
      }

      .workout-header {
        font-size: 9px;
        font-weight: 800;
        line-height: 1.15;
        margin: 0;
        flex: 1;
        min-width: 0;
      }

      .workout-dots {
        display: flex;
        align-items: center;
        gap: 3px;
        flex-shrink: 0;
        padding-top: 1px;
      }

      .workout-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        display: inline-block;
        border: 0.5px solid rgba(0,0,0,0.18);
      }

      .workout-title {
        font-size: 8.5px;
        font-weight: 500;
        line-height: 1.15;
        margin: 0 0 1px 0;
      }

      .group-details {
        font-size: 8.5px;
        line-height: 1.12;
        margin: 0;
      }

      .group-athletes {
        font-size: 7.5px;
        font-style: italic;
        color: #4b5563;
        line-height: 1.1;
        margin: 0 0 1px 0;
      }

      .off-line {
        font-size: 8.5px;
        font-style: italic;
        color: #4b5563;
        line-height: 1.15;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <h1 class="title">Weekly Training Plan</h1>
      <p class="subtitle">${escapePdfHtml(args.weekLabel)}${args.generatedAtLabel ? ` • Generated ${escapePdfHtml(args.generatedAtLabel)}` : ""}</p>
      <div class="days-grid">
        ${rows}
      </div>
    </div>
  </body>
</html>
`.trim();
}

function printHtmlInWebWindow(html: string) {
  if (Platform.OS !== "web") return false;

  const printWindow = window.open("", "_blank", "width=1200,height=900");
  if (!printWindow) {
    throw new Error("Popup blocked. Please allow popups for this site to export the PDF.");
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();

  const finalizePrint = () => {
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      setTimeout(() => {
        try {
          printWindow.close();
        } catch {}
      }, 300);
    }, 250);
  };

  if (printWindow.document.readyState === "complete") {
    finalizePrint();
  } else {
    printWindow.onload = finalizePrint;
  }

  return true;
}

function toISODate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function monthStart(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, delta: number) {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

function addDays(d: Date, delta: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + delta);
  return next;
}

function startOfWeek(d: Date, weekStartsOn: WeekStartDay) {
  const day = d.getDay();
  const offset = (day - weekStartsOn + 7) % 7;
  return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -offset);
}

function buildMonthGrid(anchor: Date, weekStartsOn: WeekStartDay): MonthCell[] {
  const first = monthStart(anchor);
  const jsDay = first.getDay();
  const startIndex = (jsDay - weekStartsOn + 7) % 7;

  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startIndex);

  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push({
      dateISO: toISODate(d),
      dayNumber: d.getDate(),
      inMonth: d.getMonth() === anchor.getMonth(),
    });
  }
  return cells;
}

function workoutCategoryNames(w: AthleteWorkout): string[] {
  const arr = Array.isArray((w as any)?.categories)
    ? (w as any).categories
    : [(w as any)?.category ?? (w as any)?.categoryName ?? "Other"];
  const cleaned = arr
    .map((x: any) => String(x ?? "").trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["Other"];
}

function getWorkoutDateISO(w: AthleteWorkout): string {
  return String((w as any)?.dateISO ?? (w as any)?.date ?? "");
}

function getWorkoutBatchKey(w: AthleteWorkout): string {
  const batchId = String((w as any)?.batchId ?? "").trim();
  if (batchId) return `batch:${batchId}`;
  return `single:${String((w as any)?.id ?? "")}`;
}

function normalizeDetailsText(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function getWorkoutLocation(w: AthleteWorkout): string {
  return String((w as any)?.location ?? "").trim();
}

function getAthleteFallbackName(w: AthleteWorkout): string {
  const candidate = String((w as any)?.athleteName ?? (w as any)?.athleteDisplayName ?? "").trim();
  return candidate || "Unknown athlete";
}

function parseDisplayName(fullName: string): ParsedDisplayName {
  const full = String(fullName ?? "").trim().replace(/\s+/g, " ");
  if (!full) {
    return { full: "Unknown athlete", last: "", first: "", firstInitial: "", secondInitial: "" };
  }
  const parts = full.split(" ").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const givenParts = parts.slice(0, -1);
  const first = givenParts[0] ?? "";
  const second = givenParts[1] ?? "";
  return {
    full,
    last,
    first,
    firstInitial: first ? first.charAt(0).toUpperCase() : "",
    secondInitial: second ? second.charAt(0).toUpperCase() : "",
  };
}

function buildCompactWeeklyAthleteLabels(records: Array<{ athleteId: string; resolvedName: string }>): Map<string, string> {
  const parsedById = new Map<string, ParsedDisplayName>();
  for (const record of records) {
    if (!record.athleteId) continue;
    if (!parsedById.has(record.athleteId)) {
      parsedById.set(record.athleteId, parseDisplayName(record.resolvedName));
    }
  }

  const byLast = new Map<string, string[]>();
  for (const [athleteId, parsed] of parsedById.entries()) {
    const lastKey = parsed.last.toLowerCase();
    const list = byLast.get(lastKey) ?? [];
    list.push(athleteId);
    byLast.set(lastKey, list);
  }

  const out = new Map<string, string>();
  for (const athleteIds of byLast.values()) {
    if (athleteIds.length === 1) {
      const athleteId = athleteIds[0];
      const parsed = parsedById.get(athleteId);
      if (!parsed) continue;
      out.set(athleteId, parsed.last || parsed.full || "Unknown athlete");
      continue;
    }

    const labelWithFirstInitial = new Map<string, string>();
    athleteIds.forEach((athleteId) => {
      const parsed = parsedById.get(athleteId);
      if (!parsed) return;
      const label = parsed.last
        ? `${parsed.last}, ${parsed.firstInitial || "?"}.`
        : parsed.full;
      labelWithFirstInitial.set(athleteId, label);
    });

    const initialCounts = new Map<string, number>();
    for (const label of labelWithFirstInitial.values()) {
      initialCounts.set(label, (initialCounts.get(label) ?? 0) + 1);
    }

    const labelWithSecondInitial = new Map<string, string>();
    athleteIds.forEach((athleteId) => {
      const parsed = parsedById.get(athleteId);
      const base = labelWithFirstInitial.get(athleteId) ?? "Unknown athlete";
      if (!parsed) {
        labelWithSecondInitial.set(athleteId, base);
        return;
      }
      if ((initialCounts.get(base) ?? 0) <= 1) {
        labelWithSecondInitial.set(athleteId, base);
        return;
      }
      if (parsed.secondInitial) {
        labelWithSecondInitial.set(athleteId, `${parsed.last}, ${parsed.firstInitial}.${parsed.secondInitial}.`);
        return;
      }
      labelWithSecondInitial.set(athleteId, parsed.last ? `${parsed.last}, ${parsed.first}` : parsed.full);
    });

    const secondCounts = new Map<string, number>();
    for (const label of labelWithSecondInitial.values()) {
      secondCounts.set(label, (secondCounts.get(label) ?? 0) + 1);
    }

    athleteIds.forEach((athleteId) => {
      const parsed = parsedById.get(athleteId);
      const candidate = labelWithSecondInitial.get(athleteId) ?? "Unknown athlete";
      if ((secondCounts.get(candidate) ?? 0) > 1) {
        out.set(athleteId, parsed?.full || candidate || "Unknown athlete");
      } else {
        out.set(athleteId, candidate);
      }
    });
  }

  return out;
}

function toLegacyWorkout(row: TeamWorkoutRow): AthleteWorkout {
  return {
    id: row.id,
    athleteId: row.athlete_profile_id,
    athleteName:
      String(
        (row as any).athlete_display_name ??
          (row as any).display_name ??
          (row as any).athlete_name ??
          ""
      ).trim() || "Athlete",
    dateISO: row.date_iso,
    session: row.session,
    time: row.time_text ?? undefined,
    title: row.title ?? "Workout",
    details: row.details ?? undefined,
    location: (row as any).location ?? undefined,
    athleteDisplayName:
      (row as any).athlete_display_name ??
      (row as any).display_name ??
      (row as any).athlete_name ??
      undefined,
    category: row.primary_category ?? undefined,
    categories: row.categories ?? undefined,
    batchId: row.batch_id ?? undefined,
    groupId: row.group_id ?? undefined,
    preRoutineIds: row.pre_routine_ids ?? undefined,
    postRoutineIds: row.post_routine_ids ?? undefined,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined,
  } as AthleteWorkout;
}

export default function CoachCalendarMonth() {
  const router = useRouter();
  const { saved, date, batch } = useLocalSearchParams<{ saved?: string | string[]; date?: string | string[]; batch?: string | string[] }>();
  const launchHandledRef = useRef("");

  const [calendarMode, setCalendarMode] = useState<"month" | "week">("month");
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [allWorkouts, setAllWorkouts] = useState<AthleteWorkout[]>([]);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [rosterNameById, setRosterNameById] = useState<Map<string, string>>(new Map());
  const [anchorMonth, setAnchorMonth] = useState(() => monthStart(new Date()));
  const [anchorWeekStart, setAnchorWeekStart] = useState(() => startOfWeek(new Date(), 1));
  const [showSavedBanner, setShowSavedBanner] = useState(false);
  const [expandedWeeklyWorkouts, setExpandedWeeklyWorkouts] = useState<Record<string, boolean>>({});
  const [exportingPdf, setExportingPdf] = useState(false);

  const isWebDesktop = Platform.OS === "web" && SCREEN_W >= 960;
  const todayISO = useMemo(() => toISODate(new Date()), []);

  const loadCalendarData = useCallback(async () => {
    const [ws, workoutRows, savedSettings, rosterMap] = await Promise.all([
      loadJSON<WeekStartDay>(WEEK_START_KEY, 1),
      listTeamWorkoutsInRange("1970-01-01", "2100-12-31"),
      loadCoachSettings(),
      getRosterMapById().catch(() => new Map<string, string>()),
    ]);
    setWeekStartsOn((ws ?? 1) as WeekStartDay);
    setAllWorkouts((workoutRows ?? []).map(toLegacyWorkout));
    setCategories(getCategoryOptions(savedSettings));
    setRosterNameById(rosterMap);
  }, []);

  useEffect(() => {
    loadCalendarData();
  }, [loadCalendarData]);

  useFocusEffect(
    useCallback(() => {
      loadCalendarData();
    }, [loadCalendarData])
  );

  useEffect(() => {
    const raw = Array.isArray(saved) ? saved[0] : saved;
    if (String(raw ?? "") !== "1") return;
    setShowSavedBanner(true);
    const timer = setTimeout(() => setShowSavedBanner(false), 2200);
    return () => clearTimeout(timer);
  }, [saved]);

  useEffect(() => {
    const dateRaw = Array.isArray(date) ? date[0] : date;
    const batchRaw = Array.isArray(batch) ? batch[0] : batch;
    const dateISO = String(dateRaw ?? "").trim();
    const batchId = String(batchRaw ?? "").trim();
    if (!dateISO || !batchId) return;
    const token = `${dateISO}::${batchId}`;
    if (launchHandledRef.current === token) return;
    launchHandledRef.current = token;
    router.push({
      pathname: "/(coach)/workouts",
      params: { date: dateISO, batch: batchId },
    });
  }, [batch, date, router]);

  const monthCells = useMemo(() => buildMonthGrid(anchorMonth, weekStartsOn), [anchorMonth, weekStartsOn]);
  const monthRows = useMemo(() => {
    const rows: MonthCell[][] = [];
    for (let i = 0; i < monthCells.length; i += 7) rows.push(monthCells.slice(i, i + 7));
    return rows;
  }, [monthCells]);

  const weekDates = useMemo(() => {
    return Array.from({ length: 7 }, (_, idx) => addDays(anchorWeekStart, idx));
  }, [anchorWeekStart]);
  const weekDateISOs = useMemo(() => weekDates.map((d) => toISODate(d)), [weekDates]);

  const monthLabel = useMemo(
    () =>
      anchorMonth.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      }),
    [anchorMonth]
  );

  const weekLabel = useMemo(() => {
    const start = weekDates[0];
    const end = weekDates[6];
    if (!start || !end) return "";
    const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `${startLabel} - ${endLabel}`;
  }, [weekDates]);

  const weekdayLabels = useMemo(() => {
    const arr: string[] = [];
    for (let i = 0; i < 7; i++) arr.push(WEEKDAY_LABELS[(weekStartsOn + i) % 7]);
    return arr;
  }, [weekStartsOn]);

  const workoutDotColorsByDate = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const w of allWorkouts) {
      const dateISO = String((w as any)?.dateISO ?? (w as any)?.date ?? "");
      if (!dateISO) continue;
      const existing = map.get(dateISO) ?? [];
      for (const categoryName of workoutCategoryNames(w)) {
        const color = categoryColorByName(categories, categoryName);
        if (!existing.includes(color)) existing.push(color);
      }
      map.set(dateISO, existing);
    }
    return map;
  }, [allWorkouts, categories]);

  const workoutCountByDate = useMemo(() => {
    const grouped = new Map<string, Set<string>>();

    for (const w of allWorkouts) {
      const dateISO = String((w as any)?.dateISO ?? (w as any)?.date ?? "");
      if (!dateISO) continue;

      const batchId = String((w as any)?.batchId ?? "").trim();
      const groupId = String((w as any)?.groupId ?? "1").trim() || "1";
      const fallbackId = String((w as any)?.id ?? "");
      const workoutKey = batchId ? `${batchId}::${groupId}` : `single::${fallbackId}`;

      const set = grouped.get(dateISO) ?? new Set<string>();
      set.add(workoutKey);
      grouped.set(dateISO, set);
    }

    const counts = new Map<string, number>();
    for (const [dateISO, set] of grouped.entries()) counts.set(dateISO, set.size);
    return counts;
  }, [allWorkouts]);

  const weeklyTitleRowsByDate = useMemo(() => {
    const map = new Map<string, { title: string; color: string; count: number }[]>();
    const grouped = new Map<string, Map<string, { title: string; color: string; count: number }>>();

    for (const w of allWorkouts) {
      const dateISO = String((w as any)?.dateISO ?? (w as any)?.date ?? "");
      if (!dateISO) continue;

      const title = String((w as any)?.title ?? "").trim() || "Workout";
      const category = String((w as any)?.category ?? "Other");
      const color = categoryColorByName(categories, category);
      const batchId = String((w as any)?.batchId ?? "").trim();
      const uniqueKey = batchId ? `batch:${batchId}` : `single:${String((w as any)?.id ?? "")}`;

      const byDate = grouped.get(dateISO) ?? new Map<string, { title: string; color: string; count: number }>();
      const existing = byDate.get(uniqueKey);
      if (existing) {
        existing.count += 1;
      } else {
        byDate.set(uniqueKey, { title, color, count: 1 });
      }
      grouped.set(dateISO, byDate);
    }

    for (const [dateISO, rows] of grouped.entries()) {
      map.set(
        dateISO,
        Array.from(rows.values()).sort((a, b) => a.title.localeCompare(b.title))
      );
    }

    return map;
  }, [allWorkouts, categories]);

  const weeklyDaySections = useMemo<WeeklyDaySection[]>(() => {
    const weeklyAthleteLabelById = buildCompactWeeklyAthleteLabels(
      allWorkouts
        .filter((w) => weekDateISOs.includes(getWorkoutDateISO(w)))
        .map((w) => {
          const athleteId = String((w as any)?.athleteId ?? "").trim();
          const resolvedName = resolveAthleteDisplayName(
            athleteId,
            rosterNameById,
            getAthleteFallbackName(w)
          );
          return { athleteId, resolvedName: resolvedName || "Unknown athlete" };
        })
    );

    const dateSet = new Set(weekDateISOs);
    const workoutsByDate = new Map<
      string,
      Map<
        string,
        {
          key: string;
          rows: AthleteWorkout[];
        }
      >
    >();

    for (const workout of allWorkouts) {
      const dateISO = getWorkoutDateISO(workout);
      if (!dateSet.has(dateISO)) continue;
      const workoutKey = getWorkoutBatchKey(workout);
      const byDate = workoutsByDate.get(dateISO) ?? new Map();
      const existing = byDate.get(workoutKey) ?? { key: `${dateISO}::${workoutKey}`, rows: [] as AthleteWorkout[] };
      existing.rows.push(workout);
      byDate.set(workoutKey, existing);
      workoutsByDate.set(dateISO, byDate);
    }

    return weekDates.map((dateObj, idx) => {
      const dateISO = weekDateISOs[idx];
      const entries = Array.from(
        (workoutsByDate.get(dateISO) ?? new Map<string, { key: string; rows: AthleteWorkout[] }>()).values()
      );

      const workouts = entries
        .map((entry): WeeklyWorkoutSection => {
          const rows = entry.rows;
          const first = rows[0];
          const categoriesForWorkout: string[] = Array.from(
            new Set(rows.flatMap((r) => workoutCategoryNames(r).map((c) => String(c).trim()).filter(Boolean)))
          );
          const categoryColor = categoryColorByName(categories, categoriesForWorkout[0] ?? "Other");
          const athleteIds = new Set(rows.map((r) => String((r as any)?.athleteId ?? "").trim()).filter(Boolean));
          const groupIds = new Set(rows.map((r) => String((r as any)?.groupId ?? "").trim() || "Ungrouped"));

          const groupsMap = new Map<string, AthleteWorkout[]>();
          rows.forEach((r) => {
            const groupId = String((r as any)?.groupId ?? "").trim() || "Ungrouped";
            const groupRows = groupsMap.get(groupId) ?? [];
            groupRows.push(r);
            groupsMap.set(groupId, groupRows);
          });

          const groups = Array.from(groupsMap.entries())
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([groupId, groupRows], groupIndex) => {
              const detailsBuckets = new Map<string, { details: string; names: Set<string> }>();
              groupRows.forEach((r) => {
                const details = normalizeDetailsText((r as any)?.details);
                const key = details || "__no_notes__";
                const bucket = detailsBuckets.get(key) ?? { details: details || "No notes", names: new Set<string>() };
                const athleteId = String((r as any)?.athleteId ?? "").trim();
                const resolvedName = resolveAthleteDisplayName(
                  athleteId,
                  rosterNameById,
                  getAthleteFallbackName(r)
                );
                const compactName =
                  (athleteId ? weeklyAthleteLabelById.get(athleteId) : null) ??
                  resolvedName ??
                  "Unknown athlete";
                bucket.names.add(compactName);
                detailsBuckets.set(key, bucket);
              });

              const lines: WeeklyGroupLine[] = Array.from(detailsBuckets.values()).map((bucket) => ({
                details: bucket.details,
                athleteNames: Array.from(bucket.names).sort((a, b) => a.localeCompare(b)),
              }));

              return {
                key: `${entry.key}::group:${groupId}`,
                label: `Group ${groupIndex + 1}`,
                lines,
              };
            });

          return {
            key: entry.key,
            dateISO,
            title: String((first as any)?.title ?? "").trim() || "Workout",
            session: String((first as any)?.session ?? ""),
            time: String((first as any)?.time ?? "").trim() || undefined,
            location: getWorkoutLocation(first) || undefined,
            categories: categoriesForWorkout,
            categoryColor,
            athleteCount: athleteIds.size || (rows.length > 0 ? 1 : 0),
            groupCount: groupIds.size || 1,
            groups,
          };
        })
        .sort((a, b) => {
          const sessionOrder = a.session.localeCompare(b.session);
          if (sessionOrder !== 0) return sessionOrder;
          const timeOrder = String(a.time ?? "").localeCompare(String(b.time ?? ""));
          if (timeOrder !== 0) return timeOrder;
          return a.title.localeCompare(b.title);
        });

      return {
        dateISO,
        weekday: dateObj.toLocaleDateString(undefined, { weekday: "long" }),
        fullDate: dateObj.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }),
        workouts,
      };
    });
  }, [allWorkouts, categories, rosterNameById, weekDateISOs, weekDates]);

  const shiftMonth = useCallback((delta: number) => {
    setAnchorMonth((prev) => addMonths(prev, delta));
  }, []);

  const shiftWeek = useCallback((delta: number) => {
    setAnchorWeekStart((prev) => addDays(prev, delta * 7));
  }, []);

  const translateX = useSharedValue(0);

  const goToToday = useCallback(() => {
    const now = new Date();
    setAnchorMonth(monthStart(now));
    setAnchorWeekStart(startOfWeek(now, weekStartsOn));
    translateX.value = 0;
  }, [translateX, weekStartsOn]);

  const commitSwipe = useCallback(
    (dir: "prev" | "next") => {
      const delta = dir === "prev" ? -1 : 1;
      translateX.value = withTiming(dir === "prev" ? SCREEN_W : -SCREEN_W, { duration: 140 }, (finished) => {
        if (finished) {
          if (calendarMode === "month") {
            runOnJS(shiftMonth)(delta);
          } else {
            runOnJS(shiftWeek)(delta);
          }
          translateX.value = 0;
        }
      });
    },
    [calendarMode, shiftMonth, shiftWeek, translateX]
  );

  const pan = Gesture.Pan()
    .onChange((e) => {
      translateX.value = e.translationX;
    })
    .onEnd((e) => {
      const threshold = SCREEN_W * 0.22;
      if (e.translationX > threshold) {
        runOnJS(commitSwipe)("prev");
        return;
      }
      if (e.translationX < -threshold) {
        runOnJS(commitSwipe)("next");
        return;
      }
      translateX.value = withSpring(0);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const quickNewSessionDateISO = useMemo(() => {
    if (calendarMode === "month") {
      const today = new Date();
      if (
        today.getFullYear() === anchorMonth.getFullYear() &&
        today.getMonth() === anchorMonth.getMonth()
      ) {
        return todayISO;
      }
      return toISODate(monthStart(anchorMonth));
    }

    const startISO = toISODate(weekDates[0]);
    const endISO = toISODate(weekDates[6]);
    if (todayISO >= startISO && todayISO <= endISO) return todayISO;
    return startISO;
  }, [anchorMonth, calendarMode, todayISO, weekDates]);

  const handleExportWeekPdf = useCallback(async () => {
    if (calendarMode !== "week" || exportingPdf) return;
    console.log("[weekly-pdf] export start", {
      weekLabel,
      dayCount: weeklyDaySections.length,
    });
    console.log("[weekly-pdf] Print module keys", Object.keys(Print || {}));
    setExportingPdf(true);
    try {
      const generatedAtLabel = new Date().toLocaleString();
      const html = buildWeeklyHandoutHtml({
        weekLabel,
        generatedAtLabel,
        days: weeklyDaySections,
        categories,
      });
      console.log("[weekly-pdf] using handout html builder");
      console.log("[weekly-pdf] html preview", html.slice(0, 400));
      console.log("[weekly-pdf] html built", { length: html.length });

      if (Platform.OS === "web") {
        printHtmlInWebWindow(html);
        console.log("[weekly-pdf] web print window opened");
        Alert.alert("Export PDF", "Print dialog opened.");
      } else {
        const result = await Print.printToFileAsync({ html });
        console.log("[weekly-pdf] print result", result);
        const canShare = await Sharing.isAvailableAsync();
        console.log("[weekly-pdf] sharing available", canShare);

        if (canShare) {
          await Sharing.shareAsync(result.uri);
        } else {
          Alert.alert("PDF created", result.uri);
        }
      }
    } catch (e: any) {
      console.log("[weekly-pdf] export error", e);
      Alert.alert("Export failed", String(e?.message ?? "Could not export weekly PDF."));
    } finally {
      setExportingPdf(false);
    }
  }, [calendarMode, categories, exportingPdf, weekLabel, weeklyDaySections]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => commitSwipe("prev")} style={styles.navBtn}>
          <Text style={styles.navBtnText}>◀</Text>
        </Pressable>

        <View style={{ alignItems: "center" }}>
          <Text style={styles.monthLabel}>{calendarMode === "month" ? monthLabel : weekLabel}</Text>
          <Text style={styles.subLabel}>Tap a day to view all workouts</Text>
        </View>

        <View style={styles.headerRight}>
          {calendarMode === "week" ? (
            <Pressable onPress={() => void handleExportWeekPdf()} style={styles.todayBtn} disabled={exportingPdf}>
              <Text style={styles.todayBtnText}>{exportingPdf ? "Exporting..." : "Export PDF"}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={goToToday} style={styles.todayBtn}>
            <Text style={styles.todayBtnText}>Today</Text>
          </Pressable>
          <Pressable onPress={() => commitSwipe("next")} style={styles.navBtn}>
            <Text style={styles.navBtnText}>▶</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.modeRow}>
        <Pressable
          onPress={() => setCalendarMode("month")}
          style={[styles.modePill, calendarMode === "month" && styles.modePillActive]}
        >
          <Text style={[styles.modePillText, calendarMode === "month" && styles.modePillTextActive]}>Monthly</Text>
        </Pressable>
        <Pressable
          onPress={() => setCalendarMode("week")}
          style={[styles.modePill, calendarMode === "week" && styles.modePillActive]}
        >
          <Text style={[styles.modePillText, calendarMode === "week" && styles.modePillTextActive]}>Weekly</Text>
        </Pressable>
      </View>

      {calendarMode === "month" ? (
        isWebDesktop ? (
          <>
            <View style={[styles.weekdayRow, styles.monthWeekdayRowDense]}>
              {weekdayLabels.map((d) => (
                <Text key={d} style={[styles.weekdayText, styles.monthWeekdayTextDense]}>
                  {d}
                </Text>
              ))}
            </View>

            <View style={styles.monthSheet}>
              {monthRows.map((row, rowIndex) => (
                <View key={`row-${rowIndex}`} style={[styles.monthSheetRow, rowIndex === 5 && styles.monthSheetRowLast]}>
                  {row.map((cell, cellIndex) => {
                    const iso = cell.dateISO;
                    const workoutCount = workoutCountByDate.get(iso) ?? 0;
                    const summaries = (weeklyTitleRowsByDate.get(iso) ?? []).slice(0, 2);
                    const dayColors = workoutDotColorsByDate.get(iso) ?? [];
                    return (
                      <Pressable
                        key={iso}
                        onPress={() =>
                          router.push({
                            pathname: "/(coach)/workouts",
                            params: { date: iso },
                          })
                        }
                        style={({ pressed }) => [
                          styles.monthSheetCell,
                          cellIndex === 6 && styles.monthSheetCellLast,
                          !cell.inMonth && styles.outsideMonth,
                          iso === todayISO && styles.todayCell,
                          pressed && styles.pressed,
                        ]}
                      >
                        <View style={styles.monthDayTopRow}>
                          <Text style={[styles.dayNum, !cell.inMonth && styles.dayNumMuted]}>{cell.dayNumber}</Text>
                          <Text style={styles.monthDayCount}>{workoutCount > 0 ? `${workoutCount}` : ""}</Text>
                        </View>
                        {dayColors.length > 0 ? (
                          <View style={styles.dotRow}>
                            {dayColors.slice(0, 3).map((color, i) => (
                              <View key={`${iso}-dot-${i}-${color}`} style={[styles.workoutDot, { backgroundColor: color }]} />
                            ))}
                          </View>
                        ) : null}
                        {summaries.map((rowItem, idx) => (
                          <View key={`${iso}-summary-${idx}`} style={styles.monthSummaryRow}>
                            <View style={[styles.workoutDot, { backgroundColor: rowItem.color, marginRight: 6 }]} />
                            <Text numberOfLines={1} style={styles.monthSummaryText}>
                              {rowItem.title}
                              {rowItem.count > 1 ? ` (${rowItem.count})` : ""}
                            </Text>
                          </View>
                        ))}
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
          </>
        ) : (
          <>
            <View style={styles.weekdayRow}>
              {weekdayLabels.map((d) => (
                <Text key={d} style={styles.weekdayText}>
                  {d}
                </Text>
              ))}
            </View>

            <GestureDetector gesture={pan}>
              <Animated.View style={[styles.gridWrap, animatedStyle]}>
                <View style={styles.grid}>
                  {monthRows.map((row, rowIndex) => (
                    <View key={`row-${rowIndex}`} style={styles.weekRow}>
                      {row.map((cell, cellIndex) => {
                        const iso = cell.dateISO;
                        const workoutCount = workoutCountByDate.get(iso) ?? 0;

                        return (
                          <Pressable
                            key={iso}
                            onPress={() =>
                              router.push({
                                pathname: "/(coach)/workouts",
                                params: { date: iso },
                              })
                            }
                            style={({ pressed }) => [
                              styles.cell,
                              cellIndex < 6 && styles.cellGapRight,
                              !cell.inMonth && styles.outsideMonth,
                              iso === todayISO && styles.todayCell,
                              pressed && styles.pressed,
                              styles.emptyCell,
                            ]}
                          >
                            <Text style={[styles.dayNum, !cell.inMonth && styles.dayNumMuted]}>{cell.dayNumber}</Text>
                            {(workoutDotColorsByDate.get(iso) ?? []).length > 0 ? (
                              <View style={styles.dotRow}>
                                {(workoutDotColorsByDate.get(iso) ?? []).slice(0, 4).map((color, i) => (
                                  <View key={`${iso}-dot-${i}-${color}`} style={[styles.workoutDot, { backgroundColor: color }]} />
                                ))}
                                {(workoutDotColorsByDate.get(iso) ?? []).length > 4 ? (
                                  <Text style={styles.moreDotsText}>+{(workoutDotColorsByDate.get(iso) ?? []).length - 4}</Text>
                                ) : null}
                              </View>
                            ) : null}
                            {workoutCount > 0 ? <Text style={styles.workoutCountText}>{workoutCount}</Text> : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  ))}
                </View>
              </Animated.View>
            </GestureDetector>
          </>
        )
      ) : isWebDesktop ? (
        <ScrollView style={styles.weekScroll} contentContainerStyle={[styles.weekScrollContent, styles.weekScrollContentDesktop]}>
          {weeklyDaySections.map((day) => {
            const isToday = day.dateISO === todayISO;
            return (
              <View key={day.dateISO} style={[styles.weekDaySection, isToday && styles.todayCell]}>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/(coach)/workouts",
                      params: { date: day.dateISO },
                    })
                  }
                  style={styles.weekDaySectionHeader}
                >
                  <View>
                    <Text style={styles.weekSectionWeekday}>{day.weekday}</Text>
                    <Text style={styles.weekSectionDate}>{day.fullDate}</Text>
                  </View>
                  <Text style={styles.weekSectionOpenDay}>Open Day</Text>
                </Pressable>

                {day.workouts.length === 0 ? (
                  <Text style={styles.weekNoWorkouts}>No workouts</Text>
                ) : (
                  day.workouts.map((workout) => {
                    const expanded = !!expandedWeeklyWorkouts[workout.key];
                    return (
                      <View key={workout.key} style={styles.weekWorkoutBox}>
                        <Pressable
                          onPress={() =>
                            setExpandedWeeklyWorkouts((prev) => ({
                              ...prev,
                              [workout.key]: !prev[workout.key],
                            }))
                          }
                          style={styles.weekWorkoutHeader}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.weekWorkoutTitle}>{workout.title}</Text>
                            <Text style={styles.weekWorkoutMeta}>
                              {workout.session}
                              {workout.time ? ` • ${workout.time}` : ""}
                              {workout.location ? ` • ${workout.location}` : ""}
                              {` • ${workout.athleteCount} athletes • ${workout.groupCount} groups`}
                            </Text>
                            <View style={styles.weekCategoriesRow}>
                              {workout.categories.map((cat) => (
                                <View key={`${workout.key}-${cat}`} style={styles.weekCategoryChip}>
                                  <View style={[styles.workoutDot, { backgroundColor: categoryColorByName(categories, cat), marginRight: 6 }]} />
                                  <Text style={styles.weekCategoryChipText}>{cat}</Text>
                                </View>
                              ))}
                            </View>
                          </View>
                          <Text style={styles.weekExpandChevron}>{expanded ? "▾" : "▸"}</Text>
                        </Pressable>

                        {expanded ? (
                          <View style={styles.weekExpandedBody}>
                            {workout.groups.map((group) => (
                              <View key={group.key} style={styles.weekGroupBlock}>
                                <Text style={styles.weekGroupLabel}>{group.label}</Text>
                                {group.lines.map((line, idx) => (
                                  <Text key={`${group.key}-${idx}`} style={styles.weekGroupLineText}>
                                    {line.athleteNames.join(", ")} — {line.details || "No notes"}
                                  </Text>
                                ))}
                              </View>
                            ))}
                          </View>
                        ) : null}
                      </View>
                    );
                  })
                )}
              </View>
            );
          })}
        </ScrollView>
      ) : (
        <GestureDetector gesture={pan}>
          <Animated.View style={animatedStyle}>
            <ScrollView style={styles.weekScroll} contentContainerStyle={styles.weekScrollContent}>
              {weeklyDaySections.map((day) => {
                const isToday = day.dateISO === todayISO;
                return (
                  <View key={day.dateISO} style={[styles.weekDaySection, isToday && styles.todayCell]}>
                    <Pressable
                      onPress={() =>
                        router.push({
                          pathname: "/(coach)/workouts",
                          params: { date: day.dateISO },
                        })
                      }
                      style={styles.weekDaySectionHeader}
                    >
                      <View>
                        <Text style={styles.weekSectionWeekday}>{day.weekday}</Text>
                        <Text style={styles.weekSectionDate}>{day.fullDate}</Text>
                      </View>
                      <Text style={styles.weekSectionOpenDay}>Open Day</Text>
                    </Pressable>

                    {day.workouts.length === 0 ? (
                      <Text style={styles.weekNoWorkouts}>No workouts</Text>
                    ) : (
                      day.workouts.map((workout) => {
                        const expanded = !!expandedWeeklyWorkouts[workout.key];
                        return (
                          <View key={workout.key} style={styles.weekWorkoutBox}>
                            <Pressable
                              onPress={() =>
                                setExpandedWeeklyWorkouts((prev) => ({
                                  ...prev,
                                  [workout.key]: !prev[workout.key],
                                }))
                              }
                              style={styles.weekWorkoutHeader}
                            >
                              <View style={{ flex: 1 }}>
                                <Text style={styles.weekWorkoutTitle}>{workout.title}</Text>
                                <Text style={styles.weekWorkoutMeta}>
                                  {workout.session}
                                  {workout.time ? ` • ${workout.time}` : ""}
                                  {workout.location ? ` • ${workout.location}` : ""}
                                  {` • ${workout.athleteCount} athletes • ${workout.groupCount} groups`}
                                </Text>
                              </View>
                              <Text style={styles.weekExpandChevron}>{expanded ? "▾" : "▸"}</Text>
                            </Pressable>

                            {expanded ? (
                              <View style={styles.weekExpandedBody}>
                                {workout.groups.map((group) => (
                                  <View key={group.key} style={styles.weekGroupBlock}>
                                    <Text style={styles.weekGroupLabel}>{group.label}</Text>
                                    {group.lines.map((line, idx) => (
                                      <Text key={`${group.key}-${idx}`} style={styles.weekGroupLineText}>
                                        {line.athleteNames.join(", ")} — {line.details || "No notes"}
                                      </Text>
                                    ))}
                                  </View>
                                ))}
                              </View>
                            ) : null}
                          </View>
                        );
                      })
                    )}
                  </View>
                );
              })}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      )}

      <Pressable
        onPress={() =>
          router.push({
            pathname: "/(coach)/(tabs)/planner",
            params: { date: quickNewSessionDateISO, returnTo: "calendar" },
          })
        }
        style={styles.fabNewSession}
      >
        <Ionicons name="create-outline" size={24} color="#fff" />
      </Pressable>

      {showSavedBanner ? (
        <View style={styles.savedBanner}>
          <Text style={styles.savedBannerText}>Training session saved</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 92, backgroundColor: "#fff" },

  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  navBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#e2e2e2",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fafafa",
  },
  navBtnText: { fontSize: 16, fontWeight: "800", color: "#222" },
  todayBtn: {
    height: 36,
    paddingHorizontal: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#d7d7d7",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  todayBtnText: { fontSize: 12, fontWeight: "800", color: "#222" },
  monthLabel: { fontSize: 20, fontWeight: "800", color: "#111" },
  subLabel: { marginTop: 4, fontSize: 12, fontWeight: "600", color: "#6b6b6b" },

  modeRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  modePill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#fff",
  },
  modePillActive: { borderColor: "#111", backgroundColor: "#111" },
  modePillText: { fontWeight: "800", color: "#555" },
  modePillTextActive: { color: "#fff" },

  weekdayRow: { flexDirection: "row", marginBottom: 8 },
  weekdayText: {
    width: (SCREEN_W - 32) / 7,
    textAlign: "center",
    fontSize: 12,
    fontWeight: "800",
    color: "#6b6b6b",
  },

  gridWrap: { borderWidth: 1, borderColor: "#ececec", borderRadius: 14, padding: 8, backgroundColor: "#fafafa" },
  grid: {},
  weekRow: { flexDirection: "row", marginBottom: 6 },

  cell: {
    flex: 1,
    minHeight: 76,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#efefef",
    backgroundColor: "#fff",
  },
  cellGapRight: { marginRight: 6 },
  emptyCell: { backgroundColor: "#fff" },

  outsideMonth: { opacity: 0.45 },
  todayCell: { borderColor: "#0a84ff", borderWidth: 2 },
  pressed: { opacity: 0.75 },

  dayNum: { fontSize: 13, fontWeight: "800", color: "#1e1e1e" },
  dayNumMuted: { color: "#7a7a7a" },
  dotRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    gap: 4,
  },
  workoutDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 0.5,
    borderColor: "rgba(0,0,0,0.2)",
  },
  moreDotsText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#666",
    marginLeft: 2,
  },
  workoutCountText: {
    marginTop: 6,
    fontSize: 10,
    fontWeight: "800",
    color: "#666",
  },
  monthWeekdayRowDense: {
    marginBottom: 4,
    borderWidth: 1,
    borderColor: "#dbe4f0",
    borderBottomWidth: 0,
    borderRadius: 6,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    overflow: "hidden",
  },
  monthWeekdayTextDense: {
    flex: 1,
    width: undefined as any,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderRightColor: "#e3eaf4",
    backgroundColor: "#f3f7fc",
    color: "#42526a",
  },
  monthSheet: {
    borderWidth: 1,
    borderColor: "#dbe4f0",
    borderTopWidth: 0,
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
    overflow: "hidden",
  },
  monthSheetRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e6edf6" },
  monthSheetRowLast: { borderBottomWidth: 0 },
  monthSheetCell: {
    flex: 1,
    minHeight: 88,
    paddingHorizontal: 6,
    paddingVertical: 5,
    borderRightWidth: 1,
    borderRightColor: "#e6edf6",
    backgroundColor: "#fff",
  },
  monthSheetCellLast: { borderRightWidth: 0 },
  monthDayTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 3 },
  monthDayCount: { fontSize: 11, fontWeight: "800", color: "#5a6a83" },
  monthSummaryRow: { flexDirection: "row", alignItems: "center", marginTop: 3 },
  monthSummaryText: { flex: 1, fontSize: 11, fontWeight: "700", color: "#1d2a3f" },

  weekSheetScrollX: {
    borderWidth: 1,
    borderColor: "#d7e0ec",
    borderRadius: 6,
    backgroundColor: "#f8fbff",
  },
  weekSheetScrollXContent: { paddingBottom: 104 },
  weekSheet: { minWidth: 210 + 7 * 170, backgroundColor: "#fff" },
  weekSheetHeaderRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#d7e0ec", backgroundColor: "#eef4fb" },
  weekSheetRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e6edf6" },
  weekSheetLabelCell: {
    width: 210,
    minWidth: 210,
    maxWidth: 210,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderRightColor: "#dfe7f2",
  },
  weekSheetDayCell: {
    width: 170,
    minWidth: 170,
    maxWidth: 170,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderRightColor: "#e6edf6",
  },
  weekSheetHeaderCell: { backgroundColor: "#eef4fb" },
  weekSheetDataCell: { minHeight: 56, backgroundColor: "#fff", justifyContent: "center" },
  weekSheetHeaderText: { fontSize: 12, fontWeight: "900", color: "#24334a" },
  weekSheetHeaderSubText: { marginTop: 2, fontSize: 10, fontWeight: "700", color: "#5e718c" },
  weekSheetLabelText: { fontSize: 12, fontWeight: "800", color: "#18263a" },
  weekSheetCellTitle: { fontSize: 12, fontWeight: "900", color: "#0f1b2d" },
  weekSheetCellMeta: { marginTop: 2, fontSize: 10, fontWeight: "700", color: "#5d6e86" },

  weekScroll: {
    borderWidth: 1,
    borderColor: "#ececec",
    borderRadius: 14,
    backgroundColor: "#fafafa",
  },
  weekScrollContent: {
    padding: 10,
    paddingBottom: 104,
  },
  weekScrollContentDesktop: {
    paddingHorizontal: 6,
    paddingTop: 6,
  },
  weekDaySection: {
    borderWidth: 1,
    borderColor: "#dfe6f1",
    borderRadius: 8,
    backgroundColor: "#fff",
    marginBottom: 10,
    overflow: "hidden",
  },
  weekDaySectionHeader: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#edf1f6",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#f7f9fc",
  },
  weekSectionWeekday: { fontSize: 13, fontWeight: "900", color: "#162338" },
  weekSectionDate: { marginTop: 2, fontSize: 11, fontWeight: "700", color: "#60728c" },
  weekSectionOpenDay: { fontSize: 11, fontWeight: "900", color: "#1a4d95" },
  weekWorkoutBox: {
    borderBottomWidth: 1,
    borderBottomColor: "#edf1f6",
    backgroundColor: "#fff",
  },
  weekWorkoutHeader: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  weekWorkoutTitle: { fontSize: 13, fontWeight: "900", color: "#0f1f33" },
  weekWorkoutMeta: { marginTop: 2, fontSize: 11, fontWeight: "700", color: "#5f7089" },
  weekExpandChevron: { fontSize: 14, fontWeight: "900", color: "#42526a" },
  weekCategoriesRow: {
    marginTop: 6,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  weekCategoryChip: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#dbe4f0",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: "#fff",
  },
  weekCategoryChipText: { fontSize: 10, fontWeight: "800", color: "#1d2c41" },
  weekExpandedBody: {
    paddingHorizontal: 10,
    paddingBottom: 10,
    paddingTop: 2,
  },
  weekGroupBlock: {
    paddingTop: 6,
  },
  weekGroupLabel: {
    fontSize: 11,
    fontWeight: "900",
    color: "#22334c",
    marginBottom: 4,
  },
  weekGroupLineText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#334762",
    marginBottom: 3,
  },
  weekDayCard: {
    borderWidth: 1,
    borderColor: "#ececec",
    borderRadius: 12,
    backgroundColor: "#fff",
    padding: 10,
    marginBottom: 8,
  },
  weekDayHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  weekDayLabel: {
    fontSize: 14,
    fontWeight: "900",
    color: "#111",
  },
  weekDayMeta: {
    fontSize: 12,
    color: "#666",
    fontWeight: "800",
  },
  weekNoWorkouts: {
    marginTop: 6,
    fontSize: 12,
    color: "#888",
    fontWeight: "700",
  },
  weekTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
  },
  weekTitleText: {
    flex: 1,
    fontSize: 13,
    color: "#222",
    fontWeight: "700",
  },
  savedBanner: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 88,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#178342",
    backgroundColor: "#1f9d50",
    alignItems: "center",
    paddingVertical: 10,
  },
  savedBannerText: { color: "#fff", fontWeight: "900" },
  fabNewSession: {
    position: "absolute",
    right: 18,
    bottom: 18,
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111",
    borderWidth: 1,
    borderColor: "#111",
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
});
