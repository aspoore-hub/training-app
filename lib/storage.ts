import { isTeamKey } from "./syncKeys";
import { loadJSONWithCloudSync, saveJSONWithCloudSync } from "./cloudSync";
import { loadJSONWithTeamCloudSync, saveJSONWithTeamCloudSync } from "./teamCloudSync";

export async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  if (isTeamKey(key)) return await loadJSONWithTeamCloudSync<T>(key, fallback);
  return await loadJSONWithCloudSync<T>(key, fallback);
}

export async function saveJSON<T>(key: string, value: T): Promise<void> {
  if (isTeamKey(key)) return await saveJSONWithTeamCloudSync<T>(key, value);
  return await saveJSONWithCloudSync<T>(key, value);
}
