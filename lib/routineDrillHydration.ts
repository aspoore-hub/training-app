import type { DrillRoutineItem } from "./auxiliaryRoutines";
import type { DrillLibraryItem } from "./drillLibrary";

export type HydratedRoutineDrillItem = {
  drill: DrillLibraryItem | null;
  title: string;
  cues: string;
  videoUrl: string;
  prescription: string;
  customNotes: string;
};

function explicitTitleOverride(item: DrillRoutineItem): string {
  if (item.kind !== "libraryDrill") return "";
  const raw = item as DrillRoutineItem & {
    titleOverride?: unknown;
    customTitle?: unknown;
    title?: unknown;
  };
  return String(raw.titleOverride ?? raw.customTitle ?? raw.title ?? "").trim();
}

export function hydrateRoutineLibraryDrillItem(
  item: DrillRoutineItem,
  drillById?: Map<string, DrillLibraryItem>
): HydratedRoutineDrillItem | null {
  if (item.kind !== "libraryDrill") return null;

  const drill = drillById?.get(item.drillId) ?? null;
  const overrideTitle = explicitTitleOverride(item);
  const customNotes = String(item.customNotes ?? "").trim();

  return {
    drill,
    title: overrideTitle || (drill ? drill.name || "Library drill" : item.drillTitle || "Missing drill"),
    cues: customNotes || (drill ? drill.defaultDetails : item.drillDefaultDetails || ""),
    videoUrl: drill ? drill.videoUrl : item.drillVideoUrl || "",
    prescription: String(item.prescription ?? "").trim(),
    customNotes,
  };
}
