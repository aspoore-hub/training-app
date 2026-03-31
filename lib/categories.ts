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
  "#84CC16",
  "#A3E635",
  "#D9F99D",
  "#10B981",
  "#6EE7B7",
  "#2DD4BF",
  "#5EEAD4",
  "#22D3EE",
  "#67E8F9",
  "#38BDF8",
  "#93C5FD",
  "#C4B5FD",
  "#DDD6FE",
  "#A78BFA",
  "#C084FC",
  "#E879F9",
  "#F0ABFC",
  "#F472B6",
  "#FF4DCA",
  "#FB7185",
  "#FF6B6B",
  "#FF7F50",
  "#FDBA74",
  "#FEC89A",
  "#FAE066",
  "#FDE047",
] as const;

export const DEFAULT_CATEGORY_COLOR = "#6B7280";

type PermanentCategoryDef = {
  id: string;
  name: string;
  defaultColor: string;
  aliases: string[];
};

const PERMANENT_CATEGORY_DEFS: PermanentCategoryDef[] = [
  { id: "race", name: "Race", defaultColor: "#DC2626", aliases: ["race"] },
  { id: "recovery", name: "Recovery", defaultColor: "#0F766E", aliases: ["recovery"] },
  { id: "off", name: "Off", defaultColor: "#6B7280", aliases: ["off", "off / rest", "rest"] },
];

const PERMANENT_CATEGORY_BY_ID = new Map(
  PERMANENT_CATEGORY_DEFS.map((def) => [def.id.toLowerCase(), def])
);
const PERMANENT_CATEGORY_BY_ALIAS = new Map<string, PermanentCategoryDef>();
for (const def of PERMANENT_CATEGORY_DEFS) {
  for (const alias of def.aliases) {
    PERMANENT_CATEGORY_BY_ALIAS.set(alias.toLowerCase(), def);
  }
}

function permanentCategoryForId(id: string | undefined): PermanentCategoryDef | null {
  const key = String(id ?? "").trim().toLowerCase();
  if (!key) return null;
  return PERMANENT_CATEGORY_BY_ID.get(key) ?? null;
}

function permanentCategoryForName(name: string | undefined): PermanentCategoryDef | null {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) return null;
  return PERMANENT_CATEGORY_BY_ALIAS.get(key) ?? null;
}

export function isPermanentCategory(input: { id?: string; name?: string } | string): boolean {
  if (typeof input === "string") return !!permanentCategoryForName(input);
  return !!permanentCategoryForId(input?.id) || !!permanentCategoryForName(input?.name);
}

export function resolvePermanentCategoryName(name: string): string {
  const def = permanentCategoryForName(name);
  return def?.name ?? String(name ?? "").trim();
}

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
    { id: "off", name: "Off", color: "#6B7280" },
    { id: "cross", name: "Cross-Train", color: "#CA8A04" },
  ];
}

export function normalizeCategories(input: WorkoutCategory[] | null | undefined): WorkoutCategory[] {
  const list = Array.isArray(input) ? input : [];
  const normalized: WorkoutCategory[] = [];
  const seenByName = new Set<string>();
  const foundPermanent = new Set<string>();

  for (const raw of list) {
    if (!raw || typeof raw.name !== "string") continue;
    const rawName = String(raw.name ?? "").trim();
    if (!rawName) continue;

    const permanent =
      permanentCategoryForId(String(raw.id ?? "").trim()) ?? permanentCategoryForName(rawName);

    const id = permanent ? permanent.id : String(raw.id ?? "").trim() || newId();
    const name = permanent ? permanent.name : rawName;
    const color = isHexColor(raw.color)
      ? raw.color
      : permanent
      ? permanent.defaultColor
      : undefined;

    const key = name.toLowerCase();
    if (seenByName.has(key)) continue;
    seenByName.add(key);
    normalized.push({ id, name, color });
    if (permanent) foundPermanent.add(permanent.id);
  }

  for (const def of PERMANENT_CATEGORY_DEFS) {
    if (foundPermanent.has(def.id)) continue;
    normalized.push({
      id: def.id,
      name: def.name,
      color: def.defaultColor,
    });
  }

  return normalized;
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
  if (found?.color) return found.color;

  const permanent = permanentCategoryForName(name);
  if (permanent) {
    const canonical = categories.find((c) => c.name.trim().toLowerCase() === permanent.name.toLowerCase());
    if (canonical?.color) return canonical.color;
    return permanent.defaultColor;
  }

  return found?.color ?? DEFAULT_CATEGORY_COLOR;
}

export function newId() {
  // simple unique id (good enough for local-only)
  return `cat_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
