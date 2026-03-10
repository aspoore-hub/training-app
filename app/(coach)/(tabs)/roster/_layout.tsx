import React from "react";
import { Stack } from "expo-router";

export default function RosterLayout() {
  return (
    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen name="index" options={{ title: "Roster" }} />
      <Stack.Screen name="[id]" options={{ title: "Athlete Profile" }} />
    </Stack>
  );
}
