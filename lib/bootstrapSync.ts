import AsyncStorage from "@react-native-async-storage/async-storage";
import { SYNC_KEYS } from "./syncKeys";
import { supabase } from "./supabase";

const BOOTSTRAP_DONE_KEY = "training_app_cloud_bootstrap_done_v1";
const META_PREFIX = "training_app_sync_meta_v1";

function syncMetaStorageKey(key: string) {
  return `${META_PREFIX}:${key}`;
}

async function getUserId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

async function fetchKV(userId: string, key: string) {
  const { data, error } = await supabase
    .from("kv_blobs")
    .select("user_id,key,data,version,updated_at")
    .eq("user_id", userId)
    .eq("key", key)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return {
    data: data.data,
    version: data.version as number,
    updatedAt: data.updated_at as string,
  } as { data: any; version: number; updatedAt: string };
}

async function upsertKV(userId: string, key: string, value: any, version: number) {
  const { error } = await supabase.from("kv_blobs").upsert(
    {
      user_id: userId,
      key,
      data: value,
      version,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,key" }
  );
  if (error) throw error;
}

/**
 * One-time sync:
 * - If cloud is empty, upload local device data to cloud
 * - If cloud has data, download cloud to this device
 */
export async function bootstrapSyncOnce() {
  const userId = await getUserId();
  if (!userId) return;

  const done = await AsyncStorage.getItem(BOOTSTRAP_DONE_KEY);
  if (done === "true") return;

  // Decide direction based on whether cloud has the first key
  const firstKey = SYNC_KEYS[0];
  const firstRemote = await fetchKV(userId, firstKey);

  if (!firstRemote) {
    // Upload device -> cloud
    for (const key of SYNC_KEYS) {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;

      try {
        const parsed = JSON.parse(raw);
        // start version at 1
        await upsertKV(userId, key, parsed, 1);
      } catch {
        // ignore bad JSON
      }
    }
  } else {
    // Download cloud -> device
    for (const key of SYNC_KEYS) {
      const remote = await fetchKV(userId, key);
      if (!remote) continue;
      await AsyncStorage.setItem(key, JSON.stringify(remote.data));
      await AsyncStorage.setItem(
        syncMetaStorageKey(key),
        JSON.stringify({ version: remote.version, updatedAt: remote.updatedAt })
      );
    }
  }

  await AsyncStorage.setItem(BOOTSTRAP_DONE_KEY, "true");
}
