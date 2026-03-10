import { loadJSON, saveJSON } from "./storage";

export const WORKOUT_TEMPLATES_KEY = "training_app_workout_templates_v1";

// Authoritative template source: WORKOUT_TEMPLATES_KEY synced storage.
// Do not add alternate template read/write paths for this domain.
export type WorkoutTemplateSession = "AM" | "PM";

export type WorkoutTemplate = {
  id: string;
  name: string;
  title: string;
  details: string;
  primaryCategory: string | null;
  categories: string[];
  location: string | null;
  session: WorkoutTemplateSession | null;
  createdAt: number;
  updatedAt: number;
};

type TemplateDraft = {
  name?: string;
  title?: string;
  details?: string;
  primaryCategory?: string | null;
  categories?: string[];
  location?: string | null;
  session?: WorkoutTemplateSession | null;
  // Legacy alias (kept for compatibility with existing callers)
  categoryNames?: string[];
};

type TemplateUpdate = {
  name?: string;
  title?: string;
  details?: string;
  primaryCategory?: string | null;
  categories?: string[];
  location?: string | null;
  session?: WorkoutTemplateSession | null;
  // Legacy alias (kept for compatibility with existing callers)
  categoryNames?: string[];
};

type WorkoutTemplateSource = {
  title?: string | null;
  details?: string | null;
  primary_category?: string | null;
  primaryCategory?: string | null;
  categories?: string[] | null;
  location?: string | null;
  session?: string | null;
};

function createTemplateId() {
  return `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeCategories(raw: string[] | undefined) {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = list
    .map((name) => String(name ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(cleaned));
}

function normalizeSession(raw: unknown): WorkoutTemplateSession | null {
  const cleaned = String(raw ?? "").trim().toUpperCase();
  return cleaned === "PM" ? "PM" : cleaned === "AM" ? "AM" : null;
}

function normalizeStringOrNull(raw: unknown): string | null {
  const cleaned = String(raw ?? "").trim();
  return cleaned || null;
}

function normalizePrimaryCategory(raw: unknown, categories: string[]): string | null {
  const direct = normalizeStringOrNull(raw);
  if (direct) return direct;
  return categories[0] ?? null;
}

function normalizeTemplate(raw: any): WorkoutTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title ?? "").trim() || "Workout";
  const name = String(raw.name ?? "").trim() || title;
  const details = String(raw.details ?? "").trim();
  const categories = normalizeCategories(
    Array.isArray(raw.categories)
      ? raw.categories
      : Array.isArray(raw.categoryNames)
        ? raw.categoryNames
        : raw.category
          ? [String(raw.category)]
          : []
  );
  const primaryCategory = normalizePrimaryCategory(raw.primaryCategory ?? raw.primary_category ?? raw.category, categories);
  const location = normalizeStringOrNull(raw.location);
  const session = normalizeSession(raw.session);
  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  return {
    id: String(raw.id ?? "").trim() || createTemplateId(),
    name,
    title,
    details,
    primaryCategory,
    categories,
    location,
    session,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

export async function loadWorkoutTemplates(): Promise<WorkoutTemplate[]> {
  const raw = await loadJSON<any[]>(WORKOUT_TEMPLATES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeTemplate(item))
    .filter((item): item is WorkoutTemplate => !!item)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveWorkoutTemplates(list: WorkoutTemplate[]) {
  const normalized = (Array.isArray(list) ? list : [])
    .map((item) => normalizeTemplate(item))
    .filter((item): item is WorkoutTemplate => !!item)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  await saveJSON(WORKOUT_TEMPLATES_KEY, normalized);
}

export async function createWorkoutTemplate(draft: TemplateDraft): Promise<WorkoutTemplate> {
  const now = Date.now();
  const nextTemplate =
    normalizeTemplate({
      ...draft,
      categories: draft.categories ?? draft.categoryNames,
      createdAt: now,
      updatedAt: now,
    }) ?? {
      id: createTemplateId(),
      name: "Workout",
      title: "Workout",
      details: "",
      primaryCategory: null,
      categories: [],
      location: null,
      session: null,
      createdAt: now,
      updatedAt: now,
    };
  const existing = await loadWorkoutTemplates();
  await saveWorkoutTemplates([nextTemplate, ...existing]);
  return nextTemplate;
}

export async function deleteWorkoutTemplate(id: string) {
  const existing = await loadWorkoutTemplates();
  const next = existing.filter((t) => t.id !== id);
  await saveWorkoutTemplates(next);
}

export async function updateWorkoutTemplate(id: string, patch: TemplateUpdate) {
  const existing = await loadWorkoutTemplates();
  const next = existing.map((item) => {
    if (item.id !== id) return item;
    const normalized =
      normalizeTemplate({
        ...item,
        ...patch,
        categories: patch.categories ?? patch.categoryNames ?? item.categories,
        primaryCategory:
          patch.primaryCategory !== undefined
            ? patch.primaryCategory
            : patch.categoryNames !== undefined
              ? patch.categoryNames[0] ?? null
              : item.primaryCategory,
        updatedAt: Date.now(),
      }) ?? item;
    return normalized;
  });
  await saveWorkoutTemplates(next);
}

export function buildWorkoutTemplateDraftFromSource(source: WorkoutTemplateSource): TemplateDraft {
  const categories = normalizeCategories(source.categories ?? []);
  const primaryCategory = normalizePrimaryCategory(source.primaryCategory ?? source.primary_category, categories);
  return {
    title: String(source.title ?? "").trim() || "Workout",
    details: String(source.details ?? "").trim(),
    primaryCategory,
    categories,
    location: normalizeStringOrNull(source.location),
    session: normalizeSession(source.session),
  };
}

export async function createWorkoutTemplateFromSource(
  source: WorkoutTemplateSource & { name?: string | null }
): Promise<WorkoutTemplate> {
  const draft = buildWorkoutTemplateDraftFromSource(source);
  const name = String(source.name ?? "").trim();
  return createWorkoutTemplate({
    ...draft,
    name: name || draft.title,
  });
}
