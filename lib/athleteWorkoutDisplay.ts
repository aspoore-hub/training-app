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

export function normalizeDateISO(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = cleanDisplayText(value);
  const match = raw.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? raw;
}

export function batchHeaderKey(teamId: unknown, batchId: unknown, dateISO: unknown, session: unknown): string {
  return [
    cleanDisplayText(teamId),
    cleanDisplayText(batchId),
    normalizeDateISO(dateISO),
    normalizeDisplaySession(session),
  ].join("|");
}

export function buildBatchNotesByWorkoutId(
  workouts: Array<Pick<TeamWorkoutRow, "id" | "team_id" | "batch_id" | "date_iso" | "session" | "details">>,
  headers: TeamWorkoutBatchHeaderRow[]
): Map<string, string> {
  const notesByKey = new Map<string, string>();
  const notesByBatchDate = new Map<string, Set<string>>();
  const notesByBatch = new Map<string, Set<string>>();
  headers.forEach((header) => {
    const teamId = cleanDisplayText(header.team_id);
    const batchId = cleanDisplayText(header.batch_id);
    const dateISO = normalizeDateISO(header.date_iso);
    const notes = cleanDisplayText(header.header_notes);
    if (!teamId || !batchId || !dateISO || !notes) return;
    notesByKey.set(batchHeaderKey(teamId, batchId, dateISO, header.session), notes);
    const batchDateKey = [teamId, batchId, dateISO].join("|");
    if (!notesByBatchDate.has(batchDateKey)) notesByBatchDate.set(batchDateKey, new Set());
    notesByBatchDate.get(batchDateKey)?.add(notes);
    const batchKey = [teamId, batchId].join("|");
    if (!notesByBatch.has(batchKey)) notesByBatch.set(batchKey, new Set());
    notesByBatch.get(batchKey)?.add(notes);
  });

  const uniqueRowsById = new Map<string, Pick<TeamWorkoutRow, "id" | "team_id" | "batch_id" | "date_iso" | "session" | "details">>();
  workouts.forEach((workout) => {
    const workoutId = cleanDisplayText(workout.id);
    if (workoutId) uniqueRowsById.set(workoutId, workout);
  });
  const uniqueRows = Array.from(uniqueRowsById.values());
  const rowsByScope = new Map<string, typeof uniqueRows>();
  uniqueRows.forEach((workout) => {
    const teamId = cleanDisplayText(workout.team_id);
    const batchId = cleanDisplayText(workout.batch_id);
    const dateISO = normalizeDateISO(workout.date_iso);
    if (!teamId || !batchId || !dateISO) return;
    const key = batchHeaderKey(teamId, batchId, dateISO, workout.session);
    if (!rowsByScope.has(key)) rowsByScope.set(key, []);
    rowsByScope.get(key)?.push(workout);
  });

  const out = new Map<string, string>();
  uniqueRows.forEach((workout) => {
    const teamId = cleanDisplayText(workout.team_id);
    const batchId = cleanDisplayText(workout.batch_id);
    const dateISO = normalizeDateISO(workout.date_iso);
    const workoutId = cleanDisplayText(workout.id);
    if (!workoutId || !teamId || !batchId || !dateISO) return;
    const scopeKey = batchHeaderKey(teamId, batchId, dateISO, workout.session);
    const batchDateNotes = Array.from(notesByBatchDate.get([teamId, batchId, dateISO].join("|")) ?? []);
    const batchNotes = Array.from(notesByBatch.get([teamId, batchId].join("|")) ?? []);
    const notes =
      notesByKey.get(scopeKey) ||
      (batchDateNotes.length === 1 ? batchDateNotes[0] : "") ||
      (batchNotes.length === 1 ? batchNotes[0] : "") ||
      inferLegacyBatchNotes(workout, rowsByScope.get(scopeKey) ?? []);
    if (notes) out.set(workoutId, notes);
  });
  return out;
}

function inferLegacyBatchNotes(
  workout: Pick<TeamWorkoutRow, "id" | "details">,
  batchRows: Array<Pick<TeamWorkoutRow, "id" | "details">>
): string {
  const workoutId = cleanDisplayText(workout.id);
  const currentNotes = cleanDisplayText(workout.details);
  const siblingNotes = batchRows
    .filter((row) => cleanDisplayText(row.id) !== workoutId)
    .map((row) => cleanDisplayText(row.details))
    .filter(Boolean);

  if (siblingNotes.length === 0) return "";
  if (currentNotes && siblingNotes.some((notes) => notes === currentNotes)) return currentNotes;

  const counts = new Map<string, number>();
  siblingNotes.forEach((notes) => counts.set(notes, (counts.get(notes) ?? 0) + 1));
  const [topNotes, topCount] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (!topNotes) return "";
  if (topCount >= 2) return topNotes;
  if (!currentNotes) return topNotes;
  if (looksLikeIndividualOverride(currentNotes) && topNotes.length > currentNotes.length) return topNotes;
  return "";
}

function looksLikeIndividualOverride(value: string): boolean {
  const text = cleanDisplayText(value);
  if (!text || text.length > 40) return false;
  return (
    /^\d+(?:\.\d+)?(?:\s*(?:-|to|–)\s*\d+(?:\.\d+)?)?$/.test(text) ||
    /^\d+(?:\.\d+)?\s*(?:mi|mile|miles|km|kilometer|kilometers)$/i.test(text) ||
    /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)
  );
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

export function formatPlannedDistanceLabel(value: unknown, unit: unknown): string {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "";
  const normalizedUnit = cleanDisplayText(unit).toLowerCase() === "km" ? "km" : "mi";
  return `${Number.isInteger(numeric) ? numeric : Number(numeric.toFixed(2))} ${normalizedUnit}`;
}
