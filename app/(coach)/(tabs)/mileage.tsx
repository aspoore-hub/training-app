import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { GridCell } from "../../../components/grid/GridCell";
import { GridTable } from "../../../components/grid/GridTable";
import { useGridEngine } from "../../../components/grid/useGridEngine";
import type { GridCellBinding } from "../../../components/grid/GridTypes";
import { AppText } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { Divider } from "../../../components/ui/Divider";
import { Screen } from "../../../components/ui/Screen";
import { useAppTheme } from "../../../components/ui/useAppTheme";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { teamDataStore } from "../../../lib/teamDataStore";
import type { WeekStartDay } from "../../../lib/types";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../../lib/pace";
import { distanceUnitLabel, type DistanceUnit } from "../../../lib/units";
import { loadAthletePaceOverrides, resolveAthletePaceSeconds, type AthletePaceOverrides } from "../../../lib/athletePace";
import { useResponsive } from "../../../lib/useResponsive";
import { loadCoachSettings } from "../../../lib/settings";
import { normalizeTeamRosterAthlete, sortRosterByName } from "../../../lib/teamRoster";
import {
  WEEK_START_KEY,
  formatMileageForSheet,
  getWeekStartISO,
  parseMileageInput,
  parseISODate,
  toISODate,
} from "../../../lib/mileagePlan";
import {
  workoutEntryMilesRange,
  workoutEntryXTRange,
  parseWorkoutEntryValue,
} from "../../../lib/workoutEntryParser";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MILEAGE_GRID_ID = "mileage-grid";

type MileageValue =
  | number
  | string
  | { exact?: number; min?: number; max?: number }
  | { kind: "exact"; value: number }
  | { kind: "range"; min: number; max: number }
  | { kind: "time"; seconds: number; input?: "mm:ss" | "hh:mm:ss"; xt?: boolean }
  | { kind: "timeRange"; minSeconds: number; maxSeconds: number; input?: "mm:ss" | "hh:mm:ss"; xt?: boolean }
  | { kind: "choice"; options: [MileageValue, MileageValue] }
  | null
  | undefined;

type MileageDay = {
  am?: MileageValue;
  pm?: MileageValue;
  AM?: MileageValue;
  PM?: MileageValue;
  ncaaOff?: boolean;
};

type Range = { min: number; max: number };
type SecRange = { min: number; max: number };
type CellField = "am" | "pm";
type CellKey = string; // `${athleteId}__${weekStartISO}__${dayIdx}__${field}`
type OffKey = string; // `${athleteId}__${weekStartISO}__${dayIdx}`
type CopiedRow = { [k: string]: MileageValue | null }; // keys: `dayIdx__field`

function buildEmptyWeek() {
  const days: Record<string, any> = {};
  for (let i = 0; i < 7; i++) days[String(i)] = {};
  return days;
}

function cellCloudKey(athleteId: string, weekStart: string, dayIdx: number, field: CellField) {
  return `${athleteId}__${weekStart}__${dayIdx}__${field}`;
}

function offKey(athleteId: string, weekStart: string, dayIdx: number) {
  return `${athleteId}__${weekStart}__${dayIdx}`;
}

function toRange(v: MileageValue | null | undefined, paceSecPerMile: number): Range {
  const parsed = parseWorkoutEntryValue(v);
  if (!parsed) return { min: 0, max: 0 };
  return workoutEntryMilesRange(parsed, paceSecPerMile);
}

function addRange(a: Range, b: Range): Range {
  return { min: a.min + b.min, max: a.max + b.max };
}

function addSecRange(a: SecRange, b: SecRange): SecRange {
  return { min: a.min + b.min, max: a.max + b.max };
}

function toXTSecRange(v: MileageValue | null | undefined): SecRange {
  const parsed = parseWorkoutEntryValue(v as any);
  if (parsed) return workoutEntryXTRange(parsed);

  const fallback = (value: unknown): SecRange => {
    if (!value || typeof value !== "object") return { min: 0, max: 0 };

    const raw = value as {
      kind?: string;
      seconds?: unknown;
      minSeconds?: unknown;
      maxSeconds?: unknown;
      value?: unknown;
      min?: unknown;
      max?: unknown;
      xt?: unknown;
      options?: unknown;
    };

    const isXt = !!raw.xt;

    const toNumber = (input: unknown): number | null => {
      if (typeof input !== "number") return null;
      if (!Number.isFinite(input)) return null;
      return input;
    };

    const clampNonNegative = (n: number) => Math.max(0, n);

    const normalizeRange = (a: number, b: number) => {
      if (a <= b) return { min: a, max: b };
      return { min: b, max: a };
    };

    if (raw.kind === "choice") {
      const opts = Array.isArray(raw.options) ? raw.options : [];
      let min = Number.POSITIVE_INFINITY;
      let max = 0;
      let found = false;
      for (const option of opts) {
        const r = fallback(option);
        min = Math.min(min, r.min);
        max = Math.max(max, r.max);
        if (r.min !== 0 || r.max !== 0) found = true;
      }
      if (!found) return { min: 0, max: 0 };
      return { min, max };
    }

    if (raw.kind === "time" && isXt) {
      const seconds = toNumber(raw.seconds);
      if (seconds == null) return { min: 0, max: 0 };
      return { min: clampNonNegative(seconds), max: clampNonNegative(seconds) };
    }

    if (raw.kind === "timeRange" && isXt) {
      const min = toNumber(raw.minSeconds);
      const max = toNumber(raw.maxSeconds);
      if (min == null || max == null) return { min: 0, max: 0 };
      const normalized = normalizeRange(clampNonNegative(min), clampNonNegative(max));
      return { min: normalized.min, max: normalized.max };
    }

    if (raw.kind === "minutes" && isXt) {
      const minutes = toNumber(raw.value);
      if (minutes == null) return { min: 0, max: 0 };
      return {
        min: Math.round(clampNonNegative(minutes) * 60),
        max: Math.round(clampNonNegative(minutes) * 60),
      };
    }

    if (raw.kind === "minutesRange" && isXt) {
      const min = toNumber(raw.min);
      const max = toNumber(raw.max);
      if (min == null || max == null) return { min: 0, max: 0 };
      const normalized = normalizeRange(clampNonNegative(min), clampNonNegative(max));
      return {
        min: Math.round(normalized.min * 60),
        max: Math.round(normalized.max * 60),
      };
    }

    return { min: 0, max: 0 };
  };

  return fallback(v);
}

function formatXTTotal(sec: SecRange): string {
  if (!sec || (sec.min === 0 && sec.max === 0)) return "";

  const min = Math.round(sec.min / 60);
  const max = Math.round(sec.max / 60);

  if (min === max) return `${min}minXT`;
  return `${min}-${max}minXT`;
}

function sumWeekMilesRange(days: MileageDay[] | undefined, paceSecPerMile: number): Range {
  if (!Array.isArray(days)) return { min: 0, max: 0 };

  let total: Range = { min: 0, max: 0 };
  for (const d of days) {
    total = addRange(total, toRange(d?.am ?? d?.AM, paceSecPerMile));
    total = addRange(total, toRange(d?.pm ?? d?.PM, paceSecPerMile));
  }

  // round to 1 decimal to avoid float noise
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return { min: round1(total.min), max: round1(total.max) };
}

function formatWeekTotalRoundedDistance(r: Range, unit: DistanceUnit): string {
  if ((r.min === 0 && r.max === 0) || (!Number.isFinite(r.min) && !Number.isFinite(r.max))) return "";

  const a = Math.round(r.min);
  const b = Math.round(r.max);
  const suffix = distanceUnitLabel(unit);

  if (a === b) return `${a} ${suffix}`;
  return `${a}–${b} ${suffix}`;
}

function addDaysISO(iso: string, days: number) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function MiniPill({
  label,
  onPress,
  disabled,
  danger,
  compact,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
  compact?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => ({
        paddingHorizontal: compact ? 8 : 10,
        paddingVertical: compact ? 4 : 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: danger ? "#d11" : "#cfcfcf",
        backgroundColor: disabled ? "#f3f3f3" : pressed ? "#eee" : "#fff",
        opacity: disabled ? 0.55 : 1,
      })}
    >
      <Text style={{ fontSize: compact ? 10 : 11, fontWeight: "900", color: danger ? "#b00" : "#111" }}>{label}</Text>
    </Pressable>
  );
}

