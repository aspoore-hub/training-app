import type { ComponentProps } from "react";
import type { Ionicons } from "@expo/vector-icons";

export type CoachNavItem = {
  key: string;
  label: string;
  href: string;
  icon: ComponentProps<typeof Ionicons>["name"];
};

export const COACH_NAV_ITEMS: CoachNavItem[] = [
  { key: "calendar", label: "Calendar", href: "/(coach)/(tabs)/calendar", icon: "calendar-outline" },
  { key: "training-logs", label: "Training Logs", href: "/(coach)/(tabs)/training-logs", icon: "document-text-outline" },
  { key: "planner", label: "Create Session", href: "/(coach)/(tabs)/planner", icon: "create-outline" },
  { key: "mileage", label: "Mileage", href: "/(coach)/(tabs)/mileage", icon: "grid-outline" },
  { key: "roster", label: "Roster", href: "/(coach)/(tabs)/roster", icon: "people-outline" },
  { key: "workout-catalog", label: "Workout Catalog", href: "/(coach)/(tabs)/workout-catalog", icon: "library-outline" },
  { key: "settings", label: "Settings", href: "/(coach)/(tabs)/settings", icon: "settings-outline" },
];

export function resolveCoachTitle(pathname: string): string {
  const path = String(pathname ?? "");
  if (path.includes("/workout-batch/")) return "Edit Individual Workouts";
  if (path.includes("/workout/")) return "Edit Workout";
  if (path.includes("/workouts")) return "Athlete Workouts";
  if (path.includes("/training-logs")) return "Training Logs";
  if (path.includes("/plan-builder")) return "Workout Plan Builder";
  if (path.includes("/planner")) return "Create Session";
  if (path.includes("/mileage")) return "Mileage";
  if (path.includes("/roster")) return "Roster";
  if (path.includes("/workout-catalog")) return "Workout Catalog";
  if (path.includes("/settings")) return "Settings";
  if (path.includes("/calendar")) return "Calendar";
  const matched = COACH_NAV_ITEMS.find((item) => path.startsWith(item.href));
  return matched?.label ?? "Coach";
}

export function isCoachNavItemActive(pathname: string, href: string): boolean {
  const path = String(pathname ?? "");
  if (href === "/(coach)/workouts") {
    return path.startsWith("/(coach)/workouts") || path.includes("/workout-batch/") || path.includes("/workout/");
  }
  return path.startsWith(href);
}
