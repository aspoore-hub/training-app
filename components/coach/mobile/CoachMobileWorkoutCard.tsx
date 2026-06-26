import { Pressable, Text, View } from "react-native";
import { categoryColorByName } from "../../../lib/categories";
import type { TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";
import type { WorkoutCategory } from "../../../lib/types";

export type CoachMobileIndividualDetail = {
  workoutId: string;
  athleteName: string;
  details: string;
};

export type CoachMobileWorkoutGroup = {
  key: string;
  dateISO: string;
  session: "AM" | "PM";
  rows: TeamWorkoutRow[];
  title: string;
  batchDetails: string;
  individualDetails: CoachMobileIndividualDetail[];
  categories: string[];
  athleteNames: string[];
  athleteCount: number;
  visibleCount: number;
  hiddenCount: number;
  time: string;
  location: string;
  plannedDistanceLabels: string[];
  preRoutineIds: string[];
  postRoutineIds: string[];
  preRoutineTitles: string[];
  postRoutineTitles: string[];
};

function visibilityLabel(item: CoachMobileWorkoutGroup) {
  if (item.hiddenCount > 0 && item.visibleCount > 0) return { label: "Mixed", border: "#fed7aa", bg: "#fff7ed", text: "#9a3412" };
  if (item.visibleCount > 0) return { label: "Published", border: "#bbf7d0", bg: "#f0fdf4", text: "#166534" };
  return { label: "Hidden", border: "#e2e8f0", bg: "#f8fafc", text: "#64748b" };
}

function formatAthleteSummary(names: string[], count: number) {
  const clean = names.map((name) => String(name ?? "").trim()).filter(Boolean);
  if (count <= 0) return "No athletes";
  if (clean.length === 0) return `${count} athlete${count === 1 ? "" : "s"}`;
  if (count <= 3) return clean.slice(0, count).join(", ");
  return `${clean.slice(0, 3).join(", ")} +${count - 3} more`;
}

function Chip({ children }: { children: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: "#dbe3ef", backgroundColor: "#f8fafc", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 }}>
      <Text style={{ color: "#475569", fontWeight: "900", fontSize: 11 }}>{children}</Text>
    </View>
  );
}

function CategoryChip({ name, categoriesSource }: { name: string; categoriesSource: WorkoutCategory[] }) {
  const color = categoryColorByName(categoriesSource, name);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: "#fff",
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ fontSize: 11, fontWeight: "900", color: "#334155" }}>{name}</Text>
    </View>
  );
}

export function CoachMobileWorkoutCard({
  item,
  categoriesSource,
  onPress,
}: {
  item: CoachMobileWorkoutGroup;
  categoriesSource: WorkoutCategory[];
  onPress: () => void;
}) {
  const visibility = visibilityLabel(item);
  const distanceLabel = item.plannedDistanceLabels.slice(0, 2).join(", ");

  return (
    <Pressable
      onPress={onPress}
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: "#dbeafe",
        backgroundColor: "#ffffff",
        padding: 12,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>
            {item.dateISO} · {item.session}{item.time ? ` · ${item.time}` : ""}
          </Text>
          <Text style={{ marginTop: 4, fontSize: 17, fontWeight: "900", color: "#0f172a" }}>{item.title}</Text>
        </View>
        <View
          style={{
            borderRadius: 999,
            borderWidth: 1,
            borderColor: visibility.border,
            backgroundColor: visibility.bg,
            paddingHorizontal: 9,
            paddingVertical: 3,
            alignSelf: "flex-start",
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: "900", color: visibility.text }}>{visibility.label}</Text>
        </View>
      </View>

      {item.location ? <Text style={{ color: "#475569", fontWeight: "800" }}>{item.location}</Text> : null}
      {distanceLabel ? <Text style={{ color: "#1e40af", fontWeight: "900" }}>Mileage: {distanceLabel}</Text> : null}
      {item.batchDetails ? (
        <Text numberOfLines={3} style={{ color: "#111827", lineHeight: 20 }}>{item.batchDetails}</Text>
      ) : null}
      {item.individualDetails.length > 0 ? (
        <Text numberOfLines={2} style={{ color: "#475569", fontWeight: "700", lineHeight: 19 }}>
          Individual: {item.individualDetails.slice(0, 2).map((entry) => `${entry.athleteName}: ${entry.details}`).join(" · ")}
          {item.individualDetails.length > 2 ? ` +${item.individualDetails.length - 2} more` : ""}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Chip>{formatAthleteSummary(item.athleteNames, item.athleteCount)}</Chip>
        {item.categories.slice(0, 4).map((category) => (
          <CategoryChip key={`${item.key}-${category}`} name={category} categoriesSource={categoriesSource} />
        ))}
      </View>

      {item.preRoutineTitles.length > 0 ? (
        <Text style={{ color: "#334155", fontWeight: "800", lineHeight: 19 }}>Before: {item.preRoutineTitles.join(", ")}</Text>
      ) : null}
      {item.postRoutineTitles.length > 0 ? (
        <Text style={{ color: "#334155", fontWeight: "800", lineHeight: 19 }}>After: {item.postRoutineTitles.join(", ")}</Text>
      ) : null}
    </Pressable>
  );
}
