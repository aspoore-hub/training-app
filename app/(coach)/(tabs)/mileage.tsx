import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
import { isActiveTrainingGroupMembership, isAthleteExcludedFromSeason, teamDataStore } from "../../../lib/teamDataStore";
import type { WeekStartDay } from "../../../lib/types";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../../lib/pace";
import type { DistanceUnit } from "../../../lib/units";
import { loadAthletePaceOverrides, resolveAthletePaceSeconds, type AthletePaceOverrides } from "../../../lib/athletePace";
import { useResponsive } from "../../../lib/useResponsive";
import { loadAthleteDailyLogEntries, type AthleteDailyLogEntry } from "../../../lib/athleteDailyLogEntries";
import { parseNumericLike } from "../../../lib/feedbackParsing";
import { loadMileageFeedback, type MileageSessionFeedback } from "../../../lib/mileageFeedback";
import { loadCoachWeekLabels, loadCoreCoachSettings, loadWeekStartSetting, saveCoachWeekLabel, saveCoachWeekLabelType, type CoachWeekLabels } from "../../../lib/settings";
import { loadJSON, saveJSON } from "../../../lib/storage";
import { getWeekLabelTone, getWeekLabelToneColors, getWeekLabelToneText, type WeekLabelType } from "../../../lib/weekLabelStyle";
import {
  doesAthleteOverlapDateRange,
  isAthleteEligibleDuringWeek,
  normalizeTeamRosterAthlete,
  resolveAthleteSeasonWindowWithTenure,
  sortRosterByName,
} from "../../../lib/teamRoster";
import {
  formatCoachMileageTotalForDisplay,
  hasCoachMileageTotal,
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
import {
  fetchMileageWeekVisibilityForWeek,
  setMileageVisibilityByDateRange,
  setMileageVisibilityByWeeks,
  type MileageWeekVisibilityRow,
} from "../../../lib/mileageCloud";
import { listTeamWorkoutsInRange, setWorkoutVisibilityByDateRange, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";
import { canEditMileage, canExport, canPublishTraining, getCurrentTeamRole, type TeamRole } from "../../../lib/teamPermissions";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MILEAGE_GRID_ID = "mileage-grid";
const MILEAGE_VIEW_PREFS_KEY = "training_app_coach_mileage_view_prefs_v1";
const MILEAGE_WEEK_CACHE_PREFIX = "coach_mileage_week_cache_v1";
const COACH_MILEAGE_PLAN_EXPORT_RANGE_KEY = "coach_mileage_plan_export_range_v1";
const COACH_MILEAGE_ATHLETE_VIEW_WEEK_RANGE_KEY = "coach_mileage_athlete_view_week_range_v1";
const COACH_MILEAGE_ATHLETE_VIEW_DATE_RANGE_KEY = "coach_mileage_athlete_view_range_v2";
const COACH_MILEAGE_ATHLETE_VIEW_DATE_RANGE_LEGACY_KEY = "coach_mileage_athlete_view_date_range_v1";
const MAX_MILEAGE_PLAN_EXPORT_RANGE_DAYS = 365;
const MAX_MILEAGE_RANGE_WEEKS = 156;

function isTextEditingTarget(target: unknown): boolean {
  if (Platform.OS !== "web") return false;
  const node = target as any;
  if (!node) return false;
  const tag = String(node.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || !!node.isContentEditable;
}

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
type TrainingVisibilityAction = "publish" | "hide";
type TrainingVisibilityContent = "workouts" | "mileage" | "both";
type TrainingVisibilityRange = "week" | "custom" | "season";
type WeekClipboard = {
  sourceWeekStartISO: string;
  copiedAtMs: number;
  cells: Array<{ athleteId: string; dayIdx: number; session: "AM" | "PM"; value: MileageValue | null }>;
  flags: Array<{ athleteId: string; dayIdx: number; ncaaOff: boolean }>;
};
type MileageViewMode = "teamWeek" | "athleteMultiWeek" | "seasonMileage";
type SeasonMileageMetric = "completed" | "planned";
type SeasonMileageSort =
  | { column: "athlete"; direction: "asc" | "desc" }
  | { column: "week"; weekISO: string; direction: "asc" | "desc" };
type AthleteRangeMode = "season" | "custom";
type TrainingGroupFilterOption = {
  id: string;
  label: string;
  archived: boolean;
};
type SeasonFilterOption = {
  id: string;
  label: string;
  archived: boolean;
};

function escapePdfHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

function rowBelongsToMileageWeek(row: any, weekStartISO: string): boolean {
  const rowWeek = String(row?.week_start_iso ?? "").trim();
  return !rowWeek || rowWeek === weekStartISO;
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
  return formatCoachMileageTotalForDisplay(r, unit, "");
}

function addDaysISO(iso: string, days: number) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function seasonIntersectsWeek(
  weekStartISO: string,
  season: { start_date?: string | null; end_date?: string | null } | null
): boolean {
  if (!season) return true;
  const start = String(season.start_date ?? "").trim();
  const end = String(season.end_date ?? "").trim();
  if (!isValidISODate(start) || !isValidISODate(end)) return true;
  const weekEndISO = addDaysISO(weekStartISO, 6);
  return weekEndISO >= start && weekStartISO <= end;
}

function isValidISODate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isoDayNumber(iso: string): number {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  return Math.floor(Date.UTC(y, (m ?? 1) - 1, d ?? 1) / 86400000);
}

function formatAthleteWeekRangeLabel(weekStartISO: string): string {
  const endISO = addDaysISO(weekStartISO, 6);
  const start = parseISODate(weekStartISO);
  const end = parseISODate(endISO);
  const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${startLabel} - ${endLabel}`;
}

function formatSeasonWeekHeaderLabel(weekStartISO: string): string {
  const endISO = addDaysISO(weekStartISO, 6);
  const start = parseISODate(weekStartISO);
  const end = parseISODate(endISO);
  const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const endLabel = end.toLocaleDateString(undefined, { day: "numeric" });
  const endMonthLabel = end.toLocaleDateString(undefined, { month: "short" });
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${startLabel}-${endLabel}`;
  }
  return `${startLabel}-${endMonthLabel} ${endLabel}`;
}

function normalizeSeasonMileageRange(value: Range | number | null | undefined): Range {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { min: value, max: value } : { min: 0, max: 0 };
  }
  if (!value) return { min: 0, max: 0 };
  const min = Number(value.min);
  const max = Number(value.max);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return { min: 0, max: 0 };
  return {
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : Number.isFinite(min) ? min : 0,
  };
}

function hasSeasonMileageValue(value: Range | number | null | undefined): boolean {
  return hasCoachMileageTotal(normalizeSeasonMileageRange(value));
}

function formatSeasonMileageValue(value: Range | number, unit: DistanceUnit): string {
  return formatCoachMileageTotalForDisplay(normalizeSeasonMileageRange(value), unit, "");
}

function getSeasonMileageSortMax(value: Range | number | null | undefined): number | null {
  const range = normalizeSeasonMileageRange(value);
  if (!hasSeasonMileageValue(range)) return null;
  return Math.max(range.min, range.max);
}

function getSeasonMileageSortIndicator(
  sort: SeasonMileageSort,
  column: "athlete" | "week",
  weekISO?: string
): string {
  const active =
    sort.column === column &&
    (column === "athlete" || (sort.column === "week" && sort.weekISO === weekISO));
  if (!active) return "";
  return sort.direction === "asc" ? " ↑" : " ↓";
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
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => {
        const neutralBorder = "rgba(15,23,42,0.18)";
        const accentBorder = "rgba(37,99,235,0.42)";
        const dangerBorder = "rgba(220,38,38,0.46)";
        return {
          paddingHorizontal: compact ? 9 : 12,
          paddingVertical: compact ? 5 : 6,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: danger ? dangerBorder : pressed ? accentBorder : neutralBorder,
          backgroundColor: disabled
            ? colors.bg
            : danger
              ? pressed
                ? "rgba(220,38,38,0.12)"
                : "rgba(220,38,38,0.08)"
              : pressed
                ? "rgba(37,99,235,0.14)"
                : colors.card,
          opacity: disabled ? 0.52 : 1,
          ...(Platform.OS === "web" ? ({ cursor: disabled ? "default" : "pointer" } as any) : null),
        };
      }}
    >
      <Text style={{ fontSize: compact ? 10 : 11, fontWeight: "900", color: danger ? "#991b1b" : colors.text }}>{label}</Text>
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
  weekAnnotation?: string;
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
    ${String(args.weekAnnotation ?? "").trim() ? `<p class="sub">${escapeMileagePdfHtml(String(args.weekAnnotation ?? "").trim())}</p>` : ""}
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

function buildMileagePlanRangeHtml(args: {
  athleteName: string;
  rangeLabel: string;
  generatedAtLabel: string;
  dayHeaders: string[];
  weeks: Array<{
    weekLabel: string;
    totalMileage: string;
    totalXT: string;
    cells: Array<{ am: string; pm: string; inRange: boolean }>;
  }>;
}) {
  const header = args.dayHeaders
    .map((day) => `<th colspan="2">${escapePdfHtml(day)}</th>`)
    .join("");
  const sub = args.dayHeaders.map(() => "<th>AM</th><th>PM</th>").join("");
  const rows = args.weeks
    .map((week) => {
      const cellHtml = week.cells
        .map((cell) => {
          const muted = cell.inRange ? "" : ' class="muted"';
          return `<td${muted}>${escapePdfHtml(cell.am || "")}</td><td${muted}>${escapePdfHtml(cell.pm || "")}</td>`;
        })
        .join("");
      return `<tr><td>${escapePdfHtml(week.weekLabel)}</td><td>${escapePdfHtml(week.totalMileage)}</td><td>${escapePdfHtml(week.totalXT)}</td>${cellHtml}</tr>`;
    })
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Mileage Plan</title>
<style>
@page { size: Letter landscape; margin: 0.22in; }
body { margin:0; font-family: Arial, Helvetica, sans-serif; color:#111827; }
h1 { margin:0 0 4px 0; font-size:14px; }
p { margin:0 0 6px 0; font-size:8px; font-weight:700; color:#374151; }
table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:7px; }
th, td { border:1px solid #d1d5db; padding:3px; vertical-align:top; word-break:break-word; }
th { background:#f8fafc; font-weight:800; }
.muted { background:#f9fafb; color:#9ca3af; }
</style></head>
<body>
  <h1>Mileage Plan • ${escapePdfHtml(args.athleteName)}</h1>
  <p>${escapePdfHtml(args.rangeLabel)} • Generated ${escapePdfHtml(args.generatedAtLabel)}</p>
  <table>
    <thead>
      <tr><th rowspan="2">Week</th><th rowspan="2">Total</th><th rowspan="2">XT</th>${header}</tr>
      <tr>${sub}</tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body></html>`.trim();
}

export default function CoachMileageTab() {
  const { isDesktop, isWeb } = useResponsive();
  const { theme, colors, scheme } = useAppTheme();
  const s = teamDataStore.use();
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [weekAnchorISO, setWeekAnchorISO] = useState(() => toISODate(new Date()));
  const [viewMode, setViewMode] = useState<MileageViewMode>("teamWeek");
  const [mileageRangeStartISO, setMileageRangeStartISO] = useState(() => getWeekStartISO(toISODate(new Date()), 1));
  const [mileageRangeEndISO, setMileageRangeEndISO] = useState(() => addDaysISO(getWeekStartISO(toISODate(new Date()), 1), 41));
  const [mileageRangeInitialized, setMileageRangeInitialized] = useState(false);
  const [athleteMultiFirstWeekStartISO, setAthleteMultiFirstWeekStartISO] = useState(() => getWeekStartISO(toISODate(new Date()), 1));
  const [athleteMultiNumberOfWeeks, setAthleteMultiNumberOfWeeks] = useState(6);
  const [athleteMultiRangeStartISO, setAthleteMultiRangeStartISO] = useState(() => getWeekStartISO(toISODate(new Date()), 1));
  const [athleteMultiRangeEndISO, setAthleteMultiRangeEndISO] = useState(() => addDaysISO(getWeekStartISO(toISODate(new Date()), 1), 41));
  const [athleteMultiRangeMode, setAthleteMultiRangeMode] = useState<AthleteRangeMode>("season");
  const [athleteMultiSelectedId, setAthleteMultiSelectedId] = useState("");
  const [athleteMultiRangeError, setAthleteMultiRangeError] = useState<string | null>(null);
  const [athleteMultiExcludedSeasonMessage, setAthleteMultiExcludedSeasonMessage] = useState<string | null>(null);
  const [athleteRangeEditorOpen, setAthleteRangeEditorOpen] = useState(false);
  const [athleteRangeDraftFirstWeekISO, setAthleteRangeDraftFirstWeekISO] = useState("");
  const [athleteRangeDraftWeekCount, setAthleteRangeDraftWeekCount] = useState("6");
  const [athleteRangeDraftError, setAthleteRangeDraftError] = useState<string | null>(null);
  const [athleteMultiWeeksLoading, setAthleteMultiWeeksLoading] = useState(false);
  const [athleteSearchQuery, setAthleteSearchQuery] = useState("");
  const [athletePickerOpen, setAthletePickerOpen] = useState(false);
  const selectedTrainingGroupIds = s.sharedSelectedTrainingGroupIds;
  const [trainingGroupFilterOpen, setTrainingGroupFilterOpen] = useState(false);
  const selectedSeasonId = s.sharedSelectedSeasonId;
  const [seasonFilterOpen, setSeasonFilterOpen] = useState(false);
  const [weekAnchorReady, setWeekAnchorReady] = useState(false);
  const [paceSecPerMile, setPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [athletePaceOverrides, setAthletePaceOverrides] = useState<AthletePaceOverrides>({});
  const [invalidCells, setInvalidCells] = useState<Record<string, boolean>>({});
  const [actionBannerText, setActionBannerText] = useState("");
  const [jumpToWeekOpen, setJumpToWeekOpen] = useState(false);
  const [jumpDateInput, setJumpDateInput] = useState(() => toISODate(new Date()));
  const [weekClipboard, setWeekClipboard] = useState<WeekClipboard | null>(null);
  const [weekLabelsByStart, setWeekLabelsByStart] = useState<CoachWeekLabels>({});
  const [weekLabelDraft, setWeekLabelDraft] = useState("");
  const [isWeekLabelEditing, setIsWeekLabelEditing] = useState(false);
  const [weekLabelSaveState, setWeekLabelSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Standalone export state only; live mileage sheet rendering and grid behavior are untouched.
  const [exportingPdf, setExportingPdf] = useState(false);
  const [mileagePlanExportOpen, setMileagePlanExportOpen] = useState(false);
  const [exportingMileagePlanPdf, setExportingMileagePlanPdf] = useState(false);
  const [mileagePlanExportError, setMileagePlanExportError] = useState<string | null>(null);
  const [mileagePlanExportStartISO, setMileagePlanExportStartISO] = useState(() => toISODate(new Date()));
  const [mileagePlanExportEndISO, setMileagePlanExportEndISO] = useState(() => addDaysISO(toISODate(new Date()), 27));
  const [mileagePlanExportSeasonId, setMileagePlanExportSeasonId] = useState<string | null>(null);
  const [cachedWeekSnapshot, setCachedWeekSnapshot] = useState<{
    weekStartISO: string;
    cells: any[];
    flags: any[];
  } | null>(null);
  const [weekVisibilityRows, setWeekVisibilityRows] = useState<MileageWeekVisibilityRow[]>([]);
  const [weekVisibilityBusy, setWeekVisibilityBusy] = useState(false);
  const [currentTeamRole, setCurrentTeamRole] = useState<TeamRole | null>(null);
  const [seasonMileageMetric, setSeasonMileageMetric] = useState<SeasonMileageMetric>("completed");
  const [seasonMileageLoading, setSeasonMileageLoading] = useState(false);
  const [seasonMileageError, setSeasonMileageError] = useState<string | null>(null);
  const [seasonMileagePlannedLoading, setSeasonMileagePlannedLoading] = useState(false);
  const [seasonMileagePlannedError, setSeasonMileagePlannedError] = useState<string | null>(null);
  const [seasonMileageWorkoutRows, setSeasonMileageWorkoutRows] = useState<TeamWorkoutRow[]>([]);
  const [seasonMileageFeedbackEntries, setSeasonMileageFeedbackEntries] = useState<MileageSessionFeedback[]>([]);
  const [seasonMileageDailyLogEntries, setSeasonMileageDailyLogEntries] = useState<AthleteDailyLogEntry[]>([]);
  const [seasonMileageSort, setSeasonMileageSort] = useState<SeasonMileageSort>({ column: "athlete", direction: "asc" });
  const [trainingVisibilityOpen, setTrainingVisibilityOpen] = useState(false);
  const [trainingVisibilityAction, setTrainingVisibilityAction] = useState<TrainingVisibilityAction>("publish");
  const [trainingVisibilityContent, setTrainingVisibilityContent] = useState<TrainingVisibilityContent>("mileage");
  const [trainingVisibilityRange, setTrainingVisibilityRange] = useState<TrainingVisibilityRange>("week");
  const [trainingVisibilityStartISO, setTrainingVisibilityStartISO] = useState(() => getWeekStartISO(toISODate(new Date()), 1));
  const [trainingVisibilityEndISO, setTrainingVisibilityEndISO] = useState(() => addDaysISO(getWeekStartISO(toISODate(new Date()), 1), 6));
  const [trainingVisibilityApplying, setTrainingVisibilityApplying] = useState(false);
  const [trainingVisibilityError, setTrainingVisibilityError] = useState<string | null>(null);
  const [activeGridId, setActiveGridId] = useState<string | null>(null);
  const [mileageDraftsByKey, setMileageDraftsByKey] = useState<Record<string, string>>({});
  const actionBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mileageSheetRootRef = useRef<any>(null);
  const mileageDraftsRef = useRef<Record<string, string>>({});
  const mileageSaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingDraftSaveKeysRef = useRef<Set<string>>(new Set());
  const mileageDraftGenerationRef = useRef<Record<string, number>>({});
  const weekLabelSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const weekLabelEditingWeekRef = useRef<string | null>(null);
  const weekLabelSaveSeqRef = useRef(0);
  const lastMileageMetaRefreshAtRef = useRef(0);
  const draftKeyMetaRef = useRef<
    Record<string, { athleteId: string; weekStartISO: string; dayIdx: number; field: CellField; uiKey: string }>
  >({});
  const editingCloudKeyRef = useRef<string | null>(null);
  const restoredWeekAnchorRef = useRef(false);
  const athleteMultiWeeksLoadSeqRef = useRef(0);
  const seasonMileageWeeksLoadSeqRef = useRef(0);
  const readOnlyMileage = !canEditMileage(currentTeamRole);
  const canPublishMileageTraining = canPublishTraining(currentTeamRole);
  const canExportMileage = canExport(currentTeamRole);

  useEffect(() => {
    let active = true;
    getCurrentTeamRole()
      .then((role) => {
        if (active) setCurrentTeamRole(role);
      })
      .catch((error) => {
        console.warn("[coach-mileage] role load failed", error);
        if (active) setCurrentTeamRole(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const prefs = await loadJSON<{
        weekAnchorISO?: string;
        mode?: MileageViewMode;
        athleteMultiSelectedId?: string;
        mileageRangeStartISO?: string;
        mileageRangeEndISO?: string;
      }>(MILEAGE_VIEW_PREFS_KEY, {});
      if (!active) return;
      if (isValidISODate(prefs?.weekAnchorISO)) {
        setWeekAnchorISO(prefs.weekAnchorISO);
      }
      if (
        isValidISODate(prefs?.mileageRangeStartISO) &&
        isValidISODate(prefs?.mileageRangeEndISO) &&
        prefs.mileageRangeEndISO >= prefs.mileageRangeStartISO
      ) {
        setMileageRangeStartISO(prefs.mileageRangeStartISO);
        setMileageRangeEndISO(prefs.mileageRangeEndISO);
        setMileageRangeInitialized(true);
      }
      if (prefs?.mode === "teamWeek" || prefs?.mode === "athleteMultiWeek" || prefs?.mode === "seasonMileage") {
        setViewMode(prefs.mode);
      }
      if (typeof prefs?.athleteMultiSelectedId === "string") {
        setAthleteMultiSelectedId(prefs.athleteMultiSelectedId);
      }
      try {
        const rawWeekRange = await AsyncStorage.getItem(COACH_MILEAGE_ATHLETE_VIEW_WEEK_RANGE_KEY);
        const parsedWeekRange = rawWeekRange
          ? (JSON.parse(rawWeekRange) as {
              selectedSeasonId?: string | null;
              rangeMode?: AthleteRangeMode;
              firstWeekStartISO?: string;
              numberOfWeeks?: number;
            })
          : null;
        if (parsedWeekRange) {
          const mode = parsedWeekRange?.rangeMode === "custom" ? "custom" : "season";
          const firstWeekStartISO = String(parsedWeekRange?.firstWeekStartISO ?? "").trim();
          const numberOfWeeksRaw = Number(parsedWeekRange?.numberOfWeeks ?? 6);
          const numberOfWeeks = Number.isInteger(numberOfWeeksRaw)
            ? Math.min(MAX_MILEAGE_RANGE_WEEKS, Math.max(1, numberOfWeeksRaw))
            : 6;
          if (isValidISODate(firstWeekStartISO)) {
            setAthleteMultiFirstWeekStartISO(firstWeekStartISO);
            setAthleteMultiNumberOfWeeks(numberOfWeeks);
            setAthleteMultiRangeMode(mode);
          }
        } else {
          const rawRange = await AsyncStorage.getItem(COACH_MILEAGE_ATHLETE_VIEW_DATE_RANGE_KEY);
          const parsedRange = rawRange
            ? (JSON.parse(rawRange) as { rangeMode?: AthleteRangeMode; startDateISO?: string; endDateISO?: string })
            : null;
          const fallbackRaw =
            parsedRange == null ? await AsyncStorage.getItem(COACH_MILEAGE_ATHLETE_VIEW_DATE_RANGE_LEGACY_KEY) : null;
          const fallbackParsed = fallbackRaw
            ? (JSON.parse(fallbackRaw) as { startDateISO?: string; endDateISO?: string })
            : null;
          const savedStart = String(parsedRange?.startDateISO ?? fallbackParsed?.startDateISO ?? "").trim();
          const savedEnd = String(parsedRange?.endDateISO ?? fallbackParsed?.endDateISO ?? "").trim();
          if (isValidISODate(savedStart) && isValidISODate(savedEnd) && savedEnd >= savedStart) {
            const firstWeekStart = getWeekStartISO(savedStart, 1);
            const lastWeekStart = getWeekStartISO(savedEnd, 1);
            const numberOfWeeks = Math.min(
              MAX_MILEAGE_RANGE_WEEKS,
              Math.max(1, Math.floor((isoDayNumber(lastWeekStart) - isoDayNumber(firstWeekStart)) / 7) + 1)
            );
            setAthleteMultiFirstWeekStartISO(firstWeekStart);
            setAthleteMultiNumberOfWeeks(numberOfWeeks);
            setAthleteMultiRangeMode(parsedRange?.rangeMode === "season" ? "season" : "custom");
          }
        }
      } catch {}
      restoredWeekAnchorRef.current = true;
      setWeekAnchorReady(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!weekAnchorReady || !restoredWeekAnchorRef.current) return;
    void saveJSON(MILEAGE_VIEW_PREFS_KEY, {
      weekAnchorISO,
      mode: viewMode,
      athleteMultiSelectedId,
      mileageRangeStartISO,
      mileageRangeEndISO,
    });
  }, [
    weekAnchorISO,
    weekAnchorReady,
    viewMode,
    athleteMultiSelectedId,
    mileageRangeStartISO,
    mileageRangeEndISO,
  ]);

  useEffect(() => {
    if (!weekAnchorReady || !restoredWeekAnchorRef.current) return;
    if (!isValidISODate(athleteMultiFirstWeekStartISO)) return;
    if (!Number.isInteger(athleteMultiNumberOfWeeks) || athleteMultiNumberOfWeeks < 1) return;
    const safeWeeks = Math.min(MAX_MILEAGE_RANGE_WEEKS, Math.max(1, athleteMultiNumberOfWeeks));
    void AsyncStorage.setItem(
      COACH_MILEAGE_ATHLETE_VIEW_WEEK_RANGE_KEY,
      JSON.stringify({
        selectedSeasonId: selectedSeasonId ?? null,
        rangeMode: athleteMultiRangeMode,
        firstWeekStartISO: athleteMultiFirstWeekStartISO,
        numberOfWeeks: safeWeeks,
      })
    ).catch(() => {});
  }, [
    athleteMultiFirstWeekStartISO,
    athleteMultiNumberOfWeeks,
    athleteMultiRangeMode,
    selectedSeasonId,
    weekAnchorReady,
  ]);

  useEffect(() => {
    const safeFirst = isValidISODate(athleteMultiFirstWeekStartISO)
      ? getWeekStartISO(athleteMultiFirstWeekStartISO, weekStartsOn)
      : getWeekStartISO(toISODate(new Date()), weekStartsOn);
    const safeWeeks = Math.min(MAX_MILEAGE_RANGE_WEEKS, Math.max(1, Number(athleteMultiNumberOfWeeks) || 1));
    const derivedStart = safeFirst;
    const derivedEnd = addDaysISO(safeFirst, safeWeeks * 7 - 1);
    if (athleteMultiRangeStartISO !== derivedStart) setAthleteMultiRangeStartISO(derivedStart);
    if (athleteMultiRangeEndISO !== derivedEnd) setAthleteMultiRangeEndISO(derivedEnd);
  }, [athleteMultiFirstWeekStartISO, athleteMultiNumberOfWeeks, athleteMultiRangeEndISO, athleteMultiRangeStartISO, weekStartsOn]);

  const loadMileageWeekStartSetting = useCallback(async () => {
    const weekStartResult = await loadWeekStartSetting();
    const resolvedWeekStartsOn: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
    console.log("[coach-mileage] week start loaded via shared helper", {
      raw: weekStartResult.raw,
      normalized: resolvedWeekStartsOn,
    });
    setWeekStartsOn(resolvedWeekStartsOn);
    return resolvedWeekStartsOn;
  }, []);

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
      if (weekLabelSaveTimerRef.current) clearTimeout(weekLabelSaveTimerRef.current);
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

  const relativeWeekStatus = useMemo(() => {
    const currentWeekStartISO = getWeekStartISO(toISODate(new Date()), weekStartsOn);
    const weekOffset = Math.round((isoDayNumber(weekStartISO) - isoDayNumber(currentWeekStartISO)) / 7);
    if (weekOffset === 0) return { label: "This week", status: "current" as const };
    if (weekOffset === 1) return { label: "Next week", status: "future" as const };
    if (weekOffset > 1) return { label: `In ${weekOffset} weeks`, status: "future" as const };
    if (weekOffset === -1) return { label: "Last week", status: "past" as const };
    return { label: `${Math.abs(weekOffset)} weeks ago`, status: "past" as const };
  }, [weekStartISO, weekStartsOn]);

  const currentWeekLabelEntry = useMemo(
    () => weekLabelsByStart[weekStartISO] ?? null,
    [weekLabelsByStart, weekStartISO]
  );
  const currentWeekLabel = useMemo(
    () => String(currentWeekLabelEntry?.label ?? ""),
    [currentWeekLabelEntry]
  );
  const activeWeekLabelTone = useMemo(
    () => getWeekLabelTone(currentWeekLabelEntry?.type ?? "training"),
    [currentWeekLabelEntry]
  );
  const activeWeekToneColors = useMemo(() => {
    return getWeekLabelToneColors(activeWeekLabelTone);
  }, [activeWeekLabelTone]);

  const copiedWeekRangeLabel = useMemo(() => {
    if (!weekClipboard?.sourceWeekStartISO) return "";
    const startISO = weekClipboard.sourceWeekStartISO;
    const endISO = addDaysISO(startISO, 6);
    const start = parseISODate(startISO);
    const end = parseISODate(endISO);
    const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `${startLabel} - ${endLabel}`;
  }, [weekClipboard]);

  const viewingCopiedWeek = useMemo(() => {
    if (!weekClipboard?.sourceWeekStartISO) return false;
    return weekClipboard.sourceWeekStartISO === weekStartISO;
  }, [weekClipboard, weekStartISO]);

  useEffect(() => {
    const editingSameWeek =
      isWeekLabelEditing && weekLabelEditingWeekRef.current === weekStartISO;
    if (editingSameWeek) return;
    setWeekLabelDraft(currentWeekLabel);
  }, [currentWeekLabel, isWeekLabelEditing, weekStartISO]);

  const jumpToWeekFromDateISO = useCallback(
    (dateISO: string) => {
      const trimmed = String(dateISO ?? "").trim();
      if (!isValidISODate(trimmed)) return false;
      const targetWeekStartISO = getWeekStartISO(trimmed, weekStartsOn);
      setWeekAnchorISO(targetWeekStartISO);
      return true;
    },
    [weekStartsOn]
  );

  const weekCellsFromStore = s.mileageCellsByWeek[weekStartISO] ?? [];
  const weekFlagsFromStore = s.mileageFlagsByWeek[weekStartISO] ?? [];

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(`${MILEAGE_WEEK_CACHE_PREFIX}:${weekStartISO}`);
        if (!active || !raw) return;
        const parsed = JSON.parse(raw) as { cells?: any[]; flags?: any[] };
        setCachedWeekSnapshot({
          weekStartISO,
          cells: Array.isArray(parsed?.cells) ? parsed.cells : [],
          flags: Array.isArray(parsed?.flags) ? parsed.flags : [],
        });
      } catch {
        if (!active) return;
        setCachedWeekSnapshot({ weekStartISO, cells: [], flags: [] });
      }
    })();
    return () => {
      active = false;
    };
  }, [weekStartISO]);

  useEffect(() => {
    if (weekCellsFromStore.length === 0 && weekFlagsFromStore.length === 0) return;
    const payload = JSON.stringify({ cells: weekCellsFromStore, flags: weekFlagsFromStore, updatedAt: Date.now() });
    void AsyncStorage.setItem(`${MILEAGE_WEEK_CACHE_PREFIX}:${weekStartISO}`, payload).catch(() => {});
  }, [weekCellsFromStore, weekFlagsFromStore, weekStartISO]);

  const weekCells =
    weekCellsFromStore.length > 0
      ? weekCellsFromStore
      : cachedWeekSnapshot?.weekStartISO === weekStartISO
        ? cachedWeekSnapshot.cells
        : [];
  const weekFlags =
    weekFlagsFromStore.length > 0
      ? weekFlagsFromStore
      : cachedWeekSnapshot?.weekStartISO === weekStartISO
        ? cachedWeekSnapshot.flags
        : [];

  const cellsByKey = useMemo(() => {
    const next: Record<CellKey, MileageValue | null> = {};
    for (const row of weekCells as any[]) {
      if (!rowBelongsToMileageWeek(row, weekStartISO)) continue;
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
      if (!rowBelongsToMileageWeek(row, weekStartISO)) continue;
      const athleteId = String(row?.athlete_profile_id ?? "");
      const dayIdx = Number(row?.day_idx);
      if (!athleteId || !Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) continue;
      next[offKey(athleteId, weekStartISO, dayIdx)] = !!row?.ncaa_off;
    }
    return next;
  }, [weekFlags, weekStartISO]);

  const weekEndISO = useMemo(() => addDaysISO(weekStartISO, 6), [weekStartISO]);

  const athletesWithIds = useMemo(() => {
    const activeNormalized = sortRosterByName(
      (Array.isArray(s.roster) ? s.roster : [])
        .map((item) => normalizeTeamRosterAthlete(item))
        .filter((item): item is NonNullable<typeof item> => !!item)
        .filter((athlete) => isAthleteEligibleDuringWeek(athlete, weekStartISO, weekEndISO))
    );

    const out: Array<{ raw: any; index: number; id: string; name: string }> = [];
    activeNormalized.forEach((athlete, i) => {
      const id = String(athlete.id ?? "").trim();
      if (!id) return;
      const name = String(athlete.displayName ?? "").trim() || `Athlete ${i + 1}`;
      out.push({ raw: athlete, index: out.length, id, name });
    });

    return out;
  }, [s.roster, weekEndISO, weekStartISO]);

  const trainingGroupFilterOptions = useMemo<TrainingGroupFilterOption[]>(() => {
    const byId = new Map<string, TrainingGroupFilterOption>();
    (Array.isArray(s.trainingGroups) ? s.trainingGroups : []).forEach((group) => {
      const id = String(group?.id ?? "").trim();
      if (!id) return;
      const label = String(group?.name ?? "").trim() || "Training Group";
      const archived = !!group?.archived_at;
      if (!archived) {
        byId.set(id, { id, label, archived });
      }
    });
    selectedTrainingGroupIds.forEach((groupIdRaw) => {
      const id = String(groupIdRaw ?? "").trim();
      if (!id || byId.has(id)) return;
      const match = (s.trainingGroups ?? []).find((group) => String(group?.id ?? "").trim() === id);
      byId.set(id, {
        id,
        label: String(match?.name ?? "").trim() || `Group (${id.slice(-6)})`,
        archived: !!match?.archived_at,
      });
    });
    return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [s.trainingGroups, selectedTrainingGroupIds]);

  const seasonFilterOptions = useMemo<SeasonFilterOption[]>(() => {
    const byId = new Map<string, SeasonFilterOption>();
    (Array.isArray(s.teamSeasons) ? s.teamSeasons : []).forEach((season) => {
      const id = String(season?.id ?? "").trim();
      if (!id) return;
      const label = String(season?.name ?? "").trim() || "Season";
      const archived = !!season?.archived_at;
      if (!archived) byId.set(id, { id, label, archived });
    });
    const selectedId = String(selectedSeasonId ?? "").trim();
    if (selectedId && !byId.has(selectedId)) {
      const match = (s.teamSeasons ?? []).find((season) => String(season?.id ?? "").trim() === selectedId);
      byId.set(selectedId, {
        id: selectedId,
        label: String(match?.name ?? "").trim() || `Season (${selectedId.slice(-6)})`,
        archived: !!match?.archived_at,
      });
    }
    const order = new Map<string, number>();
    (Array.isArray(s.teamSeasons) ? s.teamSeasons : []).forEach((season, idx) => {
      const id = String(season?.id ?? "").trim();
      if (id) order.set(id, idx);
    });
    return Array.from(byId.values()).sort(
      (a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    );
  }, [s.teamSeasons, selectedSeasonId]);

  const mileagePlanExportSeasonOptions = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; archived: boolean; excluded: boolean }>();
    const athleteId = String(athleteMultiSelectedId ?? "").trim();
    (Array.isArray(s.teamSeasons) ? s.teamSeasons : []).forEach((season) => {
      const id = String(season?.id ?? "").trim();
      if (!id) return;
      const archived = !!season?.archived_at;
      if (archived) return;
      const excluded = athleteId ? isAthleteExcludedFromSeason(athleteId, id, s.athleteSeasonOverrides ?? []) : false;
      byId.set(id, { id, label: String(season?.name ?? "").trim() || "Season", archived, excluded });
    });
    const selectedId = String(mileagePlanExportSeasonId ?? "").trim();
    if (selectedId && !byId.has(selectedId)) {
      const match = (s.teamSeasons ?? []).find((season) => String(season?.id ?? "").trim() === selectedId);
      if (match) {
        const excluded = athleteId ? isAthleteExcludedFromSeason(athleteId, selectedId, s.athleteSeasonOverrides ?? []) : false;
        byId.set(selectedId, { id: selectedId, label: String(match?.name ?? "").trim() || "Season", archived: !!match?.archived_at, excluded });
      }
    }
    const order = new Map<string, number>();
    (Array.isArray(s.teamSeasons) ? s.teamSeasons : []).forEach((season, idx) => {
      const id = String(season?.id ?? "").trim();
      if (id) order.set(id, idx);
    });
    return Array.from(byId.values()).sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));
  }, [athleteMultiSelectedId, mileagePlanExportSeasonId, s.athleteSeasonOverrides, s.teamSeasons]);

  useEffect(() => {
    if (!s.sharedCoachFiltersLoaded) return;
    if (!s.trainingGroupsLoaded) return;
    const validIds = new Set(trainingGroupFilterOptions.map((option) => option.id));
    const next = selectedTrainingGroupIds.filter((id) => validIds.has(id));
    if (next.length !== selectedTrainingGroupIds.length) {
      void teamDataStore.actions.setSharedSelectedTrainingGroupIds(next);
    }
  }, [
    selectedTrainingGroupIds,
    s.sharedCoachFiltersLoaded,
    s.trainingGroupsLoaded,
    trainingGroupFilterOptions,
  ]);

  useEffect(() => {
    if (!s.sharedCoachFiltersLoaded) return;
    if (!s.teamSeasonsLoaded) return;
    const selectedId = String(selectedSeasonId ?? "").trim();
    if (!selectedId) return;
    const validIds = new Set(seasonFilterOptions.map((option) => option.id));
    if (!validIds.has(selectedId)) {
      void teamDataStore.actions.setSharedSelectedSeasonId(null);
    }
  }, [s.sharedCoachFiltersLoaded, s.teamSeasonsLoaded, seasonFilterOptions, selectedSeasonId]);

  const selectedTrainingGroupLabel = useMemo(() => {
    if (selectedTrainingGroupIds.length === 0) return "Groups: All";
    if (selectedTrainingGroupIds.length === 1) {
      const match = trainingGroupFilterOptions.find((option) => option.id === selectedTrainingGroupIds[0]);
      return match?.label ? `Group: ${match.label}` : "Groups: 1 selected";
    }
    return `Groups: ${selectedTrainingGroupIds.length} selected`;
  }, [selectedTrainingGroupIds, trainingGroupFilterOptions]);

  const selectedSeasonLabel = useMemo(() => {
    if (!selectedSeasonId) return "Preset: Custom range";
    const match = seasonFilterOptions.find((option) => option.id === selectedSeasonId);
    return match?.label ? `Preset: ${match.label}` : "Preset: Selected season";
  }, [seasonFilterOptions, selectedSeasonId]);

  const setMileageRangeFromDates = useCallback((startISO: string, endISO: string) => {
    setMileageRangeStartISO(startISO);
    setMileageRangeEndISO(endISO);
    setMileageRangeInitialized(true);
    const firstWeekStart = isValidISODate(startISO) ? getWeekStartISO(startISO, weekStartsOn) : startISO;
    const lastWeekStart = isValidISODate(endISO) ? getWeekStartISO(endISO, weekStartsOn) : endISO;
    if (isValidISODate(firstWeekStart)) setAthleteMultiFirstWeekStartISO(firstWeekStart);
    if (isValidISODate(firstWeekStart) && isValidISODate(lastWeekStart) && lastWeekStart >= firstWeekStart) {
      const numberOfWeeks = Math.min(
        MAX_MILEAGE_RANGE_WEEKS,
        Math.max(1, Math.floor((isoDayNumber(lastWeekStart) - isoDayNumber(firstWeekStart)) / 7) + 1)
      );
      setAthleteMultiNumberOfWeeks(numberOfWeeks);
    }
  }, [weekStartsOn]);

  const clearMileagePreset = useCallback(() => {
    void teamDataStore.actions.setSharedSelectedSeasonId(null);
    setAthleteMultiRangeMode("custom");
  }, []);

  const updateMileageRangeStart = useCallback((value: string) => {
    setMileageRangeFromDates(value, mileageRangeEndISO);
    clearMileagePreset();
  }, [clearMileagePreset, mileageRangeEndISO, setMileageRangeFromDates]);

  const updateMileageRangeEnd = useCallback((value: string) => {
    setMileageRangeFromDates(mileageRangeStartISO, value);
    clearMileagePreset();
  }, [clearMileagePreset, mileageRangeStartISO, setMileageRangeFromDates]);

  const applyMileageSeasonPreset = useCallback((seasonId: string) => {
    const season = (s.teamSeasons ?? []).find((row) => String(row?.id ?? "").trim() === String(seasonId ?? "").trim());
    const startISO = String(season?.start_date ?? "").trim();
    const endISO = String(season?.end_date ?? "").trim();
    if (!season || !isValidISODate(startISO) || !isValidISODate(endISO) || endISO < startISO) return;
    void teamDataStore.actions.setSharedSelectedSeasonId(String(season.id));
    setMileageRangeFromDates(startISO, endISO);
    setAthleteMultiRangeMode("season");
    setSeasonFilterOpen(false);
  }, [s.teamSeasons, setMileageRangeFromDates]);

  const applyAllSeasonsMileageRange = useCallback(() => {
    void teamDataStore.actions.setSharedSelectedSeasonId(null);
    setAthleteMultiRangeMode("custom");
    let startISO = "";
    let endISO = "";
    (Array.isArray(s.teamSeasons) ? s.teamSeasons : []).forEach((season) => {
      if (season?.archived_at) return;
      const start = String(season?.start_date ?? "").trim();
      const end = String(season?.end_date ?? "").trim();
      if (!isValidISODate(start) || !isValidISODate(end) || end < start) return;
      if (!startISO || start < startISO) startISO = start;
      if (!endISO || end > endISO) endISO = end;
    });
    if (startISO && endISO) {
      setMileageRangeFromDates(startISO, endISO);
    }
    setSeasonFilterOpen(false);
  }, [s.teamSeasons, setMileageRangeFromDates]);

  const trainingGroupAthleteIdsByGroupId = useMemo(() => {
    const map = new Map<string, Set<string>>();
    (Array.isArray(s.trainingGroupMemberships) ? s.trainingGroupMemberships : []).forEach((row) => {
      if (!isActiveTrainingGroupMembership(row)) return;
      const groupId = String(row?.group_id ?? "").trim();
      const athleteId = String(row?.athlete_profile_id ?? "").trim();
      if (!groupId || !athleteId) return;
      const prev = map.get(groupId) ?? new Set<string>();
      prev.add(athleteId);
      map.set(groupId, prev);
    });
    return map;
  }, [s.trainingGroupMemberships]);

  const selectedTrainingGroupAthleteIds = useMemo(() => {
    const out = new Set<string>();
    selectedTrainingGroupIds.forEach((groupId) => {
      const ids = trainingGroupAthleteIdsByGroupId.get(String(groupId ?? "").trim());
      if (!ids) return;
      ids.forEach((id) => out.add(id));
    });
    return out;
  }, [selectedTrainingGroupIds, trainingGroupAthleteIdsByGroupId]);

  const athleteSeasonOverridesBySeasonAndAthlete = useMemo(() => {
    const map = new Map<string, (typeof s.athleteSeasonOverrides)[number]>();
    (Array.isArray(s.athleteSeasonOverrides) ? s.athleteSeasonOverrides : []).forEach((override) => {
      const seasonId = String(override?.season_id ?? "").trim();
      const athleteId = String(override?.athlete_profile_id ?? "").trim();
      if (!seasonId || !athleteId) return;
      map.set(`${seasonId}:${athleteId}`, override);
    });
    return map;
  }, [s.athleteSeasonOverrides]);

  const selectedSeason = useMemo(() => {
    const id = String(selectedSeasonId ?? "").trim();
    if (!id) return null;
    return (s.teamSeasons ?? []).find((season) => String(season?.id ?? "").trim() === id) ?? null;
  }, [s.teamSeasons, selectedSeasonId]);

  const defaultMileageSeason = useMemo(() => {
    const seasons = (Array.isArray(s.teamSeasons) ? s.teamSeasons : []).filter((season) => !season?.archived_at);
    if (seasons.length === 0) return null;
    const todayISO = toISODate(new Date());
    return (
      seasons.find((season) => {
        const start = String(season?.start_date ?? "").trim();
        const end = String(season?.end_date ?? "").trim();
        return isValidISODate(start) && isValidISODate(end) && todayISO >= start && todayISO <= end;
      }) ??
      seasons.find((season) => {
        const start = String(season?.start_date ?? "").trim();
        return isValidISODate(start) && start > todayISO;
      }) ??
      seasons[0] ??
      null
    );
  }, [s.teamSeasons]);

  const allSeasonsDateRange = useMemo(() => {
    let startISO = "";
    let endISO = "";
    (Array.isArray(s.teamSeasons) ? s.teamSeasons : []).forEach((season) => {
      if (season?.archived_at) return;
      const start = String(season?.start_date ?? "").trim();
      const end = String(season?.end_date ?? "").trim();
      if (!isValidISODate(start) || !isValidISODate(end) || end < start) return;
      if (!startISO || start < startISO) startISO = start;
      if (!endISO || end > endISO) endISO = end;
    });
    return startISO && endISO ? { startISO, endISO } : null;
  }, [s.teamSeasons]);

  useEffect(() => {
    if (mileageRangeInitialized || !s.teamSeasonsLoaded) return;
    const season = selectedSeason ?? defaultMileageSeason;
    const startISO = String(season?.start_date ?? "").trim();
    const endISO = String(season?.end_date ?? "").trim();
    if (isValidISODate(startISO) && isValidISODate(endISO) && endISO >= startISO) {
      setMileageRangeStartISO(startISO);
      setMileageRangeEndISO(endISO);
      if (!selectedSeasonId && season?.id) {
        void teamDataStore.actions.setSharedSelectedSeasonId(String(season.id));
      }
    } else {
      const start = getWeekStartISO(toISODate(new Date()), weekStartsOn);
      setMileageRangeStartISO(start);
      setMileageRangeEndISO(addDaysISO(start, 41));
    }
    setMileageRangeInitialized(true);
  }, [
    defaultMileageSeason,
    mileageRangeInitialized,
    s.teamSeasonsLoaded,
    selectedSeason,
    selectedSeasonId,
    weekStartsOn,
  ]);

  const seasonMileageRange = useMemo(() => {
    const startISO = String(mileageRangeStartISO ?? "").trim();
    const endISO = String(mileageRangeEndISO ?? "").trim();
    if (!isValidISODate(startISO) || !isValidISODate(endISO) || endISO < startISO) {
      return { startISO: "", endISO: "" };
    }
    return { startISO, endISO };
  }, [mileageRangeEndISO, mileageRangeStartISO]);

  const seasonMileageWeekStarts = useMemo(() => {
    if (!seasonMileageRange.startISO || !seasonMileageRange.endISO) return [];
    const firstWeekStart = getWeekStartISO(seasonMileageRange.startISO, weekStartsOn);
    const lastWeekStart = getWeekStartISO(seasonMileageRange.endISO, weekStartsOn);
    const out: string[] = [];
    for (let ws = firstWeekStart; ws <= lastWeekStart && out.length < MAX_MILEAGE_RANGE_WEEKS; ws = addDaysISO(ws, 7)) {
      out.push(ws);
    }
    return out;
  }, [seasonMileageRange.endISO, seasonMileageRange.startISO, weekStartsOn]);

  const seasonMileageTableRange = useMemo(() => {
    const firstWeekStart = seasonMileageWeekStarts[0] ?? "";
    const lastWeekStart = seasonMileageWeekStarts[seasonMileageWeekStarts.length - 1] ?? "";
    if (!firstWeekStart || !lastWeekStart) return { startISO: "", endISO: "" };
    return { startISO: firstWeekStart, endISO: addDaysISO(lastWeekStart, 6) };
  }, [seasonMileageWeekStarts]);

  const resolveSelectedSeasonWindowForAthlete = useCallback(
    (athleteIdRaw: string | null | undefined) => {
      if (!selectedSeason) return null;
      const athleteId = String(athleteIdRaw ?? "").trim();
      const override = athleteId
        ? athleteSeasonOverridesBySeasonAndAthlete.get(`${String(selectedSeason.id ?? "").trim()}:${athleteId}`) ?? null
        : null;
      return teamDataStore.resolveAthleteSeasonWindow(selectedSeason, override);
    },
    [athleteSeasonOverridesBySeasonAndAthlete, selectedSeason]
  );

  const resolveSeasonMileageWindowForAthlete = useCallback(
    (athleteIdRaw: string | null | undefined) => {
      const athleteId = String(athleteIdRaw ?? "").trim();
      if (!athleteId || !seasonMileageRange.startISO || !seasonMileageRange.endISO) return null;

      if (selectedSeason) {
        const override =
          athleteSeasonOverridesBySeasonAndAthlete.get(`${String(selectedSeason.id ?? "").trim()}:${athleteId}`) ?? null;
        return teamDataStore.resolveAthleteSeasonWindow(selectedSeason, override);
      }

      const rawAthlete = (s.roster ?? []).find((row) => String((row as any)?.id ?? "").trim() === athleteId);
      const athlete = normalizeTeamRosterAthlete(rawAthlete ?? {});
      let startISO = seasonMileageRange.startISO;
      let endISO = seasonMileageRange.endISO;
      const athleteStart = String(athlete?.teamStartDate ?? "").trim();
      const athleteEnd = String(athlete?.teamEndDate ?? "").trim();
      if (isValidISODate(athleteStart) && athleteStart > startISO) startISO = athleteStart;
      if (isValidISODate(athleteEnd) && athleteEnd < endISO) endISO = athleteEnd;
      return { start_date: startISO, end_date: endISO };
    },
    [
      athleteSeasonOverridesBySeasonAndAthlete,
      s.roster,
      seasonMileageRange.endISO,
      seasonMileageRange.startISO,
      selectedSeason,
    ]
  );

  const teamWeekGroupFilteredAthletes = useMemo(() => {
    if (selectedTrainingGroupIds.length === 0) return athletesWithIds;
    return athletesWithIds.filter((athlete) =>
      selectedTrainingGroupAthleteIds.has(String(athlete.id ?? "").trim())
    );
  }, [athletesWithIds, selectedTrainingGroupAthleteIds, selectedTrainingGroupIds.length]);

  const teamWeekVisibleAthletes = useMemo(() => {
    return teamWeekGroupFilteredAthletes;
  }, [teamWeekGroupFilteredAthletes]);

  const seasonMileageAthletes = useMemo(() => {
    if (!seasonMileageRange.startISO || !seasonMileageRange.endISO) return [];
    const seasonId = String(selectedSeason?.id ?? "").trim();
    const normalized = sortRosterByName(
      (Array.isArray(s.roster) ? s.roster : [])
        .map((item) => normalizeTeamRosterAthlete(item))
        .filter((item): item is NonNullable<typeof item> => !!item)
    );

    return normalized
      .filter((athlete) => {
        const athleteId = String(athlete.id ?? "").trim();
        if (!athleteId) return false;
        if (!doesAthleteOverlapDateRange(athlete, seasonMileageRange.startISO, seasonMileageRange.endISO)) return false;
        if (selectedTrainingGroupIds.length > 0 && !selectedTrainingGroupAthleteIds.has(athleteId)) return false;
        if (seasonId && isAthleteExcludedFromSeason(athleteId, seasonId, s.athleteSeasonOverrides ?? [])) return false;
        const resolvedWindow = resolveSeasonMileageWindowForAthlete(athleteId);
        const start = String(resolvedWindow?.start_date ?? seasonMileageRange.startISO).trim();
        const end = String(resolvedWindow?.end_date ?? seasonMileageRange.endISO).trim();
        if (!isValidISODate(start) || !isValidISODate(end) || end < start) return false;
        return end >= seasonMileageRange.startISO && start <= seasonMileageRange.endISO;
      })
      .map((athlete, index) => ({
        raw: athlete,
        index,
        id: String(athlete.id ?? "").trim(),
        name: String(athlete.displayName ?? "").trim() || `Athlete ${index + 1}`,
      }));
  }, [
    resolveSeasonMileageWindowForAthlete,
    s.athleteSeasonOverrides,
    s.roster,
    seasonMileageRange.endISO,
    seasonMileageRange.startISO,
    selectedSeason,
    selectedTrainingGroupAthleteIds,
    selectedTrainingGroupIds.length,
  ]);

  const refreshMileageWeekVisibility = useCallback(async () => {
    try {
      const rows = await fetchMileageWeekVisibilityForWeek(weekStartISO);
      setWeekVisibilityRows(rows);
    } catch (error) {
      console.warn("[coach-mileage] load week visibility failed", error);
      setWeekVisibilityRows([]);
    }
  }, [weekStartISO]);

  useEffect(() => {
    void refreshMileageWeekVisibility();
  }, [refreshMileageWeekVisibility]);

  const mileageWeekVisibilityLabel = useMemo(() => {
    const athleteIds = teamWeekVisibleAthletes.map((athlete) => String(athlete.id ?? "").trim()).filter(Boolean);
    if (athleteIds.length === 0) return "No athletes";
    const byAthlete = new Map(weekVisibilityRows.map((row) => [String(row.athlete_profile_id ?? "").trim(), !!row.athlete_visible]));
    const visibleCount = athleteIds.filter((athleteId) => byAthlete.get(athleteId) === true).length;
    if (visibleCount === athleteIds.length) return "Published to athletes";
    if (visibleCount === 0) return "Hidden from athletes";
    return "Mixed visibility";
  }, [teamWeekVisibleAthletes, weekVisibilityRows]);

  const setDisplayedMileageWeekVisibility = useCallback(async (visible: boolean) => {
    const athleteIds = teamWeekVisibleAthletes.map((athlete) => String(athlete.id ?? "").trim()).filter(Boolean);
    if (athleteIds.length === 0) return;
    setWeekVisibilityBusy(true);
    try {
      await Promise.all([
        setMileageVisibilityByWeeks({ athleteIds, weekStartISOs: [weekStartISO], visible }),
        setWorkoutVisibilityByDateRange({ startISO: weekStartISO, endISO: weekEndISO, athleteIds, visible }),
      ]);
      await refreshMileageWeekVisibility();
      setActionBannerText(visible ? "Published this week to athletes." : "Hid this week from athletes.");
    } catch (error: any) {
      Alert.alert("Visibility update failed", String(error?.message ?? error ?? "Could not update week visibility."));
    } finally {
      setWeekVisibilityBusy(false);
    }
  }, [refreshMileageWeekVisibility, teamWeekVisibleAthletes, weekEndISO, weekStartISO]);

  const openTrainingVisibilityModal = useCallback((content: TrainingVisibilityContent = "both") => {
    setTrainingVisibilityContent(content);
    setTrainingVisibilityRange("week");
    setTrainingVisibilityStartISO(weekStartISO);
    setTrainingVisibilityEndISO(weekEndISO);
    setTrainingVisibilityError(null);
    setTrainingVisibilityOpen(true);
  }, [weekEndISO, weekStartISO]);

  const applyTrainingVisibilityNow = useCallback(async () => {
    const visible = trainingVisibilityAction === "publish";
    const includeWorkouts = trainingVisibilityContent === "workouts" || trainingVisibilityContent === "both";
    const includeMileage = trainingVisibilityContent === "mileage" || trainingVisibilityContent === "both";
    const athleteIds = teamWeekVisibleAthletes.map((athlete) => String(athlete.id ?? "").trim()).filter(Boolean);
    const weekStartsOnForMileage = weekStartsOn === 0 ? 0 : 1;
    setTrainingVisibilityError(null);

    const showValidation = (title: string, message: string) => {
      setTrainingVisibilityError(message);
      Alert.alert(title, message);
    };

    if (athleteIds.length === 0) {
      showValidation("No athletes", "There are no athletes in the current Team Week scope.");
      return;
    }
    if (trainingVisibilityRange === "custom") {
      const startISO = String(trainingVisibilityStartISO ?? "").trim();
      const endISO = String(trainingVisibilityEndISO ?? "").trim();
      if (!isValidISODate(startISO) || !isValidISODate(endISO) || startISO > endISO) {
        showValidation("Invalid range", "Enter a valid start and end date.");
        return;
      }
    }
    if (trainingVisibilityRange === "season" && !selectedSeason) {
      showValidation("No season selected", "Select a season before applying visibility.");
      return;
    }

    const seasonWindows: Array<{ athleteId: string; startISO: string; endISO: string }> = [];
    let targetAthleteCount = athleteIds.length;
    if (trainingVisibilityRange === "season" && selectedSeason) {
      const seasonId = String(selectedSeason.id ?? "").trim();
      if (!seasonId) {
        showValidation("No season selected", "Select a season before applying visibility.");
        return;
      }
      const rosterById = new Map((s.roster ?? []).map((athlete) => [String(athlete?.id ?? "").trim(), athlete]));
      for (const athleteId of athleteIds) {
        if (isAthleteExcludedFromSeason(athleteId, seasonId, s.athleteSeasonOverrides ?? [])) continue;
        const athlete = rosterById.get(athleteId) ?? null;
        const override = athleteSeasonOverridesBySeasonAndAthlete.get(`${seasonId}:${athleteId}`) ?? null;
        const resolved = resolveAthleteSeasonWindowWithTenure(athlete as any, selectedSeason as any, override as any);
        const startISO = String(resolved.start_date ?? "").trim();
        const endISO = String(resolved.end_date ?? "").trim();
        if (!isValidISODate(startISO) || !isValidISODate(endISO) || startISO > endISO) continue;
        seasonWindows.push({ athleteId, startISO, endISO });
      }
      targetAthleteCount = seasonWindows.length;
      if (seasonWindows.length === 0) {
        showValidation("No eligible athletes", "No eligible athletes found for this season.");
        return;
      }
    }

    if (!includeWorkouts && !includeMileage) {
      showValidation("Choose training", "Select workouts, mileage, or both.");
      return;
    }

    const run = async () => {
      setTrainingVisibilityApplying(true);
      try {
        let mileageRows = 0;
        let workoutRows = 0;
        if (trainingVisibilityRange === "season" && selectedSeason) {
          for (const { athleteId, startISO, endISO } of seasonWindows) {
            if (includeWorkouts) {
              workoutRows += await setWorkoutVisibilityByDateRange({ startISO, endISO, athleteIds: [athleteId], visible });
            }
            if (includeMileage) {
              const result = await setMileageVisibilityByDateRange({
                athleteIds: [athleteId],
                startISO,
                endISO,
                visible,
                weekStartsOn: weekStartsOnForMileage,
              });
              mileageRows += result.rowCount;
            }
          }
        } else {
          const startISO = trainingVisibilityRange === "week" ? weekStartISO : String(trainingVisibilityStartISO ?? "").trim();
          const endISO = trainingVisibilityRange === "week" ? weekEndISO : String(trainingVisibilityEndISO ?? "").trim();
          if (includeWorkouts) {
            workoutRows = await setWorkoutVisibilityByDateRange({ startISO, endISO, athleteIds, visible });
          }
          if (includeMileage) {
            const result = await setMileageVisibilityByDateRange({
              athleteIds,
              startISO,
              endISO,
              visible,
              weekStartsOn: weekStartsOnForMileage,
            });
            mileageRows = result.rowCount;
          }
        }

        if ((includeWorkouts ? workoutRows : 0) === 0 && (includeMileage ? mileageRows : 0) === 0) {
          const message =
            trainingVisibilityRange === "season"
              ? "No matching workouts or mileage weeks were found for this season."
              : "No matching workouts or mileage weeks were found for this range.";
          setTrainingVisibilityError(message);
          Alert.alert("Nothing found", message);
          return;
        }

        await Promise.all([
          refreshMileageWeekVisibility(),
          teamDataStore.actions.loadMileageWeek(weekStartISO, true),
        ]);
        setTrainingVisibilityOpen(false);
        const verb = visible ? "Published" : "Hid";
        const updatedParts = [
          includeWorkouts ? `${workoutRows} workout${workoutRows === 1 ? "" : "s"}` : "",
          includeMileage ? `${mileageRows} mileage week row${mileageRows === 1 ? "" : "s"}` : "",
        ].filter(Boolean);
        setActionBannerText(`${verb} training visibility for ${targetAthleteCount} athlete${targetAthleteCount === 1 ? "" : "s"}. Updated ${updatedParts.join(" and ")}.`);
      } catch (error: any) {
        const message = String(error?.message ?? error ?? "Could not update training visibility.");
        console.error("[coach-mileage] training visibility apply failed", {
          rangeMode: trainingVisibilityRange,
          content: trainingVisibilityContent,
          action: trainingVisibilityAction,
          selectedSeasonId: selectedSeason ? String(selectedSeason.id ?? "") : null,
          athleteCount: athleteIds.length,
          error,
        });
        setTrainingVisibilityError(message);
        Alert.alert("Visibility update failed", message);
      } finally {
        setTrainingVisibilityApplying(false);
      }
    };

    const actionText = visible ? "Publish training to athletes?" : "Hide training from athletes?";
    const confirmMessage = `${visible ? "Athletes will be able to see this training and submit feedback." : "Coaches will still see this training. Hidden training will not appear on athlete Dashboard, Calendar, or Log."}\n\nMileage visibility is week-based. Any week touched by this range will be affected.`;
    if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.confirm === "function") {
      if (window.confirm(`${actionText}\n\n${confirmMessage}`)) void run();
      return;
    }
    Alert.alert(actionText, confirmMessage, [
      { text: "Cancel", style: "cancel" },
      { text: visible ? "Publish" : "Hide", style: visible ? "default" : "destructive", onPress: () => void run() },
    ]);
  }, [
    athleteSeasonOverridesBySeasonAndAthlete,
    refreshMileageWeekVisibility,
    s.athleteSeasonOverrides,
    s.roster,
    selectedSeason,
    teamWeekVisibleAthletes,
    trainingVisibilityAction,
    trainingVisibilityContent,
    trainingVisibilityEndISO,
    trainingVisibilityRange,
    trainingVisibilityStartISO,
    weekEndISO,
    weekStartISO,
    weekStartsOn,
  ]);

  useEffect(() => {
    if (athleteMultiSelectedId && athletesWithIds.some((a) => a.id === athleteMultiSelectedId)) return;
    const first = athletesWithIds[0]?.id ?? "";
    if (first) setAthleteMultiSelectedId(first);
  }, [athleteMultiSelectedId, athletesWithIds]);

  const athleteMultiRangeStartWeekISO = useMemo(
    () => getWeekStartISO(athleteMultiFirstWeekStartISO, weekStartsOn),
    [athleteMultiFirstWeekStartISO, weekStartsOn]
  );
  const athleteMultiSafeWeekCount = useMemo(
    () => Math.min(MAX_MILEAGE_RANGE_WEEKS, Math.max(1, Number(athleteMultiNumberOfWeeks) || 1)),
    [athleteMultiNumberOfWeeks]
  );
  const athleteMultiRangeEndWeekISO = useMemo(
    () => addDaysISO(athleteMultiRangeStartWeekISO, (athleteMultiSafeWeekCount - 1) * 7),
    [athleteMultiRangeStartWeekISO, athleteMultiSafeWeekCount]
  );
  const athleteMultiVisibleWeekStarts = useMemo(
    () => {
      if (!isValidISODate(athleteMultiRangeStartWeekISO)) return [];
      const out: string[] = [];
      for (let i = 0; i < athleteMultiSafeWeekCount; i++) {
        const ws = addDaysISO(athleteMultiRangeStartWeekISO, i * 7);
        out.push(ws);
      }
      return out;
    },
    [athleteMultiRangeStartWeekISO, athleteMultiSafeWeekCount]
  );

  const athleteMultiSelectedSeasonWindow = useMemo(() => {
    if (!selectedSeason) return null;
    return resolveSelectedSeasonWindowForAthlete(athleteMultiSelectedId);
  }, [athleteMultiSelectedId, resolveSelectedSeasonWindowForAthlete, selectedSeason]);

  const athleteMultiSeasonVisibleWeekStarts = useMemo(
    () => {
      if (athleteMultiRangeMode !== "season") return athleteMultiVisibleWeekStarts;
      return athleteMultiVisibleWeekStarts.filter((weekISO) =>
        seasonIntersectsWeek(weekISO, athleteMultiSelectedSeasonWindow)
      );
    },
    [athleteMultiRangeMode, athleteMultiSelectedSeasonWindow, athleteMultiVisibleWeekStarts]
  );

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
    console.log("[mileage-pdf] export start", { weekRangeLabel, athleteCount: teamWeekVisibleAthletes.length });
    setExportingPdf(true);
    try {
      const exportAthletes = teamWeekVisibleAthletes.map((a) => {
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
        weekAnnotation: currentWeekLabel ? `Week label: ${currentWeekLabel}` : "",
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
    teamWeekVisibleAthletes,
    cellsByKey,
    currentWeekLabel,
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

  const handleExportAthleteMileagePlanPdf = useCallback(async () => {
    if (exportingMileagePlanPdf) return;
    const athleteId = String(athleteMultiSelectedId ?? "").trim();
    if (!athleteId) {
      setMileagePlanExportError("Select an athlete first.");
      return;
    }
    const startISO = String(mileagePlanExportStartISO ?? "").trim();
    const endISO = String(mileagePlanExportEndISO ?? "").trim();
    if (!isValidISODate(startISO) || !isValidISODate(endISO)) {
      setMileagePlanExportError("Use valid dates.");
      return;
    }
    if (endISO < startISO) {
      setMileagePlanExportError("End date must be on or after start date.");
      return;
    }
    const spanDays = isoDayNumber(endISO) - isoDayNumber(startISO) + 1;
    if (spanDays > MAX_MILEAGE_PLAN_EXPORT_RANGE_DAYS) {
      setMileagePlanExportError(`Range too large. Maximum is ${MAX_MILEAGE_PLAN_EXPORT_RANGE_DAYS} days.`);
      return;
    }

    setMileagePlanExportError(null);
    setExportingMileagePlanPdf(true);
    try {
      const firstWeekStart = getWeekStartISO(startISO, weekStartsOn);
      const lastWeekStart = getWeekStartISO(endISO, weekStartsOn);
      const weekStarts: string[] = [];
      for (let ws = firstWeekStart; ws <= lastWeekStart; ws = addDaysISO(ws, 7)) weekStarts.push(ws);
      await teamDataStore.actions.loadMileageWeeks(weekStarts);
      const refreshedState = teamDataStore.getState();

      const weekRows = weekStarts.map((ws) => {
        const weekCells = (refreshedState.mileageCellsByWeek[ws] ?? []) as any[];
        const weekFlags = (refreshedState.mileageFlagsByWeek[ws] ?? []) as any[];
        const weekCellLookup = buildWeekCellsLookup(ws, weekCells);
        const weekFlagLookup: Record<string, boolean> = {};
        for (const row of weekFlags) {
          const rowAthleteId = String(row?.athlete_profile_id ?? "").trim();
          const rowDayIdx = Number(row?.day_idx);
          if (!rowAthleteId || !Number.isInteger(rowDayIdx) || rowDayIdx < 0 || rowDayIdx > 6) continue;
          weekFlagLookup[offKey(rowAthleteId, ws, rowDayIdx)] = !!row?.ncaa_off;
        }
        let totalMiles: Range = { min: 0, max: 0 };
        let totalXT: SecRange = { min: 0, max: 0 };
        const cells = Array.from({ length: 7 }, (_, dayIdx) => {
          const dateISO = addDaysISO(ws, dayIdx);
          const inRange = dateISO >= startISO && dateISO <= endISO;
          const amKey = cellCloudKey(athleteId, ws, dayIdx, "am");
          const pmKey = cellCloudKey(athleteId, ws, dayIdx, "pm");
          const amDraft = String(mileageDraftsRef.current[amKey] ?? "").trim();
          const pmDraft = String(mileageDraftsRef.current[pmKey] ?? "").trim();
          const amValue = amDraft.length > 0 ? parseMileageInput(amDraft) : (weekCellLookup[amKey] ?? null);
          const pmValue = pmDraft.length > 0 ? parseMileageInput(pmDraft) : (weekCellLookup[pmKey] ?? null);
          const pace = resolveAthletePaceSeconds(athleteId, athletePaceOverrides, paceSecPerMile);
          totalMiles = addRange(totalMiles, toRange(amValue as any, pace));
          totalMiles = addRange(totalMiles, toRange(pmValue as any, pace));
          totalXT = addSecRange(totalXT, toXTSecRange(amValue as any));
          totalXT = addSecRange(totalXT, toXTSecRange(pmValue as any));
          const flaggedOff = !!weekFlagLookup[offKey(athleteId, ws, dayIdx)];
          return {
            inRange,
            am: flaggedOff ? "OFF" : (amDraft.length > 0 ? amDraft : String(formatMileageForSheet(amValue as any) ?? "")),
            pm: flaggedOff ? "OFF" : (pmDraft.length > 0 ? pmDraft : String(formatMileageForSheet(pmValue as any) ?? "")),
          };
        });
        const start = parseISODate(ws);
        const end = parseISODate(addDaysISO(ws, 6));
        const weekLabel = `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
        return {
          weekLabel,
          totalMileage: formatWeekTotalRoundedDistance(totalMiles, distanceUnit),
          totalXT: formatXTTotal(totalXT),
          cells,
        };
      });

      const rangeLabel = `${parseISODate(startISO).toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${parseISODate(endISO).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
      const html = buildMileagePlanRangeHtml({
        athleteName:
          String(athletesWithIds.find((row) => String(row.id ?? "").trim() === athleteId)?.name ?? "").trim() || "Athlete",
        rangeLabel,
        generatedAtLabel: new Date().toLocaleString(),
        dayHeaders: weekdayLabels,
        weeks: weekRows,
      });

      if (Platform.OS === "web") {
        const printWindow = window.open("", "_blank", "width=1200,height=900");
        if (!printWindow) throw new Error("Popup blocked. Please allow popups for this site.");
        printWindow.document.open();
        printWindow.document.write(html);
        printWindow.document.close();
        printWindow.onload = () => {
          setTimeout(() => {
            printWindow.focus();
            printWindow.print();
          }, 200);
        };
      } else {
        const result = await Print.printToFileAsync({ html });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) await Sharing.shareAsync(result.uri);
      }
      await AsyncStorage.setItem(
        COACH_MILEAGE_PLAN_EXPORT_RANGE_KEY,
        JSON.stringify({
          startDateISO: startISO,
          endDateISO: endISO,
          seasonId: mileagePlanExportSeasonId ?? null,
        })
      ).catch(() => {});
      setMileagePlanExportOpen(false);
    } catch (error: any) {
      setMileagePlanExportError(String(error?.message ?? "Could not export mileage plan."));
    } finally {
      setExportingMileagePlanPdf(false);
    }
  }, [
    athleteMultiSelectedId,
    athletePaceOverrides,
    athletesWithIds,
    distanceUnit,
    exportingMileagePlanPdf,
    mileagePlanExportEndISO,
    mileagePlanExportSeasonId,
    mileagePlanExportStartISO,
    paceSecPerMile,
    weekStartsOn,
    weekdayLabels,
  ]);

  useEffect(() => {
    const run = async () => {
      await loadMileageWeekStartSetting();

      const [pace, unit, paceOverrides] = await Promise.all([
        loadPaceSecondsPerMile(),
        loadCoreCoachSettings(),
        loadAthletePaceOverrides(),
      ]);
      setPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
      setDistanceUnit(unit.distanceUnit);
      setAthletePaceOverrides(paceOverrides ?? {});
      const labels = await loadCoachWeekLabels().catch(() => ({}));
      setWeekLabelsByStart(labels ?? {});
      lastMileageMetaRefreshAtRef.current = Date.now();
    };
    void run();
  }, [loadMileageWeekStartSetting]);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const resolvedWeekStartsOn = await loadMileageWeekStartSetting();
        const focusedWeekStartISO = getWeekStartISO(weekAnchorISO, resolvedWeekStartsOn);
        const shouldRefreshMeta = Date.now() - lastMileageMetaRefreshAtRef.current > 20_000;
        const [
          nextCoachSettings,
          nextWeekLabels,
        ] = await Promise.all([
          shouldRefreshMeta
            ? loadCoreCoachSettings().catch((error) => {
                console.warn("[coach-mileage] loadCoreCoachSettings on focus failed", error);
                return null;
              })
            : Promise.resolve(null),
          shouldRefreshMeta
            ? loadCoachWeekLabels().catch((error) => {
                console.warn("[coach-mileage] loadCoachWeekLabels on focus failed", error);
                return {};
              })
            : Promise.resolve(null),
          teamDataStore.actions.refreshRoster().catch((error) => {
            console.warn("[coach-mileage] refreshRoster on focus failed", error);
          }),
          teamDataStore.actions.loadMileageWeek(focusedWeekStartISO).catch((error) => {
            console.warn("[coach-mileage] loadMileageWeek on focus failed", error);
          }),
        ]);
        if (nextCoachSettings?.distanceUnit) {
          setDistanceUnit(nextCoachSettings.distanceUnit);
          console.log("[coach-mileage] settings reloaded", {
            distanceUnit: nextCoachSettings.distanceUnit,
          });
        }
        if (nextWeekLabels) {
          setWeekLabelsByStart(nextWeekLabels ?? {});
        }
        if (shouldRefreshMeta) {
          lastMileageMetaRefreshAtRef.current = Date.now();
        }
        void teamDataStore.actions.loadTrainingGroups().catch((error) => {
          console.warn("[coach-mileage] loadTrainingGroups on focus failed", error);
        });
        void teamDataStore.actions.loadSharedCoachFilters().catch((error) => {
          console.warn("[coach-mileage] loadSharedCoachFilters on focus failed", error);
        });
        void teamDataStore.actions.loadTeamSeasons().catch((error) => {
          console.warn("[coach-mileage] loadTeamSeasons on focus failed", error);
        });
        void teamDataStore.actions.loadAthleteSeasonOverrides().catch((error) => {
          console.warn("[coach-mileage] loadAthleteSeasonOverrides on focus failed", error);
        });
        const previousWeekStartISO = addDaysISO(focusedWeekStartISO, -7);
        const nextWeekStartISO = addDaysISO(focusedWeekStartISO, 7);
        void teamDataStore.actions.loadMileageWeek(previousWeekStartISO).catch(() => {});
        void teamDataStore.actions.loadMileageWeek(nextWeekStartISO).catch(() => {});
      })();
    }, [loadMileageWeekStartSetting, weekAnchorISO])
  );

  const loadSeasonMileageData = useCallback(async () => {
    if (!seasonMileageTableRange.startISO || !seasonMileageTableRange.endISO) {
      setSeasonMileageWorkoutRows([]);
      setSeasonMileageFeedbackEntries([]);
      setSeasonMileageDailyLogEntries([]);
      setSeasonMileageError(null);
      setSeasonMileageLoading(false);
      return;
    }

    setSeasonMileageLoading(true);
    setSeasonMileageError(null);
    try {
      const [workoutRows, mileageEntries, dailyLogEntries] = await Promise.all([
        listTeamWorkoutsInRange(seasonMileageTableRange.startISO, seasonMileageTableRange.endISO),
        loadMileageFeedback(),
        loadAthleteDailyLogEntries(),
      ]);
      setSeasonMileageWorkoutRows(Array.isArray(workoutRows) ? workoutRows : []);
      setSeasonMileageFeedbackEntries(Array.isArray(mileageEntries) ? mileageEntries : []);
      setSeasonMileageDailyLogEntries(Array.isArray(dailyLogEntries) ? dailyLogEntries : []);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? "Could not load season view mileage.");
      setSeasonMileageWorkoutRows([]);
      setSeasonMileageFeedbackEntries([]);
      setSeasonMileageDailyLogEntries([]);
      setSeasonMileageError(message);
    } finally {
      setSeasonMileageLoading(false);
    }
  }, [seasonMileageTableRange.endISO, seasonMileageTableRange.startISO]);

  const loadSeasonMileagePlannedData = useCallback(async (force = false) => {
    if (seasonMileageWeekStarts.length === 0) {
      setSeasonMileagePlannedError(null);
      setSeasonMileagePlannedLoading(false);
      return;
    }

    const loadSeq = seasonMileageWeeksLoadSeqRef.current + 1;
    seasonMileageWeeksLoadSeqRef.current = loadSeq;
    setSeasonMileagePlannedLoading(true);
    setSeasonMileagePlannedError(null);
    try {
      await teamDataStore.actions.loadMileageWeeks(seasonMileageWeekStarts, force);
    } catch (error: any) {
      if (seasonMileageWeeksLoadSeqRef.current !== loadSeq) return;
      const message = String(error?.message ?? error ?? "Could not load planned mileage.");
      setSeasonMileagePlannedError(message);
    } finally {
      if (seasonMileageWeeksLoadSeqRef.current === loadSeq) {
        setSeasonMileagePlannedLoading(false);
      }
    }
  }, [seasonMileageWeekStarts]);

  useFocusEffect(
    useCallback(() => {
      if (viewMode !== "seasonMileage") return;
      void loadSeasonMileageData();
      void loadSeasonMileagePlannedData(false);
    }, [loadSeasonMileageData, loadSeasonMileagePlannedData, viewMode])
  );

  useEffect(() => {
    if (viewMode !== "seasonMileage") return;
    const missingWeekStarts = seasonMileageWeekStarts.filter((weekISO) => !s.mileageLoadedWeeks[weekISO]);
    if (missingWeekStarts.length === 0) {
      setSeasonMileagePlannedLoading(false);
      return;
    }

    const loadSeq = seasonMileageWeeksLoadSeqRef.current + 1;
    seasonMileageWeeksLoadSeqRef.current = loadSeq;
    setSeasonMileagePlannedLoading(true);
    setSeasonMileagePlannedError(null);
    void teamDataStore.actions
      .loadMileageWeeks(missingWeekStarts)
      .catch((error: any) => {
        if (seasonMileageWeeksLoadSeqRef.current !== loadSeq) return;
        const message = String(error?.message ?? error ?? "Could not load planned mileage.");
        setSeasonMileagePlannedError(message);
      })
      .finally(() => {
        if (seasonMileageWeeksLoadSeqRef.current === loadSeq) {
          setSeasonMileagePlannedLoading(false);
        }
      });
  }, [s.mileageLoadedWeeks, seasonMileageWeekStarts, viewMode]);

  useEffect(() => {
    if (viewMode !== "athleteMultiWeek") return;
    const missingWeekStarts = athleteMultiVisibleWeekStarts.filter((ws) => !s.mileageLoadedWeeks[ws]);
    if (missingWeekStarts.length === 0) {
      setAthleteMultiWeeksLoading(false);
      return;
    }
    const loadSeq = athleteMultiWeeksLoadSeqRef.current + 1;
    athleteMultiWeeksLoadSeqRef.current = loadSeq;
    setAthleteMultiWeeksLoading(true);
    void teamDataStore.actions.loadMileageWeeks(missingWeekStarts).finally(() => {
      if (athleteMultiWeeksLoadSeqRef.current === loadSeq) {
        setAthleteMultiWeeksLoading(false);
      }
    });
  }, [athleteMultiVisibleWeekStarts, s.mileageLoadedWeeks, viewMode]);

  useEffect(() => {
    if (viewMode === "athleteMultiWeek") {
      setTrainingGroupFilterOpen(false);
    }
  }, [viewMode]);

  useEffect(() => {
    setSeasonFilterOpen(false);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "teamWeek") return;
    setActiveGridId((prev) => (prev === MILEAGE_GRID_ID ? null : prev));
  }, [selectedTrainingGroupIds, selectedSeasonId, viewMode]);

  function buildWeekCellsLookup(targetWeekStartISO: string, targetWeekCells: any[]): Record<CellKey, MileageValue | null> {
    const lookup: Record<CellKey, MileageValue | null> = {};
    for (const row of targetWeekCells ?? []) {
      const athleteId = String(row?.athlete_profile_id ?? "");
      const dayIdx = Number(row?.day_idx);
      const session = String(row?.session ?? "").toUpperCase();
      if (!athleteId || !Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) continue;
      const field: CellField = session === "PM" ? "pm" : "am";
      lookup[cellCloudKey(athleteId, targetWeekStartISO, dayIdx, field)] = (row?.value ?? null) as MileageValue | null;
    }
    return lookup;
  }

  function cellKey(athleteId: string, dayIdx: number, field: "am" | "pm") {
    return `${athleteId}__${dayIdx}__${field}`;
  }

  async function setCellCloud(
    athleteId: string,
    targetWeekStartISO: string,
    dayIdx: number,
    field: "am" | "pm",
    text: string
  ): Promise<boolean> {
    const trimmed = String(text ?? "").trim();
    const value = trimmed ? parseMileageInput(trimmed) : null;
    if (trimmed && !value) return false;

    await teamDataStore.actions.setMileageCell(
      athleteId,
      targetWeekStartISO,
      dayIdx,
      field === "am" ? "AM" : "PM",
      value
    );

    return true;
  }

  async function copyPreviousWeekAll() {
    const message =
      "Copy all AM/PM values from the previous week into the currently visible week?";

    const runCopy = async () => {
      const previousWeekStartISO = addDaysISO(weekStartISO, -7);
      await teamDataStore.actions.loadMileageWeek(previousWeekStartISO);

      const refreshedState = teamDataStore.getState();
      const previousWeekCells =
        (s.mileageCellsByWeek[previousWeekStartISO] ?? refreshedState.mileageCellsByWeek[previousWeekStartISO] ?? []) as any[];
      const previousCellsByKey = buildWeekCellsLookup(previousWeekStartISO, previousWeekCells);

      let copiedValueCount = 0;
      const writePromises: Array<Promise<void>> = [];
      for (const athlete of athletesWithIds) {
        const athleteId = athlete.id;
        if (!athleteId) continue;
        for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
          const am = previousCellsByKey[cellCloudKey(athleteId, previousWeekStartISO, dayIdx, "am")] ?? null;
          const pm = previousCellsByKey[cellCloudKey(athleteId, previousWeekStartISO, dayIdx, "pm")] ?? null;
          if (am != null) {
            writePromises.push(teamDataStore.actions.setMileageCell(athleteId, weekStartISO, dayIdx, "AM", am));
            copiedValueCount += 1;
          }
          if (pm != null) {
            writePromises.push(teamDataStore.actions.setMileageCell(athleteId, weekStartISO, dayIdx, "PM", pm));
            copiedValueCount += 1;
          }
        }
      }
      if (writePromises.length > 0) {
        await Promise.all(writePromises);
      }

      if (copiedValueCount > 0) {
        showActionBanner("Previous week copied");
      } else {
        Alert.alert("Copy Previous Week", "No mileage found in previous week");
      }
    };

    if (Platform.OS === "web") {
      const ok = typeof window !== "undefined" ? window.confirm(message) : false;
      if (ok) await runCopy();
      return;
    }

    Alert.alert("Copy Previous Week?", message, [
      { text: "Cancel", style: "cancel" },
      { text: "Copy", style: "destructive", onPress: () => void runCopy() },
    ]);
  }

  async function clearEntireWeekAll() {
    const message =
      "This will clear all AM/PM values and NCAA Off flags for the currently visible week.";

    const runClear = async () => {
      const clearPromises: Array<Promise<void>> = [];
      for (const athlete of athletesWithIds) {
        if (!athlete.id) continue;
        for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
          clearPromises.push(teamDataStore.actions.setMileageCell(athlete.id, weekStartISO, dayIdx, "AM", null));
          clearPromises.push(teamDataStore.actions.setMileageCell(athlete.id, weekStartISO, dayIdx, "PM", null));
          clearPromises.push(teamDataStore.actions.setMileageOffFlag(athlete.id, weekStartISO, dayIdx, false));
        }
      }
      if (clearPromises.length > 0) {
        await Promise.all(clearPromises);
      }
      setInvalidCells({});
      showActionBanner("Entire week cleared");
    };

    if (Platform.OS === "web") {
      const ok = typeof window !== "undefined" ? window.confirm(message) : false;
      if (ok) await runClear();
      return;
    }

    Alert.alert("Clear Entire Week?", message, [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: () => void runClear() },
    ]);
  }

  function jumpToCurrentWeek() {
    setWeekAnchorISO(toISODate(new Date()));
    setJumpToWeekOpen(false);
    showActionBanner("Showing current week");
  }

  function applyJumpToWeekInput() {
    const ok = jumpToWeekFromDateISO(jumpDateInput);
    if (!ok) {
      Alert.alert("Jump to Week", "Enter a valid date as YYYY-MM-DD.");
      return;
    }
    setJumpToWeekOpen(false);
    showActionBanner("Week updated");
  }

  const persistWeekLabelDraft = useCallback(
    async (targetWeekStartISO: string, nextDraftRaw: string) => {
      const seq = ++weekLabelSaveSeqRef.current;
      setWeekLabelSaveState("saving");
      try {
        const next = await saveCoachWeekLabel(targetWeekStartISO, nextDraftRaw);
        if (seq !== weekLabelSaveSeqRef.current) return;
        setWeekLabelsByStart(next ?? {});
        setWeekLabelSaveState("saved");
      } catch (error: any) {
        if (seq !== weekLabelSaveSeqRef.current) return;
        setWeekLabelSaveState("error");
        Alert.alert("Week label", String(error?.message ?? "Could not save week label."));
      }
    },
    []
  );

  const persistWeekLabelType = useCallback(
    async (targetWeekStartISO: string, nextType: WeekLabelType) => {
      const seq = ++weekLabelSaveSeqRef.current;
      setWeekLabelSaveState("saving");
      try {
        const next = await saveCoachWeekLabelType(targetWeekStartISO, nextType);
        if (seq !== weekLabelSaveSeqRef.current) return;
        setWeekLabelsByStart(next ?? {});
        setWeekLabelSaveState("saved");
      } catch (error: any) {
        if (seq !== weekLabelSaveSeqRef.current) return;
        setWeekLabelSaveState("error");
        Alert.alert("Week type", String(error?.message ?? "Could not save week type."));
      }
    },
    []
  );

  useEffect(() => {
    if (!isWeekLabelEditing) return;
    if (weekLabelEditingWeekRef.current !== weekStartISO) return;
    if (weekLabelDraft === currentWeekLabel) return;

    if (weekLabelSaveTimerRef.current) clearTimeout(weekLabelSaveTimerRef.current);
    setWeekLabelSaveState("idle");
    weekLabelSaveTimerRef.current = setTimeout(() => {
      weekLabelSaveTimerRef.current = null;
      void persistWeekLabelDraft(weekStartISO, weekLabelDraft);
    }, 650);

    return () => {
      if (weekLabelSaveTimerRef.current) {
        clearTimeout(weekLabelSaveTimerRef.current);
        weekLabelSaveTimerRef.current = null;
      }
    };
  }, [currentWeekLabel, isWeekLabelEditing, persistWeekLabelDraft, weekLabelDraft, weekStartISO]);

  const handleWeekLabelFocus = useCallback(() => {
    weekLabelEditingWeekRef.current = weekStartISO;
    setIsWeekLabelEditing(true);
    setWeekLabelSaveState("idle");
  }, [weekStartISO]);

  const handleWeekLabelBlur = useCallback(() => {
    if (weekLabelSaveTimerRef.current) {
      clearTimeout(weekLabelSaveTimerRef.current);
      weekLabelSaveTimerRef.current = null;
    }
    const editingWeek = weekLabelEditingWeekRef.current;
    const draftAtBlur = weekLabelDraft;
    const savedAtBlur = currentWeekLabel;
    setIsWeekLabelEditing(false);
    weekLabelEditingWeekRef.current = null;
    if (editingWeek && draftAtBlur !== savedAtBlur) {
      void persistWeekLabelDraft(editingWeek, draftAtBlur);
    }
  }, [currentWeekLabel, persistWeekLabelDraft, weekLabelDraft]);

  function copyEntireVisibleWeek() {
    const cells: WeekClipboard["cells"] = [];
    const flags: WeekClipboard["flags"] = [];
    for (const athlete of athletesWithIds) {
      const athleteId = String(athlete.id ?? "");
      if (!athleteId) continue;
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        cells.push({
          athleteId,
          dayIdx,
          session: "AM",
          value: (cellsByKey[cellCloudKey(athleteId, weekStartISO, dayIdx, "am")] ?? null) as MileageValue | null,
        });
        cells.push({
          athleteId,
          dayIdx,
          session: "PM",
          value: (cellsByKey[cellCloudKey(athleteId, weekStartISO, dayIdx, "pm")] ?? null) as MileageValue | null,
        });
        flags.push({
          athleteId,
          dayIdx,
          ncaaOff: !!ncaaOffByKey[offKey(athleteId, weekStartISO, dayIdx)],
        });
      }
    }
    setWeekClipboard({
      sourceWeekStartISO: weekStartISO,
      copiedAtMs: Date.now(),
      cells,
      flags,
    });
    showActionBanner("Week copied");
  }

  async function pasteWeekClipboardIntoVisibleWeek() {
    if (!weekClipboard) return;
    const message = `Overwrite ${weekRangeLabel} with copied week from ${weekClipboard.sourceWeekStartISO}?`;
    const runPaste = async () => {
      const activeIds = new Set(editableAthleteIds);
      const writes: Array<Promise<void>> = [];
      for (const row of weekClipboard.cells) {
        if (!activeIds.has(row.athleteId)) continue;
        writes.push(
          teamDataStore.actions.setMileageCell(row.athleteId, weekStartISO, row.dayIdx, row.session, row.value)
        );
      }
      for (const row of weekClipboard.flags) {
        if (!activeIds.has(row.athleteId)) continue;
        writes.push(teamDataStore.actions.setMileageOffFlag(row.athleteId, weekStartISO, row.dayIdx, !!row.ncaaOff));
      }
      if (writes.length > 0) {
        await Promise.all(writes);
      }
      setInvalidCells({});
      showActionBanner("Week pasted");
    };

    if (Platform.OS === "web") {
      const ok = typeof window !== "undefined" ? window.confirm(message) : false;
      if (ok) await runPaste();
      return;
    }

    Alert.alert("Paste Week?", message, [
      { text: "Cancel", style: "cancel" },
      { text: "Paste", style: "destructive", onPress: () => void runPaste() },
    ]);
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
    () => teamWeekVisibleAthletes.filter((a) => !!a.id).map((a) => a.id),
    [teamWeekVisibleAthletes]
  );

  const mileageColKeys = useMemo(
    () =>
      Array.from({ length: 7 }).flatMap((_, dayIdx) => [
        mileageColKey(dayIdx, "am"),
        mileageColKey(dayIdx, "pm"),
      ]),
    [mileageColKey]
  );

  const queueMileageDraftSave = useCallback(
    (cloudKey: string, delayMs = 420) => {
      const meta = draftKeyMetaRef.current[cloudKey];
      if (!meta) return;
      const existing = mileageSaveTimersRef.current[cloudKey];
      if (existing) clearTimeout(existing);
      delete mileageSaveTimersRef.current[cloudKey];

      pendingDraftSaveKeysRef.current.add(cloudKey);
      mileageSaveTimersRef.current[cloudKey] = setTimeout(async () => {
        if (editingCloudKeyRef.current === cloudKey) {
          // Keep the raw draft isolated while the user is actively editing.
          queueMileageDraftSave(cloudKey, 220);
          return;
        }

        const latestText = String(mileageDraftsRef.current[cloudKey] ?? "");
        const latestTrimmed = latestText.trim();
        const latestParsed = latestTrimmed ? parseMileageInput(latestTrimmed) : null;
        const latestInvalid = !!latestTrimmed && !latestParsed;
        const saveGeneration = mileageDraftGenerationRef.current[cloudKey] ?? 0;

        if (latestInvalid) {
          setInvalidCells((prev) => ({ ...prev, [meta.uiKey]: true }));
          if ((mileageDraftGenerationRef.current[cloudKey] ?? 0) === saveGeneration) {
            pendingDraftSaveKeysRef.current.delete(cloudKey);
          }
          delete mileageSaveTimersRef.current[cloudKey];
          return;
        }

        try {
          const ok = await setCellCloud(meta.athleteId, meta.weekStartISO, meta.dayIdx, meta.field, latestText);
          const stillLatestGeneration = (mileageDraftGenerationRef.current[cloudKey] ?? 0) === saveGeneration;
          setInvalidCells((prev) => {
            const next = { ...prev };
            if (ok) delete next[meta.uiKey];
            else next[meta.uiKey] = true;
            return next;
          });
          if (ok && editingCloudKeyRef.current !== cloudKey && stillLatestGeneration) {
            const normalized =
              latestTrimmed && latestParsed
                ? String(formatMileageForSheet(latestParsed as any) ?? "")
                : "";
            setMileageDraftsByKey((prev) => ({
              ...prev,
              [cloudKey]: normalized,
            }));
          }
        } catch {
          // Keep local draft; cloud retry will happen on subsequent edits.
        } finally {
          const stillLatestGeneration = (mileageDraftGenerationRef.current[cloudKey] ?? 0) === saveGeneration;
          delete mileageSaveTimersRef.current[cloudKey];
          if (stillLatestGeneration && !mileageSaveTimersRef.current[cloudKey]) {
            pendingDraftSaveKeysRef.current.delete(cloudKey);
          }
        }
      }, delayMs);
    },
    [setCellCloud]
  );

  const applyMileageValueBatch = useCallback(
    (changes: Array<{ athleteId: string; colKey: string; value: string }>) => {
      if (changes.length === 0) return;
      const draftPatch: Record<string, string> = {};
      const invalidToSet = new Set<string>();
      const invalidToClear = new Set<string>();

      for (const change of changes) {
        const { athleteId, colKey } = change;
        const { dayIdx, field } = mileageColMeta(colKey);
        const cloudKey = cellCloudKey(athleteId, weekStartISO, dayIdx, field);
        const uiKey = cellKey(athleteId, dayIdx, field);
        const nextText = String(change.value ?? "");
        const trimmed = nextText.trim();
        const parsed = trimmed ? parseMileageInput(trimmed) : null;
        const isInvalid = !!trimmed && !parsed;
        const isEditingThisCell = editingCloudKeyRef.current === cloudKey;

        draftKeyMetaRef.current[cloudKey] = { athleteId, weekStartISO, dayIdx, field, uiKey };
        draftPatch[cloudKey] = nextText;
        mileageDraftGenerationRef.current[cloudKey] = (mileageDraftGenerationRef.current[cloudKey] ?? 0) + 1;

        if (isInvalid) invalidToSet.add(uiKey);
        else invalidToClear.add(uiKey);

        const existing = mileageSaveTimersRef.current[cloudKey];
        if (existing) clearTimeout(existing);
        delete mileageSaveTimersRef.current[cloudKey];

        if (isInvalid) {
          if (isEditingThisCell) pendingDraftSaveKeysRef.current.add(cloudKey);
          else pendingDraftSaveKeysRef.current.delete(cloudKey);
          continue;
        }

        if (isEditingThisCell) {
          pendingDraftSaveKeysRef.current.add(cloudKey);
          continue;
        }

        queueMileageDraftSave(cloudKey, 420);
      }

      setMileageDraftsByKey((prev) => ({ ...prev, ...draftPatch }));
      setInvalidCells((prev) => {
        const next = { ...prev };
        invalidToSet.forEach((key) => {
          next[key] = true;
        });
        invalidToClear.forEach((key) => {
          if (!invalidToSet.has(key)) delete next[key];
        });
        return next;
      });
    },
    [mileageColMeta, queueMileageDraftSave, weekStartISO]
  );

  const mileageGrid = useGridEngine<string, string>({
    enabled: isWeb && isDesktop && !readOnlyMileage,
    rowIds: editableAthleteIds,
    colKeys: mileageColKeys,
    onActivate: () => setActiveGridId(MILEAGE_GRID_ID),
    getValue: (athleteId, colKey) => {
      const { dayIdx, field } = mileageColMeta(colKey);
      const key = cellCloudKey(athleteId, weekStartISO, dayIdx, field);
      return String(mileageDraftsByKey[key] ?? "");
    },
    setValuesBatch: (changes) => {
      if (readOnlyMileage) return;
      applyMileageValueBatch(
        changes.map((change) => ({
          athleteId: change.rowId,
          colKey: change.colKey,
          value: change.value,
        }))
      );
    },
    setValue: (athleteId, colKey, value) => {
      applyMileageValueBatch([{ athleteId, colKey, value: String(value ?? "") }]);
    },
  });

  const editingCloudKey = useMemo(() => {
    const editing = mileageGrid.editingCell;
    if (!editing) return null;
    const { dayIdx, field } = mileageColMeta(editing.colKey);
    return cellCloudKey(editing.rowId, weekStartISO, dayIdx, field);
  }, [mileageColMeta, mileageGrid.editingCell, weekStartISO]);

  useEffect(() => {
    const prev = editingCloudKeyRef.current;
    editingCloudKeyRef.current = editingCloudKey;
    if (prev && prev !== editingCloudKey && pendingDraftSaveKeysRef.current.has(prev)) {
      queueMileageDraftSave(prev, 80);
    }
  }, [editingCloudKey, queueMileageDraftSave]);

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
        const isCurrentlyEditing = editingCloudKeyRef.current === key;
        const hasPendingSave =
          pendingDraftSaveKeysRef.current.has(key) || !!mileageSaveTimersRef.current[key];
        if ((hasPendingSave || isCurrentlyEditing) && key in prev) {
          merged[key] = prev[key];
        }
      });
      return merged;
    });
    setInvalidCells({});
  }, [cellsByKey, editableAthleteIds, weekStartISO]);

  useEffect(() => {
    if (!athleteMultiSelectedId) return;
    const nextDrafts: Record<string, string> = {};
    athleteMultiSeasonVisibleWeekStarts.forEach((weekISO) => {
      const weekRows = s.mileageCellsByWeek[weekISO] ?? [];
      const weekLookup = buildWeekCellsLookup(weekISO, weekRows as any[]);
      for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
        (["am", "pm"] as const).forEach((field) => {
          const key = cellCloudKey(athleteMultiSelectedId, weekISO, dayIdx, field);
          nextDrafts[key] = String(formatMileageForSheet(weekLookup[key] as any) ?? "");
        });
      }
    });
    setMileageDraftsByKey((prev) => {
      const merged = { ...prev, ...nextDrafts };
      Object.keys(nextDrafts).forEach((key) => {
        const isCurrentlyEditing = editingCloudKeyRef.current === key;
        const hasPendingSave = pendingDraftSaveKeysRef.current.has(key) || !!mileageSaveTimersRef.current[key];
        if ((hasPendingSave || isCurrentlyEditing) && key in prev) {
          merged[key] = prev[key];
        }
      });
      return merged;
    });
  }, [athleteMultiSeasonVisibleWeekStarts, athleteMultiSelectedId, s.mileageCellsByWeek]);

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
    if (rect.r2 <= rect.r1) return;
    const sourceId = editableAthleteIds[rect.r1];
    if (!sourceId) return;
    const changes: Array<{ rowId: string; colKey: string; prev: string; next: string }> = [];
    for (let r = rect.r1 + 1; r <= rect.r2; r += 1) {
      const rowId = editableAthleteIds[r];
      if (!rowId) continue;
      for (let c = rect.c1; c <= rect.c2; c += 1) {
        const colKey = mileageColKeys[c];
        if (!colKey) continue;
        changes.push({
          rowId,
          colKey,
          prev: getMileageDraftValue(rowId, colKey),
          next: getMileageDraftValue(sourceId, colKey),
        });
      }
    }
    mileageGrid.applyChanges(changes as any);
  }, [editableAthleteIds, getMileageDraftValue, mileageColKeys, mileageGrid]);

  useEffect(() => {
    if (!(isWeb && isDesktop)) return;
    const onKeyDown = (e: any) => {
      const doc = (globalThis as any)?.document;
      if (isTextEditingTarget(e?.target) || isTextEditingTarget(doc?.activeElement)) return;
      const handled = activeGridId === MILEAGE_GRID_ID ? mileageGrid.handleKeyDown(e) : false;
      if (!handled) return;
      e.preventDefault?.();
      e.stopPropagation?.();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activeGridId, fillSelectedMileage, isDesktop, isWeb, mileageGrid]);

  const athleteMultiSelected = useMemo(
    () => athletesWithIds.find((a) => a.id === athleteMultiSelectedId) ?? null,
    [athleteMultiSelectedId, athletesWithIds]
  );
  const athleteSearchResults = useMemo(() => {
    const q = athleteSearchQuery.trim().toLowerCase();
    if (!q) return athletesWithIds.slice(0, 40);
    return athletesWithIds
      .filter((a) => a.name.toLowerCase().includes(q))
      .slice(0, 40);
  }, [athleteSearchQuery, athletesWithIds]);
  const athleteMultiCurrentWeekStartISO = useMemo(
    () => getWeekStartISO(toISODate(new Date()), weekStartsOn),
    [weekStartsOn]
  );
  useEffect(() => {
    if (!isValidISODate(athleteMultiFirstWeekStartISO)) {
      setAthleteMultiRangeError("Choose a valid first week.");
      return;
    }
    if (!Number.isInteger(athleteMultiNumberOfWeeks) || athleteMultiNumberOfWeeks < 1) {
      setAthleteMultiRangeError("Weeks to show must be at least 1.");
      return;
    }
    if (athleteMultiNumberOfWeeks > MAX_MILEAGE_RANGE_WEEKS) {
      setAthleteMultiRangeError(`Please choose ${MAX_MILEAGE_RANGE_WEEKS} weeks or less.`);
      return;
    }
    setAthleteMultiRangeError(athleteMultiExcludedSeasonMessage);
  }, [athleteMultiExcludedSeasonMessage, athleteMultiFirstWeekStartISO, athleteMultiNumberOfWeeks]);

  const resolveAthleteSeasonRange = useCallback(() => {
    const athleteId = String(athleteMultiSelectedId ?? "").trim();
    if (!athleteId || !selectedSeason) return null;
    if (isAthleteExcludedFromSeason(athleteId, String(selectedSeason.id ?? "").trim(), s.athleteSeasonOverrides ?? [])) {
      return { excluded: true as const, message: "Selected athlete is excluded from the selected season." };
    }
    const athlete = (s.roster ?? []).find((row) => String((row as any)?.id ?? "").trim() === athleteId);
    const override = athleteSeasonOverridesBySeasonAndAthlete.get(
      `${String(selectedSeason.id ?? "").trim()}:${athleteId}`
    ) ?? null;
    const resolved = resolveAthleteSeasonWindowWithTenure(athlete ?? null, selectedSeason as any, override as any);
    const start = String(resolved.start_date ?? "").trim();
    const end = String(resolved.end_date ?? "").trim();
    if (!isValidISODate(start) || !isValidISODate(end) || end < start) {
      return { excluded: true as const, message: "Selected season has an invalid date range for this athlete." };
    }
    return { excluded: false as const, start, end };
  }, [athleteMultiSelectedId, athleteSeasonOverridesBySeasonAndAthlete, s.athleteSeasonOverrides, s.roster, selectedSeason]);

  const applySelectedSeasonToAthleteRange = useCallback(() => {
    const resolved = resolveAthleteSeasonRange();
    if (!resolved) return;
    if (resolved.excluded) {
      setAthleteMultiExcludedSeasonMessage(resolved.message);
      setAthleteMultiRangeError(resolved.message);
      return;
    }
    setAthleteMultiExcludedSeasonMessage(null);
    const firstWeekStart = getWeekStartISO(resolved.start, weekStartsOn);
    const lastWeekStart = getWeekStartISO(resolved.end, weekStartsOn);
    const numberOfWeeks = Math.min(
      MAX_MILEAGE_RANGE_WEEKS,
      Math.max(1, Math.floor((isoDayNumber(lastWeekStart) - isoDayNumber(firstWeekStart)) / 7) + 1)
    );
    setAthleteMultiFirstWeekStartISO(firstWeekStart);
    setAthleteMultiNumberOfWeeks(numberOfWeeks);
    setMileageRangeFromDates(resolved.start, resolved.end);
    setAthleteMultiRangeError(null);
    setAthleteMultiRangeMode("season");
  }, [resolveAthleteSeasonRange, setMileageRangeFromDates, weekStartsOn]);

  useEffect(() => {
    if (athleteMultiRangeMode !== "season") return;
    const resolved = resolveAthleteSeasonRange();
    if (!resolved) return;
    if (resolved.excluded) {
      setAthleteMultiExcludedSeasonMessage(resolved.message);
      setAthleteMultiRangeError(resolved.message);
      return;
    }
    setAthleteMultiExcludedSeasonMessage(null);
    const firstWeekStart = getWeekStartISO(resolved.start, weekStartsOn);
    const lastWeekStart = getWeekStartISO(resolved.end, weekStartsOn);
    const numberOfWeeks = Math.min(
      MAX_MILEAGE_RANGE_WEEKS,
      Math.max(1, Math.floor((isoDayNumber(lastWeekStart) - isoDayNumber(firstWeekStart)) / 7) + 1)
    );
    if (athleteMultiFirstWeekStartISO !== firstWeekStart) setAthleteMultiFirstWeekStartISO(firstWeekStart);
    if (athleteMultiNumberOfWeeks !== numberOfWeeks) setAthleteMultiNumberOfWeeks(numberOfWeeks);
    if (mileageRangeStartISO !== resolved.start || mileageRangeEndISO !== resolved.end) {
      setMileageRangeFromDates(resolved.start, resolved.end);
    }
    setAthleteMultiRangeError(null);
  }, [
    athleteMultiFirstWeekStartISO,
    athleteMultiNumberOfWeeks,
    athleteMultiRangeMode,
    mileageRangeEndISO,
    mileageRangeStartISO,
    resolveAthleteSeasonRange,
    setMileageRangeFromDates,
    weekStartsOn,
  ]);
  const athleteMultiVisibleRange = useMemo(() => {
    const starts = athleteMultiVisibleWeekStarts;
    if (!starts.length) {
      const ws = athleteMultiRangeStartWeekISO;
      return { startISO: ws, endISO: addDaysISO(ws, 27) };
    }
    const startISO = starts[0];
    const endISO = addDaysISO(starts[starts.length - 1], 6);
    return { startISO, endISO };
  }, [athleteMultiRangeStartWeekISO, athleteMultiVisibleWeekStarts]);

  const athleteMultiVisibleRangeLabel = useMemo(() => {
    const start = isValidISODate(athleteMultiRangeStartISO) ? athleteMultiRangeStartISO : athleteMultiVisibleRange.startISO;
    const end = isValidISODate(athleteMultiRangeEndISO) ? athleteMultiRangeEndISO : athleteMultiVisibleRange.endISO;
    const startLabel = parseISODate(start).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endLabel = parseISODate(end).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const weeksLabel = `${athleteMultiSafeWeekCount} week${athleteMultiSafeWeekCount === 1 ? "" : "s"}`;
    return `${startLabel} - ${endLabel} • ${weeksLabel}`;
  }, [
    athleteMultiRangeEndISO,
    athleteMultiRangeStartISO,
    athleteMultiSafeWeekCount,
    athleteMultiVisibleRange.endISO,
    athleteMultiVisibleRange.startISO,
  ]);

  const openAthleteRangeEditor = useCallback(() => {
    setAthleteRangeDraftFirstWeekISO(athleteMultiFirstWeekStartISO);
    setAthleteRangeDraftWeekCount(String(athleteMultiSafeWeekCount));
    setAthleteRangeDraftError(null);
    setAthleteRangeEditorOpen(true);
  }, [athleteMultiFirstWeekStartISO, athleteMultiSafeWeekCount]);

  const applyAthleteRangeDraft = useCallback(() => {
    const firstWeekInput = String(athleteRangeDraftFirstWeekISO ?? "").trim();
    const firstWeekStart = isValidISODate(firstWeekInput) ? getWeekStartISO(firstWeekInput, weekStartsOn) : "";
    const weeksRaw = Number.parseInt(String(athleteRangeDraftWeekCount ?? "").trim(), 10);
    if (!isValidISODate(firstWeekStart)) {
      setAthleteRangeDraftError("Choose a valid first-week date (YYYY-MM-DD).");
      return;
    }
    if (!Number.isInteger(weeksRaw)) {
      setAthleteRangeDraftError("Weeks to show must be a whole number.");
      return;
    }
    const safeWeeks = Math.min(MAX_MILEAGE_RANGE_WEEKS, Math.max(1, weeksRaw));
    if (safeWeeks !== weeksRaw) {
      setAthleteRangeDraftError(`Weeks to show must be between 1 and ${MAX_MILEAGE_RANGE_WEEKS}.`);
      return;
    }
    setAthleteMultiFirstWeekStartISO(firstWeekStart);
    setAthleteMultiNumberOfWeeks(safeWeeks);
    setMileageRangeFromDates(firstWeekStart, addDaysISO(firstWeekStart, safeWeeks * 7 - 1));
    setAthleteMultiRangeMode("custom");
    void teamDataStore.actions.setSharedSelectedSeasonId(null);
    setAthleteMultiExcludedSeasonMessage(null);
    setAthleteRangeEditorOpen(false);
    setAthleteRangeDraftError(null);
  }, [athleteRangeDraftFirstWeekISO, athleteRangeDraftWeekCount, setMileageRangeFromDates, weekStartsOn]);

  const openMileagePlanExport = useCallback(() => {
    if (!athleteMultiSelectedId) {
      Alert.alert("Select athlete", "Choose an athlete in Athlete Multi-Week before exporting a mileage plan.");
      return;
    }
    setMileagePlanExportStartISO(athleteMultiRangeStartISO);
    setMileagePlanExportEndISO(athleteMultiRangeEndISO);
    setMileagePlanExportSeasonId(selectedSeasonId ?? null);
    setMileagePlanExportError(null);
    setMileagePlanExportOpen(true);
  }, [athleteMultiRangeEndISO, athleteMultiRangeStartISO, athleteMultiSelectedId, selectedSeasonId]);

  const applyMileagePlanSeasonRange = useCallback((seasonId: string | null) => {
    const athleteId = String(athleteMultiSelectedId ?? "").trim();
    const normalizedSeasonId = String(seasonId ?? "").trim();
    if (!athleteId || !normalizedSeasonId) {
      setMileagePlanExportSeasonId(null);
      return;
    }
    const season = (s.teamSeasons ?? []).find((row) => String(row?.id ?? "").trim() === normalizedSeasonId);
    if (!season) return;
    if (isAthleteExcludedFromSeason(athleteId, normalizedSeasonId, s.athleteSeasonOverrides ?? [])) {
      setMileagePlanExportError("This athlete is excluded from that season.");
      return;
    }
    const athlete = (s.roster ?? []).find((row) => String((row as any)?.id ?? "").trim() === athleteId);
    const override =
      (s.athleteSeasonOverrides ?? []).find(
        (row) =>
          String(row?.season_id ?? "").trim() === normalizedSeasonId &&
          String(row?.athlete_profile_id ?? "").trim() === athleteId
      ) ?? null;
    const resolved = resolveAthleteSeasonWindowWithTenure(athlete ?? null, season as any, override as any);
    setMileagePlanExportStartISO(String(resolved.start_date ?? "").trim());
    setMileagePlanExportEndISO(String(resolved.end_date ?? "").trim());
    setMileagePlanExportSeasonId(normalizedSeasonId);
    setMileagePlanExportError(null);
  }, [athleteMultiSelectedId, s.athleteSeasonOverrides, s.roster, s.teamSeasons]);

  const shiftMileagePlanExportDate = useCallback((field: "start" | "end", deltaDays: number) => {
    const current = field === "start" ? mileagePlanExportStartISO : mileagePlanExportEndISO;
    const next = addDaysISO(current, deltaDays);
    if (field === "start") setMileagePlanExportStartISO(next);
    else setMileagePlanExportEndISO(next);
    if (mileagePlanExportSeasonId) setMileagePlanExportSeasonId(null);
    setMileagePlanExportError(null);
  }, [mileagePlanExportEndISO, mileagePlanExportSeasonId, mileagePlanExportStartISO]);

  const athleteMultiRowIds = useMemo(
    () => athleteMultiSeasonVisibleWeekStarts,
    [athleteMultiSeasonVisibleWeekStarts]
  );
  const athleteMultiColKeys = mileageColKeys;

  const getAthleteMultiDraftValue = useCallback(
    (weekISO: string, colKey: string) => {
      if (!athleteMultiSelectedId) return "";
      const { dayIdx, field } = mileageColMeta(colKey);
      const cloudKey = cellCloudKey(athleteMultiSelectedId, weekISO, dayIdx, field);
      return String(mileageDraftsByKey[cloudKey] ?? "");
    },
    [athleteMultiSelectedId, mileageColMeta, mileageDraftsByKey]
  );

  const applyAthleteMultiValueBatch = useCallback(
    (changes: Array<{ weekStartISO: string; colKey: string; value: string }>) => {
      if (!athleteMultiSelectedId || changes.length === 0) return;
      const draftPatch: Record<string, string> = {};
      const invalidToSet = new Set<string>();
      const invalidToClear = new Set<string>();
      for (const change of changes) {
        const { weekStartISO: targetWeekStartISO, colKey } = change;
        const { dayIdx, field } = mileageColMeta(colKey);
        const cloudKey = cellCloudKey(athleteMultiSelectedId, targetWeekStartISO, dayIdx, field);
        const uiKey = `${athleteMultiSelectedId}__${targetWeekStartISO}__${dayIdx}__${field}`;
        const nextText = String(change.value ?? "");
        const trimmed = nextText.trim();
        const parsed = trimmed ? parseMileageInput(trimmed) : null;
        const isInvalid = !!trimmed && !parsed;
        const isEditingThisCell = editingCloudKeyRef.current === cloudKey;
        draftKeyMetaRef.current[cloudKey] = {
          athleteId: athleteMultiSelectedId,
          weekStartISO: targetWeekStartISO,
          dayIdx,
          field,
          uiKey,
        };
        draftPatch[cloudKey] = nextText;
        mileageDraftGenerationRef.current[cloudKey] = (mileageDraftGenerationRef.current[cloudKey] ?? 0) + 1;
        if (isInvalid) invalidToSet.add(uiKey);
        else invalidToClear.add(uiKey);
        const existing = mileageSaveTimersRef.current[cloudKey];
        if (existing) clearTimeout(existing);
        delete mileageSaveTimersRef.current[cloudKey];
        if (isInvalid) {
          if (isEditingThisCell) pendingDraftSaveKeysRef.current.add(cloudKey);
          else pendingDraftSaveKeysRef.current.delete(cloudKey);
          continue;
        }
        if (isEditingThisCell) {
          pendingDraftSaveKeysRef.current.add(cloudKey);
          continue;
        }
        queueMileageDraftSave(cloudKey, 420);
      }
      setMileageDraftsByKey((prev) => ({ ...prev, ...draftPatch }));
      setInvalidCells((prev) => {
        const next = { ...prev };
        invalidToSet.forEach((key) => {
          next[key] = true;
        });
        invalidToClear.forEach((key) => {
          if (!invalidToSet.has(key)) delete next[key];
        });
        return next;
      });
    },
    [athleteMultiSelectedId, mileageColMeta, queueMileageDraftSave]
  );

  const athleteMultiGrid = useGridEngine<string, string>({
    enabled: isWeb && isDesktop && viewMode === "athleteMultiWeek" && !readOnlyMileage,
    rowIds: athleteMultiRowIds,
    colKeys: athleteMultiColKeys,
    onActivate: () => setActiveGridId("athlete-multi-grid"),
    getValue: (weekISO, colKey) => getAthleteMultiDraftValue(weekISO, colKey),
    setValuesBatch: (changes) => {
      if (readOnlyMileage) return;
      return (
      applyAthleteMultiValueBatch(
        changes.map((change) => ({
          weekStartISO: change.rowId,
          colKey: change.colKey,
          value: change.value,
        }))
      ));
    },
    setValue: (weekISO, colKey, value) => {
      if (readOnlyMileage) return;
      applyAthleteMultiValueBatch([{ weekStartISO: weekISO, colKey, value: String(value ?? "") }]);
    },
  });

  const athleteMultiEditingCloudKey = useMemo(() => {
    const editing = athleteMultiGrid.editingCell;
    if (!editing || !athleteMultiSelectedId) return null;
    const { dayIdx, field } = mileageColMeta(editing.colKey);
    return cellCloudKey(athleteMultiSelectedId, editing.rowId, dayIdx, field);
  }, [athleteMultiGrid.editingCell, athleteMultiSelectedId, mileageColMeta]);

  useEffect(() => {
    if (viewMode !== "athleteMultiWeek") return;
    const prev = editingCloudKeyRef.current;
    editingCloudKeyRef.current = athleteMultiEditingCloudKey;
    if (prev && prev !== athleteMultiEditingCloudKey && pendingDraftSaveKeysRef.current.has(prev)) {
      queueMileageDraftSave(prev, 80);
    }
  }, [athleteMultiEditingCloudKey, queueMileageDraftSave, viewMode]);

  useEffect(() => {
    if (!(isWeb && isDesktop)) return;
    const onKeyDown = (e: any) => {
      if (activeGridId !== "athlete-multi-grid") return;
      const doc = (globalThis as any)?.document;
      if (isTextEditingTarget(e?.target) || isTextEditingTarget(doc?.activeElement)) return;
      const handled = athleteMultiGrid.handleKeyDown(e);
      if (!handled) return;
      e.preventDefault?.();
      e.stopPropagation?.();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activeGridId, athleteMultiGrid, isDesktop, isWeb]);

  const athleteMultiWeekTotals = useMemo(() => {
    const map = new Map<string, string>();
    if (!athleteMultiSelectedId) return map;
    const pace = resolveAthletePaceSeconds(athleteMultiSelectedId, athletePaceOverrides, paceSecPerMile);
    athleteMultiSeasonVisibleWeekStarts.forEach((weekISO) => {
      const days: MileageDay[] = [];
      for (let i = 0; i < 7; i += 1) {
        const am = parseMileageInput(getAthleteMultiDraftValue(weekISO, mileageColKey(i, "am")).trim());
        const pm = parseMileageInput(getAthleteMultiDraftValue(weekISO, mileageColKey(i, "pm")).trim());
        days.push({ am: am ?? undefined, pm: pm ?? undefined });
      }
      const total = sumWeekMilesRange(days, pace);
      map.set(weekISO, formatWeekTotalRoundedDistance(total, distanceUnit));
    });
    return map;
  }, [
    athleteMultiSelectedId,
    athletePaceOverrides,
    athleteMultiSeasonVisibleWeekStarts,
    distanceUnit,
    getAthleteMultiDraftValue,
    mileageColKey,
    paceSecPerMile,
  ]);

  const athleteMultiWeekXTTotals = useMemo(() => {
    const map = new Map<string, string>();
    if (!athleteMultiSelectedId) return map;
    athleteMultiSeasonVisibleWeekStarts.forEach((weekISO) => {
      let total: SecRange = { min: 0, max: 0 };
      for (let i = 0; i < 7; i += 1) {
        const amParsed = parseMileageInput(getAthleteMultiDraftValue(weekISO, mileageColKey(i, "am")).trim());
        const pmParsed = parseMileageInput(getAthleteMultiDraftValue(weekISO, mileageColKey(i, "pm")).trim());
        total = addSecRange(total, toXTSecRange(amParsed as any));
        total = addSecRange(total, toXTSecRange(pmParsed as any));
      }
      map.set(weekISO, formatXTTotal(total));
    });
    return map;
  }, [athleteMultiSeasonVisibleWeekStarts, athleteMultiSelectedId, getAthleteMultiDraftValue, mileageColKey]);

  const seasonMileageTableRows = useMemo(() => {
    const weekSet = new Set(seasonMileageWeekStarts);
    const athleteIds = new Set(seasonMileageAthletes.map((athlete) => String(athlete.id ?? "").trim()).filter(Boolean));
    const nameToAthleteId = new Map<string, string>();
    for (const athlete of seasonMileageAthletes) {
      const name = String(athlete.name ?? "").trim().toLowerCase();
      if (name && athlete.id) nameToAthleteId.set(name, athlete.id);
    }
    const seasonId = String(selectedSeason?.id ?? "").trim();
    const windowByAthleteId = new Map<string, { startISO: string; endISO: string }>();
    for (const athlete of seasonMileageAthletes) {
      const athleteId = String(athlete.id ?? "").trim();
      if (!athleteId) continue;
      const resolved = resolveSeasonMileageWindowForAthlete(athleteId);
      const resolvedStartISO = String(resolved?.start_date ?? seasonMileageRange.startISO).trim();
      const resolvedEndISO = String(resolved?.end_date ?? seasonMileageRange.endISO).trim();
      const startISO =
        isValidISODate(resolvedStartISO) && resolvedStartISO <= seasonMileageRange.startISO
          ? seasonMileageTableRange.startISO
          : resolvedStartISO;
      const endISO =
        isValidISODate(resolvedEndISO) && resolvedEndISO >= seasonMileageRange.endISO
          ? seasonMileageTableRange.endISO
          : resolvedEndISO;
      windowByAthleteId.set(athleteId, {
        startISO: isValidISODate(startISO) ? startISO : seasonMileageTableRange.startISO,
        endISO: isValidISODate(endISO) ? endISO : seasonMileageTableRange.endISO,
      });
    }

    const totalsByAthleteWeek = new Map<string, Range>();
    const workoutCompletedKeys = new Set<string>();
    const getCellKey = (athleteId: string, weekISO: string) => `${athleteId}|${weekISO}`;
    const isDateAllowedForAthlete = (athleteId: string, dateISO: string) => {
      const window = windowByAthleteId.get(athleteId);
      if (!window) return false;
      return dateISO >= window.startISO && dateISO <= window.endISO;
    };
    const addRangeTotal = (athleteId: string, weekISO: string, rangeRaw: Range) => {
      if (!athleteIds.has(athleteId)) return;
      if (!weekSet.has(weekISO)) return;
      const range = normalizeSeasonMileageRange(rangeRaw);
      if (!hasSeasonMileageValue(range)) return;
      const key = getCellKey(athleteId, weekISO);
      totalsByAthleteWeek.set(key, addRange(totalsByAthleteWeek.get(key) ?? { min: 0, max: 0 }, range));
    };
    const addMiles = (athleteId: string, dateISO: string, milesRaw: unknown) => {
      if (!athleteIds.has(athleteId)) return;
      if (!isValidISODate(dateISO)) return;
      if (dateISO < seasonMileageTableRange.startISO || dateISO > seasonMileageTableRange.endISO) return;
      if (!isDateAllowedForAthlete(athleteId, dateISO)) return;
      const miles = parseNumericLike(milesRaw);
      if (miles == null || !Number.isFinite(miles) || miles <= 0) return;
      const weekISO = getWeekStartISO(dateISO, weekStartsOn);
      if (!weekSet.has(weekISO)) return;
      addRangeTotal(athleteId, weekISO, { min: miles, max: miles });
    };

    if (seasonMileageMetric === "planned") {
      for (const weekISO of seasonMileageWeekStarts) {
        const weekRows = s.mileageCellsByWeek[weekISO] ?? [];
        for (const row of weekRows as any[]) {
          if (!rowBelongsToMileageWeek(row, weekISO)) continue;
          const athleteId = String(row?.athlete_profile_id ?? "").trim();
          const dayIdx = Number(row?.day_idx);
          if (!athleteId || !Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) continue;
          const dateISO = addDaysISO(weekISO, dayIdx);
          if (dateISO < seasonMileageTableRange.startISO || dateISO > seasonMileageTableRange.endISO) continue;
          if (!isDateAllowedForAthlete(athleteId, dateISO)) continue;
          const pace = resolveAthletePaceSeconds(athleteId, athletePaceOverrides, paceSecPerMile);
          addRangeTotal(athleteId, weekISO, toRange((row?.value ?? null) as MileageValue | null, pace));
        }
      }
    } else {
      for (const row of seasonMileageWorkoutRows) {
        const athleteId = String(row.athlete_profile_id ?? "").trim();
        const dateISO = String(row.date_iso ?? "").trim().slice(0, 10);
        const session = String(row.session ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
        if (!athleteId || !dateISO) continue;
        const completedMiles = parseNumericLike(row.completed_miles);
        if (completedMiles != null) {
          workoutCompletedKeys.add(`${athleteId}|${dateISO}|${session}`);
          addMiles(athleteId, dateISO, completedMiles);
        }
      }

      for (const entry of seasonMileageFeedbackEntries) {
        const dateISO = String(entry.dateISO ?? "").trim().slice(0, 10);
        const session = String(entry.session ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
        let athleteId = String(entry.athleteId ?? "").trim();
        if (!athleteId) {
          athleteId = nameToAthleteId.get(String(entry.athleteName ?? "").trim().toLowerCase()) ?? "";
        }
        if (!athleteId || !dateISO) continue;
        if (workoutCompletedKeys.has(`${athleteId}|${dateISO}|${session}`)) continue;
        addMiles(athleteId, dateISO, entry.completedMiles);
      }

      for (const entry of seasonMileageDailyLogEntries) {
        if (entry.entryType !== "extra_activity") continue;
        if (entry.activityKind !== "run") continue;
        const athleteId = String(entry.athleteId ?? "").trim();
        const dateISO = String(entry.dateISO ?? "").trim().slice(0, 10);
        if (!athleteId || !dateISO) continue;
        addMiles(athleteId, dateISO, entry.completedMiles);
      }
    }

    return seasonMileageAthletes.map((athlete) => {
      let seasonTotal: Range = { min: 0, max: 0 };
      const weeklyTotals = new Map<string, Range>();
      for (const weekISO of seasonMileageWeekStarts) {
        const total = totalsByAthleteWeek.get(getCellKey(athlete.id, weekISO)) ?? { min: 0, max: 0 };
        if (hasSeasonMileageValue(total)) {
          weeklyTotals.set(weekISO, total);
          seasonTotal = addRange(seasonTotal, total);
        }
      }
      return {
        athleteId: athlete.id,
        athleteName: athlete.name,
        weeklyTotals,
        seasonTotal,
        seasonId,
      };
    });
  }, [
    athletePaceOverrides,
    paceSecPerMile,
    resolveSeasonMileageWindowForAthlete,
    s.mileageCellsByWeek,
    seasonMileageAthletes,
    seasonMileageDailyLogEntries,
    seasonMileageFeedbackEntries,
    seasonMileageMetric,
    seasonMileageRange.endISO,
    seasonMileageRange.startISO,
    seasonMileageTableRange.endISO,
    seasonMileageTableRange.startISO,
    selectedSeason?.id,
    seasonMileageWeekStarts,
    seasonMileageWorkoutRows,
    weekStartsOn,
  ]);

  const sortedSeasonMileageTableRows = useMemo(() => {
    const rows = [...seasonMileageTableRows];
    rows.sort((a, b) => {
      if (seasonMileageSort.column === "athlete") {
        const nameCompare = String(a.athleteName ?? "").localeCompare(String(b.athleteName ?? ""), undefined, {
          sensitivity: "base",
        });
        if (nameCompare !== 0) return seasonMileageSort.direction === "asc" ? nameCompare : -nameCompare;
        return String(a.athleteId ?? "").localeCompare(String(b.athleteId ?? ""));
      }

      const aValue = getSeasonMileageSortMax(a.weeklyTotals.get(seasonMileageSort.weekISO));
      const bValue = getSeasonMileageSortMax(b.weeklyTotals.get(seasonMileageSort.weekISO));
      const aMissing = aValue == null;
      const bMissing = bValue == null;
      if (aMissing && bMissing) {
        return String(a.athleteName ?? "").localeCompare(String(b.athleteName ?? ""), undefined, { sensitivity: "base" });
      }
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (aValue !== bValue) {
        return seasonMileageSort.direction === "asc" ? aValue - bValue : bValue - aValue;
      }
      return String(a.athleteName ?? "").localeCompare(String(b.athleteName ?? ""), undefined, { sensitivity: "base" });
    });
    return rows;
  }, [seasonMileageSort, seasonMileageTableRows]);

  const toggleSeasonMileageNameSort = useCallback(() => {
    setSeasonMileageSort((prev) =>
      prev.column === "athlete"
        ? { column: "athlete", direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column: "athlete", direction: "asc" }
    );
  }, []);

  const toggleSeasonMileageWeekSort = useCallback((weekISO: string) => {
    const normalizedWeekISO = String(weekISO ?? "").trim();
    if (!normalizedWeekISO) return;
    setSeasonMileageSort((prev) =>
      prev.column === "week" && prev.weekISO === normalizedWeekISO
        ? { column: "week", weekISO: normalizedWeekISO, direction: prev.direction === "desc" ? "asc" : "desc" }
        : { column: "week", weekISO: normalizedWeekISO, direction: "desc" }
    );
  }, []);

  const seasonMileageTeamTotalsByWeek = useMemo(() => {
    const map = new Map<string, Range>();
    for (const weekISO of seasonMileageWeekStarts) {
      let total: Range = { min: 0, max: 0 };
      for (const row of seasonMileageTableRows) {
        total = addRange(total, row.weeklyTotals.get(weekISO) ?? { min: 0, max: 0 });
      }
      if (hasSeasonMileageValue(total)) map.set(weekISO, total);
    }
    return map;
  }, [seasonMileageTableRows, seasonMileageWeekStarts]);

  const seasonMileageTeamTotal = useMemo(
    () => seasonMileageTableRows.reduce((sum, row) => addRange(sum, row.seasonTotal), { min: 0, max: 0 }),
    [seasonMileageTableRows]
  );
  const seasonMileageHasData = hasSeasonMileageValue(seasonMileageTeamTotal);
  const seasonMileageActiveLoading = seasonMileageMetric === "planned" ? seasonMileagePlannedLoading : seasonMileageLoading;
  const seasonMileageActiveError = seasonMileageMetric === "planned" ? seasonMileagePlannedError : seasonMileageError;
  const seasonMileageMetricLabel = seasonMileageMetric === "planned" ? "Planned" : "Completed";

  const fillAllAthleteMulti = useCallback(() => {
    if (athleteMultiRowIds.length < 2) return;
    const sourceWeek = athleteMultiRowIds[0];
    if (!sourceWeek) return;
    const targetWeeks = athleteMultiRowIds.slice(1);
    const changes: Array<{ rowId: string; colKey: string; prev: string; next: string }> = [];
    targetWeeks.forEach((weekISO) => {
      athleteMultiColKeys.forEach((colKey) => {
        changes.push({
          rowId: weekISO,
          colKey,
          prev: getAthleteMultiDraftValue(weekISO, colKey),
          next: getAthleteMultiDraftValue(sourceWeek, colKey),
        });
      });
    });
    athleteMultiGrid.applyChanges(changes as any);
  }, [athleteMultiColKeys, athleteMultiGrid, athleteMultiRowIds, getAthleteMultiDraftValue]);

  const fillSelectedAthleteMulti = useCallback(() => {
    const rect = athleteMultiGrid.getSelectionRect();
    if (!rect || rect.r2 <= rect.r1) return;
    const sourceWeek = athleteMultiRowIds[rect.r1];
    if (!sourceWeek) return;
    const changes: Array<{ rowId: string; colKey: string; prev: string; next: string }> = [];
    for (let r = rect.r1 + 1; r <= rect.r2; r += 1) {
      const weekISO = athleteMultiRowIds[r];
      if (!weekISO) continue;
      for (let c = rect.c1; c <= rect.c2; c += 1) {
        const colKey = athleteMultiColKeys[c];
        if (!colKey) continue;
        changes.push({
          rowId: weekISO,
          colKey,
          prev: getAthleteMultiDraftValue(weekISO, colKey),
          next: getAthleteMultiDraftValue(sourceWeek, colKey),
        });
      }
    }
    athleteMultiGrid.applyChanges(changes as any);
  }, [athleteMultiColKeys, athleteMultiGrid, athleteMultiRowIds, getAthleteMultiDraftValue]);

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
  const stickyHeaderRow1Bg = scheme === "dark" ? "#1f2937" : "#e9eff8";
  const stickyHeaderRow2Bg = scheme === "dark" ? "#243244" : "#f2f6fc";
  const headerStrongTextColor = scheme === "dark" ? "#e5e7eb" : "#0f172a";
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
  const rowSelectedBg = "#eef4ff";
  const rowSelectedPinnedBg = "#e6efff";
  const rangeSelectionOutline = "1px solid rgba(37,99,235,0.35)";
  const rangeSelectionFill = "rgba(37,99,235,0.08)";
  const activeCellOutline = "2px solid #1d4ed8";
  const activeCellFill = "rgba(29,78,216,0.12)";
  const editingCellOutline = "2px solid #0f766e";
  const editingCellFill = "rgba(15,118,110,0.13)";
  const invalidCellFill = "rgba(220,38,38,0.08)";
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
          <Text style={{ fontSize: fontTiny, color: colors.mutedText, fontWeight: "800", letterSpacing: 0.3 }}>
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
              borderLeftColor: "rgba(15,23,42,0.14)",
              backgroundColor: stickyHeaderRow1Bg,
            }}
          >
            <Text style={{ fontWeight: "900", color: headerStrongTextColor, fontSize: fontHeader, letterSpacing: 0.2 }}>{lbl}</Text>
            <Text
              style={{
                marginTop: 1,
                fontSize: fontTiny,
                color: colors.mutedText,
                fontWeight: "800",
              }}
            >
              {weekDates[i]}
            </Text>
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
                borderLeftColor: "rgba(15,23,42,0.12)",
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
      {teamWeekVisibleAthletes.length === 0 ? (
        <View
          style={{
            minWidth: gridMinWidth,
            borderBottomWidth: borderThin,
            borderBottomColor: colors.border,
            backgroundColor: colors.card,
            paddingHorizontal: 12,
            paddingVertical: 12,
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "700", color: colors.mutedText }}>
            {selectedSeasonId
              ? "No athlete rows in the selected season for this week."
              : "No athlete rows for this week."}
          </Text>
        </View>
      ) : null}
      {teamWeekVisibleAthletes.map((a, rowIndex) => {
        const canEdit = !!a.id && !readOnlyMileage;
        const rowSelected = mileageGrid.isRowSelected(a.id);
        const baseRowBg = rowIndex % 2 === 0 ? colors.card : colors.bg;
        const rowBgColor = rowSelected ? rowSelectedBg : baseRowBg;
        const pinnedBgColor = rowSelected ? rowSelectedPinnedBg : baseRowBg;
        const rowAccentColor = rowSelected ? "#1d4ed8" : "transparent";
        return (
          <View
            key={a.id || `row_${rowIndex}`}
            style={{
              flexDirection: "row",
              borderBottomWidth: borderThin,
              borderBottomColor: colors.border,
              borderLeftWidth: rowAccentColor === "transparent" ? 0 : 3,
              borderLeftColor: rowAccentColor,
              minWidth: gridMinWidth,
              backgroundColor: rowBgColor,
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
                backgroundColor: pinnedBgColor,
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
                  backgroundColor: pinnedBgColor,
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
                      checked={rowSelected}
                      hitSlopSize={0}
                      onPress={() => {
                        setActiveGridId(MILEAGE_GRID_ID);
                        mileageGrid.selectRow(a.id, false);
                      }}
                    />
                  </div>
                ) : (
                  <MiniCheck
                    checked={rowSelected}
                    hitSlopSize={0}
                    onPress={() => {
                      mileageGrid.selectRow(a.id, false);
                      setActiveGridId(MILEAGE_GRID_ID);
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
              const amCol = mileageColKey(dayIdx, "am");
              const pmCol = mileageColKey(dayIdx, "pm");
              const amSelected = mileageGrid.isCellSelected(a.id, amCol);
              const amActive = mileageGrid.isCellActive(a.id, amCol);
              const amEditing = mileageGrid.isEditingCell(a.id, amCol);
              const amInvalid = !!invalidCells[cellKey(a.id, dayIdx, "am")];
              const pmSelected = mileageGrid.isCellSelected(a.id, pmCol);
              const pmActive = mileageGrid.isCellActive(a.id, pmCol);
              const pmEditing = mileageGrid.isEditingCell(a.id, pmCol);
              const pmInvalid = !!invalidCells[cellKey(a.id, dayIdx, "pm")];

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
                            borderColor: amInvalid ? colors.danger : colors.border,
                            borderRadius: radiusCell,
                            backgroundColor: !canEdit
                              ? colors.bg
                              : amEditing
                                ? editingCellFill
                                : amActive
                                  ? activeCellFill
                                  : amSelected
                                    ? rangeSelectionFill
                                    : amInvalid
                                      ? invalidCellFill
                                      : colors.card,
                            overflow: "hidden",
                            ...(amSelected ? ({ outline: rangeSelectionOutline, outlineOffset: -1 } as any) : null),
                            ...(amActive ? ({ outline: activeCellOutline, outlineOffset: -2 } as any) : null),
                            ...(amEditing ? ({ outline: editingCellOutline, outlineOffset: -2, boxShadow: "inset 0 0 0 1px rgba(15,118,110,0.35), 0 0 0 1px rgba(15,118,110,0.2)" } as any) : null),
                          }}
                        >
                          <GridCell
                            key={`${weekStartISO}-${a.id}-${dayIdx}-am`}
                            binding={bindMileageCell(a.id, amCol)}
                            editable={canEdit}
                            value={amDraft}
                            onChangeText={(v) => mileageGrid.applyCellValue(a.id, amCol, v)}
                            placeholder=""
                            gridEditing={amEditing}
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
                            borderColor: pmInvalid ? colors.danger : colors.border,
                            borderRadius: radiusCell,
                            backgroundColor: !canEdit
                              ? colors.bg
                              : pmEditing
                                ? editingCellFill
                                : pmActive
                                  ? activeCellFill
                                  : pmSelected
                                    ? rangeSelectionFill
                                    : pmInvalid
                                      ? invalidCellFill
                                      : colors.card,
                            overflow: "hidden",
                            ...(pmSelected ? ({ outline: rangeSelectionOutline, outlineOffset: -1 } as any) : null),
                            ...(pmActive ? ({ outline: activeCellOutline, outlineOffset: -2 } as any) : null),
                            ...(pmEditing ? ({ outline: editingCellOutline, outlineOffset: -2, boxShadow: "inset 0 0 0 1px rgba(15,118,110,0.35), 0 0 0 1px rgba(15,118,110,0.2)" } as any) : null),
                          }}
                        >
                          <GridCell
                            key={`${weekStartISO}-${a.id}-${dayIdx}-pm`}
                            binding={bindMileageCell(a.id, pmCol)}
                            editable={canEdit}
                            value={pmDraft}
                            onChangeText={(v) => mileageGrid.applyCellValue(a.id, pmCol, v)}
                            placeholder=""
                            gridEditing={pmEditing}
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

  const athleteWeekColumnWidth = 196;
  const athleteGridMinWidth = athleteWeekColumnWidth + dayGroupWidth * 7;
  const athleteMultiSpreadsheet = (
    <View style={{ minWidth: athleteGridMinWidth, width: isWeb && isDesktop ? ("max-content" as any) : "100%" }}>
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden", backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", backgroundColor: stickyHeaderRow1Bg }}>
          <View style={{ width: athleteWeekColumnWidth, padding: cellPad, borderRightWidth: 1, borderRightColor: colors.border }}>
            <Text style={{ fontWeight: "900", color: headerStrongTextColor, fontSize: fontHeader }}>Week</Text>
          </View>
          {weekdayLabels.map((lbl, i) => (
            <View key={`amw-h-${lbl}-${i}`} style={{ width: dayGroupWidth, padding: cellPad, borderRightWidth: 1, borderRightColor: colors.border }}>
              <Text style={{ fontWeight: "900", color: headerStrongTextColor, fontSize: fontHeader }}>{lbl}</Text>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: "row", backgroundColor: stickyHeaderRow2Bg, borderTopWidth: 1, borderTopColor: colors.border }}>
          <View style={{ width: athleteWeekColumnWidth, padding: cellPad, borderRightWidth: 1, borderRightColor: colors.border }} />
          {Array.from({ length: 7 }, (_, i) => (
            <View key={`amw-sh-${i}`} style={{ width: dayGroupWidth, padding: cellPad, borderRightWidth: 1, borderRightColor: colors.border }}>
              <View style={{ flexDirection: "row", gap: subCellGap }}>
                <Text style={{ width: subColWidth, fontSize: fontTiny, fontWeight: "900", color: colors.mutedText }}>AM</Text>
                <Text style={{ width: subColWidth, fontSize: fontTiny, fontWeight: "900", color: colors.mutedText }}>PM</Text>
              </View>
            </View>
          ))}
        </View>
        {athleteMultiSeasonVisibleWeekStarts.map((weekISO, rowIdx) => {
          const isCurrentWeek = weekISO === athleteMultiCurrentWeekStartISO;
          const mileageLabel = String(athleteMultiWeekTotals.get(weekISO) ?? "").trim();
          const xtLabel = String(athleteMultiWeekXTTotals.get(weekISO) ?? "").trim();
          return (
          <View
            key={weekISO}
            style={{
              flexDirection: "row",
              borderTopWidth: 1,
              borderTopColor: colors.border,
              backgroundColor: isCurrentWeek
                ? "rgba(34,197,94,0.08)"
                : rowIdx % 2 === 0
                  ? colors.card
                  : colors.bg,
            }}
          >
            <View style={{ width: athleteWeekColumnWidth, padding: cellPad, borderRightWidth: 1, borderRightColor: colors.border }}>
              <Text style={{ fontWeight: "900", color: colors.text }}>{formatAthleteWeekRangeLabel(weekISO)}</Text>
              {mileageLabel ? (
                <Text style={{ fontSize: 10, color: colors.mutedText, fontWeight: "800" }}>
                  {mileageLabel}{isCurrentWeek ? " · Current" : ""}
                </Text>
              ) : isCurrentWeek ? (
                <Text style={{ fontSize: 10, color: colors.mutedText, fontWeight: "800" }}>Current</Text>
              ) : null}
              {xtLabel ? <Text style={{ fontSize: 10, color: colors.mutedText, fontWeight: "700" }}>{xtLabel}</Text> : null}
            </View>
            {Array.from({ length: 7 }, (_, dayIdx) => {
              const amCol = mileageColKey(dayIdx, "am");
              const pmCol = mileageColKey(dayIdx, "pm");
              const amEditing = athleteMultiGrid.isEditingCell(weekISO, amCol);
              const pmEditing = athleteMultiGrid.isEditingCell(weekISO, pmCol);
              const amSelected = athleteMultiGrid.isCellSelected(weekISO, amCol);
              const pmSelected = athleteMultiGrid.isCellSelected(weekISO, pmCol);
              const amActive = athleteMultiGrid.isCellActive(weekISO, amCol);
              const pmActive = athleteMultiGrid.isCellActive(weekISO, pmCol);
              return (
                <View key={`${weekISO}-${dayIdx}`} style={{ width: dayGroupWidth, padding: cellPad, borderRightWidth: 1, borderRightColor: colors.border }}>
                  <View style={{ flexDirection: "row", gap: subCellGap }}>
                    <View style={{ width: subColWidth, borderWidth: 1, borderColor: colors.border, borderRadius: radiusCell, backgroundColor: amEditing ? editingCellFill : amActive ? activeCellFill : amSelected ? rangeSelectionFill : colors.card }}>
                      <GridCell
                        binding={athleteMultiGrid.bindCell(weekISO, amCol)}
                        editable={!readOnlyMileage}
                        value={getAthleteMultiDraftValue(weekISO, amCol)}
                        onChangeText={(v) => athleteMultiGrid.applyCellValue(weekISO, amCol, v)}
                        gridEditing={amEditing}
                        editIntent={
                          athleteMultiGrid.editIntentRef.current?.rowId === weekISO &&
                          athleteMultiGrid.editIntentRef.current?.colKey === amCol
                            ? athleteMultiGrid.editIntentRef.current
                            : null
                        }
                        consumeEditIntent={() => athleteMultiGrid.consumeEditIntent(weekISO, amCol)}
                        onEnterEditMode={() => athleteMultiGrid.beginEdit(weekISO, amCol, "preserve")}
                        style={{ width: subColWidth, paddingHorizontal: inputPadH, paddingVertical: inputPadV, fontWeight: "800", fontSize: fontCell, color: colors.text }}
                      />
                    </View>
                    <View style={{ width: subColWidth, borderWidth: 1, borderColor: colors.border, borderRadius: radiusCell, backgroundColor: pmEditing ? editingCellFill : pmActive ? activeCellFill : pmSelected ? rangeSelectionFill : colors.card }}>
                      <GridCell
                        binding={athleteMultiGrid.bindCell(weekISO, pmCol)}
                        editable={!readOnlyMileage}
                        value={getAthleteMultiDraftValue(weekISO, pmCol)}
                        onChangeText={(v) => athleteMultiGrid.applyCellValue(weekISO, pmCol, v)}
                        gridEditing={pmEditing}
                        editIntent={
                          athleteMultiGrid.editIntentRef.current?.rowId === weekISO &&
                          athleteMultiGrid.editIntentRef.current?.colKey === pmCol
                            ? athleteMultiGrid.editIntentRef.current
                            : null
                        }
                        consumeEditIntent={() => athleteMultiGrid.consumeEditIntent(weekISO, pmCol)}
                        onEnterEditMode={() => athleteMultiGrid.beginEdit(weekISO, pmCol, "preserve")}
                        style={{ width: subColWidth, paddingHorizontal: inputPadH, paddingVertical: inputPadV, fontWeight: "800", fontSize: fontCell, color: colors.text }}
                      />
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        );
        })}
        {athleteMultiSeasonVisibleWeekStarts.length === 0 ? (
          <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 10, paddingVertical: 12 }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: colors.mutedText }}>
              No visible weeks in the selected season range.
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );

  const seasonAthleteColumnWidth = 220;
  const seasonWeekColumnWidth = 94;
  const seasonTotalColumnWidth = 98;
  const seasonMileageGridMinWidth =
    seasonAthleteColumnWidth + seasonWeekColumnWidth * Math.max(1, seasonMileageWeekStarts.length) + seasonTotalColumnWidth;
  const seasonMileageTable = (
    <View style={{ minWidth: seasonMileageGridMinWidth, width: isWeb && isDesktop ? ("max-content" as any) : "100%" }}>
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "visible", backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", backgroundColor: stickyHeaderRow1Bg }}>
          <View
            style={{
              width: seasonAthleteColumnWidth,
              minWidth: seasonAthleteColumnWidth,
              maxWidth: seasonAthleteColumnWidth,
              padding: cellPad,
              borderRightWidth: 1,
              borderRightColor: colors.border,
              backgroundColor: stickyHeaderRow1Bg,
              ...(showStickyAthleteCol ? ({ position: "sticky", left: 0, zIndex: 100 } as any) : null),
            }}
          >
            <Pressable onPress={toggleSeasonMileageNameSort} style={{ alignSelf: "flex-start" }}>
              <Text style={{ fontWeight: "900", color: headerStrongTextColor, fontSize: fontHeader }}>
                Athlete{getSeasonMileageSortIndicator(seasonMileageSort, "athlete")}
              </Text>
            </Pressable>
            <Text style={{ marginTop: 2, fontSize: fontTiny, fontWeight: "800", color: colors.mutedText }}>
              {seasonMileageMetric === "planned" ? "Planned miles" : "Submitted miles"}
            </Text>
          </View>
          {seasonMileageWeekStarts.map((weekISO) => (
            <View
              key={`season-mileage-header-${weekISO}`}
              style={{
                width: seasonWeekColumnWidth,
                minWidth: seasonWeekColumnWidth,
                maxWidth: seasonWeekColumnWidth,
                padding: cellPad,
                borderRightWidth: 1,
                borderRightColor: colors.border,
                backgroundColor: stickyHeaderRow1Bg,
              }}
            >
              <Pressable onPress={() => toggleSeasonMileageWeekSort(weekISO)} style={{ alignSelf: "stretch" }}>
                <Text style={{ fontWeight: "900", color: headerStrongTextColor, fontSize: 10 }} numberOfLines={2}>
                  {formatSeasonWeekHeaderLabel(weekISO)}
                  {getSeasonMileageSortIndicator(seasonMileageSort, "week", weekISO)}
                </Text>
              </Pressable>
            </View>
          ))}
          <View
            style={{
              width: seasonTotalColumnWidth,
              minWidth: seasonTotalColumnWidth,
              maxWidth: seasonTotalColumnWidth,
              padding: cellPad,
              backgroundColor: stickyHeaderRow1Bg,
            }}
          >
            <Text style={{ fontWeight: "900", color: headerStrongTextColor, fontSize: fontHeader }}>Total</Text>
          </View>
        </View>

        {seasonMileageActiveLoading ? (
          <View style={{ paddingHorizontal: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border }}>
            <Text style={{ fontSize: 12, fontWeight: "800", color: colors.mutedText }}>Loading {seasonMileageMetricLabel.toLowerCase()} mileage...</Text>
          </View>
        ) : seasonMileageActiveError ? (
          <View style={{ paddingHorizontal: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border }}>
            <Text style={{ fontSize: 12, fontWeight: "800", color: colors.danger }}>{seasonMileageActiveError}</Text>
          </View>
        ) : seasonMileageAthletes.length === 0 ? (
          <View style={{ paddingHorizontal: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border }}>
            <Text style={{ fontSize: 12, fontWeight: "800", color: colors.mutedText }}>No athletes found</Text>
          </View>
        ) : seasonMileageWeekStarts.length === 0 ? (
          <View style={{ paddingHorizontal: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border }}>
            <Text style={{ fontSize: 12, fontWeight: "800", color: colors.mutedText }}>Enter a valid date range.</Text>
          </View>
        ) : (
          <>
            {sortedSeasonMileageTableRows.map((row, rowIndex) => {
              const rowBg = rowIndex % 2 === 0 ? colors.card : colors.bg;
              return (
                <View
                  key={`season-mileage-row-${row.athleteId}`}
                  style={{
                    flexDirection: "row",
                    borderTopWidth: 1,
                    borderTopColor: colors.border,
                    backgroundColor: rowBg,
                  }}
                >
                  <View
                    style={{
                      width: seasonAthleteColumnWidth,
                      minWidth: seasonAthleteColumnWidth,
                      maxWidth: seasonAthleteColumnWidth,
                      padding: cellPad,
                      borderRightWidth: 1,
                      borderRightColor: colors.border,
                      backgroundColor: rowBg,
                      justifyContent: "center",
                      ...(showStickyAthleteCol ? ({ position: "sticky", left: 0, zIndex: 50 } as any) : null),
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "900", color: colors.text }} numberOfLines={1}>
                      {row.athleteName}
                    </Text>
                  </View>
                  {seasonMileageWeekStarts.map((weekISO) => {
                    const value = row.weeklyTotals.get(weekISO) ?? { min: 0, max: 0 };
                    const hasValue = hasSeasonMileageValue(value);
                    return (
                      <View
                        key={`season-mileage-cell-${row.athleteId}-${weekISO}`}
                        style={{
                          width: seasonWeekColumnWidth,
                          minWidth: seasonWeekColumnWidth,
                          maxWidth: seasonWeekColumnWidth,
                          paddingHorizontal: 8,
                          paddingVertical: 9,
                          borderRightWidth: 1,
                          borderRightColor: colors.border,
                          alignItems: "flex-end",
                          justifyContent: "center",
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: hasValue ? "900" : "700",
                            color: hasValue ? colors.text : colors.mutedText,
                          }}
                        >
                          {hasValue ? formatSeasonMileageValue(value, distanceUnit) : "—"}
                        </Text>
                      </View>
                    );
                  })}
                  <View
                    style={{
                      width: seasonTotalColumnWidth,
                      minWidth: seasonTotalColumnWidth,
                      maxWidth: seasonTotalColumnWidth,
                      paddingHorizontal: 8,
                      paddingVertical: 9,
                      alignItems: "flex-end",
                      justifyContent: "center",
                      backgroundColor: hasSeasonMileageValue(row.seasonTotal) ? "rgba(37,99,235,0.06)" : rowBg,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "900", color: hasSeasonMileageValue(row.seasonTotal) ? colors.text : colors.mutedText }}>
                      {hasSeasonMileageValue(row.seasonTotal) ? formatSeasonMileageValue(row.seasonTotal, distanceUnit) : "—"}
                    </Text>
                  </View>
                </View>
              );
            })}
            <View
              style={{
                flexDirection: "row",
                borderTopWidth: 2,
                borderTopColor: colors.border,
                backgroundColor: scheme === "dark" ? "#1f2937" : "#f8fafc",
              }}
            >
              <View
                style={{
                  width: seasonAthleteColumnWidth,
                  minWidth: seasonAthleteColumnWidth,
                  maxWidth: seasonAthleteColumnWidth,
                  padding: cellPad,
                  borderRightWidth: 1,
                  borderRightColor: colors.border,
                  backgroundColor: scheme === "dark" ? "#1f2937" : "#f8fafc",
                  ...(showStickyAthleteCol ? ({ position: "sticky", left: 0, zIndex: 55 } as any) : null),
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "900", color: colors.text }}>Team total</Text>
              </View>
              {seasonMileageWeekStarts.map((weekISO) => {
                const value = seasonMileageTeamTotalsByWeek.get(weekISO) ?? { min: 0, max: 0 };
                const hasValue = hasSeasonMileageValue(value);
                return (
                  <View
                    key={`season-mileage-team-total-${weekISO}`}
                    style={{
                      width: seasonWeekColumnWidth,
                      minWidth: seasonWeekColumnWidth,
                      maxWidth: seasonWeekColumnWidth,
                      paddingHorizontal: 8,
                      paddingVertical: 9,
                      borderRightWidth: 1,
                      borderRightColor: colors.border,
                      alignItems: "flex-end",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "900", color: hasValue ? colors.text : colors.mutedText }}>
                      {hasValue ? formatSeasonMileageValue(value, distanceUnit) : "—"}
                    </Text>
                  </View>
                );
              })}
              <View
                style={{
                  width: seasonTotalColumnWidth,
                  minWidth: seasonTotalColumnWidth,
                  maxWidth: seasonTotalColumnWidth,
                  paddingHorizontal: 8,
                  paddingVertical: 9,
                  alignItems: "flex-end",
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "900", color: hasSeasonMileageValue(seasonMileageTeamTotal) ? colors.text : colors.mutedText }}>
                  {hasSeasonMileageValue(seasonMileageTeamTotal) ? formatSeasonMileageValue(seasonMileageTeamTotal, distanceUnit) : "—"}
                </Text>
              </View>
            </View>
          </>
        )}
      </View>

      {!seasonMileageActiveLoading && !seasonMileageActiveError && seasonMileageAthletes.length > 0 && !seasonMileageHasData ? (
        <Text style={{ marginTop: 12, fontSize: 12, fontWeight: "800", color: colors.mutedText }}>
          No {seasonMileageMetricLabel.toLowerCase()} mileage data for this season
        </Text>
      ) : null}
      <Text style={{ marginTop: 12, fontSize: 12, color: colors.mutedText, fontWeight: "700" }}>
        {seasonMileageMetric === "planned"
          ? "This view shows planned mileage from coach mileage cells. Cross-training time is not converted into mileage."
          : "This view shows submitted completed miles from athlete workout feedback, mileage logs, and extra run entries. Cross-training time is not converted into mileage."}
      </Text>
    </View>
  );

  return (
    <Screen padded={false} style={{ flex: 1 }}>
      <View style={{ padding: theme.space.sm, gap: theme.space.sm, flex: 1 }}>
        <Card
          style={{
            gap: 6,
            paddingVertical: 6,
            backgroundColor: colors.card,
            borderColor: colors.border,
          }}
        >
          <View
            style={{
              borderWidth: 1,
              borderColor: "rgba(15,23,42,0.08)",
              borderRadius: 12,
              paddingHorizontal: 8,
              paddingVertical: 6,
              backgroundColor: "rgba(37,99,235,0.04)",
              gap: 6,
              overflow: "visible",
              position: "relative",
              zIndex: 2,
              elevation: 0,
            }}
          >
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              <Button
                title="Team Week"
                variant={viewMode === "teamWeek" ? "primary" : "secondary"}
                onPress={() => setViewMode("teamWeek")}
              />
              <Button
                title="Athlete"
                variant={viewMode === "athleteMultiWeek" ? "primary" : "secondary"}
                onPress={() => setViewMode("athleteMultiWeek")}
              />
              <Button
                title="Season View"
                variant={viewMode === "seasonMileage" ? "primary" : "secondary"}
                onPress={() => setViewMode("seasonMileage")}
              />
            </View>
            {viewMode === "teamWeek" ? (
            <>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Button
                  title="Prev"
                  variant="secondary"
                  onPress={() => setWeekAnchorISO(addDaysISO(weekAnchorISO, -7))}
                />
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    borderWidth: 1,
                    borderColor: "rgba(15,23,42,0.12)",
                    borderRadius: 999,
                    paddingHorizontal: 7,
                    paddingVertical: 3,
                    backgroundColor: colors.card,
                  }}
                >
                  <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedText }}>Week label</Text>
                  <TextInput
                    value={weekLabelDraft}
                    onChangeText={setWeekLabelDraft}
                    placeholder="Week label"
                    autoCorrect={false}
                    onFocus={handleWeekLabelFocus}
                    onBlur={handleWeekLabelBlur}
                    editable={!readOnlyMileage}
                    style={{
                      width: 118,
                      height: 26,
                      borderWidth: 1,
                      borderColor: activeWeekToneColors.border,
                      borderRadius: 999,
                      paddingHorizontal: 9,
                      color: colors.text,
                      backgroundColor: colors.bg,
                      fontSize: 11,
                      fontWeight: "600",
                    }}
                  />
                  <Text style={{ fontSize: 9, fontWeight: "700", color: colors.mutedText }}>
                    {weekLabelSaveState === "saving"
                      ? "Saving..."
                      : weekLabelSaveState === "saved"
                        ? "Saved"
                        : weekLabelSaveState === "error"
                          ? "Error"
                          : ""}
                  </Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                    {(["training", "competition", "break"] as WeekLabelType[]).map((type) => {
                      const selected = activeWeekLabelTone === type;
                      const toneColors = getWeekLabelToneColors(type);
                      return (
                        <Pressable
                          key={`mileage-week-type-${type}`}
                          disabled={readOnlyMileage}
                          onPress={() => void persistWeekLabelType(weekStartISO, type)}
                          style={{
                            borderWidth: 1,
                            borderColor: selected ? toneColors.border : "rgba(148,163,184,0.32)",
                            backgroundColor: selected ? toneColors.bg : colors.card,
                            borderRadius: 999,
                            paddingHorizontal: 7,
                            paddingVertical: 3,
                            opacity: readOnlyMileage ? 0.55 : 1,
                          }}
                        >
                          <Text style={{ fontSize: 9, fontWeight: "900", color: selected ? toneColors.text : colors.mutedText }}>
                            {getWeekLabelToneText(type)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </View>

              <View style={{ alignItems: "center", flex: 1, gap: 0 }}>
                <AppText variant="caption" color="mutedText" style={{ letterSpacing: 0.5 }}>
                  MILEAGE WEEK
                </AppText>
                <AppText variant="sub" style={{ fontWeight: "800" }}>{weekRangeLabel}</AppText>
                <View
                  style={{
                    marginTop: 2,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor:
                      relativeWeekStatus.status === "current"
                        ? "rgba(34,197,94,0.35)"
                        : relativeWeekStatus.status === "past"
                          ? "rgba(100,116,139,0.35)"
                          : "rgba(245,158,11,0.4)",
                    backgroundColor:
                      relativeWeekStatus.status === "current"
                        ? "rgba(34,197,94,0.12)"
                        : relativeWeekStatus.status === "past"
                          ? "rgba(100,116,139,0.1)"
                          : "rgba(245,158,11,0.12)",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 10,
                      fontWeight: "800",
                      color:
                        relativeWeekStatus.status === "current"
                          ? colors.success
                          : relativeWeekStatus.status === "past"
                            ? colors.mutedText
                            : colors.warning,
                    }}
                    numberOfLines={1}
                  >
                    {relativeWeekStatus.label}
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <Button title="Current Week" variant="secondary" onPress={jumpToCurrentWeek} />
                <Button
                  title={jumpToWeekOpen ? "Cancel Jump" : "Jump to Week"}
                  variant="secondary"
                  onPress={() => {
                    setJumpDateInput(weekStartISO);
                    setJumpToWeekOpen((prev) => !prev);
                  }}
                />
                <Button
                  title="Next"
                  variant="secondary"
                  onPress={() => setWeekAnchorISO(addDaysISO(weekAnchorISO, 7))}
                />
              </View>
            </View>
            {canPublishMileageTraining ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Text style={{ fontSize: 11, fontWeight: "800", color: colors.mutedText }}>
                  {mileageWeekVisibilityLabel}
                </Text>
                <Button
                  title="Visibility"
                  variant="secondary"
                  disabled={weekVisibilityBusy || teamWeekVisibleAthletes.length === 0}
                  onPress={() => openTrainingVisibilityModal("both")}
                />
                <Button
                  title={weekVisibilityBusy ? "Publishing..." : "Publish Week"}
                  variant="secondary"
                  disabled={weekVisibilityBusy || teamWeekVisibleAthletes.length === 0}
                  onPress={() => void setDisplayedMileageWeekVisibility(true)}
                />
                <Button
                  title={weekVisibilityBusy ? "Hiding..." : "Hide Week"}
                  variant="secondary"
                  disabled={weekVisibilityBusy || teamWeekVisibleAthletes.length === 0}
                  onPress={() => void setDisplayedMileageWeekVisibility(false)}
                />
              </View>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Text style={{ fontSize: 11, fontWeight: "800", color: colors.mutedText }}>Groups</Text>
              <View
                style={{
                  minWidth: 230,
                  maxWidth: 420,
                  flex: 1,
                  position: "relative",
                  zIndex: 8,
                  overflow: "visible",
                }}
              >
                <Pressable
                  onPress={() => setTrainingGroupFilterOpen((prev) => !prev)}
                  style={{
                    height: 34,
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    backgroundColor: colors.bg,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: colors.text }}>
                    {selectedTrainingGroupLabel}
                  </Text>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: colors.mutedText }}>
                    {trainingGroupFilterOpen ? "▴" : "▾"}
                  </Text>
                </Pressable>
              </View>
              <Text style={{ fontSize: 11, fontWeight: "800", color: colors.mutedText }}>Preset</Text>
              <View
                style={{
                  minWidth: 230,
                  maxWidth: 420,
                  flex: 1,
                  position: "relative",
                  zIndex: 7,
                  overflow: "visible",
                }}
              >
                <Pressable
                  onPress={() => setSeasonFilterOpen(true)}
                  style={{
                    height: 34,
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    backgroundColor: colors.bg,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: colors.text }}>
                    {selectedSeasonLabel}
                  </Text>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: colors.mutedText }}>
                    {seasonFilterOpen ? "▴" : "▾"}
                  </Text>
                </Pressable>
                <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedText, marginTop: 4, marginLeft: 4 }}>
                  Presets fill range views.
                </Text>
              </View>
            </View>
            </>
            ) : viewMode === "seasonMileage" ? null : (
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text style={{ fontSize: 11, fontWeight: "800", color: colors.mutedText }}>Athlete</Text>
                  <View
                    style={{
                      minWidth: 260,
                      flex: 1,
                      maxWidth: 460,
                      position: "relative",
                      overflow: "visible",
                      zIndex: 3,
                    }}
                  >
                    <Pressable
                      onPress={() => {
                        setAthleteSearchQuery("");
                        setAthletePickerOpen(true);
                      }}
                      style={{
                        height: 34,
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: 8,
                        paddingHorizontal: 10,
                        backgroundColor: colors.bg,
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ fontSize: 12, fontWeight: "700", color: colors.text }}>
                        {athleteMultiSelected?.name || "Select athlete"}
                      </Text>
                    </Pressable>
                  </View>
                  <Text style={{ fontSize: 11, fontWeight: "800", color: colors.mutedText }}>Preset</Text>
                  <View
                    style={{
                      minWidth: 230,
                      maxWidth: 420,
                      flex: 1,
                      position: "relative",
                      zIndex: 2,
                      overflow: "visible",
                    }}
                  >
                    <Pressable
                      onPress={() => setSeasonFilterOpen(true)}
                      style={{
                        height: 34,
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: 8,
                        paddingHorizontal: 10,
                        backgroundColor: colors.bg,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: colors.text }}>
                        {selectedSeasonLabel}
                      </Text>
                      <Text style={{ fontSize: 11, fontWeight: "900", color: colors.mutedText }}>
                        {seasonFilterOpen ? "▴" : "▾"}
                      </Text>
                    </Pressable>
                <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedText, marginTop: 4, marginLeft: 4 }}>
                  Presets fill the date range.
                </Text>
              </View>
            </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <View style={{ minWidth: 142, gap: 3 }}>
                    <Text style={{ fontSize: 10, fontWeight: "900", color: colors.mutedText }}>Start date</Text>
                    {Platform.OS === "web" ? (
                      <input
                        type="date"
                        value={mileageRangeStartISO}
                        onChange={(event) => updateMileageRangeStart(String((event.target as HTMLInputElement)?.value ?? "").trim())}
                        style={{
                          height: 34,
                          border: `1px solid ${colors.border}`,
                          borderRadius: 8,
                          padding: "0 10px",
                          color: colors.text,
                          background: colors.bg,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      />
                    ) : (
                      <TextInput
                        value={mileageRangeStartISO}
                        onChangeText={updateMileageRangeStart}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder="YYYY-MM-DD"
                        style={{
                          height: 34,
                          borderWidth: 1,
                          borderColor: colors.border,
                          borderRadius: 8,
                          paddingHorizontal: 10,
                          color: colors.text,
                          backgroundColor: colors.bg,
                          fontSize: 12,
                          fontWeight: "700",
                        }}
                      />
                    )}
                  </View>
                  <View style={{ minWidth: 142, gap: 3 }}>
                    <Text style={{ fontSize: 10, fontWeight: "900", color: colors.mutedText }}>End date</Text>
                    {Platform.OS === "web" ? (
                      <input
                        type="date"
                        value={mileageRangeEndISO}
                        onChange={(event) => updateMileageRangeEnd(String((event.target as HTMLInputElement)?.value ?? "").trim())}
                        style={{
                          height: 34,
                          border: `1px solid ${colors.border}`,
                          borderRadius: 8,
                          padding: "0 10px",
                          color: colors.text,
                          background: colors.bg,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      />
                    ) : (
                      <TextInput
                        value={mileageRangeEndISO}
                        onChangeText={updateMileageRangeEnd}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder="YYYY-MM-DD"
                        style={{
                          height: 34,
                          borderWidth: 1,
                          borderColor: colors.border,
                          borderRadius: 8,
                          paddingHorizontal: 10,
                          color: colors.text,
                          backgroundColor: colors.bg,
                          fontSize: 12,
                          fontWeight: "700",
                        }}
                      />
                    )}
                  </View>
                  <Text style={{ fontSize: 11, fontWeight: "800", color: colors.mutedText }}>
                    Range: {athleteMultiVisibleRangeLabel}
                  </Text>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedText }}>
                    Mode: {athleteMultiRangeMode === "season" ? "Season" : "Custom"}
                  </Text>
                  {!readOnlyMileage ? (
                    <>
                      <Button title="Edit Range" variant="secondary" onPress={openAthleteRangeEditor} />
                      <Button
                        title="Use Selected Season"
                        variant="secondary"
                        onPress={applySelectedSeasonToAthleteRange}
                        disabled={!selectedSeason || !athleteMultiSelectedId}
                      />
                    </>
                  ) : null}
                  {canExportMileage ? (
                    <Button
                      title={exportingMileagePlanPdf ? "Exporting..." : "Export Mileage Plan"}
                      variant="secondary"
                      onPress={openMileagePlanExport}
                      disabled={!athleteMultiSelectedId || exportingMileagePlanPdf}
                    />
                  ) : null}
                  {athleteMultiRangeError ? (
                    <Text style={{ fontSize: 11, fontWeight: "700", color: "#b91c1c" }}>{athleteMultiRangeError}</Text>
                  ) : null}
                </View>
              </View>
            )}
            {viewMode === "teamWeek" && jumpToWeekOpen ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: "rgba(15,23,42,0.1)",
                  borderRadius: 10,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  backgroundColor: colors.card,
                  gap: 5,
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedText }}>
                  Enter any date (YYYY-MM-DD) to jump to that week
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <TextInput
                    value={jumpDateInput}
                    onChangeText={setJumpDateInput}
                    placeholder="YYYY-MM-DD"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "default"}
                    style={{
                      minWidth: 150,
                      height: 34,
                      borderWidth: 1,
                      borderColor: colors.border,
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      color: colors.text,
                      backgroundColor: colors.bg,
                    }}
                  />
                  <Button title="Go" variant="secondary" onPress={applyJumpToWeekInput} />
                </View>
              </View>
            ) : null}
            {viewMode === "seasonMileage" ? (
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text style={{ fontSize: 11, fontWeight: "800", color: colors.mutedText }}>Groups</Text>
                  <View
                    style={{
                      minWidth: 230,
                      maxWidth: 420,
                      flex: 1,
                      position: "relative",
                      zIndex: 8,
                      overflow: "visible",
                    }}
                  >
                    <Pressable
                      onPress={() => setTrainingGroupFilterOpen((prev) => !prev)}
                      style={{
                        height: 34,
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: 8,
                        paddingHorizontal: 10,
                        backgroundColor: colors.bg,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: colors.text }}>
                        {selectedTrainingGroupLabel}
                      </Text>
                      <Text style={{ fontSize: 11, fontWeight: "900", color: colors.mutedText }}>
                        {trainingGroupFilterOpen ? "▴" : "▾"}
                      </Text>
                    </Pressable>
                  </View>
                  <Text style={{ fontSize: 11, fontWeight: "800", color: colors.mutedText }}>Preset</Text>
                  <View
                    style={{
                      minWidth: 230,
                      maxWidth: 420,
                      flex: 1,
                      position: "relative",
                      zIndex: 7,
                      overflow: "visible",
                    }}
                  >
                    <Pressable
                      onPress={() => setSeasonFilterOpen(true)}
                      style={{
                        height: 34,
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: 8,
                        paddingHorizontal: 10,
                        backgroundColor: colors.bg,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: colors.text }}>
                        {selectedSeasonLabel}
                      </Text>
                      <Text style={{ fontSize: 11, fontWeight: "900", color: colors.mutedText }}>
                        {seasonFilterOpen ? "▴" : "▾"}
                      </Text>
                    </Pressable>
                    <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedText, marginTop: 4, marginLeft: 4 }}>
                      Presets fill the date range.
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <View style={{ minWidth: 142, gap: 3 }}>
                    <Text style={{ fontSize: 10, fontWeight: "900", color: colors.mutedText }}>Start date</Text>
                    {Platform.OS === "web" ? (
                      <input
                        type="date"
                        value={mileageRangeStartISO}
                        onChange={(event) => updateMileageRangeStart(String((event.target as HTMLInputElement)?.value ?? "").trim())}
                        style={{
                          height: 34,
                          border: `1px solid ${colors.border}`,
                          borderRadius: 8,
                          padding: "0 10px",
                          color: colors.text,
                          background: colors.bg,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      />
                    ) : (
                      <TextInput
                        value={mileageRangeStartISO}
                        onChangeText={updateMileageRangeStart}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder="YYYY-MM-DD"
                        style={{
                          height: 34,
                          borderWidth: 1,
                          borderColor: colors.border,
                          borderRadius: 8,
                          paddingHorizontal: 10,
                          color: colors.text,
                          backgroundColor: colors.bg,
                          fontSize: 12,
                          fontWeight: "700",
                        }}
                      />
                    )}
                  </View>
                  <View style={{ minWidth: 142, gap: 3 }}>
                    <Text style={{ fontSize: 10, fontWeight: "900", color: colors.mutedText }}>End date</Text>
                    {Platform.OS === "web" ? (
                      <input
                        type="date"
                        value={mileageRangeEndISO}
                        onChange={(event) => updateMileageRangeEnd(String((event.target as HTMLInputElement)?.value ?? "").trim())}
                        style={{
                          height: 34,
                          border: `1px solid ${colors.border}`,
                          borderRadius: 8,
                          padding: "0 10px",
                          color: colors.text,
                          background: colors.bg,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      />
                    ) : (
                      <TextInput
                        value={mileageRangeEndISO}
                        onChangeText={updateMileageRangeEnd}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder="YYYY-MM-DD"
                        style={{
                          height: 34,
                          borderWidth: 1,
                          borderColor: colors.border,
                          borderRadius: 8,
                          paddingHorizontal: 10,
                          color: colors.text,
                          backgroundColor: colors.bg,
                          fontSize: 12,
                          fontWeight: "700",
                        }}
                      />
                    )}
                  </View>
                  <Text style={{ fontSize: 11, fontWeight: "800", color: colors.mutedText }}>Mileage type</Text>
                  <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                    <Button
                      title="Completed"
                      variant={seasonMileageMetric === "completed" ? "primary" : "secondary"}
                      onPress={() => setSeasonMileageMetric("completed")}
                    />
                    <Button
                      title="Planned"
                      variant={seasonMileageMetric === "planned" ? "primary" : "secondary"}
                      onPress={() => {
                        setSeasonMileageMetric("planned");
                        void loadSeasonMileagePlannedData(false);
                      }}
                    />
                  </View>
                  <Text style={{ fontSize: 11, fontWeight: "800", color: colors.mutedText }}>
                    {seasonMileageRange.startISO && seasonMileageRange.endISO
                      ? `${seasonMileageRange.startISO} to ${seasonMileageRange.endISO}`
                      : "No valid range"}
                  </Text>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedText }}>
                    {seasonMileageWeekStarts.length} week{seasonMileageWeekStarts.length === 1 ? "" : "s"} • {seasonMileageAthletes.length} athlete{seasonMileageAthletes.length === 1 ? "" : "s"}
                  </Text>
                  <Button
                    title={seasonMileageActiveLoading ? "Refreshing..." : "Refresh"}
                    variant="secondary"
                    disabled={seasonMileageActiveLoading}
                    onPress={() => {
                      if (seasonMileageMetric === "planned") {
                        void loadSeasonMileagePlannedData(true);
                      } else {
                        void loadSeasonMileageData();
                      }
                    }}
                  />
                  {seasonMileageActiveError ? (
                    <Text style={{ fontSize: 11, fontWeight: "800", color: "#b91c1c" }}>{seasonMileageActiveError}</Text>
                  ) : null}
                </View>
              </View>
            ) : null}
          </View>

          {readOnlyMileage ? (
            <View style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 10, backgroundColor: "#f8fafc", paddingHorizontal: 10, paddingVertical: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: "800", color: "#475569" }}>Viewer access: editing is disabled.</Text>
            </View>
          ) : null}

          <View
            style={{
              borderWidth: 1,
              borderColor: "rgba(15,23,42,0.08)",
              borderRadius: 12,
              paddingHorizontal: 8,
              paddingVertical: 6,
              backgroundColor: "rgba(15,23,42,0.02)",
              gap: 5,
              position: "relative",
              zIndex: 1,
            }}
          >
            {viewMode === "teamWeek" ? (
            <>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <AppText variant="caption" color="mutedText" style={{ fontWeight: "800", marginRight: 2 }}>
                  WEEK ACTIONS
                </AppText>
                {!readOnlyMileage ? (
                  <>
                    <Button title="Copy Week" variant="secondary" onPress={copyEntireVisibleWeek} />
                    <Button
                      title="Paste Week"
                      variant="secondary"
                      onPress={() => void pasteWeekClipboardIntoVisibleWeek()}
                      disabled={!weekClipboard}
                    />
                    <Button title="Copy Previous Week" variant="secondary" onPress={copyPreviousWeekAll} />
                    <Button title="Clear Entire Week" variant="secondary" onPress={clearEntireWeekAll} />
                  </>
                ) : null}
                {canExportMileage ? (
                  <Button
                    title={exportingPdf ? "Exporting..." : "Export PDF"}
                    variant="secondary"
                    onPress={() => void handleExportMileagePdf()}
                    disabled={exportingPdf}
                  />
                ) : null}
                {weekClipboard ? (
                  <View
                    style={{
                      borderWidth: 1,
                      borderColor: "rgba(37,99,235,0.28)",
                      backgroundColor: "rgba(37,99,235,0.08)",
                      borderRadius: 999,
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <Text style={{ fontSize: 10, fontWeight: "800", color: colors.text }}>
                      Copied: {copiedWeekRangeLabel}
                    </Text>
                    <Text style={{ fontSize: 9, fontWeight: "700", color: colors.mutedText }}>
                      {viewingCopiedWeek ? "Viewing" : "Ready"}
                    </Text>
                  </View>
                ) : null}
              </View>

              <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedText }}>
                Grid: {mileageSelectedRowsCount} row{mileageSelectedRowsCount === 1 ? "" : "s"} selected
              </Text>
            </View>

            {!readOnlyMileage ? (
            <View
              style={{
                flexDirection: "row",
                gap: 3,
                flexWrap: "wrap",
                alignItems: "center",
                ...(isDesktop
                  ? ({ justifyContent: "flex-end" } as any)
                  : ({ justifyContent: "flex-start" } as any)),
              }}
            >
              <AppText variant="caption" color="mutedText" style={{ fontWeight: "800", marginRight: 2 }}>
                GRID TOOLS
              </AppText>
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
            </View>
            ) : null}
            </>
            ) : viewMode === "seasonMileage" ? (
              <View
                style={{
                  flexDirection: "row",
                  gap: 6,
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedText }}>
                  Season View: {seasonMileageActiveLoading ? "Loading..." : `${seasonMileageTableRows.length} athlete row${seasonMileageTableRows.length === 1 ? "" : "s"}`}
                </Text>
                <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedText }}>
                  Showing {seasonMileageMetricLabel.toLowerCase()} mileage
                </Text>
              </View>
            ) : (
              <View
                style={{
                  flexDirection: "row",
                  gap: 6,
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedText }}>
                  Athlete Grid: {athleteMultiGrid.selectedRowIds.length} week row{athleteMultiGrid.selectedRowIds.length === 1 ? "" : "s"} selected
                  {athleteMultiWeeksLoading ? " • Loading visible weeks..." : ""}
                </Text>
                {!readOnlyMileage ? (
                <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
                  <MiniPill compact label="Copy" onPress={() => { setActiveGridId("athlete-multi-grid"); void athleteMultiGrid.copySelectionToClipboard(); }} />
                  <MiniPill compact label="Paste" onPress={() => { setActiveGridId("athlete-multi-grid"); void athleteMultiGrid.pasteFromClipboard(); }} />
                  <MiniPill compact label="Undo" onPress={() => { setActiveGridId("athlete-multi-grid"); athleteMultiGrid.undo(); }} />
                  <MiniPill
                    compact
                    label="Fill Selected"
                    onPress={() => {
                      setActiveGridId("athlete-multi-grid");
                      fillSelectedAthleteMulti();
                    }}
                    disabled={!athleteMultiGrid.getSelectionRect() || athleteMultiGrid.selectedRowIds.length < 2}
                  />
                  <MiniPill
                    compact
                    label="Fill All"
                    onPress={() => {
                      setActiveGridId("athlete-multi-grid");
                      fillAllAthleteMulti();
                    }}
                    disabled={athleteMultiRowIds.length < 2}
                  />
                </View>
                ) : null}
              </View>
            )}
          </View>
        </Card>

        <Card style={{ padding: 0, overflow: isWeb && isDesktop ? ("visible" as any) : "hidden", flex: 1 }}>
          <View style={{ flex: 1, minHeight: 0 }}>
            {viewMode === "teamWeek" ? (
            <>
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
            </>
            ) : viewMode === "seasonMileage" ? (
              isWeb && isDesktop ? (
                <div
                  ref={mileageSheetRootRef as any}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowX: "auto",
                    overflowY: "auto",
                    position: "relative",
                    isolation: "isolate",
                  }}
                >
                  <View style={{ minWidth: seasonMileageGridMinWidth, width: "max-content" as any, paddingBottom: 20 }}>
                    {seasonMileageTable}
                  </View>
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
                  <GridTable minWidth={seasonMileageGridMinWidth}>{seasonMileageTable}</GridTable>
                </ScrollView>
              )
            ) : (
              isWeb && isDesktop ? (
                <div
                  ref={mileageSheetRootRef as any}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowX: "auto",
                    overflowY: "auto",
                    position: "relative",
                    isolation: "isolate",
                  }}
                >
                  <View style={{ minWidth: athleteGridMinWidth, width: "max-content" as any, paddingBottom: 20 }}>
                    {athleteMultiSpreadsheet}
                  </View>
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
                  <GridTable minWidth={athleteGridMinWidth}>{athleteMultiSpreadsheet}</GridTable>
                </ScrollView>
              )
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

        <Modal
          visible={trainingVisibilityOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setTrainingVisibilityOpen(false)}
        >
          <Pressable
            onPress={() => setTrainingVisibilityOpen(false)}
            style={{
              flex: 1,
              backgroundColor: "rgba(2,6,23,0.28)",
              alignItems: "center",
              justifyContent: "center",
              padding: 18,
            }}
          >
            <Pressable
              onPress={() => {}}
              style={{
                width: "100%",
                maxWidth: 520,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.card,
                padding: 14,
                gap: 10,
              }}
            >
              <Text style={{ fontSize: 18, fontWeight: "900", color: colors.text }}>Training Visibility</Text>
              <Text style={{ fontSize: 12, fontWeight: "700", color: colors.mutedText }}>
                Current scope: {teamWeekVisibleAthletes.length} Team Week athlete{teamWeekVisibleAthletes.length === 1 ? "" : "s"}.
              </Text>

              <Text style={{ fontSize: 11, fontWeight: "900", color: colors.mutedText }}>Action</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {(["publish", "hide"] as TrainingVisibilityAction[]).map((value) => (
                  <Pressable
                    key={`mileage-visibility-action-${value}`}
                    onPress={() => setTrainingVisibilityAction(value)}
                    style={{
                      minHeight: 32,
                      paddingHorizontal: 10,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: trainingVisibilityAction === value ? colors.tint : colors.border,
                      backgroundColor: trainingVisibilityAction === value ? "rgba(37,99,235,0.12)" : colors.card,
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: "900", color: colors.text }}>
                      {value === "publish" ? "Publish to athletes" : "Hide from athletes"}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={{ fontSize: 11, fontWeight: "900", color: colors.mutedText }}>Content</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {([
                  ["workouts", "Workouts only"],
                  ["mileage", "Mileage only"],
                  ["both", "Workouts + Mileage"],
                ] as Array<[TrainingVisibilityContent, string]>).map(([value, label]) => (
                  <Pressable
                    key={`mileage-visibility-content-${value}`}
                    onPress={() => setTrainingVisibilityContent(value)}
                    style={{
                      minHeight: 32,
                      paddingHorizontal: 10,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: trainingVisibilityContent === value ? colors.tint : colors.border,
                      backgroundColor: trainingVisibilityContent === value ? "rgba(37,99,235,0.12)" : colors.card,
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: "900", color: colors.text }}>{label}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={{ fontSize: 11, fontWeight: "900", color: colors.mutedText }}>Range</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {([
                  ["week", "Current week"],
                  ["custom", "Custom range"],
                  ["season", "Selected season"],
                ] as Array<[TrainingVisibilityRange, string]>).map(([value, label]) => (
                  <Pressable
                    key={`mileage-visibility-range-${value}`}
                    onPress={() => setTrainingVisibilityRange(value)}
                    style={{
                      minHeight: 32,
                      paddingHorizontal: 10,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: trainingVisibilityRange === value ? colors.tint : colors.border,
                      backgroundColor: trainingVisibilityRange === value ? "rgba(37,99,235,0.12)" : colors.card,
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: "900", color: colors.text }}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              {trainingVisibilityRange === "season" ? (
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.mutedText }}>Season: {selectedSeasonLabel}</Text>
              ) : null}
              {trainingVisibilityRange === "custom" ? (
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  <View style={{ flex: 1, minWidth: 150, gap: 4 }}>
                    <Text style={{ fontSize: 11, fontWeight: "900", color: colors.mutedText }}>Start date</Text>
                    <TextInput
                      value={trainingVisibilityStartISO}
                      onChangeText={setTrainingVisibilityStartISO}
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder="YYYY-MM-DD"
                      style={{ height: 38, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, color: colors.text }}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 150, gap: 4 }}>
                    <Text style={{ fontSize: 11, fontWeight: "900", color: colors.mutedText }}>End date</Text>
                    <TextInput
                      value={trainingVisibilityEndISO}
                      onChangeText={setTrainingVisibilityEndISO}
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder="YYYY-MM-DD"
                      style={{ height: 38, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, color: colors.text }}
                    />
                  </View>
                </View>
              ) : null}
              <Text style={{ fontSize: 12, fontWeight: "700", color: colors.mutedText }}>
                Mileage visibility is week-based. Any week touched by this range will be affected.
              </Text>
              {trainingVisibilityError ? (
                <Text style={{ fontSize: 11, fontWeight: "800", color: "#b91c1c" }}>{trainingVisibilityError}</Text>
              ) : null}
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
                <Button title="Cancel" variant="secondary" disabled={trainingVisibilityApplying} onPress={() => setTrainingVisibilityOpen(false)} />
                <Button title={trainingVisibilityApplying ? "Applying..." : "Apply"} disabled={trainingVisibilityApplying} onPress={() => void applyTrainingVisibilityNow()} />
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          visible={(viewMode === "teamWeek" || viewMode === "seasonMileage") && trainingGroupFilterOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setTrainingGroupFilterOpen(false)}
        >
          <Pressable
            onPress={() => setTrainingGroupFilterOpen(false)}
            style={{
              flex: 1,
              backgroundColor: "rgba(2,6,23,0.28)",
              alignItems: "center",
              justifyContent: isDesktop ? "flex-start" : "center",
              paddingTop: isDesktop ? 84 : 24,
              paddingHorizontal: 16,
            }}
          >
            <Pressable
              onPress={() => {}}
              style={{
                width: "100%",
                maxWidth: 520,
                maxHeight: isDesktop ? 520 : 460,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 12,
                backgroundColor: colors.card,
                overflow: "hidden",
                shadowColor: "#000",
                shadowOpacity: 0.22,
                shadowRadius: 14,
                shadowOffset: { width: 0, height: 6 },
                elevation: 16,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border,
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "900", color: colors.text }}>Training Groups</Text>
                <Button title="Done" variant="secondary" onPress={() => setTrainingGroupFilterOpen(false)} />
              </View>

              <ScrollView style={{ maxHeight: isDesktop ? 440 : 360 }} keyboardShouldPersistTaps="handled">
                <Pressable
                  onPress={() => {
                    void teamDataStore.actions.setSharedSelectedTrainingGroupIds([]);
                    setTrainingGroupFilterOpen(false);
                  }}
                  style={{
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    backgroundColor: selectedTrainingGroupIds.length === 0 ? "rgba(37,99,235,0.12)" : colors.card,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text }}>All groups (clear)</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    void teamDataStore.actions.setSharedSelectedTrainingGroupIds(
                      trainingGroupFilterOptions.map((option) => option.id)
                    );
                  }}
                  style={{
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    backgroundColor: colors.card,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text }}>Select all</Text>
                </Pressable>
                {trainingGroupFilterOptions.map((option) => (
                  <Pressable
                    key={`mileage-training-group-filter-modal-${option.id}`}
                    onPress={() => {
                      void teamDataStore.actions.setSharedSelectedTrainingGroupIds(
                        selectedTrainingGroupIds.includes(option.id)
                          ? selectedTrainingGroupIds.filter((id) => id !== option.id)
                          : [...selectedTrainingGroupIds, option.id]
                      );
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "rgba(15,23,42,0.06)",
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      backgroundColor: selectedTrainingGroupIds.includes(option.id) ? "rgba(37,99,235,0.12)" : colors.card,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text }}>
                      {selectedTrainingGroupIds.includes(option.id) ? "☑ " : "☐ "}
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
                {trainingGroupFilterOptions.length === 0 ? (
                  <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                    <Text style={{ fontSize: 12, color: colors.mutedText }}>No training groups found</Text>
                  </View>
                ) : null}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          visible={seasonFilterOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setSeasonFilterOpen(false)}
        >
          <Pressable
            onPress={() => setSeasonFilterOpen(false)}
            style={{
              flex: 1,
              backgroundColor: "rgba(2,6,23,0.28)",
              alignItems: "center",
              justifyContent: isDesktop ? "flex-start" : "center",
              paddingTop: isDesktop ? 84 : 24,
              paddingHorizontal: 16,
            }}
          >
            <Pressable
              onPress={() => {}}
              style={{
                width: "100%",
                maxWidth: 520,
                maxHeight: isDesktop ? 520 : 460,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 12,
                backgroundColor: colors.card,
                overflow: "hidden",
                shadowColor: "#000",
                shadowOpacity: 0.22,
                shadowRadius: 14,
                shadowOffset: { width: 0, height: 6 },
                elevation: 16,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border,
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "900", color: colors.text }}>Date Preset</Text>
                <Button title="Done" variant="secondary" onPress={() => setSeasonFilterOpen(false)} />
              </View>

              <ScrollView style={{ maxHeight: isDesktop ? 440 : 360 }} keyboardShouldPersistTaps="handled">
                <Pressable
                  onPress={() => {
                    void teamDataStore.actions.setSharedSelectedSeasonId(null);
                    setAthleteMultiRangeMode("custom");
                    setSeasonFilterOpen(false);
                  }}
                  style={{
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    backgroundColor: !selectedSeasonId ? "rgba(37,99,235,0.12)" : colors.card,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text }}>Custom range</Text>
                  <Text style={{ marginTop: 2, fontSize: 11, fontWeight: "700", color: colors.mutedText }}>
                    Keep the current start and end dates.
                  </Text>
                </Pressable>
                <Pressable
                  onPress={applyAllSeasonsMileageRange}
                  style={{
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    backgroundColor: colors.card,
                    opacity: allSeasonsDateRange ? 1 : 0.55,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text }}>All seasons date range</Text>
                  <Text style={{ marginTop: 2, fontSize: 11, fontWeight: "700", color: colors.mutedText }}>
                    {allSeasonsDateRange
                      ? `${allSeasonsDateRange.startISO} to ${allSeasonsDateRange.endISO}`
                      : "No season dates found."}
                  </Text>
                </Pressable>
                {seasonFilterOptions.map((option) => (
                  <Pressable
                    key={`mileage-season-filter-modal-${option.id}`}
                    onPress={() => {
                      applyMileageSeasonPreset(option.id);
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "rgba(15,23,42,0.06)",
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      backgroundColor: selectedSeasonId === option.id ? "rgba(37,99,235,0.12)" : colors.card,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text }}>
                      {selectedSeasonId === option.id ? "☑ " : "☐ "}
                      {option.label}
                    </Text>
                    {(() => {
                      const season = (s.teamSeasons ?? []).find((row) => String(row?.id ?? "").trim() === option.id);
                      const startISO = String(season?.start_date ?? "").trim();
                      const endISO = String(season?.end_date ?? "").trim();
                      return isValidISODate(startISO) && isValidISODate(endISO) ? (
                        <Text style={{ marginTop: 2, fontSize: 11, fontWeight: "700", color: colors.mutedText }}>
                          {startISO} to {endISO}
                        </Text>
                      ) : null;
                    })()}
                  </Pressable>
                ))}
                {seasonFilterOptions.length === 0 ? (
                  <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                    <Text style={{ fontSize: 12, color: colors.mutedText }}>No seasons found</Text>
                  </View>
                ) : null}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          visible={athleteRangeEditorOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setAthleteRangeEditorOpen(false)}
        >
          <Pressable
            onPress={() => setAthleteRangeEditorOpen(false)}
            style={{
              flex: 1,
              backgroundColor: "rgba(2,6,23,0.28)",
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 16,
            }}
          >
            <Pressable
              onPress={() => {}}
              style={{
                width: "100%",
                maxWidth: 520,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 12,
                backgroundColor: colors.card,
                overflow: "hidden",
              }}
            >
              <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                <Text style={{ fontSize: 14, fontWeight: "900", color: colors.text }}>Edit Athlete Range</Text>
                <Text style={{ fontSize: 11, fontWeight: "600", color: colors.mutedText }}>
                  {athleteMultiSelected?.name || "No athlete selected"} • Max {MAX_MILEAGE_RANGE_WEEKS} weeks
                </Text>
              </View>
              <View style={{ padding: 10, gap: 8 }}>
                <Text style={{ fontSize: 12, fontWeight: "800", color: colors.mutedText }}>First week (YYYY-MM-DD)</Text>
                <TextInput
                  value={athleteRangeDraftFirstWeekISO}
                  onChangeText={setAthleteRangeDraftFirstWeekISO}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="YYYY-MM-DD"
                  style={{
                    height: 36,
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    color: colors.text,
                    backgroundColor: colors.bg,
                  }}
                />
                <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedText }}>
                  Week of{" "}
                  {formatAthleteWeekRangeLabel(
                    getWeekStartISO(
                      isValidISODate(athleteRangeDraftFirstWeekISO)
                        ? athleteRangeDraftFirstWeekISO
                        : toISODate(new Date()),
                      weekStartsOn
                    )
                  )}
                </Text>
                <Text style={{ fontSize: 12, fontWeight: "800", color: colors.mutedText }}>Weeks to show</Text>
                <TextInput
                  value={athleteRangeDraftWeekCount}
                  onChangeText={setAthleteRangeDraftWeekCount}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={`1-${MAX_MILEAGE_RANGE_WEEKS}`}
                  keyboardType={Platform.OS === "ios" ? "number-pad" : "numeric"}
                  style={{
                    height: 36,
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    color: colors.text,
                    backgroundColor: colors.bg,
                  }}
                />
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  <Button
                    title="Use Selected Season"
                    variant="secondary"
                    onPress={() => {
                      applySelectedSeasonToAthleteRange();
                      setAthleteRangeEditorOpen(false);
                    }}
                    disabled={!selectedSeason || !athleteMultiSelectedId}
                  />
                  <Button
                    title="This Week"
                    variant="secondary"
                    onPress={() => {
                      const ws = athleteMultiCurrentWeekStartISO;
                      setAthleteRangeDraftFirstWeekISO(ws);
                      setAthleteRangeDraftError(null);
                    }}
                  />
                </View>
                {athleteRangeDraftError ? (
                  <Text style={{ fontSize: 11, fontWeight: "700", color: "#b91c1c" }}>{athleteRangeDraftError}</Text>
                ) : null}
                <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
                  <Button title="Cancel" variant="secondary" onPress={() => setAthleteRangeEditorOpen(false)} />
                  <Button title="Save Range" onPress={applyAthleteRangeDraft} />
                </View>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          visible={mileagePlanExportOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setMileagePlanExportOpen(false)}
        >
          <Pressable
            onPress={() => setMileagePlanExportOpen(false)}
            style={{
              flex: 1,
              backgroundColor: "rgba(2,6,23,0.28)",
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 16,
            }}
          >
            <Pressable
              onPress={() => {}}
              style={{
                width: "100%",
                maxWidth: 640,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 12,
                backgroundColor: colors.card,
                overflow: "hidden",
              }}
            >
              <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                <Text style={{ fontSize: 14, fontWeight: "900", color: colors.text }}>Export Mileage Plan</Text>
                <Text style={{ fontSize: 11, fontWeight: "600", color: colors.mutedText }}>
                  Athlete: {athleteMultiSelected?.name || "None"} • Max {MAX_MILEAGE_PLAN_EXPORT_RANGE_DAYS} days
                </Text>
              </View>
              <View style={{ padding: 10, gap: 8 }}>
                <Text style={{ fontSize: 12, fontWeight: "800", color: colors.mutedText }}>Season quick-pick</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                  <Pressable
                    onPress={() => setMileagePlanExportSeasonId(null)}
                    style={{
                      borderWidth: 1,
                      borderColor: colors.border,
                      borderRadius: 999,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      backgroundColor: !mileagePlanExportSeasonId ? "rgba(37,99,235,0.12)" : colors.card,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: colors.text }}>Custom range</Text>
                  </Pressable>
                  {mileagePlanExportSeasonOptions.map((option) => (
                    <Pressable
                      key={`mileage-plan-season-${option.id}`}
                      onPress={() => {
                        if (option.excluded) return;
                        applyMileagePlanSeasonRange(option.id);
                      }}
                      style={{
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: 999,
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        backgroundColor: mileagePlanExportSeasonId === option.id ? "rgba(37,99,235,0.12)" : colors.card,
                        opacity: option.excluded ? 0.5 : 1,
                      }}
                    >
                      <Text style={{ fontSize: 12, fontWeight: "700", color: colors.text }}>
                        {option.label}{option.excluded ? " (Excluded)" : ""}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>

                <Text style={{ fontSize: 12, fontWeight: "800", color: colors.mutedText }}>Start date</Text>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.text }}>{mileagePlanExportStartISO}</Text>
                <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                  <Button title="-1w" variant="secondary" onPress={() => shiftMileagePlanExportDate("start", -7)} />
                  <Button title="-1d" variant="secondary" onPress={() => shiftMileagePlanExportDate("start", -1)} />
                  <Button title="Today" variant="secondary" onPress={() => {
                    setMileagePlanExportStartISO(toISODate(new Date()));
                    if (mileagePlanExportSeasonId) setMileagePlanExportSeasonId(null);
                  }} />
                  <Button title="+1d" variant="secondary" onPress={() => shiftMileagePlanExportDate("start", 1)} />
                  <Button title="+1w" variant="secondary" onPress={() => shiftMileagePlanExportDate("start", 7)} />
                </View>

                <Text style={{ fontSize: 12, fontWeight: "800", color: colors.mutedText }}>End date</Text>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.text }}>{mileagePlanExportEndISO}</Text>
                <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                  <Button title="-1w" variant="secondary" onPress={() => shiftMileagePlanExportDate("end", -7)} />
                  <Button title="-1d" variant="secondary" onPress={() => shiftMileagePlanExportDate("end", -1)} />
                  <Button title="Today" variant="secondary" onPress={() => {
                    setMileagePlanExportEndISO(toISODate(new Date()));
                    if (mileagePlanExportSeasonId) setMileagePlanExportSeasonId(null);
                  }} />
                  <Button title="+1d" variant="secondary" onPress={() => shiftMileagePlanExportDate("end", 1)} />
                  <Button title="+1w" variant="secondary" onPress={() => shiftMileagePlanExportDate("end", 7)} />
                </View>

                {mileagePlanExportError ? (
                  <Text style={{ fontSize: 12, fontWeight: "700", color: "#b91c1c" }}>{mileagePlanExportError}</Text>
                ) : null}

                <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
                  <Button title="Cancel" variant="secondary" onPress={() => setMileagePlanExportOpen(false)} disabled={exportingMileagePlanPdf} />
                  <Button
                    title={exportingMileagePlanPdf ? "Exporting..." : "Export PDF"}
                    variant="primary"
                    onPress={() => void handleExportAthleteMileagePlanPdf()}
                    disabled={exportingMileagePlanPdf}
                  />
                </View>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          visible={viewMode === "athleteMultiWeek" && athletePickerOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setAthletePickerOpen(false)}
        >
          <Pressable
            onPress={() => setAthletePickerOpen(false)}
            style={{
              flex: 1,
              backgroundColor: "rgba(2,6,23,0.28)",
              alignItems: "center",
              justifyContent: isDesktop ? "flex-start" : "center",
              paddingTop: isDesktop ? 84 : 24,
              paddingHorizontal: 16,
            }}
          >
            <Pressable
              onPress={() => {}}
              style={{
                width: "100%",
                maxWidth: 520,
                maxHeight: isDesktop ? 520 : 460,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 12,
                backgroundColor: colors.card,
                overflow: "hidden",
                shadowColor: "#000",
                shadowOpacity: 0.22,
                shadowRadius: 14,
                shadowOffset: { width: 0, height: 6 },
                elevation: 16,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border,
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "900", color: colors.text }}>Select Athlete</Text>
                <Button title="Cancel" variant="secondary" onPress={() => setAthletePickerOpen(false)} />
              </View>

              <View style={{ padding: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                <TextInput
                  value={athleteSearchQuery}
                  onChangeText={setAthleteSearchQuery}
                  placeholder="Search athlete..."
                  autoCorrect={false}
                  autoCapitalize="none"
                  style={{
                    height: 34,
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    color: colors.text,
                    backgroundColor: colors.bg,
                    fontSize: 12,
                    fontWeight: "600",
                  }}
                />
              </View>

              <ScrollView style={{ maxHeight: isDesktop ? 440 : 360 }} keyboardShouldPersistTaps="handled">
                {athleteSearchResults.map((a) => (
                  <Pressable
                    key={`athlete-modal-option-${a.id}`}
                    onPress={() => {
                      setAthleteMultiSelectedId(a.id);
                      setAthletePickerOpen(false);
                    }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderBottomWidth: 1,
                      borderBottomColor: "rgba(15,23,42,0.06)",
                      backgroundColor: a.id === athleteMultiSelectedId ? "rgba(37,99,235,0.12)" : colors.card,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text }}>{a.name}</Text>
                  </Pressable>
                ))}
                {athleteSearchResults.length === 0 ? (
                  <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                    <Text style={{ fontSize: 12, color: colors.mutedText }}>No athletes found</Text>
                  </View>
                ) : null}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      </View>
    </Screen>
  );
}
