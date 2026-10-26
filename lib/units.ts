import { loadJSON, saveJSON } from "./storage";
import type { MileageValue } from "./types";

export type DistanceUnit = "mi" | "km";

export const DISTANCE_UNIT_KEY = "training_app_distance_unit_v1";
export const DEFAULT_DISTANCE_UNIT: DistanceUnit = "mi";

export const MI_TO_KM = 1.609344;
export const KM_TO_MI = 1 / MI_TO_KM;

type AthleteDistancePreference = {
  preferred_distance_unit?: unknown;
  preferredDistanceUnit?: unknown;
} | null | undefined;

type TeamDistanceSettings = {
  distanceUnit?: unknown;
} | DistanceUnit | null | undefined;

export function normalizeDistanceUnit(raw: unknown): DistanceUnit {
  return raw === "km" ? "km" : "mi";
}

export function normalizeOptionalDistanceUnit(raw: unknown): DistanceUnit | null {
  return raw === "mi" || raw === "km" ? raw : null;
}

export async function loadDistanceUnit(): Promise<DistanceUnit> {
  const raw = await loadJSON<string>(DISTANCE_UNIT_KEY, DEFAULT_DISTANCE_UNIT);
  return normalizeDistanceUnit(raw);
}

export async function saveDistanceUnit(unit: DistanceUnit) {
  await saveJSON(DISTANCE_UNIT_KEY, normalizeDistanceUnit(unit));
}

export function milesToKm(value: number): number {
  return Number.isFinite(value) ? value * MI_TO_KM : value;
}

export function kmToMiles(value: number): number {
  return Number.isFinite(value) ? value * KM_TO_MI : value;
}

export function convertDistance(value: number, from: DistanceUnit, to: DistanceUnit): number {
  if (!Number.isFinite(value) || from === to) return value;
  if (from === "mi" && to === "km") return milesToKm(value);
  return kmToMiles(value);
}

export function getAthleteDistanceUnit(
  athlete: AthleteDistancePreference,
  teamSettings: TeamDistanceSettings
): DistanceUnit {
  const preferred = normalizeOptionalDistanceUnit(
    athlete?.preferred_distance_unit ?? athlete?.preferredDistanceUnit
  );
  if (preferred) return preferred;
  const teamUnit = typeof teamSettings === "string" ? teamSettings : teamSettings?.distanceUnit;
  return normalizeDistanceUnit(teamUnit);
}

export function roundDistance(value: number, decimalPlaces = 2): number {
  if (!Number.isFinite(value)) return value;
  const precision = Math.max(0, Math.min(6, Math.trunc(decimalPlaces)));
  const multiplier = 10 ** precision;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

export function formatDistanceForUnit(
  value: number,
  unit: DistanceUnit,
  options?: { decimalPlaces?: number; includeUnit?: boolean }
): string {
  if (!Number.isFinite(value)) return "";
  const rounded = roundDistance(value, options?.decimalPlaces ?? 2);
  const numeric = Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
  return options?.includeUnit === false ? numeric : `${numeric} ${distanceUnitLabel(unit)}`;
}

export function convertMileageValue(
  value: MileageValue | undefined,
  from: DistanceUnit,
  to: DistanceUnit
): MileageValue | undefined {
  if (!value || from === to) return value;
  if (value.kind === "exact") {
    return { ...value, value: convertDistance(value.value, from, to) };
  }
  if (value.kind === "range") {
    return {
      ...value,
      min: convertDistance(value.min, from, to),
      max: convertDistance(value.max, from, to),
    };
  }
  if (value.kind === "choice") {
    return {
      ...value,
      options: value.options.map((option) => convertMileageValue(option, from, to) ?? option) as [MileageValue, MileageValue],
    };
  }
  return value;
}

export function distanceInputFromMiles(value: unknown, unit: DistanceUnit): string {
  const miles = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(miles)) return "";
  return formatDistanceForUnit(convertDistance(miles, "mi", unit), unit, {
    decimalPlaces: 2,
    includeUnit: false,
  });
}

export function distanceInputToMiles(value: number | null | undefined, unit: DistanceUnit): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return roundDistance(convertDistance(value, unit, "mi"), 6);
}

export function convertPaceSecondsPerUnit(sec: number, from: DistanceUnit, to: DistanceUnit): number {
  if (!Number.isFinite(sec) || from === to) return sec;
  // time per unit: sec/km = sec/mi * (mi per km), sec/mi = sec/km * (km per mi)
  if (from === "mi" && to === "km") return sec * KM_TO_MI;
  return sec * MI_TO_KM;
}

export function distanceUnitLabel(unit: DistanceUnit): string {
  return unit === "km" ? "km" : "mi";
}

export function paceUnitLongLabel(unit: DistanceUnit): string {
  return unit === "km" ? "kilometer" : "mile";
}
