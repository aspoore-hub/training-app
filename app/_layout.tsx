import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { bootstrapSyncOnce } from "../lib/bootstrapSync";
import { flushUserDirtyKeys } from "../lib/cloudSync";
import { runMigrations } from "../lib/migrations";
import { resetLocalIfUserChanged } from "../lib/sessionGuard";
import { TEAM_KEYS, USER_KEYS } from "../lib/syncKeys";
import { supabase } from "../lib/supabase";
import { flushTeamDirtyKeys } from "../lib/teamCloudSync";
import { AppRuntimeProvider } from "../lib/appState";
import { TeamBrandingEffect } from "../components/branding/TeamBrandingEffect";
import { DevDebugPanel } from "../components/dev/DevDebugPanel";

export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const { data } = await supabase.auth.getSession();
        const hasSession = !!data.session;

        if (hasSession) {
          // OPTION A: if user changed, wipe local first
          await resetLocalIfUserChanged();

          // then align cloud/local
          // await bootstrapSyncOnce();
        }

        await runMigrations();
      } catch (e) {
        console.warn("Init failed", e);
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let interval: any;

    async function start() {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return;

      // immediate attempt
      flushUserDirtyKeys(USER_KEYS).catch(() => {});
      flushTeamDirtyKeys(TEAM_KEYS).catch(() => {});

      // periodic retries
      interval = setInterval(() => {
        flushUserDirtyKeys(USER_KEYS).catch(() => {});
        flushTeamDirtyKeys(TEAM_KEYS).catch(() => {});
      }, 15000);
    }

    start();
    return () => {
      if (interval) clearInterval(interval);
    };
  }, []);

  // Prevent rendering screens before storage is consistent
  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppRuntimeProvider>
        <TeamBrandingEffect />
        <Stack screenOptions={{ headerShown: false }} />
        {__DEV__ ? <DevDebugPanel /> : null}
      </AppRuntimeProvider>
    </GestureHandlerRootView>
  );
}
