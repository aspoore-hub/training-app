import { loadJSON, saveJSON } from "./storage";
import { normalizeWorkoutTimeInput } from "./time";

export const PRACTICE_DEFAULTS_KEY = "training_app_default_practice_times_v1";

export type PracticeTimeSessionDefaults = {
  am?: string;
  pm?: string;
};

export type PracticeTimeDefaults = Record<string, PracticeTimeSessionDefaults>;

export function emptyPracticeTimeDefaults(): PracticeTimeDefaults {
  const out: PracticeTimeDefaults = {};
  for (let i = 0; i < 7; i++) out[String(i)] = {};
  return out;
}

export function normalizePracticeTimeDefaults(raw: any): PracticeTimeDefaults {
  const base = emptyPracticeTimeDefaults();
  if (!raw || typeof raw !== "object") return base;

  for (let i = 0; i < 7; i++) {
    const key = String(i);
    const day = raw?.[key];
    const am = String(day?.am ?? "").trim();
    const pm = String(day?.pm ?? "").trim();
    base[key] = {
      am: am || undefined,
      pm: pm || undefined,
    };
  }

  return base;
}

export async function loadPracticeTimeDefaults(): Promise<PracticeTimeDefaults> {
  const raw = await loadJSON<any>(PRACTICE_DEFAULTS_KEY, emptyPracticeTimeDefaults());
  return normalizePracticeTimeDefaults(raw);
}

export async function savePracticeTimeDefaults(next: PracticeTimeDefaults) {
  await saveJSON(PRACTICE_DEFAULTS_KEY, normalizePracticeTimeDefaults(next));
}

export function getDefaultPracticeTime(
  defaults: PracticeTimeDefaults,
  dateISO: string,
  session: "AM" | "PM"
): string | undefined {
  const [y, m, d] = String(dateISO ?? "").split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return undefined;
  const dow = new Date(y, m - 1, d).getDay(); // 0..6
  const day = defaults[String(dow)] ?? {};
  const raw = String(session === "AM" ? day.am ?? "" : day.pm ?? "").trim();
  if (!raw) return undefined;
  return normalizeWorkoutTimeInput(raw) ?? raw;
}
