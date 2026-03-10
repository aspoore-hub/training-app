import { loadCoachCategoriesFromTeamKV } from "./settings";
import type { WorkoutCategory } from "./types";

function cleanCategoryName(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeCoachCategories(input: unknown): WorkoutCategory[] {
  const list = Array.isArray(input) ? input : [];
  const out: WorkoutCategory[] = [];
  const seen = new Set<string>();

  for (const raw of list as any[]) {
    const id = String(raw?.id ?? "").trim();
    const name = cleanCategoryName(raw?.name);
    if (!id || !name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      name,
      color: typeof raw?.color === "string" ? String(raw.color).trim() : undefined,
    });
  }

  return out;
}

export async function loadCoachCategories(): Promise<WorkoutCategory[]> {
  return await loadCoachCategoriesFromTeamKV();
}

export async function loadCoachCategoryNames(): Promise<string[]> {
  const categories = await loadCoachCategories();
  return categories.map((c) => c.name).filter(Boolean);
}
