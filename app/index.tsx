import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { resolveStartupAccountContext, routeForAccountContext } from "../lib/accountContexts";
import { supabase } from "../lib/supabase";

type IndexTarget =
  | "/(auth)/login"
  | "/(auth)/choose-account"
  | "/(coach)/(tabs)/calendar?view=monthly"
  | "/(athlete)/dashboard";

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

        const resolution = await resolveStartupAccountContext();
        if (resolution.status === "ready") {
          if (!cancelled) setTarget(routeForAccountContext(resolution.context));
          return;
        }

        if (!cancelled) setTarget("/(auth)/choose-account");
      } catch (error) {
        console.error("Startup account routing failed", error);
        if (!cancelled) setTarget("/(auth)/choose-account");
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
