import { loadJSON, saveJSON } from "./storage";
import { MILEAGE_PLANS_KEY } from "./mileagePlan";
import type { DailyMileageTarget, MileageValue, WeeklyMileagePlan } from "./types";
import { migrateRosterToV2Once } from "./roster";

const MIGRATIONS_KEY = "training_app_migrations_v1";
const MIGRATION_ID = "normalize_mileage_values_v1";

type Done = Record<string, true>;

function isFiniteNumber(n: any): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function parseLegacyStringToMileage(raw: string): MileageValue | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;

  const dash = s.includes("-") ? s.split("-") : null;
  if (dash && dash.length === 2) {
    const a = Number(dash[0].trim());
    const b = Number(dash[1].trim());
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      return { kind: "range", min, max };
    }
    return undefined;
  }

  const v = Number(s);
  if (!Number.isFinite(v)) return undefined;
  return { kind: "exact", value: v };
}

function normalizeMileageValue(v: any): MileageValue | undefined {
  if (v == null) return undefined;

  // Already canonical
  if (typeof v === "object" && typeof v.kind === "string") {
    if (v.kind === "exact" && isFiniteNumber(v.value)) return { kind: "exact", value: v.value };
    if (v.kind === "range" && isFiniteNumber(v.min) && isFiniteNumber(v.max)) {
      const min = Math.min(v.min, v.max);
      const max = Math.max(v.min, v.max);
      return { kind: "range", min, max };
    }
  }

  // Legacy: number
  if (isFiniteNumber(v)) return { kind: "exact", value: v };

  // Legacy: string
  if (typeof v === "string") return parseLegacyStringToMileage(v);

  // Legacy: { exact } or { min/max }
  if (typeof v === "object") {
    if (isFiniteNumber(v.exact)) return { kind: "exact", value: v.exact };

    const hasMin = isFiniteNumber(v.min);
    const hasMax = isFiniteNumber(v.max);
    if (hasMin || hasMax) {
      const mn = hasMin ? v.min : v.max;
      const mx = hasMax ? v.max : v.min;
      const min = Math.min(mn, mx);
      const max = Math.max(mn, mx);
      return { kind: "range", min, max };
    }
  }

  return undefined;
}

function normalizeDayTarget(day: any): { day: DailyMileageTarget; changed: boolean } {
  let changed = false;

  const src: any = day ?? {};
  const next: any = { ...src };

  // normalize both lowercase and any lingering uppercase fields
  const amRaw = src.am ?? src.AM;
  const pmRaw = src.pm ?? src.PM;

  const am = normalizeMileageValue(amRaw);
  const pm = normalizeMileageValue(pmRaw);

  // Only write canonical fields
  if (amRaw !== undefined || src.AM !== undefined) {
    if (am) next.am = am;
    else delete next.am;
    changed = true;
  }

  if (pmRaw !== undefined || src.PM !== undefined) {
    if (pm) next.pm = pm;
    else delete next.pm;
    changed = true;
  }

  // Remove legacy uppercase fields if present
  if ("AM" in next) {
    delete next.AM;
    changed = true;
  }
  if ("PM" in next) {
    delete next.PM;
    changed = true;
  }

  return { day: next as DailyMileageTarget, changed };
}

function normalizePlan(plan: WeeklyMileagePlan): { plan: WeeklyMileagePlan; changed: boolean } {
  let changed = false;

  // days should be Record<string, DailyMileageTarget>
  const daysAny: any = (plan as any).days ?? {};
  const nextDays: any = { ...daysAny };

  for (let i = 0; i < 7; i++) {
    const key = String(i);
    const { day, changed: c } = normalizeDayTarget(daysAny[key]);
    nextDays[key] = day;
    if (c) changed = true;
  }

  if (!changed) return { plan, changed: false };

  const nextPlan: any = { ...plan, days: nextDays };
  // Optional: bump updatedAt if you use it
  if (typeof nextPlan.updatedAt === "number") nextPlan.updatedAt = Date.now();
  return { plan: nextPlan as WeeklyMileagePlan, changed: true };
}

async function runMileageNormalizationMigration(done: Done): Promise<Done> {
  if (done[MIGRATION_ID]) return done;

  const rawPlans = await loadJSON<any>(MILEAGE_PLANS_KEY, []);
  const plansArr: WeeklyMileagePlan[] = Array.isArray(rawPlans)
    ? rawPlans
    : typeof rawPlans === "object" && rawPlans
      ? (Object.values(rawPlans) as WeeklyMileagePlan[])
      : [];

  let anyChanged = false;
  const nextPlans = plansArr.map((p) => {
    const { plan, changed } = normalizePlan(p);
    if (changed) anyChanged = true;
    return plan;
  });

  if (anyChanged) {
    await saveJSON(MILEAGE_PLANS_KEY, nextPlans);
  }

  return { ...done, [MIGRATION_ID]: true };
}

export async function runMigrations() {
  let done = await loadJSON<Done>(MIGRATIONS_KEY, {});

  done = await runMileageNormalizationMigration(done);
  await migrateRosterToV2Once();

  await saveJSON(MIGRATIONS_KEY, done);
}
