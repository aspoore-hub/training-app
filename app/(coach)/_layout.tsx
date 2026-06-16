import { useEffect, useState } from "react";
import { Stack, useRouter } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";
import { CoachShell } from "../../components/coach/CoachShell";
import { resolveStartupAccountContext, routeForAccountContext } from "../../lib/accountContexts";

export default function CoachLayout() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const resolution = await resolveStartupAccountContext();
      if (resolution.status === "ready" && resolution.context.kind === "coach") {
        if (!cancelled) setAllowed(true);
        return;
      }
      if (resolution.status === "ready") {
        if (!cancelled) router.replace(routeForAccountContext(resolution.context));
        return;
      }
      if (!cancelled) router.replace("/(auth)/choose-account");
    })().catch(() => {
      if (!cancelled) router.replace("/(auth)/choose-account");
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!allowed) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }}>
        <ActivityIndicator />
        <Text style={{ color: "#64748b", fontWeight: "700" }}>Loading account...</Text>
      </View>
    );
  }

  return (
    <CoachShell>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="workouts" options={{ headerShown: false }} />
        <Stack.Screen name="workout/[id]" options={{ headerShown: false }} />
      </Stack>
    </CoachShell>
  );
}
