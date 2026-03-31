import { Stack } from "expo-router";
import { CoachShell } from "../../components/coach/CoachShell";

export default function CoachLayout() {
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
