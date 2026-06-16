import "react-native-url-polyfill/auto";
import { createClient } from "@supabase/supabase-js";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const extra = Constants.expoConfig?.extra as any;

const supabaseUrl =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? (extra?.EXPO_PUBLIC_SUPABASE_URL as string | undefined);
const supabaseAnonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? (extra?.EXPO_PUBLIC_SUPABASE_ANON_KEY as string | undefined);

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase configuration. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY."
  );
}

// SecureStore for native; web can use default storage
const ExpoSecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: Platform.OS === "web" ? undefined : (ExpoSecureStoreAdapter as any),
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
