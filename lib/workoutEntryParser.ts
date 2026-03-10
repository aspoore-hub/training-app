export type WorkoutOption =
  | { kind: "miles"; min: number; max: number }
  | { kind: "run_time"; minMinutes: number; maxMinutes: number }
  | { kind: "xt"; minMinutes: number; maxMinutes: number };

export type ParsedWorkoutEntry = {
  raw: string;
  choiceMode: "single" | "or";
  options: WorkoutOption[];
};

export type MilesRange = { min: number; max: number };
export type SecRange = { min: number; max: number };

export const MAX_UNLABELED_MILES = 40;

type ParseOptions = {
  maxUnlabeledMiles?: number;
};

type LegacyMileageValue = {
  kind?: string;
  value?: unknown;
  min?: unknown;
  max?: unknown;
  seconds?: unknown;
  minSeconds?: unknown;
  maxSeconds?: unknown;
  input?: unknown;
  xt?: unknown;
  options?: unknown;
  exact?: unknown;
};

function coerceNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function parseTimeToSeconds(value: string): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const hms = raw.match(/^(\d+)\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})$/);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const s = Number(hms[3]);
    if ([h, m, s].every(Number.isFinite) && m >= 0 && m < 60 && s >= 0 && s < 60) {
      return h * 3600 + m * 60 + s;
    }
    return null;
  }

  const mmss = raw.match(/^(\d+)\s*:\s*(\d{1,2})$/);
  if (mmss) {
    const m = Number(mmss[1]);
    const s = Number(mmss[2]);
    if (Number.isFinite(m) && Number.isFinite(s) && s >= 0 && s < 60) {
      return m * 60 + s;
    }
    return null;
  }

  return null;
}

function parseNumberRange(raw: string): { min: number; max: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const plain = trimmed.match(/^([+-]?\d*\.?\d+)\s*-\s*([+-]?\d*\.?\d+)$/);
  if (plain) {
    const min = Number(plain[1]);
    const max = Number(plain[2]);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return { min: Math.min(min, max), max: Math.max(min, max) };
    }
    return null;
  }

  const single = trimmed.match(/^[+-]?\d*\.?\d+$/);
  if (single) {
    const value = Number(single[0]);
    if (Number.isFinite(value)) return { min: value, max: value };
  }

  return null;
}

function normalizeRange(range: { min: number; max: number }) {
  if (range.min <= range.max) return range;
  return { min: range.max, max: range.min };
}

function parseRunLike(raw: string): { kind: "run_time" | "xt"; minMinutes: number; maxMinutes: number } | null {
  const trimmed = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!trimmed) return null;

  // colon time, optionally as a range
  if (trimmed.includes(":")) {
    const parts = trimmed.split("-").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 1) {
      const sec = parseTimeToSeconds(parts[0]);
      if (sec == null) return null;
      const min = Math.max(0, sec / 60);
      return { kind: "run_time", minMinutes: min, maxMinutes: min };
    }
    if (parts.length === 2) {
      const a = parseTimeToSeconds(parts[0]);
      const b = parseTimeToSeconds(parts[1]);
      if (a == null || b == null) return null;
      const range = normalizeRange({ min: a / 60, max: b / 60 });
      return { kind: "run_time", minMinutes: range.min, maxMinutes: range.max };
    }
    return null;
  }

  const labeled = trimmed.match(/^([+-]?\d*\.?\d+)(?:-\s*([+-]?\d*\.?\d+))?(min|m)$/i);
  if (labeled) {
    return parseRangeWithSuffix(trimmed, /(min|m)$/i);
  }

  return null;
}

function parseRangeWithSuffix(raw: string, suffixPattern: RegExp): { kind: "run_time" | "xt"; minMinutes: number; maxMinutes: number } | null {
  const normalized = String(raw ?? "").trim().toLowerCase();
  const m = normalized.match(new RegExp(`^([+-]?[0-9]*\\.?[0-9]+)\\s*(?:-\\s*([+-]?[0-9]*\\.?[0-9]+))?\\s*${suffixPattern.source}$`, "i"));
  if (!m) return null;

  const min = Number(m[1]);
  const second = m[2];
  const max = second ? Number(second) : min;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const range = normalizeRange({ min, max });
  return { kind: "run_time", minMinutes: range.min, maxMinutes: range.max };
}

