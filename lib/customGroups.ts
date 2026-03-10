import { loadJSON, saveJSON } from "./storage";

export const CUSTOM_GROUPS_KEY = "training_app_custom_groups_v1";

export type CustomAthleteGroup = {
  id: string;
  name: string;
  athleteIds: string[];
  createdAt: number;
  updatedAt: number;
};

function normalizeName(name: string) {
  return String(name ?? "").trim();
}

function uniqueIds(ids: string[]) {
  return Array.from(new Set((ids ?? []).map((id) => String(id ?? "").trim()).filter(Boolean)));
}

export async function loadCustomAthleteGroups(): Promise<CustomAthleteGroup[]> {
  const raw = await loadJSON<any[]>(CUSTOM_GROUPS_KEY, []);
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item, idx) => {
      const name = normalizeName(item?.name ?? "");
      const id = String(item?.id ?? `grp_${idx}_${Date.now()}`).trim();
      const athleteIds = uniqueIds(Array.isArray(item?.athleteIds) ? item.athleteIds : []);
      const createdAt = Number(item?.createdAt ?? Date.now());
      const updatedAt = Number(item?.updatedAt ?? createdAt);
      if (!id || !name) return null;
      return { id, name, athleteIds, createdAt, updatedAt } as CustomAthleteGroup;
    })
    .filter((x): x is CustomAthleteGroup => !!x);
}

export async function saveCustomAthleteGroups(groups: CustomAthleteGroup[]) {
  const cleaned = (groups ?? [])
    .map((g) => {
      const name = normalizeName(g?.name ?? "");
      const id = String(g?.id ?? "").trim();
      if (!id || !name) return null;
      return {
        ...g,
        id,
        name,
        athleteIds: uniqueIds(g?.athleteIds ?? []),
        createdAt: Number(g?.createdAt ?? Date.now()),
        updatedAt: Number(g?.updatedAt ?? Date.now()),
      } as CustomAthleteGroup;
    })
    .filter((x): x is CustomAthleteGroup => !!x);

  await saveJSON(CUSTOM_GROUPS_KEY, cleaned);
}

export function createGroupId() {
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
