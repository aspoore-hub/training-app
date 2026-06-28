import { loadWeekStartSetting } from "./settings";
import { loadJSON, saveJSON } from "./storage";

export const COACH_DATE_CURSOR_KEY = "training_app_coach_date_cursor_v1";

export type CoachDateCursorSource = "calendar" | "workouts" | "mileage" | "trainingLogs" | "planner";

export type CoachDateCursor = {
  selectedDateIso: string;
  weekStartIso: string;
  weekEndIso: string;
  monthIso: string;
  source: CoachDateCursorSource;
  updatedAt: number;
};

type WeekStartDay = 0 | 1;

function isISODateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseISODateOnly(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function toISODateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysISO(dateIso: string, days: number): string {
  const date = parseISODateOnly(dateIso);
  date.setDate(date.getDate() + days);
  return toISODateOnly(date);
}

export function getCoachCursorWeekStartISO(dateIso: string, weekStartsOn: WeekStartDay): string {
  const date = parseISODateOnly(dateIso);
  const day = date.getDay();
  const offset = (day - weekStartsOn + 7) % 7;
  date.setDate(date.getDate() - offset);
  return toISODateOnly(date);
}

export function getCoachCursorMonthISO(dateIso: string): string {
  const date = parseISODateOnly(dateIso);
  date.setDate(1);
  return toISODateOnly(date);
}

function normalizeCursor(value: unknown): CoachDateCursor | null {
  if (!value || typeof value !== "object") return null;
  const maybe = value as Partial<CoachDateCursor>;
  const source = maybe.source;
  if (
    source !== "calendar" &&
    source !== "workouts" &&
    source !== "mileage" &&
    source !== "trainingLogs" &&
    source !== "planner"
  ) {
    return null;
  }
  if (!isISODateOnly(maybe.selectedDateIso) || !isISODateOnly(maybe.weekStartIso) || !isISODateOnly(maybe.weekEndIso) || !isISODateOnly(maybe.monthIso)) {
    return null;
  }
  const updatedAt = typeof maybe.updatedAt === "number" && Number.isFinite(maybe.updatedAt) ? maybe.updatedAt : 0;
  return {
    selectedDateIso: maybe.selectedDateIso,
    weekStartIso: maybe.weekStartIso,
    weekEndIso: maybe.weekEndIso,
    monthIso: maybe.monthIso,
    source,
    updatedAt,
  };
}

export async function loadCoachDateCursor(): Promise<CoachDateCursor | null> {
  const raw = await loadJSON<unknown>(COACH_DATE_CURSOR_KEY, null);
  return normalizeCursor(raw);
}

async function loadConfiguredWeekStartsOn(): Promise<WeekStartDay> {
  try {
    const result = await loadWeekStartSetting();
    return result.normalized === "sunday" ? 0 : 1;
  } catch {
    return 1;
  }
}

export function buildCoachDateCursor(args: {
  selectedDateIso: string;
  source: CoachDateCursorSource;
  weekStartsOn: WeekStartDay;
  updatedAt?: number;
}): CoachDateCursor | null {
  const selectedDateIso = String(args.selectedDateIso ?? "").trim();
  if (!isISODateOnly(selectedDateIso)) return null;
  const weekStartIso = getCoachCursorWeekStartISO(selectedDateIso, args.weekStartsOn);
  return {
    selectedDateIso,
    weekStartIso,
    weekEndIso: addDaysISO(weekStartIso, 6),
    monthIso: getCoachCursorMonthISO(selectedDateIso),
    source: args.source,
    updatedAt: args.updatedAt ?? Date.now(),
  };
}

export async function saveCoachDateCursorForDate(args: {
  selectedDateIso: string;
  source: CoachDateCursorSource;
  weekStartsOn?: WeekStartDay;
}): Promise<void> {
  const weekStartsOn = args.weekStartsOn ?? (await loadConfiguredWeekStartsOn());
  const cursor = buildCoachDateCursor({
    selectedDateIso: args.selectedDateIso,
    source: args.source,
    weekStartsOn,
  });
  if (!cursor) return;
  await saveJSON(COACH_DATE_CURSOR_KEY, cursor);
}