function parseSingleWorkoutOption(raw: string, maxUnlabeledMiles: number): WorkoutOption | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;

  const compact = trimmed.replace(/\s+/g, "");
  const hasXT = /xt$/i.test(compact);
  const core = hasXT ? compact.slice(0, -2) : compact;

  // time-like
  const runLike = parseRunLike(core);
  if (runLike) {
    return {
      kind: hasXT ? "xt" : "run_time",
      minMinutes: runLike.minMinutes,
      maxMinutes: runLike.maxMinutes,
    };
  }

  // XT time numeric with no time suffix (e.g. "75XT", "2-3XT")
  if (hasXT) {
    const numRange = parseNumberRange(core);
    if (numRange) {
      return {
        kind: "xt",
        minMinutes: Math.max(0, numRange.min),
        maxMinutes: Math.max(0, numRange.max),
      };
    }
    return null;
  }

  // unlabeled miles (numeric/range)
  const numeric = parseNumberRange(core);
  if (!numeric) return null;
  const { min, max } = normalizeRange(numeric);
  if (min > maxUnlabeledMiles || max > maxUnlabeledMiles) return null;
  return { kind: "miles", min, max };
}

export function parseWorkoutEntry(raw: string, options: ParseOptions = {}): ParsedWorkoutEntry | null {
  const maxUnlabeledMiles = options.maxUnlabeledMiles ?? MAX_UNLABELED_MILES;
  const rawTrimmed = String(raw ?? "").trim();
  if (!rawTrimmed) return null;

  const optionParts = rawTrimmed.split(/\s+or\s+/i).map((part) => part.trim()).filter(Boolean);
  if (optionParts.length === 0) return null;
  if (optionParts.length > 2) return null;

  const parsedOptions = optionParts
    .map((part) => parseSingleWorkoutOption(part, maxUnlabeledMiles))
    .filter((opt): opt is WorkoutOption => !!opt);
  if (parsedOptions.length !== optionParts.length) return null;

  return {
    raw: rawTrimmed,
    choiceMode: optionParts.length === 1 ? "single" : "or",
    options: parsedOptions,
  };
}

function parseLegacyObject(input: LegacyMileageValue): ParsedWorkoutEntry | null {
  const kind = typeof input.kind === "string" ? input.kind : undefined;
  if (kind === "choice") {
    const maybeOptions = Array.isArray(input.options) ? input.options : [];
    if (maybeOptions.length !== 2) return null;
    const a = parseLegacyObject(maybeOptions[0] as LegacyMileageValue);
    const b = parseLegacyObject(maybeOptions[1] as LegacyMileageValue);
    if (!a || !b) return null;
    return { raw: "legacy-choice", choiceMode: "or", options: [...a.options, ...b.options] };
  }

  if (kind === "exact") {
    const value = coerceNumber(input.value);
    if (value == null) return null;
    return {
      raw: "legacy-exact",
      choiceMode: "single",
      options: [{ kind: "miles", min: value, max: value }],
    };
  }

  if (kind === "range") {
    const min = coerceNumber(input.min);
    const max = coerceNumber(input.max);
    if (min == null || max == null) return null;
    return {
      raw: "legacy-range",
      choiceMode: "single",
      options: [{ kind: "miles", min: Math.min(min, max), max: Math.max(min, max) }],
    };
  }

  if (kind === "time" || kind === "timeRange") {
    const isXt = !!input.xt;
    if (kind === "time") {
      const seconds = coerceNumber(input.seconds);
      if (seconds == null) return null;
      const min = Math.max(0, seconds / 60);
      return {
        raw: "legacy-time",
        choiceMode: "single",
        options: [{ kind: isXt ? "xt" : "run_time", minMinutes: min, maxMinutes: min }],
      };
    }
    const min = coerceNumber(input.minSeconds);
    const max = coerceNumber(input.maxSeconds);
    if (min == null || max == null) return null;
    const range = normalizeRange({ min: min / 60, max: max / 60 });
    return {
      raw: "legacy-timeRange",
      choiceMode: "single",
      options: [{ kind: isXt ? "xt" : "run_time", minMinutes: range.min, maxMinutes: range.max }],
    };
  }

  // Legacy minutes-based model support
  if (kind === "minutes") {
    const value = coerceNumber(input.value);
    if (value == null) return null;
    const isXt = !!input.xt;
    return {
      raw: "legacy-minutes",
      choiceMode: "single",
      options: [
        {
          kind: isXt ? "xt" : "run_time",
          minMinutes: Math.max(0, value),
          maxMinutes: Math.max(0, value),
        },
      ],
    };
  }

  if (kind === "minutesRange") {
    const min = coerceNumber(input.min);
    const max = coerceNumber(input.max);
    if (min == null || max == null) return null;
    const isXt = !!input.xt;
    const range = normalizeRange({ min, max });
    return {
      raw: "legacy-minutesRange",
      choiceMode: "single",
      options: [
        {
          kind: isXt ? "xt" : "run_time",
          minMinutes: Math.max(0, range.min),
          maxMinutes: Math.max(0, range.max),
        },
      ],
    };
  }

  // fallback legacy shorthand shape
  const exact = coerceNumber((input as any).exact);
  if (exact != null) {
    return {
      raw: "legacy-exact-proxy",
      choiceMode: "single",
      options: [{ kind: "miles", min: exact, max: exact }],
    };
  }

  const minLegacy = coerceNumber((input as any).min);
  const maxLegacy = coerceNumber((input as any).max);
  if (minLegacy != null || maxLegacy != null) {
    const min = minLegacy ?? maxLegacy ?? 0;
    const max = maxLegacy ?? minLegacy ?? 0;
    const range = normalizeRange({ min, max });
    return {
      raw: "legacy-object-range",
      choiceMode: "single",
      options: [{ kind: "miles", min: range.min, max: range.max }],
    };
  }

  return null;
}

