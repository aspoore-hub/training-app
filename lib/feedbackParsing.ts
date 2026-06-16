type WorkoutFeedbackFields = {
  completed_miles?: unknown;
  completed_time_text?: unknown;
  splits_or_pace?: unknown;
  additional_feedback?: unknown;
};

type MileageFeedbackFields = {
  completedMiles?: unknown;
  completedTime?: unknown;
  splitsOrPace?: unknown;
  additionalFeedback?: unknown;
};

export function parseNumericLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return undefined;
    const numericMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:mi|mile|miles|km|kilometer|kilometers)?$/i);
    const parsed = numericMatch ? Number(numericMatch[1]) : Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function hasWorkoutCompletion(row: WorkoutFeedbackFields): boolean {
  return (
    parseNumericLike(row.completed_miles) != null ||
    String(row.completed_time_text ?? "").trim().length > 0
  );
}

export function hasWorkoutFeedback(row: WorkoutFeedbackFields): boolean {
  return (
    hasWorkoutCompletion(row) ||
    String(row.splits_or_pace ?? "").trim().length > 0 ||
    String(row.additional_feedback ?? "").trim().length > 0
  );
}

export function hasMileageFeedback(entry: MileageFeedbackFields): boolean {
  return (
    parseNumericLike(entry.completedMiles) != null ||
    String(entry.completedTime ?? "").trim().length > 0 ||
    String(entry.splitsOrPace ?? "").trim().length > 0 ||
    String(entry.additionalFeedback ?? "").trim().length > 0
  );
}
