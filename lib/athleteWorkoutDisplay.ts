import type { AuxiliaryRoutine } from "./auxiliaryRoutines";
import type { TeamWorkoutBatchHeaderRow } from "./teamWorkoutBatchHeadersCloud";
import type { TeamWorkoutRow } from "./teamWorkoutsCloud";
import type { MileageValue } from "./types";
import { formatMileage } from "./mileagePlan";

export function cleanDisplayText(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeDisplaySession(value: unknown): "AM" | "PM" {
  return String(value ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
}

export function batchHeaderKey(batchId: unknown, dateISO: unknown, session: unknown): string {
  return [
    cleanDisplayText(batchId),
    cleanDisplayText(dateISO),
    normalizeDisplaySession(session),
  ].join("|");
}

export function buildBatchNotesByWorkoutId(
  workouts: Array<Pick<TeamWorkoutRow, "id" | "batch_id" | "date_iso" | "session">>,
  headers: TeamWorkoutBatchHeaderRow[]
): Map<string, string> {
  const notesByKey = new Map<string, string>();
  headers.forEach((header) => {
    const batchId = cleanDisplayText(header.batch_id);
    const dateISO = cleanDisplayText(header.date_iso);
    const notes = cleanDisplayText(header.header_notes);
    if (!batchId || !dateISO || !notes) return;
    notesByKey.set(batchHeaderKey(batchId, dateISO, header.session), notes);
  });

  const out = new Map<string, string>();
  workouts.forEach((workout) => {
    const batchId = cleanDisplayText(workout.batch_id);
    const dateISO = cleanDisplayText(workout.date_iso);
    const workoutId = cleanDisplayText(workout.id);
    if (!workoutId || !batchId || !dateISO) return;
    const notes = notesByKey.get(batchHeaderKey(batchId, dateISO, workout.session));
    if (notes) out.set(workoutId, notes);
  });
  return out;
}

export function getRoutineTitles(ids: unknown, routineById: Map<string, AuxiliaryRoutine>): string[] {
  if (!Array.isArray(ids)) return [];
  return Array.from(
    new Set(
      ids
        .map((id) => routineById.get(cleanDisplayText(id))?.title ?? "")
        .map((title) => cleanDisplayText(title))
        .filter(Boolean)
    )
  );
}

export function formatPrescribedLabel(value?: MileageValue | string | null): string {
  const raw = typeof value === "string" ? cleanDisplayText(value) : formatMileage(value ?? undefined);
  if (!raw) return "";
  if (/(:|\bmi\b|\bmile\b|\bmiles\b|\bkm\b|\bkilometer\b|\bkilometers\b|\bxt\b|\bmin\b)/i.test(raw)) return raw;
  return `${raw} mi`;
}
