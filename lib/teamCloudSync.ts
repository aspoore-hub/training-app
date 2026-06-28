import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";
import { requireTeamPermission } from "./teamPermissions";

const META_PREFIX = "training_app_sync_meta_v1";
const DIRTY_PREFIX = "training_app_sync_dirty_team_v1";

type StorageLike = Pick<typeof AsyncStorage, "getItem" | "setItem">;

export type SyncMeta = { version: number; updatedAt: string };
export type SyncBlob = { key: string; version: number; updatedAt: string; payload: string };

const defaultMeta: SyncMeta = { version: 0, updatedAt: "1970-01-01T00:00:00.000Z" };

function syncMetaStorageKey(key: string) {
  return `${META_PREFIX}:${key}`;
}

function dirtyStorageKey(key: string) {
  return `${DIRTY_PREFIX}:${key}`;
}

async function markDirty(key: string, storage: StorageLike = AsyncStorage) {
  try {
    await storage.setItem(dirtyStorageKey(key), "1");
  } catch {}
}

async function clearDirty(key: string, storage: StorageLike = AsyncStorage) {
  try {
    await storage.setItem(dirtyStorageKey(key), "0");
  } catch {}
}

async function isDirty(key: string, storage: StorageLike = AsyncStorage): Promise<boolean> {
  try {
    const v = await storage.getItem(dirtyStorageKey(key));
    return v === "1";
  } catch {
    return false;
  }
}

async function readMeta(key: string, storage: StorageLike = AsyncStorage): Promise<SyncMeta> {
  try {
    const raw = await storage.getItem(syncMetaStorageKey(key));
    if (!raw) return defaultMeta;
    const parsed = JSON.parse(raw) as Partial<SyncMeta>;
    if (typeof parsed.version === "number" && typeof parsed.updatedAt === "string") {
      return { version: parsed.version, updatedAt: parsed.updatedAt };
    }
    return defaultMeta;
  } catch {
    return defaultMeta;
  }
}

async function writeMeta(key: string, meta: SyncMeta, storage: StorageLike = AsyncStorage) {
  try {
    await storage.setItem(syncMetaStorageKey(key), JSON.stringify(meta));
  } catch (e) {
    console.warn("Failed to write team meta", key, e);
  }
}

function isRemoteNewer(local: SyncMeta, remote: SyncBlob) {
  if (remote.version !== local.version) return remote.version > local.version;
  return remote.updatedAt > local.updatedAt;
}

async function uploadToTeam(key: string, version: number, updatedAt: string, payload: string) {
  const teamId = await getCurrentTeamId();
  if (!teamId) return;
  await requireTeamPermission("training.edit", teamId);

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = payload;
  }

  const { error } = await supabase.from("team_kv_blobs").upsert(
    { team_id: teamId, key, data: parsed, version, updated_at: updatedAt },
    { onConflict: "team_id,key" }
  );
  if (error) throw error;
}

async function downloadFromTeam(key: string): Promise<SyncBlob | null> {
  const teamId = await getCurrentTeamId();
  if (!teamId) return null;

  const { data, error } = await supabase
    .from("team_kv_blobs")
    .select("data,version,updated_at")
    .eq("team_id", teamId)
    .eq("key", key)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    key,
    version: data.version as number,
    updatedAt: (data.updated_at as string) ?? defaultMeta.updatedAt,
    payload: JSON.stringify(data.data),
  };
}

/**
 * Offline-first save:
 * - always writes locally
 * - tries team push
 * - if push fails, marks key dirty for retry
 */
export async function saveJSONWithTeamCloudSync<T>(
  key: string,
  value: T,
  storage: StorageLike = AsyncStorage
) {
  const teamId = await getCurrentTeamId();
  await requireTeamPermission("training.edit", teamId);

  try {
    await storage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("Failed to save local", key, e);
    return;
  }

  try {
    const meta = await readMeta(key, storage);
    const next: SyncMeta = { version: meta.version + 1, updatedAt: new Date().toISOString() };

    await uploadToTeam(key, next.version, next.updatedAt, JSON.stringify(value));
    await writeMeta(key, next, storage);

    await clearDirty(key, storage);
  } catch (e) {
    await markDirty(key, storage);
    console.warn("Team push failed; queued retry", key, e);
  }
}

/**
 * Strict team save for destructive actions that should not look successful
 * unless the team cloud row was actually updated.
 */
export async function saveJSONWithTeamCloudSyncStrict<T>(
  key: string,
  value: T,
  storage: StorageLike = AsyncStorage
) {
  const teamId = await getCurrentTeamId();
  await requireTeamPermission("training.edit", teamId);

  const meta = await readMeta(key, storage);
  const next: SyncMeta = { version: meta.version + 1, updatedAt: new Date().toISOString() };
  const payload = JSON.stringify(value);

  await uploadToTeam(key, next.version, next.updatedAt, payload);
  await storage.setItem(key, payload);
  await writeMeta(key, next, storage);
  await clearDirty(key, storage);
}

export async function loadJSONWithTeamCloudSync<T>(
  key: string,
  fallback: T,
  storage: StorageLike = AsyncStorage
): Promise<T> {
  try {
    // Never overwrite local unsynced edits with remote data.
    const dirty = await isDirty(key, storage);
    if (!dirty) {
      const remote = await downloadFromTeam(key);
      if (remote) {
        const localMeta = await readMeta(key, storage);
        if (isRemoteNewer(localMeta, remote)) {
          await storage.setItem(key, remote.payload);
          await writeMeta(key, { version: remote.version, updatedAt: remote.updatedAt }, storage);
        }
      }
    }
  } catch (e) {
    console.warn("Team sync down failed", key, e);
  }

  try {
    const raw = await storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Cloud-authoritative team load:
 * - uses the team cloud row whenever it exists, even if local storage is dirty/newer
 * - updates local storage to match the cloud row
 * - falls back to local/fallback only when the cloud row is missing or unreadable
 */
export async function loadJSONWithTeamCloudSyncAuthoritative<T>(
  key: string,
  fallback: T,
  storage: StorageLike = AsyncStorage
): Promise<T> {
  try {
    const remote = await downloadFromTeam(key);
    if (remote) {
      await storage.setItem(key, remote.payload);
      await writeMeta(key, { version: remote.version, updatedAt: remote.updatedAt }, storage);
      await clearDirty(key, storage);
      return JSON.parse(remote.payload) as T;
    }
  } catch (e) {
    console.warn("Team authoritative load failed", key, e);
  }

  try {
    const raw = await storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Retry uploads for any team keys that are marked dirty.
 * Safe to call periodically.
 */
export async function flushTeamDirtyKeys(keys: readonly string[], storage: StorageLike = AsyncStorage) {
  for (const key of keys) {
    const dirty = await isDirty(key, storage);
    if (!dirty) continue;

    try {
      const raw = await storage.getItem(key);
      if (raw == null) {
        await clearDirty(key, storage);
        continue;
      }

      const meta = await readMeta(key, storage);
      const next: SyncMeta = { version: meta.version + 1, updatedAt: new Date().toISOString() };

      await uploadToTeam(key, next.version, next.updatedAt, raw);
      await writeMeta(key, next, storage);

      await clearDirty(key, storage);
    } catch {
      // keep dirty and retry later
    }
  }
}
