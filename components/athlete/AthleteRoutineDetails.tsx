import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { AuxiliaryRoutine, DrillRoutineItem } from "../../lib/auxiliaryRoutines";
import type { DrillLibraryItem } from "../../lib/drillLibrary";
import { LinkifiedText } from "../ui/LinkifiedText";

export function hasStructuredRoutineItems(routine: AuxiliaryRoutine | null | undefined) {
  return Array.isArray(routine?.items) && routine.items.length > 0;
}

export function routineHasDisplayDetails(routine: AuxiliaryRoutine | null | undefined) {
  return hasStructuredRoutineItems(routine) || String(routine?.details ?? "").trim().length > 0;
}

function resolveDrill(item: DrillRoutineItem, drillById?: Map<string, DrillLibraryItem>) {
  if (item.kind !== "libraryDrill") return null;
  return drillById?.get(item.drillId) ?? null;
}

function itemTitle(item: DrillRoutineItem, drillById?: Map<string, DrillLibraryItem>) {
  if (item.kind === "text") return item.text;
  return resolveDrill(item, drillById)?.name || item.drillTitle || "Library drill";
}

function itemDetails(item: DrillRoutineItem, drillById?: Map<string, DrillLibraryItem>) {
  if (item.kind === "text") return item.text;
  return resolveDrill(item, drillById)?.defaultDetails || item.drillDefaultDetails || "";
}

function itemVideoUrl(item: DrillRoutineItem, drillById?: Map<string, DrillLibraryItem>) {
  if (item.kind !== "libraryDrill") return "";
  return resolveDrill(item, drillById)?.videoUrl || item.drillVideoUrl || "";
}

export function getRoutinePreviewText(routine: AuxiliaryRoutine, drillById?: Map<string, DrillLibraryItem>) {
  const items = Array.isArray(routine.items) ? routine.items : [];
  if (items.length > 0) {
    return items
      .slice(0, 3)
      .map((item) => {
        if (item.kind === "text") return item.text;
        const prescription = String(item.prescription ?? "").trim();
        const title = itemTitle(item, drillById);
        return [prescription, title].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(routine.details ?? "").trim();
}

export function AthleteRoutineDetails({
  routine,
  drillById,
}: {
  routine: AuxiliaryRoutine;
  drillById?: Map<string, DrillLibraryItem>;
}) {
  const items = useMemo(() => (Array.isArray(routine.items) ? routine.items : []), [routine.items]);
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(new Set());
  const legacyDetails = String(routine.details ?? "").trim();

  function toggleItem(id: string) {
    setExpandedItemIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (items.length === 0) {
    return legacyDetails ? (
      <LinkifiedText text={legacyDetails} style={{ color: "#475569", lineHeight: 19 }} />
    ) : null;
  }

  return (
    <View style={{ gap: 8 }}>
      {items.map((item, index) => {
        if (item.kind === "text") {
          return (
            <View key={item.id} style={{ borderRadius: 10, backgroundColor: "#f8fafc", padding: 10 }}>
              <LinkifiedText text={item.text} style={{ color: "#334155", lineHeight: 19, fontWeight: "700" }} />
            </View>
          );
        }

        const title = itemTitle(item, drillById);
        const details = itemDetails(item, drillById);
        const videoUrl = itemVideoUrl(item, drillById);
        const customNotes = String(item.customNotes ?? "").trim();
        const prescription = String(item.prescription ?? "").trim();
        const expanded = expandedItemIds.has(item.id);
        const canExpand = Boolean(details || customNotes);

        return (
          <View key={item.id} style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 12, backgroundColor: "#ffffff", overflow: "hidden" }}>
            <Pressable
              onPress={() => {
                if (canExpand) toggleItem(item.id);
              }}
              style={{ padding: 10, gap: 6 }}
            >
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900" }}>{index + 1}.</Text>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <Text style={{ color: "#0f172a", fontWeight: "900", lineHeight: 19 }}>
                    {prescription ? `${prescription} ` : ""}{title}
                  </Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    {videoUrl ? <LinkifiedText text={videoUrl} style={{ color: "#2563eb", fontSize: 12, fontWeight: "900" }} /> : null}
                    {canExpand ? (
                      <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "800" }}>
                        {expanded ? "Hide cues" : "Show cues"}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>
            </Pressable>

            {expanded ? (
              <View style={{ borderTopWidth: 1, borderTopColor: "#f1f5f9", padding: 10, gap: 8 }}>
                {details ? (
                  <View style={{ gap: 3 }}>
                    <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900" }}>Library cues</Text>
                    <LinkifiedText text={details} style={{ color: "#475569", lineHeight: 19 }} />
                  </View>
                ) : null}
                {customNotes ? (
                  <View style={{ gap: 3 }}>
                    <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900" }}>Coach notes</Text>
                    <LinkifiedText text={customNotes} style={{ color: "#475569", lineHeight: 19 }} />
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}

      {legacyDetails ? (
        <View style={{ borderTopWidth: 1, borderTopColor: "#f1f5f9", paddingTop: 8, gap: 4 }}>
          <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900" }}>Additional notes</Text>
          <LinkifiedText text={legacyDetails} style={{ color: "#475569", lineHeight: 19 }} />
        </View>
      ) : null}
    </View>
  );
}
