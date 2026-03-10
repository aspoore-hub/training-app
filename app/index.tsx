import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { getMyProfileFull } from "../lib/profile";
import { supabase } from "../lib/supabase";

type IndexTarget =
  | "/(auth)/login"
  | "/(auth)/join"
  | "/(coach)/(tabs)/calendar"
  | "/(athlete)";

export default function Index() {
  const [target, setTarget] = useState<IndexTarget | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function resolveStartRoute() {
      try {
        const { data } = await supabase.auth.getSession();
        const hasSession = !!data.session;

        if (!hasSession) {
          if (!cancelled) setTarget("/(auth)/login");
          return;
        }

        const profile = await getMyProfileFull();

        if (profile?.role === "coach") {
          if (!cancelled) setTarget("/(coach)/(tabs)/calendar");
          return;
        }

        if (profile?.role === "athlete") {
          if (!profile.current_team_id) {
            if (!cancelled) setTarget("/(auth)/join");
            return;
          }
          if (!cancelled) setTarget("/(athlete)");
          return;
        }

        if (!cancelled) setTarget("/(auth)/login");
      } catch {
        if (!cancelled) setTarget("/(auth)/login");
      }
    }

    resolveStartRoute();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!target) return null;
  return <Redirect href={target} />;
}
