import AsyncStorage from "@react-native-async-storage/async-storage";
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { resolveStartupAccountContext, routeForAccountContext } from "../lib/accountContexts";
import { supabase } from "../lib/supabase";
import { useIsCoachMobileView } from "../lib/useCoachMobileView";

const PENDING_INVITE_TOKEN_KEY = "training_app_pending_invite_token_v1";

type IndexTarget =
  | "/(auth)/login"
  | "/(auth)/choose-account"
  | "/(coach)/(tabs)/calendar?view=monthly"
  | "/(coach)/(tabs)/dashboard"
  | "/(athlete)/dashboard"
  | string;

export default function Index() {
  const isCoachMobileView = useIsCoachMobileView();
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

        const pendingInviteToken = String((await AsyncStorage.getItem(PENDING_INVITE_TOKEN_KEY)) ?? "").trim();
        if (pendingInviteToken) {
          if (!cancelled) setTarget(`/(auth)/join?token=${encodeURIComponent(pendingInviteToken)}`);
          return;
        }

        const resolution = await resolveStartupAccountContext();
        if (resolution.status === "ready") {
          if (!cancelled) {
            setTarget(
              routeForAccountContext(resolution.context, {
                coachDefault: isCoachMobileView ? "home" : "calendar",
              })
            );
          }
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
  }, [isCoachMobileView]);

  if (!target) return null;
  return <Redirect href={target} />;
}
