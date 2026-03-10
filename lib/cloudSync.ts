import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";

const META_PREFIX = "training_app_sync_meta_v1";
const DIRTY_PREFIX = "training_app_sync_dirty_user_v1";

type StorageLike = Pick<typeof AsyncStorage, "getItem" | "setItem">;

export type SyncMeta = {
  version: number;
  updatedAt: string;
};

export type SyncBlob = {
  key: string;
  version: number;
  updatedAt: string;
  payload: string;
};

export interface CloudSyncClient {
  uploadBlob(blob: SyncBlob): Promise<void>;
  downloadBlob(key: string): Promise<SyncBlob | null>;
}

type SaveWithSyncOptions = {
  client?: CloudSyncClient;
  storage?: StorageLike;
  now?: () => Date;
};

type LoadWithSyncOptions = {
  client?: CloudSyncClient;
  storage?: StorageLike;
};

type PullResult = "updated" | "stale" | "missing";

const defaultMeta: SyncMeta = {
  version: 0,
  updatedAt: "1970-01-01T00:00:00.000Z",
};

function dirtyStorageKey(key: string): string {
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

async function getUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

const supabaseCloudClient: CloudSyncClient = {
  async uploadBlob(blob) {
    const userId = await getUserId();
    if (!userId) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(blob.payload);
    } catch {
      parsed = blob.payload;
    }

    const { error } = await supabase.from("kv_blobs").upsert(
      {
        user_id: userId,
        key: blob.key,
        data: parsed,
        version: blob.version,
        updated_at: blob.updatedAt,
      },
      { onConflict: "user_id,key" }
    );
    if (error) throw error;
  },

  async downloadBlob(key) {
    const userId = await getUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from("kv_blobs")
      .select("data,version,updated_at")
      .eq("user_id", userId)
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
  },
};

function syncMetaStorageKey(key: string): string {
  return `${META_PREFIX}:${key}`;
}

async function readMeta(key: string, storage: StorageLike = AsyncStorage): Promise<SyncMeta> {
  try {
    const raw = await storage.getItem(syncMetaStorageKey(key));
    if (!raw) return defaultMeta;
    const parsed = JSON.parse(raw) as Partial<SyncMeta>;
    if (
      typeof parsed.version === "number" &&
      Number.isFinite(parsed.version) &&
      typeof parsed.updatedAt === "string"
    ) {
      return { version: parsed.version, updatedAt: parsed.updatedAt };
    }
    return defaultMeta;
  } catch {
    return defaultMeta;
  }
}

async function writeMeta(key: string, meta: SyncMeta, storage: StorageLike = AsyncStorage): Promise<void> {
  try {
    await storage.setItem(syncMetaStorageKey(key), JSON.stringify(meta));
  } catch (e) {
    console.warn("Failed to save sync meta", key, e);
  }
}

function isRemoteNewer(local: SyncMeta, remote: SyncBlob): boolean {
  if (remote.version !== local.version) return remote.version > local.version;
  return remote.updatedAt > local.updatedAt;
}

export async function pushLocalToCloud(key: string, options: SaveWithSyncOptions): Promise<void> {
  const client = options.client ?? supabaseCloudClient;
  const storage = options.storage ?? AsyncStorage;
  const now = options.now ?? (() => new Date());
  const raw = await storage.getItem(key);
  if (raw == null) return;

  const currentMeta = await readMeta(key, storage);
  const nextMeta: SyncMeta = {
    version: currentMeta.version + 1,
    updatedAt: now().toISOString(),
  };

  await client.uploadBlob({
    key,
    version: nextMeta.version,
    updatedAt: nextMeta.updatedAt,
    payload: raw,
  });

  await writeMeta(key, nextMeta, storage);
}

export async function pullCloudToLocal(key: string, options: LoadWithSyncOptions): Promise<PullResult> {
  const client = options.client ?? supabaseCloudClient;
  const storage = options.storage ?? AsyncStorage;
  const remote = await client.downloadBlob(key);
  if (!remote) return "missing";

  const localMeta = await readMeta(key, storage);
  if (!isRemoteNewer(localMeta, remote)) return "stale";

  await storage.setItem(key, remote.payload);
  await writeMeta(key, { version: remote.version, updatedAt: remote.updatedAt }, storage);
  return "updated";
}

/**
 * Offline-first save:
 * - always writes locally
 * - tries cloud push
 * - if push fails, marks key dirty for retry
 */
export async function saveJSONWithCloudSync<T>(
  key: string,
  value: T,
  options: SaveWithSyncOptions = {}
): Promise<void> {
  const storage = options.storage ?? AsyncStorage;

  try {
    await storage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("Failed to save local", key, e);
    return;
  }

  try {
    await pushLocalToCloud(key, options);
    await clearDirty(key, storage);
  } catch (e) {
    await markDirty(key, storage);
    console.warn("Cloud push failed; queued retry", key, e);
  }
}

export async function loadJSONWithCloudSync<T>(
  key: string,
  fallback: T,
  options: LoadWithSyncOptions = {}
): Promise<T> {
  const storage = options.storage ?? AsyncStorage;

  try {
    // Never overwrite local unsynced edits with remote data.
    const dirty = await isDirty(key, storage);
    if (!dirty) {
      await pullCloudToLocal(key, options);
    }
  } catch (e) {
    console.warn("Failed to sync down", key, e);
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
 * Retry uploads for any keys that are marked dirty.
 * Safe to call periodically.
 */
export async function flushUserDirtyKeys(
  keys: readonly string[],
  options: SaveWithSyncOptions = {}
): Promise<void> {
  const storage = options.storage ?? AsyncStorage;

  for (const key of keys) {
    const dirty = await isDirty(key, storage);
    if (!dirty) continue;

    try {
      await pushLocalToCloud(key, options);
      await clearDirty(key, storage);
    } catch {
      // still dirty; retry later
    }
  }
}
