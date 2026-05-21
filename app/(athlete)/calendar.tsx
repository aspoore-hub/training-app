import { useEffect } from "react";
import { View, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { loadJSON } from "../../lib/storage";
import { ATHLETE_CALENDAR_VIEW_STATE_KEY, type AthleteCalendarViewState } from "../../lib/athleteCalendarView";

export default function AthleteCalendarRedirect() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name?: string; date?: string }>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const name = String(params?.name ?? "").trim();
      const routeDate = String(params?.date ?? "").trim();
      const saved = await loadJSON<AthleteCalendarViewState>(ATHLETE_CALENDAR_VIEW_STATE_KEY, {});
      if (cancelled) return;

      const savedView = saved?.view === "week" ? "week" : "month";
      const savedDate = String(saved?.dateISO ?? "").trim();
      const date = routeDate || savedDate;

      if (savedView === "week") {
        router.replace({
          pathname: "/(athlete)/week",
          params: {
            ...(name ? { name } : {}),
            ...(date ? { date } : {}),
          },
        });
        return;
      }

      router.replace({
        pathname: "/(athlete)/month",
        params: {
          ...(name ? { name } : {}),
          ...(date ? { date } : {}),
        },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [params?.date, params?.name, router]);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 20 }}>
      <Text style={{ opacity: 0.7 }}>Redirecting to monthly calendar…</Text>
    </View>
  );
}
