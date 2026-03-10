import { loadJSON, saveJSON } from "./storage";
import { loadDistanceUnit, type DistanceUnit } from "./units";

export const PACE_KEY = "training_app_pace_seconds_per_mile_v1";
export const DEFAULT_PACE_SEC = 480; // 8:00 / mile

export function defaultPaceSecForUnit(unit: DistanceUnit) {
  return unit === "km" ? 300 : DEFAULT_PACE_SEC;
}

export function formatPace(sec: number) {
  const s = Math.max(1, Math.round(sec || DEFAULT_PACE_SEC));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function parsePace(text: string): number | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  // "8:00"
  const m = raw.match(/^(\d+)\s*:\s*(\d{1,2})$/);
  if (m) {
    const mm = Number(m[1]);
    const ss = Number(m[2]);
    if (Number.isFinite(mm) && Number.isFinite(ss) && ss >= 0 && ss < 60) {
      return mm * 60 + ss;
    }
    return null;
  }

  // "8" meaning 8:00
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.round(n * 60);

  return null;
}

export async function loadPaceSecondsPerMile() {
  const unit = await loadDistanceUnit();
  return await loadJSON<number>(PACE_KEY, defaultPaceSecForUnit(unit));
}

export async function savePaceSecondsPerMile(sec: number) {
  await saveJSON(PACE_KEY, Math.max(1, Math.round(sec)));
}
