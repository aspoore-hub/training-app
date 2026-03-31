import type { DailyMileageTarget, MileageValue, WeekStartDay, WeeklyMileagePlan } from "./types";
import {
  parseWorkoutEntryValue,
  type ParsedWorkoutEntry,
} from "./workoutEntryParser";
import { DEFAULT_PACE_SEC } from "./pace";

export function toISODate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function parseISODate(iso: string) {
  // iso: YYYY-MM-DD
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

// Returns week start date (ISO) for any date, based on weekStartsOn
export function getWeekStartISO(dateISO: string, weekStartsOn: WeekStartDay) {
  const d = parseISODate(dateISO);
  const jsDay = d.getDay(); // 0 Sun..6 Sat
  // compute how many days to subtract to reach weekStartsOn
  const diff = (jsDay - weekStartsOn + 7) % 7;
  const start = new Date(d);
  start.setDate(d.getDate() - diff);
  return toISODate(start);
}

// For a date in the week, return index 0..6 where 0 is week start
export function getWeekIndex(dateISO: string, weekStartISO: string) {
  const d = parseISODate(dateISO);
  const s = parseISODate(weekStartISO);
  const ms = d.getTime() - s.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000)); // 0..6 expected
}

export function parseMileageInput(text: string): MileageValue | undefined {
  const parsed = parseWorkoutEntryValue(text);
  if (!parsed) return undefined;
  return toLegacyMileageValue(parsed);
}

function toLegacyMileageValue(entry: ParsedWorkoutEntry): MileageValue {
  if (entry.options.length === 0) return { kind: "exact", value: 0 };

  const toLegacyOption = (option: ParsedWorkoutEntry["options"][number]): MileageValue | null => {
    if (option.kind === "miles") {
      if (option.min === option.max) return { kind: "exact", value: option.min };
      return { kind: "range", min: option.min, max: option.max };
    }

    const isXt = option.kind === "xt";
    if (option.minMinutes === option.maxMinutes) {
      return {
        kind: "time",
        seconds: Math.round(option.minMinutes * 60),
        input: "mm:ss",
        xt: isXt ? true : undefined,
      };
    }

    return {
      kind: "timeRange",
      minSeconds: Math.round(option.minMinutes * 60),
      maxSeconds: Math.round(option.maxMinutes * 60),
      input: "mm:ss",
      xt: isXt ? true : undefined,
    };
  };

  if (entry.choiceMode === "single") {
    return toLegacyOption(entry.options[0] as ParsedWorkoutEntry["options"][number]) || { kind: "exact", value: 0 };
  }

  return {
    kind: "choice",
    options: [toLegacyOption(entry.options[0] as ParsedWorkoutEntry["options"][number]) as MileageValue, toLegacyOption(entry.options[1] as ParsedWorkoutEntry["options"][number]) as MileageValue],
  };
}

