import AsyncStorage from "@react-native-async-storage/async-storage";
import { SYNC_KEYS } from "./syncKeys";
import { supabase } from "./supabase";
import { getCurrentTeamId, ensureCoachTeam } from "./team"; // adjust import if your file is named teams.ts

const TEAM_BOOTSTRAP_DONE_KEY = "training_app_team_cloud_bootstrap_done_v1";
const META_PREFIX = "training_app_sync_meta_v1";

function syncMetaStorageKey(key: string) {
  return `${META_PREFIX}:${key}`;
}

async function fetchTeamKV(teamId: string, key: string) {
  const { data, error } = await supabase
    .from("team_kv_blobs")
    .select("team_id,key,data,version,updated_at")
    .eq("team_id", teamId)
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

async function upsertTeamKV(teamId: string, key: string, value: any, version: number) {
  const { error } = await supabase.from("team_kv_blobs").upsert(
    {
      team_id: teamId,
      key,
      data: value,
      version,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "team_id,key" }
  );
  if (error) throw error;
}

/**
 * One-time TEAM sync:
 * - If team cloud is empty, upload this device's local team data to cloud
 * - If team cloud has data, download cloud to this device
 *
 * NOTE: Coaches should run this once after team creation.
 * Athletes should run this after claiming invite.
 */
export async function bootstrapTeamSyncOnce() {
  // If coach is logged in and has no team yet, ensure it exists.
  // (For athletes, ensureCoachTeam should NOT be called, but calling it is safe
  // only if your ensureCoachTeam checks role; if it doesn't, comment this line out.)
  // await ensureCoachTeam("My Team").catch(() => {});

  const teamId = await getCurrentTeamId();
  if (!teamId) return;

  // Team bootstrap is per-team; include teamId in done key so switching teams doesn't break.
  const doneKey = `${TEAM_BOOTSTRAP_DONE_KEY}:${teamId}`;
  const done = await AsyncStorage.getItem(doneKey);
  if (done === "true") return;

  const firstKey = SYNC_KEYS[0];
  const firstRemote = await fetchTeamKV(teamId, firstKey);

  if (!firstRemote) {
    // Upload device -> team cloud
    for (const key of SYNC_KEYS) {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;

      try {
        const parsed = JSON.parse(raw);
        await upsertTeamKV(teamId, key, parsed, 1);
      } catch {
        // ignore bad JSON
      }
    }
  } else {
    // Download team cloud -> device
    for (const key of SYNC_KEYS) {
      const remote = await fetchTeamKV(teamId, key);
      if (!remote) continue;

      await AsyncStorage.setItem(key, JSON.stringify(remote.data));
      await AsyncStorage.setItem(
        syncMetaStorageKey(key),
        JSON.stringify({ version: remote.version, updatedAt: remote.updatedAt })
      );
    }
  }

  await AsyncStorage.setItem(doneKey, "true");
}

/** Utility for debugging / re-running bootstrap */
export async function resetTeamBootstrapFlag() {
  const teamId = await getCurrentTeamId();
  if (!teamId) return;
  const doneKey = `${TEAM_BOOTSTRAP_DONE_KEY}:${teamId}`;
  await AsyncStorage.removeItem(doneKey);
}
