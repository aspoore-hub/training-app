import { useMemo, useState } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import type { AuxiliaryRoutine, DrillRoutineItem } from "../../lib/auxiliaryRoutines";
import type { DrillLibraryItem } from "../../lib/drillLibrary";
import { LinkifiedText } from "../ui/LinkifiedText";

export function hasStructuredRoutineItems(routine: AuxiliaryRoutine | null | undefined) {
  return Array.isArray(routine?.items) && routine.items.length > 0;
}

export function routineHasDisplayDetails(routine: AuxiliaryRoutine | null | undefined) {
  return (
    hasStructuredRoutineItems(routine) ||
    String(routine?.description ?? "").trim().length > 0 ||
    String(routine?.details ?? "").trim().length > 0
  );
}

function resolveDrill(item: DrillRoutineItem, drillById?: Map<string, DrillLibraryItem>) {
  if (item.kind !== "libraryDrill") return null;
  return drillById?.get(item.drillId) ?? null;
}

function itemTitle(item: DrillRoutineItem, drillById?: Map<string, DrillLibraryItem>) {
  if (item.kind === "text") return item.text;
  const drill = resolveDrill(item, drillById);
  if (drill) return drill.name || "Library drill";
  return item.drillTitle || "Missing drill";
}

function itemDetails(item: DrillRoutineItem, drillById?: Map<string, DrillLibraryItem>) {
  if (item.kind === "text") return item.text;
  const drill = resolveDrill(item, drillById);
  if (drill) return drill.defaultDetails;
  return item.drillDefaultDetails || "";
}

function itemVideoUrl(item: DrillRoutineItem, drillById?: Map<string, DrillLibraryItem>) {
  if (item.kind !== "libraryDrill") return "";
  const drill = resolveDrill(item, drillById);
  if (drill) return drill.videoUrl;
  return item.drillVideoUrl || "";
}

function openVideoUrl(url: string, event?: any) {
  event?.stopPropagation?.();
  const clean = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(clean)) return;
  if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.open === "function") {
    window.open(clean, "_blank", "noopener,noreferrer");
    return;
  }
  void Linking.openURL(clean).catch((error) => {
    console.warn("[athlete-routine-details] open video failed", { url: clean, error });
  });
}

function VideoLinkButton({ url }: { url: string }) {
  const clean = String(url ?? "").trim();
  if (!clean) return null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="Open drill video"
      hitSlop={8}
      onPress={(event) => openVideoUrl(clean, event)}
      style={{
        minWidth: 32,
        minHeight: 32,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 16,
        backgroundColor: "#eff6ff",
      }}
    >
      <Text style={{ color: "#2563eb", fontSize: 16, fontWeight: "900" }}>↗</Text>
    </Pressable>
  );
}

export function getRoutinePreviewText(routine: AuxiliaryRoutine, drillById?: Map<string, DrillLibraryItem>) {
  const items = Array.isArray(routine.items) ? routine.items : [];
  const description = String(routine.description ?? "").trim();
  if (items.length > 0) {
    const itemPreview = items
      .slice(0, 3)
      .map((item) => {
        if (item.kind === "text") return item.text;
        const prescription = String(item.prescription ?? "").trim();
        const title = itemTitle(item, drillById);
        return [prescription, title].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join("\n");
    return [description, itemPreview].filter(Boolean).join("\n");
  }
  return [description, String(routine.details ?? "").trim()].filter(Boolean).join("\n");
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
  const description = String(routine.description ?? "").trim();
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
    return description || legacyDetails ? (
      <View style={{ gap: 8 }}>
        {description ? (
          <View style={{ gap: 4 }}>
            <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900" }}>Description</Text>
            <LinkifiedText text={description} style={{ color: "#475569", lineHeight: 19 }} />
          </View>
        ) : null}
        {legacyDetails ? (
          <View style={{ gap: 4 }}>
            {description ? <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900" }}>Additional notes</Text> : null}
            <LinkifiedText text={legacyDetails} style={{ color: "#475569", lineHeight: 19 }} />
          </View>
        ) : null}
      </View>
    ) : null;
  }

  return (
    <View style={{ gap: 8 }}>
      {description ? (
        <View style={{ borderRadius: 10, backgroundColor: "#f8fafc", padding: 10, gap: 4 }}>
          <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900" }}>Description</Text>
          <LinkifiedText text={description} style={{ color: "#475569", lineHeight: 19 }} />
        </View>
      ) : null}
      <View style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 12, backgroundColor: "#ffffff", overflow: "hidden" }}>
      {items.map((item, index) => {
        if (item.kind === "text") {
          return (
            <View
              key={item.id}
              style={{
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: "#f1f5f9",
                paddingHorizontal: 10,
                paddingVertical: 8,
                flexDirection: "row",
                gap: 8,
              }}
            >
              <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900", width: 22 }}>{index + 1}.</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                <LinkifiedText text={item.text} style={{ color: "#334155", lineHeight: 19, fontWeight: "700" }} />
              </View>
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
          <View key={item.id} style={{ borderTopWidth: index === 0 ? 0 : 1, borderTopColor: "#f1f5f9" }}>
            <View style={{ paddingHorizontal: 10, paddingVertical: 8, gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900", width: 22 }}>{index + 1}.</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: "#0f172a", fontWeight: "900", lineHeight: 19 }}>
                    {prescription ? `${prescription} ` : ""}{title}
                  </Text>
                </View>
                {canExpand ? (
                  <Pressable
                    onPress={() => toggleItem(item.id)}
                    hitSlop={8}
                    style={{
                      minHeight: 32,
                      justifyContent: "center",
                      paddingHorizontal: 6,
                    }}
                  >
                    <Text style={{ color: "#2563eb", fontSize: 12, fontWeight: "900" }}>
                      {expanded ? "Hide cues" : "Show cues"}
                    </Text>
                  </Pressable>
                ) : null}
                {videoUrl ? <VideoLinkButton url={videoUrl} /> : null}
              </View>

            {expanded ? (
              <View style={{ marginLeft: 30, borderTopWidth: 1, borderTopColor: "#f1f5f9", paddingTop: 8, gap: 8 }}>
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
          </View>
        );
      })}
      </View>

      {legacyDetails ? (
        <View style={{ borderTopWidth: 1, borderTopColor: "#f1f5f9", paddingTop: 8, gap: 4 }}>
          <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "900" }}>Additional notes</Text>
          <LinkifiedText text={legacyDetails} style={{ color: "#475569", lineHeight: 19 }} />
        </View>
      ) : null}
    </View>
  );
}