function formatMinutesCompact(totalMinutes: number, inputStyle?: "mm:ss" | "hh:mm:ss") {
  const minutes = Math.round(totalMinutes);
  if (inputStyle === "hh:mm:ss") {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}hr ${m}min`;
  }
  return `${minutes}min`;
}

function pad2(n: number) {
  return String(Math.floor(Math.abs(n))).padStart(2, "0");
}

function secondsToClock(seconds: number, style?: "mm:ss" | "hh:mm:ss") {
  const s = Math.max(0, Math.round(seconds || 0));

  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;

  if (style === "hh:mm:ss") {
    return `${hh}:${pad2(mm)}:${pad2(ss)}`;
  }

  // mm:ss (minutes can exceed 60, e.g. 60:00)
  const totalMin = Math.floor(s / 60);
  return `${totalMin}:${pad2(ss)}`;
}

export function formatMileage(v?: MileageValue): string {
  if (!v) return "";

  if ((v as any).kind === "choice") {
    const options = Array.isArray((v as any).options) ? (v as any).options : [];
    if (options.length !== 2) return "";
    const left = formatMileage(options[0]);
    const right = formatMileage(options[1]);
    if (!left || !right) return "";
    return `${left} or ${right}`;
  }

  if ((v as any).kind === "exact") return String((v as any).value);
  if ((v as any).kind === "range") return `${(v as any).min}-${(v as any).max}`;

  if ((v as any).kind === "time") {
    const minutes = ((v as any).seconds ?? 0) / 60;
    const base = formatMinutesCompact(minutes, (v as any).input);
    return (v as any).xt ? `${base} XT` : base;
  }

  if ((v as any).kind === "timeRange") {
    const minMin = ((v as any).minSeconds ?? 0) / 60;
    const maxMin = ((v as any).maxSeconds ?? 0) / 60;

    let base = "";
    if ((v as any).input === "hh:mm:ss") {
      base = `${formatMinutesCompact(minMin, "hh:mm:ss")}–${formatMinutesCompact(maxMin, "hh:mm:ss")}`;
    } else {
      const a = Math.round(minMin);
      const b = Math.round(maxMin);
      base = a === b ? `${a}min` : `${a}-${b}min`;
    }

    return (v as any).xt ? `${base} XT` : base;
  }

  return "";
}

/**
 * Sheet formatter:
 * - miles stay as "6" or "2-3"
 * - time stays as "20:00" or "1:00:00"
 */
export function formatMileageForSheet(v?: MileageValue): string {
  if (!v) return "";

  if ((v as any).kind === "choice") {
    const options = Array.isArray((v as any).options) ? (v as any).options : [];
    if (options.length !== 2) return "";
    const left = formatMileageForSheet(options[0]);
    const right = formatMileageForSheet(options[1]);
    if (!left || !right) return "";
    return `${left} or ${right}`;
  }

  if ((v as any).kind === "exact") return String((v as any).value);
  if ((v as any).kind === "range") return `${(v as any).min}-${(v as any).max}`;

  if ((v as any).kind === "time") {
    const s = secondsToClock((v as any).seconds ?? 0, (v as any).input);
    return (v as any).xt ? `${s}XT` : s;
  }

  if ((v as any).kind === "timeRange") {
    const a = secondsToClock((v as any).minSeconds ?? 0, (v as any).input);
    const b = secondsToClock((v as any).maxSeconds ?? 0, (v as any).input);
    const s = `${a}-${b}`;
    return (v as any).xt ? `${s}XT` : s;
  }

  return "";
}

function mileageRangeForValue(v: MileageValue | undefined, paceSecPerMile: number): { min: number; max: number } {
  if (!v) return { min: 0, max: 0 };
  const kind = (v as any).kind;
  const paceMinPerMile = Math.max(1, (paceSecPerMile || DEFAULT_PACE_SEC) / 60);

  if (kind === "choice") {
    const options = Array.isArray((v as any).options) ? (v as any).options : [];
    if (options.length !== 2) return { min: 0, max: 0 };
    const a = mileageRangeForValue(options[0], paceSecPerMile);
    const b = mileageRangeForValue(options[1], paceSecPerMile);
    return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
  }

  if (kind === "exact") {
    const miles = Number((v as any).value ?? 0);
    if (!Number.isFinite(miles)) return { min: 0, max: 0 };
    return { min: miles, max: miles };
  }
  if (kind === "range") {
    const a = Number((v as any).min ?? 0);
    const b = Number((v as any).max ?? 0);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { min: 0, max: 0 };
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  if (kind === "time") {
    if ((v as any).xt) return { min: 0, max: 0 };
    const minutes = Number((v as any).seconds ?? 0) / 60;
    if (!Number.isFinite(minutes)) return { min: 0, max: 0 };
    const miles = minutes / paceMinPerMile;
    return { min: miles, max: miles };
  }
  if (kind === "timeRange") {
    if ((v as any).xt) return { min: 0, max: 0 };
    const a = Number((v as any).minSeconds ?? 0) / 60;
    const b = Number((v as any).maxSeconds ?? 0) / 60;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { min: 0, max: 0 };
    return { min: Math.min(a, b) / paceMinPerMile, max: Math.max(a, b) / paceMinPerMile };
  }

  // Legacy data support from prior minutes-based model
  if (kind === "minutes") {
    const minutes = Number((v as any).value ?? 0);
    if (!Number.isFinite(minutes)) return { min: 0, max: 0 };
    const miles = minutes / paceMinPerMile;
    return { min: miles, max: miles };
  }
  if (kind === "minutesRange") {
    const a = Number((v as any).min ?? 0);
    const b = Number((v as any).max ?? 0);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { min: 0, max: 0 };
    return { min: Math.min(a, b) / paceMinPerMile, max: Math.max(a, b) / paceMinPerMile };
  }

  return { min: 0, max: 0 };
}

export function sumMileage(values: Array<MileageValue | undefined>, paceSecPerMile: number = DEFAULT_PACE_SEC) {
  let min = 0;
  let max = 0;
  for (const v of values) {
    const r = mileageRangeForValue(v, paceSecPerMile);
    min += r.min;
    max += r.max;
  }
  return { min, max };
}

export function formatSum(sum: { min: number; max: number }) {
  if (sum.min === 0 && sum.max === 0) return "";
  if (Math.abs(sum.min - sum.max) < 1e-9) return String(Math.round(sum.min * 10) / 10);
  return `${Math.round(sum.min * 10) / 10}-${Math.round(sum.max * 10) / 10}`;
}
