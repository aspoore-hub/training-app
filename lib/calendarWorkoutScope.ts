import { hasWorkoutFeedback } from "./feedbackParsing";
import { isAthleteActiveOnDate, type TeamRosterAthlete } from "./teamRoster";
import type { TeamWorkoutRow } from "./teamWorkoutsCloud";

export type CalendarWorkoutFilterScope = {
  selectedAthleteIds: ReadonlySet<string>;
  selectedTrainingGroupIds: ReadonlySet<string>;
  selectedTrainingGroupAthleteIds: ReadonlySet<string>;
  rosterAthleteById: ReadonlyMap<string, TeamRosterAthlete>;
  selectedSeasonWindowForAthlete: (athleteId: string) => { startISO: string; endISO: string } | null;
  visibility: "all" | "published" | "draft";
};

export function doesCalendarWorkoutMatchFilters(
  workout: { athleteId: string; dateISO: string; athleteVisible?: boolean },
  scope: CalendarWorkoutFilterScope
): boolean {
  const athleteId = String(workout.athleteId ?? "").trim();
  const dateISO = String(workout.dateISO ?? "").trim();
  if (!athleteId || !dateISO) return false;
  const athlete = scope.rosterAthleteById.get(athleteId);
  if (scope.rosterAthleteById.size > 0 && (!athlete || !isAthleteActiveOnDate(athlete, dateISO))) return false;
  if (scope.selectedAthleteIds.size > 0 && !scope.selectedAthleteIds.has(athleteId)) return false;
  if (scope.selectedTrainingGroupIds.size > 0 && !scope.selectedTrainingGroupAthleteIds.has(athleteId)) return false;
  const seasonWindow = scope.selectedSeasonWindowForAthlete(athleteId);
  if (seasonWindow && (dateISO < seasonWindow.startISO || dateISO > seasonWindow.endISO)) return false;
  if (scope.visibility === "published" && workout.athleteVisible === false) return false;
  if (scope.visibility === "draft" && workout.athleteVisible !== false) return false;
  return true;
}

export type BulkWorkoutDeletionItem = {
  key: string;
  dateISO: string;
  session: "AM" | "PM";
  title: string;
  matchingRowIds: string[];
  matchingAthleteCount: number;
  totalAthleteCount: number;
  outcome: "whole-batch" | "partial-batch" | "row-only";
};

export type BulkWorkoutDeletionPreview = {
  matchingRows: TeamWorkoutRow[];
  protectedRows: TeamWorkoutRow[];
  deletableRows: TeamWorkoutRow[];
  items: BulkWorkoutDeletionItem[];
  batchCount: number;
  uniqueAthleteCount: number;
  dateCount: number;
  publishedCount: number;
  draftCount: number;
  partialBatchCount: number;
  wholeBatchCount: number;
};

function batchKey(row: TeamWorkoutRow): string {
  const batchId = String(row.batch_id ?? "").trim();
  return batchId
    ? `batch:${batchId}:${row.date_iso}:${row.session}`
    : `row:${row.id}`;
}

export function buildBulkWorkoutDeletionPreview(
  allRangeRows: TeamWorkoutRow[],
  matchingRows: TeamWorkoutRow[],
  excludeProtected: boolean
): BulkWorkoutDeletionPreview {
  const allByKey = new Map<string, TeamWorkoutRow[]>();
  allRangeRows.forEach((row) => {
    const key = batchKey(row);
    allByKey.set(key, [...(allByKey.get(key) ?? []), row]);
  });
  const matchingByKey = new Map<string, TeamWorkoutRow[]>();
  matchingRows.forEach((row) => {
    const key = batchKey(row);
    matchingByKey.set(key, [...(matchingByKey.get(key) ?? []), row]);
  });
  const protectedRows = matchingRows.filter(hasWorkoutFeedback);
  const deletableRows = excludeProtected ? matchingRows.filter((row) => !hasWorkoutFeedback(row)) : matchingRows;
  const deletableIds = new Set(deletableRows.map((row) => row.id));
  const items = Array.from(matchingByKey.entries())
    .map(([key, rows]) => {
      const deleting = rows.filter((row) => deletableIds.has(row.id));
      if (deleting.length === 0) return null;
      const sample = deleting[0];
      const totalRows = allByKey.get(key) ?? rows;
      const isBatch = !!String(sample.batch_id ?? "").trim();
      return {
        key,
        dateISO: sample.date_iso,
        session: sample.session,
        title: String(sample.title ?? "").trim() || "Workout",
        matchingRowIds: deleting.map((row) => row.id),
        matchingAthleteCount: deleting.length,
        totalAthleteCount: totalRows.length,
        outcome: !isBatch ? "row-only" : deleting.length === totalRows.length ? "whole-batch" : "partial-batch",
      } satisfies BulkWorkoutDeletionItem;
    })
    .filter((item): item is BulkWorkoutDeletionItem => !!item)
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.session.localeCompare(b.session) || a.title.localeCompare(b.title));
  return {
    matchingRows,
    protectedRows,
    deletableRows,
    items,
    batchCount: items.filter((item) => item.outcome !== "row-only").length,
    uniqueAthleteCount: new Set(deletableRows.map((row) => row.athlete_profile_id)).size,
    dateCount: new Set(deletableRows.map((row) => row.date_iso)).size,
    publishedCount: deletableRows.filter((row) => row.athlete_visible !== false).length,
    draftCount: deletableRows.filter((row) => row.athlete_visible === false).length,
    partialBatchCount: items.filter((item) => item.outcome === "partial-batch").length,
    wholeBatchCount: items.filter((item) => item.outcome === "whole-batch").length,
  };
}
