import type { WorkoutCategory } from "./types";

export const CATEGORIES_KEY = "training_app_categories_v1";
export const CATEGORY_COLOR_PALETTE = [
  "#111111",
  "#374151",
  "#475569",
  "#DC2626",
  "#EA580C",
  "#F97316",
  "#F59E0B",
  "#CA8A04",
  "#FFEB3B",
  "#65A30D",
  "#22C55E",
  "#16A34A",
  "#14B8A6",
  "#0F766E",
  "#06B6D4",
  "#7DD3FC",
  "#3B82F6",
  "#2563EB",
  "#1D4ED8",
  "#8B5CF6",
  "#7C3AED",
  "#A21CAF",
  "#BE185D",
  "#EC4899",
  "#F43F5E",
] as const;

export const DEFAULT_CATEGORY_COLOR = "#6B7280";

function isHexColor(value: string | undefined) {
  if (!value) return false;
  return /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

export function defaultCategories(): WorkoutCategory[] {
  return [
    { id: "easy", name: "Easy", color: "#16A34A" },
    { id: "recovery", name: "Recovery", color: "#0F766E" },
    { id: "long", name: "Long Run", color: "#2563EB" },
    { id: "workout", name: "Workout", color: "#7C3AED" },
    { id: "race", name: "Race", color: "#DC2626" },
    { id: "off", name: "Off / Rest", color: "#6B7280" },
    { id: "cross", name: "Cross-Train", color: "#CA8A04" },
  ];
}

export function normalizeCategories(input: WorkoutCategory[] | null | undefined): WorkoutCategory[] {
  const list = Array.isArray(input) ? input : [];
  const cleaned = list
    .filter((c) => c && typeof c.name === "string" && c.name.trim().length > 0)
    .map((c) => ({
      ...c,
      name: c.name.trim(),
      color: isHexColor(c.color) ? c.color : undefined,
    }));

  return cleaned;
}

export function pickUnusedCategoryColor(categories: WorkoutCategory[]) {
  const used = new Set(
    categories
      .map((c) => (isHexColor(c.color) ? c.color!.toUpperCase() : ""))
      .filter(Boolean)
  );
  const next = CATEGORY_COLOR_PALETTE.find((c) => !used.has(c.toUpperCase()));
  return next ?? CATEGORY_COLOR_PALETTE[categories.length % CATEGORY_COLOR_PALETTE.length];
}

export function categoryColorByName(categories: WorkoutCategory[], name: string) {
  const target = String(name ?? "").trim().toLowerCase();
  const found = categories.find((c) => c.name.trim().toLowerCase() === target);
  return found?.color ?? DEFAULT_CATEGORY_COLOR;
}

export function newId() {
  // simple unique id (good enough for local-only)
  return `cat_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
