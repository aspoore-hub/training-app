import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";

const LAST_USER_KEY = "training_app_last_user_id_v1";

/**
 * If the signed-in user differs from the last user on this device,
 * clear local storage so we don't accidentally import previous user's data.
 *
 * Returns true if a reset happened.
 */
export async function resetLocalIfUserChanged(): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id ?? null;

  const last = await AsyncStorage.getItem(LAST_USER_KEY);

  // If no one is logged in, don't clear anything here.
  if (!userId) return false;

  // First login on this device
  if (!last) {
    await AsyncStorage.setItem(LAST_USER_KEY, userId);
    return false;
  }

  // Same user, nothing to do
  if (last === userId) return false;

  // Different user: clear everything local
  await AsyncStorage.clear();

  // Save the new user id so we don't loop
  await AsyncStorage.setItem(LAST_USER_KEY, userId);

  return true;
}