function MiniCheck({
  checked,
  onPress,
  disabled,
  hitSlopSize,
}: {
  checked: boolean;
  onPress: () => void;
  disabled?: boolean;
  hitSlopSize?: number;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: disabled ? "#ddd" : checked ? "#111" : "#cfcfcf",
        backgroundColor: disabled ? "#f5f5f5" : checked ? "#111" : "#fff",
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.45 : 1,
        ...(Platform.OS === "web" ? ({ cursor: disabled ? "default" : "pointer" } as any) : null),
      }}
      hitSlop={hitSlopSize ?? 8}
    >
      {checked ? <Text style={{ color: "#fff", fontSize: 11, fontWeight: "900", lineHeight: 12 }}>✓</Text> : null}
    </Pressable>
  );
}

function MiniIconButton({
  icon,
  onPress,
  disabled,
}: {
  icon: "copy" | "paste";
  onPress: () => void;
  disabled?: boolean;
}) {
  const glyph = icon === "copy" ? "⧉" : "⎘";

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      hitSlop={6}
      style={{
        width: 16,
        height: 16,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.35 : 1,
        ...(Platform.OS === "web" ? ({ cursor: disabled ? "default" : "pointer" } as any) : null),
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: "900",
          lineHeight: 14,
        }}
      >
        {glyph}
      </Text>
    </Pressable>
  );
}

function escapeMileagePdfHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMileagePdfDateLabel(iso: string): string {
  const dt = parseISODate(String(iso ?? ""));
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Export-only helper: reads existing in-memory values and never mutates screen/grid state.
function splitAthleteName(fullName: string): { first: string; last: string } {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

// Export-only helper: reads displayed week totals and optional XT line.
function getExportTotalText(args: {
  athleteId: string;
  weekTotalByAthleteId: Map<string, Range>;
  weekXTByAthleteId: Map<string, SecRange>;
  distanceUnit: DistanceUnit;
}): { goalMileage: string; totalMileage: string; xtTotal: string } {
  const totalRange = args.weekTotalByAthleteId.get(String(args.athleteId ?? "")) ?? { min: 0, max: 0 };
  const totalMileage = formatWeekTotalRoundedDistance(totalRange, args.distanceUnit);
  const xtTotal = formatXTTotal(args.weekXTByAthleteId.get(String(args.athleteId ?? "")) ?? { min: 0, max: 0 });
  return {
    goalMileage: totalMileage,
    totalMileage,
    xtTotal,
  };
}

// Export-only helper: reads existing cell/flag maps and formats text without mutating live state.
function getExportCellText(args: {
  athleteId: string;
  weekStartISO: string;
  dayIdx: number;
  cellsByKey: Record<CellKey, MileageValue | null>;
  ncaaOffByKey: Record<OffKey, boolean>;
}): { am: string; pm: string; ncaaOff: boolean } {
  const amRaw = args.cellsByKey[cellCloudKey(args.athleteId, args.weekStartISO, args.dayIdx, "am")];
  const pmRaw = args.cellsByKey[cellCloudKey(args.athleteId, args.weekStartISO, args.dayIdx, "pm")];
  const ncaaOff = !!args.ncaaOffByKey[offKey(args.athleteId, args.weekStartISO, args.dayIdx)];
  return {
    am: amRaw == null ? "" : String(formatMileageForSheet(amRaw as any) ?? ""),
    pm: pmRaw == null ? "" : String(formatMileageForSheet(pmRaw as any) ?? ""),
    ncaaOff,
  };
}

function buildMileageHandoutHtml(args: {
  weekRangeLabel: string;
  weekdayLabels: string[];
  weekDates: string[];
  athletes: Array<{
    first: string;
    last: string;
    goalMileage: string;
    totalMileage: string;
    xtTotal: string;
    days: Array<{
      am: string;
      pm: string;
      ncaaOff: boolean;
    }>;
  }>;
}): string {
  // Export uses standalone HTML only; it does not print/capture the live mileage screen DOM.
  const dayHeaders = Array.from({ length: 7 }, (_, i) => {
    const day = escapeMileagePdfHtml(args.weekdayLabels[i] ?? "");
    const date = escapeMileagePdfHtml(formatMileagePdfDateLabel(args.weekDates[i] ?? ""));
    return `<th class="day-group" colspan="2">${day}<span class="day-date">${date}</span></th>`;
  }).join("");

  const subHeaders = Array.from({ length: 7 }, () => '<th class="sub-col">AM</th><th class="sub-col">PM</th>').join("");

  const rows = (Array.isArray(args.athletes) ? args.athletes : [])
    .map((athlete, rowIdx) => {
      const dayCells = Array.from({ length: 7 }, (_, i) => {
        const day = athlete.days[i] ?? { am: "", pm: "", ncaaOff: false };
        const am = String(day.am ?? "").trim();
        const pm = String(day.pm ?? "").trim();
        return `<td class="cell">${escapeMileagePdfHtml(am)}</td><td class="cell">${escapeMileagePdfHtml(pm)}</td>`;
      }).join("");

      const xtLine = String(athlete.xtTotal ?? "").trim()
        ? `<div class="xt-line">${escapeMileagePdfHtml(athlete.xtTotal)}</div>`
        : "";

      return `
        <tr class="${rowIdx % 2 === 0 ? "row-even" : "row-odd"}">
          <td class="name-col">${escapeMileagePdfHtml(athlete.first)}</td>
          <td class="name-col">${escapeMileagePdfHtml(athlete.last)}</td>
          <td class="goal-col">${escapeMileagePdfHtml(athlete.goalMileage)}</td>
          <td class="minmax-col">${escapeMileagePdfHtml(String(athlete.xtTotal ?? ""))}</td>
          ${dayCells}
        </tr>
      `;
    })
    .join("");

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Weekly Mileage Chart</title>
    <style>
      @page { size: Letter landscape; margin: 0.3in; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #111827; background: #fff; font-family: Arial, Helvetica, sans-serif; font-size: 9px; line-height: 1.1; }
      .title { font-size: 12px; font-weight: 800; margin: 0 0 2px 0; line-height: 1.05; }
      .sub { font-size: 8px; font-weight: 700; color: #374151; margin: 0 0 5px 0; line-height: 1.05; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; border: 0.8px solid #9ca3af; }
      th, td { border: 0.7px solid #9ca3af; padding: 3px 2px; vertical-align: middle; }
      thead th { background: #e5e7eb; color: #111827; font-size: 8px; font-weight: 800; text-align: center; white-space: nowrap; line-height: 1.0; }
      .row-even td { background: #f3f4f6; }
      .row-odd td { background: #ffffff; }
      .name-col { width: 34px; font-size: 7px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
      .goal-col { width: 38px; font-size: 7px; font-weight: 700; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
      .minmax-col { width: 38px; font-size: 7px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
      .total-main { font-size: 7px; font-weight: 800; line-height: 1.0; }
      .xt-line { font-size: 6px; font-style: italic; color: #4b5563; margin-top: 0; line-height: 1.0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .day-group { font-size: 7px; line-height: 1.0; }
      .day-date { display: block; font-size: 6px; font-weight: 700; color: #6b7280; margin-top: 0; line-height: 1.0; white-space: nowrap; }
      .sub-col { font-size: 6.5px; font-weight: 800; text-align: center; }
      .cell { font-size: 7px; line-height: 1.15; min-height: 30px; text-align: center; white-space: normal; overflow-wrap: anywhere; word-break: break-word; vertical-align: top; }
    </style>
  </head>
  <body>
    <h1 class="title">Weekly Mileage Chart</h1>
    <p class="sub">${escapeMileagePdfHtml(args.weekRangeLabel)}</p>
    <table>
      <thead>
        <tr>
          <th rowspan="2">First</th>
          <th rowspan="2">Last</th>
          <th rowspan="2">Goal Mileage</th>
          <th rowspan="2">XT Total</th>
          ${dayHeaders}
        </tr>
        <tr>${subHeaders}</tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </body>
</html>
`.trim();
}

export default function CoachMileageTab() {
  const { isDesktop, isWeb } = useResponsive();
  const { theme, colors } = useAppTheme();
  const s = teamDataStore.use();
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [weekAnchorISO, setWeekAnchorISO] = useState(() => toISODate(new Date()));
  const [copiedRow, setCopiedRow] = useState<CopiedRow | null>(null);
  const [pasteTargets, setPasteTargets] = useState<Set<string>>(() => new Set());
  const [paceSecPerMile, setPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [athletePaceOverrides, setAthletePaceOverrides] = useState<AthletePaceOverrides>({});
  const [invalidCells, setInvalidCells] = useState<Record<string, boolean>>({});
  const [actionBannerText, setActionBannerText] = useState("");
  // Standalone export state only; live mileage sheet rendering and grid behavior are untouched.
  const [exportingPdf, setExportingPdf] = useState(false);
  const [activeGridId, setActiveGridId] = useState<string | null>(null);
  const [mileageDraftsByKey, setMileageDraftsByKey] = useState<Record<string, string>>({});
  const actionBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mileageSheetRootRef = useRef<any>(null);
  const mileageDraftsRef = useRef<Record<string, string>>({});
  const mileageSaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingDraftSaveKeysRef = useRef<Set<string>>(new Set());

  const showActionBanner = useCallback((text: string) => {
    if (actionBannerTimerRef.current) clearTimeout(actionBannerTimerRef.current);
    setActionBannerText(text);
    actionBannerTimerRef.current = setTimeout(() => {
      setActionBannerText("");
      actionBannerTimerRef.current = null;
    }, 1600);
  }, []);

  useEffect(() => {
    return () => {
      if (actionBannerTimerRef.current) clearTimeout(actionBannerTimerRef.current);
      Object.values(mileageSaveTimersRef.current).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    mileageDraftsRef.current = mileageDraftsByKey;
  }, [mileageDraftsByKey]);

  const weekStartISO = useMemo(() => getWeekStartISO(weekAnchorISO, weekStartsOn), [weekAnchorISO, weekStartsOn]);

  const weekdayLabels = useMemo(() => {
    const arr: string[] = [];
    for (let i = 0; i < 7; i++) arr.push(WEEKDAY_LABELS[(weekStartsOn + i) % 7]);
    return arr;
  }, [weekStartsOn]);

  const weekDates = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDaysISO(weekStartISO, i));
  }, [weekStartISO]);

  const weekRangeLabel = useMemo(() => {
    const startISO = weekDates[0];
    const endISO = weekDates[6];
    if (!startISO || !endISO) return weekStartISO;
    const start = parseISODate(startISO);
    const end = parseISODate(endISO);
    const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `${startLabel} - ${endLabel}`;
  }, [weekDates, weekStartISO]);

  const weekCells = s.mileageCellsByWeek[weekStartISO] ?? [];
  const weekFlags = s.mileageFlagsByWeek[weekStartISO] ?? [];

  const cellsByKey = useMemo(() => {
    const next: Record<CellKey, MileageValue | null> = {};
    for (const row of weekCells as any[]) {
      const athleteId = String(row?.athlete_profile_id ?? "");
      const dayIdx = Number(row?.day_idx);
      const session = String(row?.session ?? "").toUpperCase();
      if (!athleteId || !Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) continue;
      const field: CellField = session === "PM" ? "pm" : "am";
      next[cellCloudKey(athleteId, weekStartISO, dayIdx, field)] = (row?.value ?? null) as MileageValue | null;
    }
    return next;
  }, [weekCells, weekStartISO]);

  const ncaaOffByKey = useMemo(() => {
    const next: Record<OffKey, boolean> = {};
    for (const row of weekFlags as any[]) {
      const athleteId = String(row?.athlete_profile_id ?? "");
      const dayIdx = Number(row?.day_idx);
      if (!athleteId || !Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) continue;
      next[offKey(athleteId, weekStartISO, dayIdx)] = !!row?.ncaa_off;
    }
    return next;
  }, [weekFlags, weekStartISO]);

  const athletesWithIds = useMemo(() => {
    const normalized = sortRosterByName(
      (s.roster ?? [])
        .map((item) => normalizeTeamRosterAthlete(item))
        .filter((item): item is NonNullable<typeof item> => !!item)
    );

    return normalized.map((athlete, i) => {
      const id = String(athlete.id ?? "");
      const name = String(athlete.displayName ?? "").trim() || `Athlete ${i + 1}`;
      return { raw: athlete, index: i, id, name };
    });
  }, [s.roster]);

  const buildDaysForAthleteWeek = useCallback(
    (athleteId: string, targetWeekStartISO: string): Record<string, MileageDay> => {
      const days = buildEmptyWeek() as Record<string, MileageDay>;
      for (let i = 0; i < 7; i++) {
        const am = cellsByKey[cellCloudKey(athleteId, targetWeekStartISO, i, "am")];
        const pm = cellsByKey[cellCloudKey(athleteId, targetWeekStartISO, i, "pm")];
        if (am != null) (days[String(i)] as MileageDay).am = am;
        if (pm != null) (days[String(i)] as MileageDay).pm = pm;
        if (ncaaOffByKey[offKey(athleteId, targetWeekStartISO, i)]) {
          (days[String(i)] as MileageDay).ncaaOff = true;
        }
      }
      return days;
    },
    [cellsByKey, ncaaOffByKey]
  );

  const weekTotalByAthleteId = useMemo(() => {
    const map = new Map<string, Range>();

    for (const athlete of athletesWithIds) {
      const athleteId = String(athlete.id ?? "");
      if (!athleteId) continue;
      const pace = resolveAthletePaceSeconds(athleteId, athletePaceOverrides, paceSecPerMile);

      let total: Range = { min: 0, max: 0 };
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const am = cellsByKey[cellCloudKey(athleteId, weekStartISO, dayIdx, "am")];
        const pm = cellsByKey[cellCloudKey(athleteId, weekStartISO, dayIdx, "pm")];
        total = addRange(total, toRange(am as any, pace));
        total = addRange(total, toRange(pm as any, pace));
      }

      const round1 = (n: number) => Math.round(n * 10) / 10;
      map.set(athleteId, { min: round1(total.min), max: round1(total.max) });
    }

    return map;
  }, [athletesWithIds, athletePaceOverrides, paceSecPerMile, cellsByKey, weekStartISO]);

  const weekXTByAthleteId = useMemo(() => {
    const map = new Map<string, SecRange>();

    for (const athlete of athletesWithIds) {
      const athleteId = String(athlete.id ?? "");
      if (!athleteId) continue;

      let total: SecRange = { min: 0, max: 0 };
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const am = cellsByKey[cellCloudKey(athleteId, weekStartISO, dayIdx, "am")];
        const pm = cellsByKey[cellCloudKey(athleteId, weekStartISO, dayIdx, "pm")];
        total = addSecRange(total, toXTSecRange(am as any));
        total = addSecRange(total, toXTSecRange(pm as any));
      }

      map.set(athleteId, total);
    }

    return map;
  }, [athletesWithIds, cellsByKey, weekStartISO]);

  const handleExportMileagePdf = useCallback(async () => {
    // Read-only export path: builds a separate document from in-memory data without mutating sheet state.
    if (exportingPdf) return;
    console.log("[mileage-pdf] export start", { weekRangeLabel, athleteCount: athletesWithIds.length });
    setExportingPdf(true);
    try {
      const exportAthletes = athletesWithIds.map((a) => {
        const name = splitAthleteName(String(a.name ?? ""));
        const totals = getExportTotalText({
          athleteId: a.id,
          weekTotalByAthleteId,
          weekXTByAthleteId,
          distanceUnit,
        });
        const days = Array.from({ length: 7 }, (_, dayIdx) => {
          return getExportCellText({
            athleteId: a.id,
            weekStartISO,
            dayIdx,
            cellsByKey,
            ncaaOffByKey,
          });
        });
        return {
          first: name.first,
          last: name.last,
          goalMileage: totals.goalMileage,
          totalMileage: totals.totalMileage,
          xtTotal: totals.xtTotal,
          days,
        };
      });

      console.log("[mileage-pdf] using custom html builder");
      const html = buildMileageHandoutHtml({
        weekRangeLabel,
        weekdayLabels,
        weekDates,
        athletes: exportAthletes,
      });
      console.log("[mileage-pdf] html built", { length: html.length });
      console.log("[mileage-pdf] html preview", html.slice(0, 400));

      if (Platform.OS === "web") {
        console.log("[mileage-pdf] opening standalone web print window");

        const printWindow = window.open("", "_blank", "width=1200,height=900");
        if (!printWindow) {
          throw new Error("Popup blocked. Please allow popups for this site to export PDF.");
        }

        printWindow.document.open();
        printWindow.document.write(html);
        printWindow.document.close();

        await new Promise<void>((resolve) => {
          const finalize = () => resolve();

          printWindow.onload = () => {
            setTimeout(() => {
              printWindow.focus();
              printWindow.print();
              setTimeout(() => {
                try {
                  printWindow.close();
                } catch {}
                finalize();
              }, 300);
            }, 250);
          };

          setTimeout(() => {
            try {
              printWindow.focus();
              printWindow.print();
            } catch {}
            setTimeout(() => {
              try {
                printWindow.close();
              } catch {}
              finalize();
            }, 500);
          }, 900);
        });

        console.log("[mileage-pdf] web print window completed");
      } else {
        const result = await Print.printToFileAsync({ html });
        console.log("[mileage-pdf] print result", result);
        await Sharing.shareAsync(result.uri);
      }
    } catch (e: any) {
      console.log("[mileage-pdf] export error", e);
      Alert.alert("Export failed", String(e?.message ?? "Could not export mileage PDF."));
    } finally {
      setExportingPdf(false);
    }
  }, [
    athletesWithIds,
    cellsByKey,
    distanceUnit,
    exportingPdf,
    ncaaOffByKey,
    weekDates,
    weekRangeLabel,
    weekStartISO,
    weekTotalByAthleteId,
    weekXTByAthleteId,
    weekdayLabels,
  ]);

  useEffect(() => {
    const run = async () => {
      const rawWeekStart = await AsyncStorage.getItem(WEEK_START_KEY);
      const parsedWeekStart = Number(rawWeekStart);
      const resolvedWeekStartsOn: WeekStartDay =
        parsedWeekStart === 0 || parsedWeekStart === 1 ? (parsedWeekStart as WeekStartDay) : 1;
      setWeekStartsOn(resolvedWeekStartsOn);

      const [pace, unit, paceOverrides] = await Promise.all([
        loadPaceSecondsPerMile(),
        loadCoachSettings(),
        loadAthletePaceOverrides(),
      ]);
      setPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
      setDistanceUnit(unit.distanceUnit);
      setAthletePaceOverrides(paceOverrides ?? {});
    };
    void run();
  }, []);

  useFocusEffect(
    useCallback(() => {
      void teamDataStore.actions.refreshRoster();
      void teamDataStore.actions.loadMileageWeek(weekStartISO);
    }, [weekStartISO])
  );

  function hasAnyCellForWeek(athleteId: string, targetWeekStartISO: string) {
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      for (const field of ["am", "pm"] as const) {
        const v = cellsByKey[cellCloudKey(athleteId, targetWeekStartISO, dayIdx, field)];
        if (v != null) return true;
      }
    }
    return false;
  }

  function cellKey(athleteId: string, dayIdx: number, field: "am" | "pm") {
    return `${athleteId}__${dayIdx}__${field}`;
  }

  async function setCellCloud(athleteId: string, dayIdx: number, field: "am" | "pm", text: string): Promise<boolean> {
    const trimmed = String(text ?? "").trim();
    const value = trimmed ? parseMileageInput(trimmed) : null;
    if (trimmed && !value) return false;

    await teamDataStore.actions.setMileageCell(
      athleteId,
      weekStartISO,
      dayIdx,
      field === "am" ? "AM" : "PM",
      value
    );

    return true;
  }

  function setNCAAOffDayCloud(athleteId: string, dayIdx: number, enabled: boolean) {
    void teamDataStore.actions.setMileageOffFlag(athleteId, weekStartISO, dayIdx, enabled);
  }

  function copyRow(athleteId: string) {
    blurActiveInput();
    const row: CopiedRow = {};
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      row[`${dayIdx}__am`] = cellsByKey[cellCloudKey(athleteId, weekStartISO, dayIdx, "am")] ?? null;
      row[`${dayIdx}__pm`] = cellsByKey[cellCloudKey(athleteId, weekStartISO, dayIdx, "pm")] ?? null;
    }
    setCopiedRow(row);
    setPasteTargets(new Set());
    showActionBanner("Row copied");
  }

  function pasteRowCloud(targetAthleteId: string) {
    if (!copiedRow) return;
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const am = copiedRow[`${dayIdx}__am`] ?? null;
      const pm = copiedRow[`${dayIdx}__pm`] ?? null;
      void teamDataStore.actions.setMileageCell(targetAthleteId, weekStartISO, dayIdx, "AM", am);
      void teamDataStore.actions.setMileageCell(targetAthleteId, weekStartISO, dayIdx, "PM", pm);
    }
  }

  function togglePasteTarget(athleteId: string) {
    setPasteTargets((prev) => {
      const next = new Set(prev);
      if (next.has(athleteId)) next.delete(athleteId);
      else next.add(athleteId);
      return next;
    });
  }

  function clearPasteTargets() {
    setPasteTargets(new Set());
  }

  function selectPasteRange(startIndex: number, count: number) {
    setPasteTargets((prev) => {
      const next = new Set(prev);
      for (let i = startIndex; i < Math.min(athletesWithIds.length, startIndex + count); i++) {
        const id = athletesWithIds[i]?.id;
        if (id) next.add(id);
      }
      return next;
    });
  }

  function confirmPaste(message: string, onConfirm: () => void) {
    if (Platform.OS === "web") {
      const ok = typeof window !== "undefined" ? window.confirm(message) : false;
      if (ok) onConfirm();
      return;
    }

    Alert.alert("Paste week plan?", message, [
      { text: "Cancel", style: "cancel" },
      { text: "Paste", style: "destructive", onPress: onConfirm },
    ]);
  }

  function blurActiveInput() {
    if (Platform.OS === "web") {
      (document.activeElement as any)?.blur?.();
    } else {
      // RN native: blur focused input if any
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const TextInputNative = require("react-native").TextInput;
        TextInputNative?.State?.currentlyFocusedInput?.()?.blur?.();
      } catch {}
    }
  }

  function pasteRow(targetAthleteId: string) {
    blurActiveInput();
    if (!copiedRow) return;
    confirmPaste(
      "This will overwrite the target athlete’s AM/PM values for this week.",
      () => {
        pasteRowCloud(targetAthleteId);
        showActionBanner("Row pasted");
      }
    );
  }

  function pasteToSelected() {
    blurActiveInput();
    if (!copiedRow) return;
    const targets = Array.from(pasteTargets).filter(Boolean);
    if (targets.length === 0) return;
    confirmPaste(
      "This will overwrite the selected athletes’ AM/PM values for this week.",
      () => {
        for (const targetAthleteId of targets) {
          pasteRowCloud(targetAthleteId);
        }
        showActionBanner(`Pasted to ${targets.length}`);
        clearPasteTargets();
      }
    );
  }

  function clearSelectedRows() {
    blurActiveInput();
    const targets = Array.from(pasteTargets).filter(Boolean);
    if (targets.length === 0) return;

    const message = "This will clear ALL AM/PM values (and NCAA Off flags) for this week for the selected rows.";
    const runClear = async () => {
      try {
        for (const athleteId of targets) {
          for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
            await teamDataStore.actions.setMileageCell(athleteId, weekStartISO, dayIdx, "AM", null);
            await teamDataStore.actions.setMileageCell(athleteId, weekStartISO, dayIdx, "PM", null);
            await teamDataStore.actions.setMileageOffFlag(athleteId, weekStartISO, dayIdx, false);
          }
        }

        showActionBanner(`Cleared ${targets.length} row${targets.length === 1 ? "" : "s"}`);
        clearPasteTargets();
      } catch (e) {
        console.warn("Clear row failed", e);
        Alert.alert("Clear row failed", "Could not clear one or more rows. Check logs.");
      }
    };

    if (Platform.OS === "web") {
      const ok = typeof window !== "undefined" ? window.confirm(message) : false;
      if (ok) void runClear();
      return;
    }

    Alert.alert(
      `Clear row for ${targets.length} athlete${targets.length === 1 ? "" : "s"}?`,
      message,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear Row", style: "destructive", onPress: () => void runClear() },
      ]
    );
  }

  function copyPreviousWeekAll() {
    const previousWeekStartISO = addDaysISO(weekStartISO, -7);

    for (const athlete of athletesWithIds) {
      const athleteId = athlete.id;
      if (!athleteId) continue;
      if (!hasAnyCellForWeek(athleteId, previousWeekStartISO)) continue;
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const am = cellsByKey[cellCloudKey(athleteId, previousWeekStartISO, dayIdx, "am")] ?? null;
        const pm = cellsByKey[cellCloudKey(athleteId, previousWeekStartISO, dayIdx, "pm")] ?? null;
        void teamDataStore.actions.setMileageCell(athleteId, weekStartISO, dayIdx, "AM", am);
        void teamDataStore.actions.setMileageCell(athleteId, weekStartISO, dayIdx, "PM", pm);
      }
    }
    showActionBanner("Previous week copied");
  }

  function clearEntireWeekAll() {
    for (const athlete of athletesWithIds) {
      if (!athlete.id) continue;
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        void teamDataStore.actions.setMileageCell(athlete.id, weekStartISO, dayIdx, "AM", null);
        void teamDataStore.actions.setMileageCell(athlete.id, weekStartISO, dayIdx, "PM", null);
        void teamDataStore.actions.setMileageOffFlag(athlete.id, weekStartISO, dayIdx, false);
      }
    }
    setInvalidCells({});
    showActionBanner("Entire week cleared");
  }

  // --- Spreadsheet engine (shared with daily worksheet) ---
  const mileageColKey = useCallback((dayIdx: number, field: CellField) => {
    return `d${dayIdx}_${field}`;
  }, []);

  const mileageColMeta = useCallback((colKey: string): { dayIdx: number; field: CellField } => {
    const m = /^d(\d+)_(am|pm)$/.exec(String(colKey ?? ""));
    if (!m) return { dayIdx: 0, field: "am" };
    return {
      dayIdx: Number(m[1] ?? 0),
      field: m[2] === "pm" ? "pm" : "am",
    };
  }, []);

  const editableAthleteIds = useMemo(
    () => athletesWithIds.filter((a) => !!a.id).map((a) => a.id),
    [athletesWithIds]
  );

  const mileageColKeys = useMemo(
    () =>
      Array.from({ length: 7 }).flatMap((_, dayIdx) => [
        mileageColKey(dayIdx, "am"),
        mileageColKey(dayIdx, "pm"),
      ]),
    [mileageColKey]
  );

  const mileageGrid = useGridEngine<string, string>({
    enabled: isWeb && isDesktop,
    rowIds: editableAthleteIds,
    colKeys: mileageColKeys,
    onActivate: () => setActiveGridId(MILEAGE_GRID_ID),
    getValue: (athleteId, colKey) => {
      const { dayIdx, field } = mileageColMeta(colKey);
      const key = cellCloudKey(athleteId, weekStartISO, dayIdx, field);
      return String(mileageDraftsByKey[key] ?? "");
    },
    setValue: (athleteId, colKey, value) => {
      const { dayIdx, field } = mileageColMeta(colKey);
      const cloudKey = cellCloudKey(athleteId, weekStartISO, dayIdx, field);
      const uiKey = cellKey(athleteId, dayIdx, field);
      const nextText = String(value ?? "");
      const trimmed = nextText.trim();
      const parsed = trimmed ? parseMileageInput(trimmed) : null;
      const isInvalid = !!trimmed && !parsed;

      setMileageDraftsByKey((prev) => ({ ...prev, [cloudKey]: nextText }));
      setInvalidCells((prev) => {
        const next = { ...prev };
        if (isInvalid) next[uiKey] = true;
        else delete next[uiKey];
        return next;
      });

      const existing = mileageSaveTimersRef.current[cloudKey];
      if (existing) clearTimeout(existing);
      delete mileageSaveTimersRef.current[cloudKey];

      if (isInvalid) {
        pendingDraftSaveKeysRef.current.delete(cloudKey);
        return;
      }

      pendingDraftSaveKeysRef.current.add(cloudKey);
      mileageSaveTimersRef.current[cloudKey] = setTimeout(async () => {
        const latestText = String(mileageDraftsRef.current[cloudKey] ?? "");
        const latestTrimmed = latestText.trim();
        const latestParsed = latestTrimmed ? parseMileageInput(latestTrimmed) : null;
        const latestInvalid = !!latestTrimmed && !latestParsed;

        if (latestInvalid) {
          setInvalidCells((prev) => ({ ...prev, [uiKey]: true }));
          pendingDraftSaveKeysRef.current.delete(cloudKey);
          delete mileageSaveTimersRef.current[cloudKey];
          return;
        }

        try {
          const ok = await setCellCloud(athleteId, dayIdx, field, latestText);
          setInvalidCells((prev) => {
            const next = { ...prev };
            if (ok) delete next[uiKey];
            else next[uiKey] = true;
            return next;
          });
        } catch {
          // Keep local draft; cloud retry will happen on subsequent edits.
        } finally {
          pendingDraftSaveKeysRef.current.delete(cloudKey);
          delete mileageSaveTimersRef.current[cloudKey];
        }
      }, 420);
    },
  });

  useEffect(() => {
    const nextDrafts: Record<string, string> = {};
    editableAthleteIds.forEach((athleteId) => {
      for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
        (["am", "pm"] as const).forEach((field) => {
          const key = cellCloudKey(athleteId, weekStartISO, dayIdx, field);
          const raw = cellsByKey[key];
          nextDrafts[key] = String(formatMileageForSheet(raw as any) ?? "");
        });
      }
    });

    setMileageDraftsByKey((prev) => {
      const merged = { ...nextDrafts };
      Object.keys(nextDrafts).forEach((key) => {
        const hasPendingSave =
          pendingDraftSaveKeysRef.current.has(key) || !!mileageSaveTimersRef.current[key];
        if (hasPendingSave && key in prev) {
          merged[key] = prev[key];
        }
      });
      return merged;
    });
    setInvalidCells({});
  }, [cellsByKey, editableAthleteIds, weekStartISO]);

  useEffect(() => {
    if (!(isWeb && isDesktop)) return;
    const onMouseDown = (e: any) => {
      const root = mileageSheetRootRef.current as any;
      const rootNode = root?.getScrollableNode?.() ?? root?.getInnerViewNode?.() ?? root;
      const target = e?.target as Node | null;
      if (!rootNode || !target || typeof rootNode.contains !== "function") {
        setActiveGridId(null);
        return;
      }
      if (!rootNode.contains(target)) {
        setActiveGridId(null);
      }
    };
    window.addEventListener("mousedown", onMouseDown, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [isDesktop, isWeb]);

  const bindMileageCell = useCallback(
    (athleteId: string, colKey: string): GridCellBinding => {
      const base = mileageGrid.bindCell(athleteId, colKey);
      if (!(isWeb && isDesktop)) return base;
      const handlers = base?.handlers ?? {};
      return {
        ...base,
        handlers: {
          ...handlers,
          onMouseDown: (e: any) => {
            setActiveGridId(MILEAGE_GRID_ID);
            handlers.onMouseDown?.(e);
          },
          onFocus: (e: any) => {
            setActiveGridId(MILEAGE_GRID_ID);
            handlers.onFocus?.(e);
          },
        },
      };
    },
    [isDesktop, isWeb, mileageGrid]
  );

  const getMileageDraftValue = useCallback(
    (athleteId: string, colKey: string) => {
      const { dayIdx, field } = mileageColMeta(colKey);
      return String(mileageDraftsByKey[cellCloudKey(athleteId, weekStartISO, dayIdx, field)] ?? "");
    },
    [mileageColMeta, mileageDraftsByKey, weekStartISO]
  );

  const fillAllMileage = useCallback(() => {
    if (editableAthleteIds.length < 2) return;
    const sourceId = editableAthleteIds[0];
    if (!sourceId) return;
    const targetIds = editableAthleteIds.slice(1);
    const changes: Array<{ rowId: string; colKey: string; prev: string; next: string }> = [];
    targetIds.forEach((rowId) => {
      mileageColKeys.forEach((colKey) => {
        changes.push({
          rowId,
          colKey,
          prev: getMileageDraftValue(rowId, colKey),
          next: getMileageDraftValue(sourceId, colKey),
        });
      });
    });
    mileageGrid.applyChanges(changes as any);
  }, [editableAthleteIds, getMileageDraftValue, mileageColKeys, mileageGrid]);

  const fillSelectedMileage = useCallback(() => {
    const rect = mileageGrid.getSelectionRect();
    if (!rect) return;
    const sourceId = editableAthleteIds[rect.r1];
    if (!sourceId) return;
    const selectedCols = new Set(mileageGrid.getSelectedColKeys());
    const selectedRowIds = mileageGrid.selectedRowIds;
    const changes: Array<{ rowId: string; colKey: string; prev: string; next: string }> = [];
    selectedRowIds.forEach((rowId) => {
      if (rowId === sourceId) return;
      mileageColKeys.forEach((colKey) => {
        if (!selectedCols.has(colKey)) return;
        changes.push({
          rowId,
          colKey,
          prev: getMileageDraftValue(rowId, colKey),
          next: getMileageDraftValue(sourceId, colKey),
        });
      });
    });
    mileageGrid.applyChanges(changes as any);
  }, [editableAthleteIds, getMileageDraftValue, mileageColKeys, mileageGrid]);

  useEffect(() => {
    if (!(isWeb && isDesktop)) return;
    const onKeyDown = (e: any) => {
      if (activeGridId !== MILEAGE_GRID_ID) return;
      const handled = mileageGrid.handleKeyDown(e);
      if (!handled) return;
      e.preventDefault?.();
      e.stopPropagation?.();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activeGridId, fillSelectedMileage, isDesktop, isWeb, mileageGrid]);

  const denseGrid = true;
  const mileageSelectionRect = mileageGrid.getSelectionRect();
  const mileageHasSelection = !!mileageSelectionRect;
  const mileageSelectedRowsCount = mileageGrid.selectedRowIds.length;

  // Spreadsheet-like density (shared coach layout on web + mobile)
  const athleteColWidth = 260;
  const showSelectCol = true;
  const selectColWidth = showSelectCol ? 32 : 0;
  const dayGroupWidth = 204;
  const subCellGap = 8;
  const cellPad = 6;
  const subColWidth = Math.floor((dayGroupWidth - cellPad * 2 - subCellGap) / 2);
  const gridMinWidth = athleteColWidth + selectColWidth + dayGroupWidth * 7;

  const showStickyAthleteCol = isWeb && isDesktop;
  const showStickySelectCol = isWeb && isDesktop;
  const stickyHeaderRow1Bg = "#f3f6fb";
  const stickyHeaderRow2Bg = "#f7f9fc";
  const stickyAthleteStyle = showStickyAthleteCol
    ? ({ position: "sticky", left: 0, zIndex: 130 } as any)
    : null;
  const stickySelectStyle = showStickySelectCol
    ? ({ position: "sticky", left: athleteColWidth, zIndex: 120, backgroundColor: colors.bg } as any)
    : null;

  const fontCell = 11;
  const fontHeader = 11;
  const fontTiny = 10;

  const inputPadV = 4;
  const inputPadH = 5;

  const radiusCell = 6;
  const borderThin = 1;
  const dayColumnsWidth = dayGroupWidth * 7;
  const pinnedHeaderWidth = athleteColWidth + selectColWidth;
  const webHeaderDaysScrollRef = useRef<any>(null);
  const webBodyScrollRef = useRef<any>(null);

  const syncHeaderFromBody = useCallback((scrollLeft: number) => {
    const header = webHeaderDaysScrollRef.current as any;
    if (!header) return;
    if (Math.abs((header.scrollLeft ?? 0) - scrollLeft) < 1) return;
    header.scrollLeft = scrollLeft;
  }, []);

  const handleWebBodyScroll = useCallback((e: any) => {
    syncHeaderFromBody(Number(e?.currentTarget?.scrollLeft ?? 0));
  }, [syncHeaderFromBody]);

  const renderHeaderLeft = () => (
    <View style={{ width: pinnedHeaderWidth }}>
      <View style={{ flexDirection: "row", backgroundColor: stickyHeaderRow1Bg }}>
        <View
          style={{
            width: athleteColWidth,
            minWidth: athleteColWidth,
            maxWidth: athleteColWidth,
            padding: cellPad,
            borderRightWidth: borderThin,
            borderRightColor: colors.border,
            backgroundColor: stickyHeaderRow1Bg,
            overflow: "hidden",
          }}
        >
          <Text style={{ fontWeight: "900", color: colors.text, fontSize: fontHeader }}>Athlete</Text>
          <Text style={{ fontSize: fontTiny, color: colors.mutedText, fontWeight: "700" }}>
            AM / PM per day
          </Text>
        </View>
        {showSelectCol ? (
          <View
            style={{
              width: selectColWidth,
              minWidth: selectColWidth,
              maxWidth: selectColWidth,
              borderRightWidth: borderThin,
              borderRightColor: colors.border,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: stickyHeaderRow1Bg,
              overflow: "hidden",
            }}
          >
            <Text style={{ fontSize: 10, fontWeight: "800", color: colors.mutedText }}>✓</Text>
          </View>
        ) : null}
      </View>

      {denseGrid ? (
        <View
          style={{
            flexDirection: "row",
            borderTopWidth: borderThin,
            borderTopColor: colors.border,
            backgroundColor: stickyHeaderRow2Bg,
          }}
        >
          <View
            style={{
              width: athleteColWidth,
              minWidth: athleteColWidth,
              maxWidth: athleteColWidth,
              paddingHorizontal: cellPad,
              paddingVertical: 6,
              borderRightWidth: borderThin,
              borderRightColor: colors.border,
              backgroundColor: stickyHeaderRow2Bg,
              overflow: "hidden",
            }}
          >
            <Text style={{ fontSize: fontTiny, color: colors.mutedText, fontWeight: "800" }}>
              Totals • Copy/Paste
            </Text>
          </View>
          {showSelectCol ? (
            <View
              style={{
                width: selectColWidth,
                minWidth: selectColWidth,
                maxWidth: selectColWidth,
                borderRightWidth: borderThin,
                borderRightColor: colors.border,
                backgroundColor: stickyHeaderRow2Bg,
                overflow: "hidden",
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );

  const renderHeaderRight = () => (
    <View style={{ width: dayColumnsWidth }}>
      <View style={{ flexDirection: "row", backgroundColor: stickyHeaderRow1Bg }}>
        {weekdayLabels.map((lbl, i) => (
          <View
            key={`${lbl}-${i}`}
            style={{
              width: dayGroupWidth,
              padding: cellPad,
              borderLeftWidth: borderThin,
              borderLeftColor: colors.border,
              backgroundColor: stickyHeaderRow1Bg,
            }}
          >
            <Text style={{ fontWeight: "900", color: colors.text, fontSize: fontHeader }}>{lbl}</Text>
            <Text style={{ fontSize: fontTiny, color: colors.mutedText, fontWeight: "700" }}>{weekDates[i]}</Text>
          </View>
        ))}
      </View>

      {denseGrid ? (
        <View
          style={{
            flexDirection: "row",
            borderTopWidth: borderThin,
            borderTopColor: colors.border,
            backgroundColor: stickyHeaderRow2Bg,
          }}
        >
          {Array.from({ length: 7 }, (_, i) => (
            <View
              key={`sub-${i}`}
              style={{
                width: dayGroupWidth,
                padding: cellPad,
                borderLeftWidth: borderThin,
                borderLeftColor: colors.border,
                backgroundColor: stickyHeaderRow2Bg,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: subCellGap }}>
                <Text
                  style={{
                    width: subColWidth,
                    fontSize: fontTiny,
                    fontWeight: "900",
                    color: colors.mutedText,
                  }}
                >
                  AM
                </Text>
                <Text
                  style={{
                    width: subColWidth,
                    fontSize: fontTiny,
                    fontWeight: "900",
                    color: colors.mutedText,
                  }}
                >
                  PM
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );

  const renderMileageHeader = () => (
    <View style={{ minWidth: gridMinWidth, backgroundColor: colors.bg, borderBottomWidth: borderThin, borderBottomColor: colors.border }}>
      <View style={{ flexDirection: "row" }}>
        {renderHeaderLeft()}
        {renderHeaderRight()}
      </View>
    </View>
  );

  const renderMileageBody = () => (
    <>
      {athletesWithIds.map((a, rowIndex) => {
        const canEdit = !!a.id;
        const rowSelected = mileageGrid.isRowSelected(a.id);
        return (
          <View
            key={a.id || `row_${rowIndex}`}
            style={{
              flexDirection: "row",
              borderBottomWidth: borderThin,
              borderBottomColor: colors.border,
              minWidth: gridMinWidth,
              backgroundColor: rowSelected ? "#eef4ff" : rowIndex % 2 === 0 ? colors.card : colors.bg,
            }}
          >
            <View
              style={{
                width: athleteColWidth,
                minWidth: athleteColWidth,
                maxWidth: athleteColWidth,
                padding: cellPad,
                justifyContent: "center",
                borderRightWidth: borderThin,
                borderRightColor: colors.border,
                backgroundColor: rowSelected ? "#e6efff" : rowIndex % 2 === 0 ? colors.card : colors.bg,
                ...(stickyAthleteStyle ?? {}),
                overflow: "hidden",
                zIndex: 50,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "900", color: colors.text }}>{a.name}</Text>
                  {(() => {
                    const total = weekTotalByAthleteId.get(String(a.id ?? "")) ?? { min: 0, max: 0 };
                    const label = formatWeekTotalRoundedDistance(total, distanceUnit);
                    if (!label) return null;
                    return <Text style={{ fontSize: 12, color: colors.mutedText }}>{label}</Text>;
                  })()}
                  {(() => {
                    const xt = weekXTByAthleteId.get(String(a.id ?? "")) ?? { min: 0, max: 0 };
                    const xtLabel = formatXTTotal(xt);
                    if (!xtLabel) return null;
                    return <Text style={{ fontSize: 12, color: colors.mutedText }}>{xtLabel}</Text>;
                  })()}
                </View>

                {canEdit ? (
                  <View
                    style={{
                      alignItems: "flex-end",
                      gap: 4,
                      marginLeft: 6,
                    }}
                  >
                    <MiniIconButton icon="copy" onPress={() => copyRow(a.id)} />
                    <MiniIconButton icon="paste" onPress={() => pasteRow(a.id)} disabled={!copiedRow} />
                  </View>
                ) : null}
              </View>

              {!canEdit ? (
                <Text style={{ marginTop: 6, fontSize: 11, fontWeight: "800", color: colors.danger }}>
                  Missing athlete id in roster
                </Text>
              ) : null}
            </View>

            {showSelectCol ? (
              <View
                style={{
                  width: selectColWidth,
                  minWidth: selectColWidth,
                  maxWidth: selectColWidth,
                  borderLeftWidth: 1,
                  borderLeftColor: colors.border,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: rowSelected ? "#e6efff" : rowIndex % 2 === 0 ? colors.card : colors.bg,
                  ...(stickySelectStyle ?? {}),
                  overflow: "hidden",
                  zIndex: 45,
                }}
              >
                {Platform.OS === "web" ? (
                  <div
                    onMouseDown={(e: any) => {
                      e.preventDefault?.();
                      setActiveGridId(MILEAGE_GRID_ID);
                      mileageGrid.selectRow(a.id, !!e?.shiftKey);
                    }}
                    style={{
                      width: "100%",
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                    }}
                  >
                    <MiniCheck
                      checked={pasteTargets.has(a.id)}
                      hitSlopSize={0}
                      onPress={() => {
                        setActiveGridId(MILEAGE_GRID_ID);
                        togglePasteTarget(a.id);
                      }}
                    />
                  </div>
                ) : (
                  <MiniCheck
                    checked={pasteTargets.has(a.id)}
                    hitSlopSize={0}
                    onPress={() => {
                      mileageGrid.selectRow(a.id, false);
                      setActiveGridId(MILEAGE_GRID_ID);
                      togglePasteTarget(a.id);
                    }}
                  />
                )}
              </View>
            ) : null}

            {Array.from({ length: 7 }, (_, dayIdx) => {
              const amKey = cellCloudKey(a.id, weekStartISO, dayIdx, "am");
              const pmKey = cellCloudKey(a.id, weekStartISO, dayIdx, "pm");
              const amDraft = String(mileageDraftsByKey[amKey] ?? "");
              const pmDraft = String(mileageDraftsByKey[pmKey] ?? "");
              const ncaaOff = !!ncaaOffByKey[offKey(a.id, weekStartISO, dayIdx)];
              const amCol = mileageColKey(dayIdx, "am");
              const pmCol = mileageColKey(dayIdx, "pm");
              const amSelected = mileageGrid.isCellSelected(a.id, amCol);
              const amActive = mileageGrid.isCellActive(a.id, amCol);
              const pmSelected = mileageGrid.isCellSelected(a.id, pmCol);
              const pmActive = mileageGrid.isCellActive(a.id, pmCol);

              return (
                <View
                  key={`c-${rowIndex}-${dayIdx}`}
                  style={{
                    width: dayGroupWidth,
                    borderLeftWidth: borderThin,
                    borderLeftColor: colors.border,
                    padding: cellPad,
                    position: "relative",
                    zIndex: 1,
                  }}
                >
                  {denseGrid ? (
                    <>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: subCellGap }}>
                        <View
                          style={{
                            width: subColWidth,
                            borderWidth: borderThin,
                            borderColor: invalidCells[cellKey(a.id, dayIdx, "am")] ? colors.danger : colors.border,
                            borderRadius: radiusCell,
                            backgroundColor: canEdit ? colors.card : colors.bg,
                            overflow: "hidden",
                            ...(amSelected ? ({ outline: "1px solid rgba(15,23,42,0.55)", outlineOffset: -1 } as any) : null),
                            ...(amActive ? ({ outline: "2px solid #111827", outlineOffset: -2 } as any) : null),
                          }}
                        >
                          <GridCell
                            key={`${weekStartISO}-${a.id}-${dayIdx}-am`}
                            binding={bindMileageCell(a.id, amCol)}
                            editable={canEdit}
                            value={amDraft}
                            onChangeText={(v) => mileageGrid.applyCellValue(a.id, amCol, v)}
                            placeholder="AM"
                            gridEditing={mileageGrid.isEditingCell(a.id, amCol)}
                            editIntent={
                              mileageGrid.editIntentRef.current?.rowId === a.id &&
                              mileageGrid.editIntentRef.current?.colKey === amCol
                                ? mileageGrid.editIntentRef.current
                                : null
                            }
                            consumeEditIntent={() => mileageGrid.consumeEditIntent(a.id, amCol)}
                            onEnterEditMode={() => mileageGrid.beginEdit(a.id, amCol, "preserve")}
                            style={{
                              width: subColWidth,
                              borderWidth: 0,
                              borderRadius: radiusCell,
                              paddingHorizontal: inputPadH,
                              paddingVertical: inputPadV,
                              fontWeight: "800",
                              fontSize: fontCell,
                              color: colors.text,
                              backgroundColor: "transparent",
                            }}
                          />
                        </View>

                        <View
                          style={{
                            width: subColWidth,
                            borderWidth: borderThin,
                            borderColor: invalidCells[cellKey(a.id, dayIdx, "pm")] ? colors.danger : colors.border,
                            borderRadius: radiusCell,
                            backgroundColor: canEdit ? colors.card : colors.bg,
                            overflow: "hidden",
                            ...(pmSelected ? ({ outline: "1px solid rgba(15,23,42,0.55)", outlineOffset: -1 } as any) : null),
                            ...(pmActive ? ({ outline: "2px solid #111827", outlineOffset: -2 } as any) : null),
                          }}
                        >
                          <GridCell
                            key={`${weekStartISO}-${a.id}-${dayIdx}-pm`}
                            binding={bindMileageCell(a.id, pmCol)}
                            editable={canEdit}
                            value={pmDraft}
                            onChangeText={(v) => mileageGrid.applyCellValue(a.id, pmCol, v)}
                            placeholder="PM"
                            gridEditing={mileageGrid.isEditingCell(a.id, pmCol)}
                            editIntent={
                              mileageGrid.editIntentRef.current?.rowId === a.id &&
                              mileageGrid.editIntentRef.current?.colKey === pmCol
                                ? mileageGrid.editIntentRef.current
                                : null
                            }
                            consumeEditIntent={() => mileageGrid.consumeEditIntent(a.id, pmCol)}
                            onEnterEditMode={() => mileageGrid.beginEdit(a.id, pmCol, "preserve")}
                            style={{
                              width: subColWidth,
                              borderWidth: 0,
                              borderRadius: radiusCell,
                              paddingHorizontal: inputPadH,
                              paddingVertical: inputPadV,
                              fontWeight: "800",
                              fontSize: fontCell,
                              color: colors.text,
                              backgroundColor: "transparent",
                            }}
                          />
                        </View>
                      </View>

                      {Platform.OS === "web" ? (
                        <button
                          type="button"
                          disabled={!canEdit}
                          onClick={(e: any) => {
                            e.stopPropagation();
                            if (!canEdit) return;
                            setNCAAOffDayCloud(a.id, dayIdx, !ncaaOff);
                          }}
                          onPointerDown={(e: any) => {
                            e.stopPropagation();
                          }}
                          style={{
                            marginTop: 6,
                            display: "flex",
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 6,
                            opacity: canEdit ? 1 : 0.55,
                            cursor: canEdit ? "pointer" : "default",
                            userSelect: "none",
                            padding: 0,
                            border: "none",
                            background: "transparent",
                          }}
                        >
                          <div
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: 3,
                              border: `1px solid ${ncaaOff ? colors.tint : colors.border}`,
                              backgroundColor: ncaaOff ? colors.tint : colors.card,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            {ncaaOff ? (
                              <Text style={{ color: colors.card, fontSize: 10, fontWeight: "900", lineHeight: 11 }}>✓</Text>
                            ) : null}
                          </div>
                          <Text style={{ fontSize: 10, fontWeight: "800", color: colors.mutedText }}>Off</Text>
                        </button>
                      ) : (
                        <Pressable
                          disabled={!canEdit}
                          onPress={() => {
                            if (!canEdit) return;
                            setNCAAOffDayCloud(a.id, dayIdx, !ncaaOff);
                          }}
                          style={{
                            marginTop: 6,
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 6,
                            opacity: canEdit ? 1 : 0.55,
                          }}
                        >
                          <View
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: 3,
                              borderWidth: 1,
                              borderColor: ncaaOff ? colors.tint : colors.border,
                              backgroundColor: ncaaOff ? colors.tint : colors.card,
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            {ncaaOff ? (
                              <Text style={{ color: colors.card, fontSize: 10, fontWeight: "900", lineHeight: 11 }}>✓</Text>
                            ) : null}
                          </View>
                          <Text style={{ fontSize: 10, fontWeight: "800", color: colors.mutedText }}>Off</Text>
                        </Pressable>
                      )}
                    </>
                  ) : null}
                </View>
              );
            })}
          </View>
        );
      })}
    </>
  );

  const spreadsheetContent = (
    <View
      style={{
        minWidth: gridMinWidth,
        ...(isWeb && isDesktop ? ({ width: "max-content", overflow: "visible" } as any) : ({ width: "100%" } as any)),
      }}
    >
      <View
        style={{
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 14,
          overflow: isWeb && isDesktop ? ("visible" as any) : "hidden",
          backgroundColor: colors.bg,
        }}
      >
        {renderMileageHeader()}
        {renderMileageBody()}
      </View>

      <Text style={{ marginTop: 12, fontSize: 12, color: colors.mutedText, fontWeight: "700" }}>
        Input format: “6”, “2-3”, “30:00XT”, or choice like “3 or 30:00XT”. Invalid cells highlight red and are excluded from totals until fixed.
      </Text>
    </View>
  );

  return (
    <Screen padded={false} style={{ flex: 1 }}>
      <View style={{ padding: theme.space.sm, gap: theme.space.sm, flex: 1 }}>
        <Card style={{ gap: 8, paddingVertical: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Button
              title="Prev"
              variant="secondary"
              onPress={() => setWeekAnchorISO(addDaysISO(weekAnchorISO, -7))}
            />

            <View style={{ alignItems: "center", flex: 1, gap: 2 }}>
              <AppText variant="sub">{weekRangeLabel}</AppText>
              <AppText variant="caption" color="mutedText">Week range</AppText>
            </View>

            <Button
              title="Next"
              variant="secondary"
              onPress={() => setWeekAnchorISO(addDaysISO(weekAnchorISO, 7))}
            />
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <Button title="Copy Previous Week" variant="secondary" onPress={copyPreviousWeekAll} />
              <Button title="Clear Entire Week" variant="secondary" onPress={clearEntireWeekAll} />
              <Button
                title={exportingPdf ? "Exporting..." : "Export PDF"}
                variant="secondary"
                onPress={() => void handleExportMileagePdf()}
                disabled={exportingPdf}
              />
            </View>

            <View
              style={{
                flexDirection: "row",
                gap: 4,
                flexWrap: "wrap",
                alignItems: "center",
                ...(isDesktop
                  ? ({ marginLeft: "auto", justifyContent: "flex-end" } as any)
                  : ({ width: "100%", justifyContent: "flex-start" } as any)),
              }}
            >
              <MiniPill
                compact
                label={`Paste to selected (${pasteTargets.size})`}
                onPress={pasteToSelected}
                disabled={!copiedRow || pasteTargets.size === 0}
              />
              <MiniPill
                compact
                label="Unselect All"
                onPress={clearPasteTargets}
                disabled={pasteTargets.size === 0}
              />
              <MiniPill
                compact
                label="Clear Row"
                onPress={clearSelectedRows}
                disabled={pasteTargets.size === 0}
                danger
              />
              <MiniPill
                compact
                label="Copy"
                onPress={() => {
                  setActiveGridId(MILEAGE_GRID_ID);
                  void mileageGrid.copySelectionToClipboard();
                }}
                disabled={!mileageHasSelection}
              />
              <MiniPill
                compact
                label="Paste"
                onPress={() => {
                  setActiveGridId(MILEAGE_GRID_ID);
                  void mileageGrid.pasteFromClipboard();
                }}
                disabled={!mileageHasSelection}
              />
              <MiniPill
                compact
                label="Undo"
                onPress={() => {
                  setActiveGridId(MILEAGE_GRID_ID);
                  mileageGrid.undo();
                }}
              />
              <MiniPill
                compact
                label="Fill Selected"
                onPress={() => {
                  setActiveGridId(MILEAGE_GRID_ID);
                  fillSelectedMileage();
                }}
                disabled={!mileageHasSelection || mileageSelectedRowsCount < 2}
              />
              <MiniPill
                compact
                label="Fill All"
                onPress={() => {
                  setActiveGridId(MILEAGE_GRID_ID);
                  fillAllMileage();
                }}
                disabled={editableAthleteIds.length < 2}
              />
              <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedText }}>
                Grid: {mileageSelectedRowsCount} row{mileageSelectedRowsCount === 1 ? "" : "s"} selected
              </Text>
            </View>
          </View>
        </Card>

        <Card style={{ padding: 0, overflow: isWeb && isDesktop ? ("visible" as any) : "hidden", flex: 1 }}>
          <View style={{ flex: 1, minHeight: 0 }}>
            {/* Outer page scroll container: the page itself stays static; sheet scroll lives below. */}
            {isWeb && isDesktop ? (
              <div
                ref={mileageSheetRootRef as any}
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                  position: "relative",
                  isolation: "isolate",
                }}
              >
                <View
                  style={{
                    display: "flex",
                    flexDirection: "row",
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderBottomWidth: 0,
                    borderTopLeftRadius: 14,
                    borderTopRightRadius: 14,
                    overflow: "hidden",
                    backgroundColor: colors.bg,
                  }}
                >
                  <View style={{ width: pinnedHeaderWidth }}>{renderHeaderLeft()}</View>
                  <div
                    ref={webHeaderDaysScrollRef as any}
                    style={{
                      flex: 1,
                      overflowX: "hidden",
                      overflowY: "hidden",
                    }}
                  >
                    <View style={{ width: dayColumnsWidth, minWidth: dayColumnsWidth }}>
                      {renderHeaderRight()}
                    </View>
                  </div>
                </View>

                <div
                  ref={webBodyScrollRef as any}
                  onScroll={handleWebBodyScroll}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowX: "auto",
                    overflowY: "auto",
                    position: "relative",
                    isolation: "isolate",
                    borderBottomLeftRadius: 14,
                    borderBottomRightRadius: 14,
                  }}
                >
                  <View style={{ minWidth: gridMinWidth, width: "max-content" as any }}>
                    <View
                      style={{
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderTopWidth: 0,
                        borderBottomLeftRadius: 14,
                        borderBottomRightRadius: 14,
                        overflow: "visible",
                        backgroundColor: colors.bg,
                      }}
                    >
                      {renderMileageBody()}
                    </View>

                    <Text style={{ marginTop: 12, fontSize: 12, color: colors.mutedText, fontWeight: "700" }}>
                      Input format: “6”, “2-3”, “30:00XT”, or choice like “3 or 30:00XT”. Invalid cells highlight red and are excluded from totals until fixed.
                    </Text>
                  </View>
                </div>
              </div>
            ) : (
              <ScrollView
                ref={mileageSheetRootRef}
                automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
                keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: 20 }}
              >
                <GridTable minWidth={gridMinWidth}>{spreadsheetContent}</GridTable>
              </ScrollView>
            )}
          </View>
        </Card>

        {actionBannerText ? (
          <View
            style={{
              position: "absolute",
              left: theme.space.lg,
              right: theme.space.lg,
              bottom: theme.space.lg,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: colors.success,
              backgroundColor: colors.success,
              alignItems: "center",
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: colors.card, fontWeight: "900" }}>{actionBannerText}</Text>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