export function parseWorkoutEntryValue(
  value: unknown,
  options?: ParseOptions
): ParsedWorkoutEntry | null {
  if (value == null) return null;

  const maxUnlabeledMiles = options?.maxUnlabeledMiles ?? MAX_UNLABELED_MILES;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (Math.abs(value) > maxUnlabeledMiles) return null;
    return {
      raw: String(value),
      choiceMode: "single",
      options: [{ kind: "miles", min: value, max: value }],
    };
  }

  if (typeof value === "string") {
    return parseWorkoutEntry(value, options);
  }

  if (typeof value === "object") {
    return parseLegacyObject(value as LegacyMileageValue);
  }

  return null;
}

function minutesToSeconds(value: number) {
  return Math.max(0, Math.round(value * 60));
}

export function parseOptionMinutesToRange(option: WorkoutOption, paceSecPerMile: number) {
  const p = Math.max(1, paceSecPerMile || 480) / 60;
  if (option.kind === "miles") {
    return { min: option.min, max: option.max };
  }
  if (option.kind === "run_time") {
    return { min: option.minMinutes / p, max: option.maxMinutes / p };
  }
  return { min: 0, max: 0 };
}

export function workoutEntryMilesRange(entry: ParsedWorkoutEntry, paceSecPerMile: number): MilesRange {
  if (!entry.options.length) return { min: 0, max: 0 };
  let min = Number.POSITIVE_INFINITY;
  let max = 0;

  for (const option of entry.options) {
    if (option.kind === "xt") {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
      continue;
    }
    const r = parseOptionMinutesToRange(option, paceSecPerMile);
    min = Math.min(min, r.min);
    max = Math.max(max, r.max);
  }

  if (!Number.isFinite(min)) return { min: 0, max: 0 };
  return { min, max };
}

export function workoutEntryXTRange(entry: ParsedWorkoutEntry): SecRange {
  if (!entry.options.length) return { min: 0, max: 0 };
  let min = Number.POSITIVE_INFINITY;
  let max = 0;

  for (const option of entry.options) {
    if (option.kind !== "xt") {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
      continue;
    }
    min = Math.min(min, minutesToSeconds(option.minMinutes));
    max = Math.max(max, minutesToSeconds(option.maxMinutes));
  }

  if (!Number.isFinite(min)) return { min: 0, max: 0 };
  return { min, max };
}

function formatOption(option: WorkoutOption) {
  if (option.kind === "miles") {
    const hasRange = option.min !== option.max;
    const base = hasRange ? `${option.min}-${option.max}` : String(option.min);
    return `${base}mi`;
  }

  if (option.kind === "run_time") {
    const hasRange = option.minMinutes !== option.maxMinutes;
    if (hasRange) return `${Math.round(option.minMinutes)}-${Math.round(option.maxMinutes)}min`;
    return `${Math.round(option.minMinutes)}min`;
  }

  // xt
  const hasRange = option.minMinutes !== option.maxMinutes;
  if (hasRange) return `${Math.round(option.minMinutes)}-${Math.round(option.maxMinutes)}min XT`;
  return `${Math.round(option.minMinutes)}min XT`;
}

export function formatParsedWorkoutEntry(entry: ParsedWorkoutEntry | null | undefined) {
  if (!entry || !Array.isArray(entry.options) || entry.options.length === 0) return "";
  if (entry.choiceMode === "single") {
    return formatOption(entry.options[0] as WorkoutOption);
  }
  if (entry.options.length === 1) return formatOption(entry.options[0] as WorkoutOption);
  return entry.options.map((option) => formatOption(option)).join(" or ");
}
