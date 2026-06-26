import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AthleteRoutineDetails } from "../../athlete/AthleteRoutineDetails";
import type { AuxiliaryRoutine } from "../../../lib/auxiliaryRoutines";
import type { DrillLibraryItem } from "../../../lib/drillLibrary";
import type { WorkoutCategory } from "../../../lib/types";
import { categoryColorByName } from "../../../lib/categories";
import { LinkifiedText } from "../../ui/LinkifiedText";
import type { CoachMobileWorkoutGroup } from "./CoachMobileWorkoutCard";

function formatDateLabel(dateISO: string) {
  const [y, m, d] = String(dateISO ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(dateISO ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(dateISO ?? "");
  return dt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: "900", color: "#64748b" }}>{title}</Text>
      {children}
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
        paddingHorizontal: 8,
        paddingVertical: 4,
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

function RoutineSection({
  title,
  ids,
  routineById,
  drillById,
}: {
  title: string;
  ids: string[];
  routineById: Map<string, AuxiliaryRoutine>;
  drillById: Map<string, DrillLibraryItem>;
}) {
  const cleanIds = ids.map((id) => String(id ?? "").trim()).filter(Boolean);
  const [expandedRoutineIds, setExpandedRoutineIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpandedRoutineIds(new Set());
  }, [cleanIds.join("|")]);

  function toggleRoutine(id: string) {
    setExpandedRoutineIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (cleanIds.length === 0) return null;
  return (
    <Section title={title}>
      <View style={{ gap: 10 }}>
        {cleanIds.map((id, index) => {
          const routine = routineById.get(id);
          if (!routine) {
            return (
              <View key={`${title}-${id}-${index}`} style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 12, padding: 10, backgroundColor: "#fff" }}>
                <Text style={{ color: "#0f172a", fontWeight: "900" }}>Routine unavailable</Text>
                <Text style={{ marginTop: 3, color: "#64748b", fontWeight: "700" }}>{id}</Text>
              </View>
            );
          }
          const expanded = expandedRoutineIds.has(id);
          const itemCount = Array.isArray(routine.items) ? routine.items.length : 0;
          const detailsText = [routine.description, routine.details].map((value) => String(value ?? "").trim()).filter(Boolean);
          const summaryParts = [
            itemCount > 0 ? `${itemCount} item${itemCount === 1 ? "" : "s"}` : "",
            detailsText.length > 0 ? "notes" : "",
          ].filter(Boolean);
          return (
            <View key={`${title}-${id}`} style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 12, backgroundColor: "#fff", overflow: "hidden" }}>
              <Pressable
                onPress={() => toggleRoutine(id)}
                style={{ padding: 10, flexDirection: "row", alignItems: "center", gap: 10 }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: "#0f172a", fontWeight: "900", fontSize: 15 }}>{routine.title}</Text>
                  <Text style={{ marginTop: 3, color: "#64748b", fontWeight: "800", fontSize: 12 }}>
                    {summaryParts.length > 0 ? summaryParts.join(" · ") : "Tap to view"}
                  </Text>
                </View>
                <Text style={{ color: "#2563eb", fontWeight: "900", fontSize: 16 }}>{expanded ? "▾" : "▸"}</Text>
              </Pressable>
              {expanded ? (
                <View style={{ borderTopWidth: 1, borderTopColor: "#f1f5f9", padding: 10 }}>
                  <AthleteRoutineDetails routine={routine} drillById={drillById} />
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

export function CoachMobileWorkoutDetail({
  item,
  categoriesSource,
  routineById,
  drillById,
  routineDataError,
  onClose,
}: {
  item: CoachMobileWorkoutGroup | null;
  categoriesSource: WorkoutCategory[];
  routineById: Map<string, AuxiliaryRoutine>;
  drillById: Map<string, DrillLibraryItem>;
  routineDataError?: string | null;
  onClose: () => void;
}) {
  return (
    <Modal visible={!!item} animationType="slide" onRequestClose={onClose}>
      {item ? (
        <View style={{ flex: 1, backgroundColor: "#f3f6fb" }}>
          <View
            style={{
              borderBottomWidth: 1,
              borderBottomColor: "#dbe2ee",
              backgroundColor: "#fff",
              paddingHorizontal: 12,
              paddingTop: 14,
              paddingBottom: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 17, fontWeight: "900", color: "#172033" }}>{item.title}</Text>
              <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 12, fontWeight: "800", color: "#64748b" }}>
                {formatDateLabel(item.dateISO)} · {item.session}{item.time ? ` · ${item.time}` : ""}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              style={{ borderWidth: 1, borderColor: "#dbe3ef", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#fff" }}
            >
              <Text style={{ color: "#172033", fontWeight: "900" }}>Close</Text>
            </Pressable>
          </View>

          <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 12, paddingBottom: 32, gap: 14 }}>
            <View style={{ borderWidth: 1, borderColor: "#dbe3ef", backgroundColor: "#fff", borderRadius: 14, padding: 12, gap: 10 }}>
              {item.location ? (
                <Text style={{ color: "#334155", fontWeight: "800" }}>Location: {item.location}</Text>
              ) : null}
              {item.plannedDistanceLabels.length > 0 ? (
                <Text style={{ color: "#1e40af", fontWeight: "900" }}>Mileage: {item.plannedDistanceLabels.join(", ")}</Text>
              ) : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {item.categories.map((category) => (
                  <CategoryChip key={`${item.key}-detail-${category}`} name={category} categoriesSource={categoriesSource} />
                ))}
              </View>
            </View>

            {item.batchDetails ? (
              <Section title="Workout notes">
                <View style={{ borderWidth: 1, borderColor: "#dbe3ef", backgroundColor: "#fff", borderRadius: 14, padding: 12 }}>
                  <LinkifiedText text={item.batchDetails} style={{ color: "#111827", lineHeight: 20 }} />
                </View>
              </Section>
            ) : null}

            {item.individualDetails.length > 0 ? (
              <Section title="Individual athlete notes">
                <View style={{ gap: 8 }}>
                  {item.individualDetails.map((entry) => (
                    <View key={entry.workoutId} style={{ borderWidth: 1, borderColor: "#e2e8f0", backgroundColor: "#fff", borderRadius: 12, padding: 10, gap: 4 }}>
                      <Text style={{ color: "#0f172a", fontWeight: "900" }}>{entry.athleteName}</Text>
                      <LinkifiedText text={entry.details} style={{ color: "#475569", lineHeight: 19 }} />
                    </View>
                  ))}
                </View>
              </Section>
            ) : null}

            <Section title={`Athletes (${item.athleteCount})`}>
              <View style={{ borderWidth: 1, borderColor: "#dbe3ef", backgroundColor: "#fff", borderRadius: 14, padding: 12 }}>
                <Text style={{ color: "#334155", lineHeight: 20, fontWeight: "700" }}>{item.athleteNames.join(", ") || "No athletes"}</Text>
              </View>
            </Section>

            {routineDataError ? (
              <View style={{ borderWidth: 1, borderColor: "#fecaca", backgroundColor: "#fff1f2", borderRadius: 12, padding: 10 }}>
                <Text style={{ color: "#991b1b", fontWeight: "800", lineHeight: 19 }}>{routineDataError}</Text>
              </View>
            ) : null}

            <RoutineSection title="Pre-routines" ids={item.preRoutineIds} routineById={routineById} drillById={drillById} />
            <RoutineSection title="Post-routines" ids={item.postRoutineIds} routineById={routineById} drillById={drillById} />
          </ScrollView>
        </View>
      ) : null}
    </Modal>
  );
}
