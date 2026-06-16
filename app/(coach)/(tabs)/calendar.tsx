import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Dimensions, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { AthleteWorkout, WeekStartDay, WorkoutCategory } from "../../../lib/types";
import { categoryColorByName } from "../../../lib/categories";
import {
  createTeamWorkoutBatch,
  deleteTeamWorkout,
  deleteWorkoutBatch,
  listTeamWorkoutsInRange,
  setWorkoutVisibilityByDateRange,
  updateTeamWorkoutById,
  updateTeamWorkoutsByBatchId,
  type TeamWorkoutRow,
} from "../../../lib/teamWorkoutsCloud";
import {
  listTeamWorkoutBatchHeadersInRange,
  saveTeamWorkoutBatchHeaderNotes,
} from "../../../lib/teamWorkoutBatchHeadersCloud";
import {
  getCachedCoachCategories,
  getCategoryOptions,
  loadCoachCategoriesFromTeamKV,
  loadCoachWeekLabels,
  loadWeekStartSetting,
  saveCoachWeekLabel,
} from "../../../lib/settings";
import {
  compareAthleteDisplayNamesByLastName,
  getRosterMapById,
  loadTeamRoster,
  resolveAthleteSeasonWindowWithTenure,
  resolveAthleteDisplayName,
} from "../../../lib/teamRoster";
import { loadAuxiliaryRoutines, type AuxiliaryRoutine } from "../../../lib/auxiliaryRoutines";
import { loadJSON, saveJSON } from "../../../lib/storage";
import { normalizeWorkoutTimeInput } from "../../../lib/time";
import { formatMileageForSheet, getWeekIndex, getWeekStartISO } from "../../../lib/mileagePlan";
import { getWeekLabelTone, getWeekLabelToneText } from "../../../lib/weekLabelStyle";
import { isActiveTrainingGroupMembership, isAthleteExcludedFromSeason, teamDataStore } from "../../../lib/teamDataStore";
import { setMileageVisibilityByDateRange } from "../../../lib/mileageCloud";
import { canEditTraining, canExport, canPublishTraining, getCurrentTeamRole, type TeamRole } from "../../../lib/teamPermissions";

const SCREEN_W = Dimensions.get("window").width;
const COACH_CALENDAR_VIEW_PREFS_KEY = "coach_calendar_view_prefs_v1";
const COACH_CALENDAR_WORKOUTS_CACHE_KEY = "coach_calendar_workouts_cache_v1";
const COACH_CALENDAR_ATHLETE_FILTER_KEY = "coach_calendar_selected_athlete_filter_v1";
const COACH_TRAINING_PLAN_EXPORT_RANGE_KEY = "coach_training_plan_export_range_v1";
const MAX_TRAINING_PLAN_EXPORT_RANGE_DAYS = 112;
const DEBUG_CALENDAR = false;

function debugCalendar(...args: unknown[]) {
  if (DEBUG_CALENDAR) console.log(...args);
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type CoachCalendarWorkout = AthleteWorkout & {
  calendarLocation?: string;
  athleteDisplayName?: string;
  categoryName?: string;
  date?: string;
  createdAt?: number;
  athleteVisible?: boolean;
};

type MonthCell = {
  dateISO: string;
  dayNumber: number;
  inMonth: boolean;
};

type WeeklyGroupLine = {
  individualNotes?: string;
  athleteNames: string[];
};

type WeeklyGroupSection = {
  key: string;
  label: string;
  lines: WeeklyGroupLine[];
};

type WeeklyWorkoutSection = {
  key: string;
  saveKey: string;
  dateISO: string;
  title: string;
  session: string;
  time?: string;
  location?: string;
  details?: string;
  categories: string[];
  preRoutineIds: string[];
  postRoutineIds: string[];
  categoryColor: string;
  athleteCount: number;
  groupCount: number;
  groups: WeeklyGroupSection[];
  suggestedMileageText?: string;
  suggestedMileageOnly?: boolean;
  visibilityStatus?: WeekWorkoutVisibilityStatus;
};

type WeeklyDaySection = {
  dateISO: string;
  weekday: string;
  fullDate: string;
  workouts: WeeklyWorkoutSection[];
};

type ParsedDisplayName = {
  full: string;
  last: string;
  first: string;
  firstInitial: string;
  secondInitial: string;
};

type WeeklyBatchDraft = {
  session: "AM" | "PM";
  time_text: string;
  date_iso: string;
  location: string;
  title: string;
  details: string;
  categories: string[];
};

type WeeklyBatchEditableField =
  | "time_text"
  | "location"
  | "title";

type WeeklySaveState = {
  status: "idle" | "saving" | "saved" | "error";
  message?: string;
};

type TrainingVisibilityAction = "publish" | "hide";
type TrainingVisibilityContent = "workouts" | "mileage" | "both";
type TrainingVisibilityRange = "week" | "custom" | "season";
type WeekWorkoutVisibilityStatus = "empty" | "hidden" | "published" | "mixed";

type ParsedWeeklyBatchKey = {
  isBatch: boolean;
  id: string;
};

type MonthWorkoutSummaryRow = {
  title: string;
  color: string;
  dotColors: string[];
  count: number;
  priority: 0 | 1 | 2;
  firstSeenOrder: number;
};

type AthleteFilterOption = {
  id: string;
  label: string;
};

type TrainingPlanWeekSection = {
  weekStartISO: string;
  weekLabel: string;
  days: WeeklyDaySection[];
};

function escapePdfHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPdfDateShort(dateISO: string): string {
  const [y, m, d] = String(dateISO ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(dateISO ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(dateISO ?? "");
  return `${dt.getDate()}-${dt.toLocaleDateString(undefined, { month: "short" })}`;
}

function buildWeeklyHandoutHtml(args: {
  weekLabel: string;
  weekAnnotation?: string;
  weekAnnotationTone?: ReturnType<typeof getWeekLabelTone>;
  generatedAtLabel?: string;
  days: WeeklyDaySection[];
  categories: WorkoutCategory[];
}): string {
  const weekAnnotationText = String(args.weekAnnotation ?? "").trim();
  const weekAnnotationTone = args.weekAnnotationTone ?? getWeekLabelTone(weekAnnotationText);
  const weekAnnotationColors = getWeekLabelToneColors(weekAnnotationTone);
  const dayColumns = (Array.isArray(args.days) ? args.days : [])
    .map((day) => {
      const workoutHtml =
        day.workouts.length === 0
          ? `<div class="off-line">Off / No team workout scheduled</div>`
          : day.workouts
              .map((workout) => {
                const time = String(workout.time ?? "").trim() || String(workout.session ?? "").trim();
                const location = String(workout.location ?? "").trim();
                const headerLine = [time, location ? `@ ${location}` : ""].filter(Boolean).join(" ");
                const title = String(workout.title ?? "").trim();
                const batchNotes = String(workout.details ?? "").trim();
                const showBatchNotes = batchNotes.length > 0 && batchNotes.toLowerCase() !== "no notes";
                const accentColors = normalizeWorkoutAccentColors(workout.categories, args.categories);
                const accentBackground = buildVerticalAccentBackground(accentColors);
                const dotsHtml = (Array.isArray(workout.categories) ? workout.categories : [])
                  .map((cat) => {
                    const color = categoryColorByName(args.categories, cat);
                    return `
                      <span class="workout-category-item">
                        <span class="workout-dot" style="background:${escapePdfHtml(color)};"></span>
                        <span class="workout-category-label">${escapePdfHtml(String(cat ?? "").trim() || "Other")}</span>
                      </span>
                    `;
                  })
                  .join("");
                const groups = (Array.isArray(workout.groups) ? workout.groups : [])
                  .map((group) =>
                    (Array.isArray(group.lines) ? group.lines : [])
                      .map((line) => {
                        const details = String(line.individualNotes ?? "").trim();
                        const names = (Array.isArray(line.athleteNames) ? line.athleteNames : []).join(", ");
                        const showDetails = !!details;
                        return `
                          ${showDetails ? `<div class="group-details">${escapePdfHtml(details)}</div>` : ""}
                          <div class="group-athletes">${escapePdfHtml(names || "Unknown athlete")}</div>
                        `;
                      })
                      .join("")
                  )
                  .join("");

                return `
                  <div class="workout-block">
                    <div class="workout-accent" style="background:${escapePdfHtml(accentBackground)};"></div>
                    <div class="workout-content">
                      <div class="workout-header-row">
                        <div class="workout-header">${escapePdfHtml(headerLine || "Workout")}</div>
                      </div>
                      ${dotsHtml ? `<div class="workout-categories-row">${dotsHtml}</div>` : ""}
                      ${title ? `<div class="workout-title">${escapePdfHtml(title)}</div>` : ""}
                      ${showBatchNotes ? `<div class="workout-batch-notes">${escapePdfHtml(batchNotes)}</div>` : ""}
                      ${groups}
                    </div>
                  </div>
                `;
              })
              .join("");

      return `
      <div class="day-column">
        <div class="day-head">
          <div class="day-name">${escapePdfHtml(day.weekday)}</div>
          <div class="day-date">${escapePdfHtml(formatPdfDateShort(day.dateISO))}</div>
        </div>
        <div class="day-workouts">
          ${workoutHtml}
        </div>
      </div>
      `;
    })
    .join("");

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Weekly Training Plan</title>
    <style>
      @page { size: Letter landscape; margin: 0.22in; }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        background: #fff;
        color: #111827;
        font-family: Arial, Helvetica, sans-serif;
      }

      .page {
        width: 100%;
      }

      .title {
        font-size: 14px;
        font-weight: 800;
        margin: 0 0 2px 0;
        line-height: 1.1;
      }

      .subtitle {
        font-size: 8px;
        font-weight: 700;
        margin: 0 0 6px 0;
        color: #374151;
        line-height: 1.1;
      }

      .week-grid {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: 6px;
        align-items: stretch;
        overflow: visible;
      }

      .day-column {
        border: 1px solid #9ca3af;
        border-radius: 4px;
        background: #fff;
        overflow: visible;
        break-inside: auto;
        page-break-inside: auto;
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .day-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 5px;
        border-bottom: 1px solid #d1d5db;
        padding: 4px 5px 3px 5px;
        background: #f8fafc;
      }

      .day-name {
        font-size: 9px;
        font-weight: 800;
        color: #111827;
        line-height: 1.1;
      }

      .day-date {
        font-size: 8px;
        font-weight: 800;
        color: #334155;
        line-height: 1.1;
        white-space: nowrap;
      }

      .day-workouts {
        padding: 4px;
        overflow: visible;
        flex: 1 1 auto;
        align-content: flex-start;
      }

      .workout-block {
        break-inside: avoid;
        page-break-inside: avoid;
        margin-bottom: 4px;
        border: 1px solid #d1d5db;
        border-radius: 3px;
        background: #ffffff;
        padding: 0;
        display: flex;
        align-items: stretch;
        overflow: hidden;
      }

      .workout-block:last-child { margin-bottom: 0; }

      .workout-accent {
        width: 4px;
        flex: 0 0 4px;
      }

      .workout-content {
        flex: 1;
        min-width: 0;
        padding: 3px 4px;
      }

      .workout-header-row {
        display: flex;
        align-items: center;
        gap: 4px;
        margin: 0 0 2px 0;
      }

      .workout-header {
        font-size: 8px;
        font-weight: 800;
        line-height: 1.2;
        margin: 0;
        flex: 1;
        min-width: 0;
        white-space: normal;
        word-break: break-word;
      }

      .workout-categories-row {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
        margin: 0 0 2px 0;
      }

      .workout-category-item {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        min-width: 0;
      }

      .workout-dot {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        display: inline-block;
        border: 0.5px solid rgba(0,0,0,0.18);
      }

      .workout-category-label {
        font-size: 7px;
        font-weight: 700;
        color: #334155;
        line-height: 1.15;
      }

      .workout-title {
        font-size: 8px;
        font-weight: 700;
        line-height: 1.2;
        margin: 0 0 2px 0;
        white-space: normal;
        word-break: break-word;
      }

      .workout-batch-notes {
        font-size: 7.5px;
        line-height: 1.2;
        margin: 0 0 2px 0;
        color: #334155;
        white-space: normal;
        word-break: break-word;
      }

      .group-details {
        font-size: 7.5px;
        line-height: 1.2;
        margin: 0 0 1px 0;
        white-space: normal;
        word-break: break-word;
      }

      .group-athletes {
        font-size: 7px;
        font-style: italic;
        color: #4b5563;
        line-height: 1.2;
        margin: 0 0 2px 0;
        white-space: normal;
        word-break: break-word;
      }

      .group-athletes:last-child {
        margin-bottom: 0;
      }

      .off-line {
        font-size: 7.5px;
        font-style: italic;
        color: #4b5563;
        line-height: 1.2;
        padding: 1px 0;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <h1 class="title">Weekly Training Plan</h1>
      <p class="subtitle">${escapePdfHtml(args.weekLabel)}${args.generatedAtLabel ? ` • Generated ${escapePdfHtml(args.generatedAtLabel)}` : ""}</p>
      ${
        weekAnnotationText
          ? `<p class="subtitle" style="display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid ${escapePdfHtml(
              weekAnnotationColors.border
            )};background:${escapePdfHtml(weekAnnotationColors.bg)};color:${escapePdfHtml(weekAnnotationColors.text)};">${escapePdfHtml(
              weekAnnotationText
            )}</p>`
          : ""
      }
      <div class="week-grid">
        ${dayColumns}
      </div>
    </div>
  </body>
</html>
`.trim();
}

function formatTrainingPlanRangeLabel(startISO: string, endISO: string): string {
  const [sy, sm, sd] = String(startISO ?? "").split("-").map(Number);
  const [ey, em, ed] = String(endISO ?? "").split("-").map(Number);
  if (!sy || !sm || !sd || !ey || !em || !ed) return `${startISO} - ${endISO}`;
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${startISO} - ${endISO}`;
  const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const endOpts = start.getFullYear() === end.getFullYear()
    ? { month: "short", day: "numeric", year: "numeric" } as const
    : { month: "short", day: "numeric", year: "numeric" } as const;
  const endLabel = end.toLocaleDateString(undefined, endOpts);
  return `${startLabel} - ${endLabel}`;
}

function buildTrainingPlanRangeHtml(args: {
  title: string;
  rangeLabel: string;
  generatedAtLabel?: string;
  weeks: TrainingPlanWeekSection[];
  categories: WorkoutCategory[];
}): string {
  const weekBlocks = (Array.isArray(args.weeks) ? args.weeks : [])
    .map((week) => {
      const dayColumns = (Array.isArray(week.days) ? week.days : [])
        .map((day) => {
          const workoutHtml =
            day.workouts.length === 0
              ? `<div class="off-line">Off / No team workout scheduled</div>`
              : day.workouts
                  .map((workout) => {
                    const time = String(workout.time ?? "").trim() || String(workout.session ?? "").trim();
                    const location = String(workout.location ?? "").trim();
                    const headerLine = [time, location ? `@ ${location}` : ""].filter(Boolean).join(" ");
                    const title = String(workout.title ?? "").trim();
                    const batchNotes = String(workout.details ?? "").trim();
                    const showBatchNotes = batchNotes.length > 0 && batchNotes.toLowerCase() !== "no notes";
                    const suggestedMileageText = String(workout.suggestedMileageText ?? "").trim();
                    const accentColors = normalizeWorkoutAccentColors(workout.categories, args.categories);
                    const accentBackground = workout.suggestedMileageOnly
                      ? "#0f766e"
                      : buildVerticalAccentBackground(accentColors);
                    const dotsHtml = (Array.isArray(workout.categories) ? workout.categories : [])
                      .map((cat) => {
                        const color = categoryColorByName(args.categories, cat);
                        return `
                          <span class="workout-category-item">
                            <span class="workout-dot" style="background:${escapePdfHtml(color)};"></span>
                            <span class="workout-category-label">${escapePdfHtml(String(cat ?? "").trim() || "Other")}</span>
                          </span>
                        `;
                      })
                      .join("");
                    const groups = (Array.isArray(workout.groups) ? workout.groups : [])
                      .map((group) =>
                        (Array.isArray(group.lines) ? group.lines : [])
                          .map((line) => {
                            const details = String(line.individualNotes ?? "").trim();
                            const names = (Array.isArray(line.athleteNames) ? line.athleteNames : []).join(", ");
                            const showDetails = !!details;
                            return `
                              ${showDetails ? `<div class="group-details">${escapePdfHtml(details)}</div>` : ""}
                              <div class="group-athletes">${escapePdfHtml(names || "Unknown athlete")}</div>
                            `;
                          })
                          .join("")
                      )
                      .join("");

                    return `
                      <div class="workout-block">
                        <div class="workout-accent" style="background:${escapePdfHtml(accentBackground)};"></div>
                        <div class="workout-content">
                          <div class="workout-header-row">
                            <div class="workout-header">${escapePdfHtml(headerLine || "Workout")}</div>
                          </div>
                          ${dotsHtml ? `<div class="workout-categories-row">${dotsHtml}</div>` : ""}
                          ${title ? `<div class="workout-title">${escapePdfHtml(title)}</div>` : ""}
                          ${suggestedMileageText ? `<div class="workout-mileage">Mileage: ${escapePdfHtml(suggestedMileageText)}</div>` : ""}
                          ${showBatchNotes ? `<div class="workout-batch-notes">${escapePdfHtml(batchNotes)}</div>` : ""}
                          ${groups}
                        </div>
                      </div>
                    `;
                  })
                  .join("");

          return `
            <div class="day-column">
              <div class="day-head">
                <div class="day-name">${escapePdfHtml(day.weekday)}</div>
                <div class="day-date">${escapePdfHtml(formatPdfDateShort(day.dateISO))}</div>
              </div>
              <div class="day-workouts">
                ${workoutHtml}
              </div>
            </div>
          `;
        })
        .join("");

      return `
        <section class="week-block">
          <h2 class="week-title">${escapePdfHtml(week.weekLabel)}</h2>
          <div class="week-grid">
            ${dayColumns}
          </div>
        </section>
      `;
    })
    .join("");

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Training Plan</title>
    <style>
      @page { size: Letter landscape; margin: 0.22in; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #fff; color: #111827; font-family: Arial, Helvetica, sans-serif; }
      .page { width: 100%; }
      .title { font-size: 14px; font-weight: 800; margin: 0 0 2px 0; line-height: 1.1; }
      .subtitle { font-size: 8px; font-weight: 700; margin: 0 0 6px 0; color: #374151; line-height: 1.1; }
      .week-block { break-inside: avoid; page-break-inside: avoid; margin: 0 0 8px 0; }
      .week-title { font-size: 10px; font-weight: 800; margin: 0 0 4px 0; color: #111827; }
      .week-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; align-items: stretch; overflow: visible; }
      .day-column { border: 1px solid #9ca3af; border-radius: 4px; background: #fff; overflow: visible; break-inside: auto; page-break-inside: auto; display: flex; flex-direction: column; height: 100%; }
      .day-head { display: flex; align-items: center; justify-content: space-between; gap: 5px; border-bottom: 1px solid #d1d5db; padding: 4px 5px 3px 5px; background: #f8fafc; }
      .day-name { font-size: 9px; font-weight: 800; color: #111827; line-height: 1.1; }
      .day-date { font-size: 8px; font-weight: 800; color: #334155; line-height: 1.1; white-space: nowrap; }
      .day-workouts { padding: 4px; overflow: visible; flex: 1 1 auto; align-content: flex-start; }
      .workout-block { break-inside: avoid; page-break-inside: avoid; margin-bottom: 4px; border: 1px solid #d1d5db; border-radius: 3px; background: #ffffff; padding: 0; display: flex; align-items: stretch; overflow: hidden; }
      .workout-block:last-child { margin-bottom: 0; }
      .workout-accent { width: 4px; flex: 0 0 4px; }
      .workout-content { flex: 1; min-width: 0; padding: 3px 4px; }
      .workout-header-row { display: flex; align-items: center; gap: 4px; margin: 0 0 2px 0; }
      .workout-header { font-size: 8px; font-weight: 800; line-height: 1.2; margin: 0; flex: 1; min-width: 0; white-space: normal; word-break: break-word; }
      .workout-categories-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin: 0 0 2px 0; }
      .workout-category-item { display: inline-flex; align-items: center; gap: 3px; min-width: 0; }
      .workout-dot { width: 6px; height: 6px; border-radius: 999px; display: inline-block; border: 0.5px solid rgba(0,0,0,0.18); }
      .workout-category-label { font-size: 7px; font-weight: 700; color: #334155; line-height: 1.15; }
      .workout-title { font-size: 8px; font-weight: 700; line-height: 1.2; margin: 0 0 2px 0; white-space: normal; word-break: break-word; }
      .workout-mileage { font-size: 7.5px; font-weight: 800; line-height: 1.2; margin: 0 0 2px 0; color: #0f766e; white-space: normal; word-break: break-word; }
      .workout-batch-notes { font-size: 7.5px; line-height: 1.2; margin: 0 0 2px 0; color: #334155; white-space: normal; word-break: break-word; }
      .group-details { font-size: 7.5px; line-height: 1.2; margin: 0 0 1px 0; white-space: normal; word-break: break-word; }
      .group-athletes { font-size: 7px; font-style: italic; color: #4b5563; line-height: 1.2; margin: 0 0 2px 0; white-space: normal; word-break: break-word; }
      .group-athletes:last-child { margin-bottom: 0; }
      .off-line { font-size: 7.5px; font-style: italic; color: #4b5563; line-height: 1.2; padding: 1px 0; }
    </style>
  </head>
  <body>
    <div class="page">
      <h1 class="title">${escapePdfHtml(args.title)}</h1>
      <p class="subtitle">${escapePdfHtml(args.rangeLabel)}${args.generatedAtLabel ? ` • Generated ${escapePdfHtml(args.generatedAtLabel)}` : ""}</p>
      ${weekBlocks}
    </div>
  </body>
</html>
`.trim();
}

function buildVerticalAccentBackground(colors: string[]): string {
  const safe = (Array.isArray(colors) ? colors : []).filter(Boolean).slice(0, 4);
  if (safe.length === 0) return "#e0e8f6";
  if (safe.length === 1) return safe[0];
  const step = 100 / safe.length;
  const stops = safe.map((color, idx) => {
    const start = (idx * step).toFixed(2);
    const end = ((idx + 1) * step).toFixed(2);
    return `${color} ${start}% ${end}%`;
  });
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

function printHtmlInWebWindow(html: string) {
  if (Platform.OS !== "web") return false;

  const printWindow = window.open("", "_blank", "width=1200,height=900");
  if (!printWindow) {
    throw new Error("Popup blocked. Please allow popups for this site to export the PDF.");
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();

  const finalizePrint = () => {
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      setTimeout(() => {
        try {
          printWindow.close();
        } catch {}
      }, 300);
    }, 250);
  };

  if (printWindow.document.readyState === "complete") {
    finalizePrint();
  } else {
    printWindow.onload = finalizePrint;
  }

  return true;
}

function toISODate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseISODate(iso: string): Date {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function monthStart(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, delta: number) {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

function addDays(d: Date, delta: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + delta);
  return next;
}

function shiftISODateByDays(dateISO: string, delta: number): string {
  const [y, m, d] = String(dateISO ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(dateISO ?? "");
  const shifted = addDays(new Date(y, m - 1, d), delta);
  return toISODate(shifted);
}

function diffISODateDays(fromISO: string, toISO: string): number {
  const [fromY, fromM, fromD] = String(fromISO ?? "").split("-").map(Number);
  const [toY, toM, toD] = String(toISO ?? "").split("-").map(Number);
  if (!fromY || !fromM || !fromD || !toY || !toM || !toD) return 0;
  const fromDate = new Date(fromY, fromM - 1, fromD);
  const toDate = new Date(toY, toM - 1, toD);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((toDate.getTime() - fromDate.getTime()) / msPerDay);
}

function isValidISODate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function generateCopiedBatchId(): string {
  const randomUuid = (globalThis as any)?.crypto?.randomUUID?.();
  if (typeof randomUuid === "string" && randomUuid.trim()) return randomUuid;
  return `copy_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function toShortWeekdayLabel(weekday: string): string {
  const normalized = String(weekday ?? "").trim().toLowerCase();
  if (normalized === "monday") return "Mon";
  if (normalized === "tuesday") return "Tues";
  if (normalized === "wednesday") return "Wed";
  if (normalized === "thursday") return "Thurs";
  if (normalized === "friday") return "Fri";
  if (normalized === "saturday") return "Sat";
  if (normalized === "sunday") return "Sun";
  return String(weekday ?? "");
}

function startOfWeek(d: Date, weekStartsOn: WeekStartDay) {
  const day = d.getDay();
  const offset = (day - weekStartsOn + 7) % 7;
  return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -offset);
}

function formatWeekRangeFromStartISO(weekStartISO: string): string {
  const start = parseISODate(weekStartISO);
  if (Number.isNaN(start.getTime())) return weekStartISO;
  const end = addDays(start, 6);
  const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${startLabel} - ${endLabel}`;
}

function buildMonthGrid(anchor: Date, weekStartsOn: WeekStartDay): MonthCell[] {
  const first = monthStart(anchor);
  const jsDay = first.getDay();
  const startIndex = (jsDay - weekStartsOn + 7) % 7;

  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startIndex);

  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push({
      dateISO: toISODate(d),
      dayNumber: d.getDate(),
      inMonth: d.getMonth() === anchor.getMonth(),
    });
  }
  return cells;
}

function workoutCategoryNames(w: CoachCalendarWorkout): string[] {
  const arr = Array.isArray(w.categories) ? w.categories : [w.category ?? w.categoryName ?? "Other"];
  const cleaned = arr
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["Other"];
}

function getWorkoutDateISO(w: CoachCalendarWorkout): string {
  return String(w.dateISO ?? w.date ?? "");
}

function getWorkoutBatchKey(w: CoachCalendarWorkout): string {
  const batchId = String(w.batchId ?? "").trim();
  if (batchId) return `batch:${batchId}`;
  return `single:${String(w.id ?? "")}`;
}

function parseWeeklyBatchKey(key: string): ParsedWeeklyBatchKey {
  if (String(key ?? "").startsWith("batch:")) {
    return { isBatch: true, id: String(key).slice(6) };
  }
  return { isBatch: false, id: String(key).replace(/^single:/, "") };
}

function normalizeSession(value: string): "AM" | "PM" {
  return String(value ?? "").trim().toUpperCase() === "AM" ? "AM" : "PM";
}

function toWorkoutBatchHeaderNotesKey(dateISO: string, batchId: string, session: string): string {
  return `${String(dateISO ?? "").trim()}::${String(batchId ?? "").trim()}::${normalizeSession(String(session ?? ""))}`;
}

function toWorkoutBatchHeaderNotesBaseKey(dateISO: string, batchId: string): string {
  return `${String(dateISO ?? "").trim()}::${String(batchId ?? "").trim()}`;
}

function applyHeaderNotesToWeeklySections(
  days: WeeklyDaySection[],
  headerByKey: Record<string, string>,
  headerByBaseKey: Record<string, string>,
  headerByBatchId: Record<string, string>
): WeeklyDaySection[] {
  return (Array.isArray(days) ? days : []).map((day) => ({
    ...day,
    workouts: (Array.isArray(day.workouts) ? day.workouts : []).map((workout) => {
      const parsed = parseWeeklyBatchKey(workout.saveKey);
      if (!parsed.isBatch) return workout;
      const exactKey = toWorkoutBatchHeaderNotesKey(day.dateISO, parsed.id, String(workout.session ?? ""));
      const exact = String(headerByKey[exactKey] ?? "").trim();
      if (exact) return { ...workout, details: exact };
      const baseKey = toWorkoutBatchHeaderNotesBaseKey(day.dateISO, parsed.id);
      const base = String(headerByBaseKey[baseKey] ?? "").trim();
      if (base) return { ...workout, details: base };
      const byBatch = String(headerByBatchId[parsed.id] ?? "").trim();
      if (byBatch) return { ...workout, details: byBatch };
      return workout;
    }),
  }));
}

function trainingPlanMileageSessionKey(dateISO: string, session: string): string {
  return `${String(dateISO ?? "").trim()}::${normalizeSession(session)}`;
}

function buildTrainingPlanMileageOnlySection(
  dateISO: string,
  session: "AM" | "PM",
  mileageText: string
): WeeklyWorkoutSection {
  return {
    key: `mileage:${dateISO}:${session}`,
    saveKey: `mileage:${dateISO}:${session}`,
    dateISO,
    title: "Suggested Mileage",
    session,
    categories: [],
    preRoutineIds: [],
    postRoutineIds: [],
    categoryColor: "#0f766e",
    athleteCount: 1,
    groupCount: 0,
    groups: [],
    suggestedMileageText: mileageText,
    suggestedMileageOnly: true,
  };
}

function applySuggestedMileageToTrainingPlanWeeks(
  weeks: TrainingPlanWeekSection[],
  suggestedMileageByDateSession: Map<string, string>
): TrainingPlanWeekSection[] {
  if (suggestedMileageByDateSession.size === 0) return weeks;

  return weeks.map((week) => ({
    ...week,
    days: week.days.map((day) => {
      const mileageRenderedBySession = new Set<string>();
      const workoutsWithMileage = day.workouts.map((workout) => {
        const session = normalizeSession(workout.session);
        const mileageText = suggestedMileageByDateSession.get(trainingPlanMileageSessionKey(day.dateISO, session));
        if (!mileageText || mileageRenderedBySession.has(session)) return workout;
        mileageRenderedBySession.add(session);
        return {
          ...workout,
          suggestedMileageText: mileageText,
        };
      });

      const mileageOnlyWorkouts: WeeklyWorkoutSection[] = (["AM", "PM"] as const)
        .map((session) => {
          if (mileageRenderedBySession.has(session)) return null;
          const mileageText = suggestedMileageByDateSession.get(trainingPlanMileageSessionKey(day.dateISO, session));
          if (!mileageText) return null;
          mileageRenderedBySession.add(session);
          return buildTrainingPlanMileageOnlySection(day.dateISO, session, mileageText);
        })
        .filter((value): value is WeeklyWorkoutSection => !!value);

      return {
        ...day,
        workouts: sortWeeklyDayWorkoutsForDisplay([...workoutsWithMileage, ...mileageOnlyWorkouts]),
      };
    }),
  }));
}

function summarizeWeeklySectionDetails(days: WeeklyDaySection[]) {
  return (Array.isArray(days) ? days : []).flatMap((day) =>
    (Array.isArray(day.workouts) ? day.workouts : []).map((workout) => {
      const parsed = parseWeeklyBatchKey(workout.saveKey);
      const firstLine = String(workout.details ?? "").trim().split(/\n+/)[0] ?? "";
      return {
        dateISO: day.dateISO,
        batchId: parsed.isBatch ? parsed.id : "",
        session: String(workout.session ?? ""),
        title: String(workout.title ?? ""),
        details: String(workout.details ?? ""),
        detailsPreview: firstLine,
      };
    })
  );
}

function sanitizeBatchCategories(raw: unknown): string[] {
  const out = Array.isArray(raw)
    ? raw
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
    : [];
  return Array.from(new Set(out));
}

function sanitizeRoutineIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function toWeeklyBatchDraft(workout: WeeklyWorkoutSection): WeeklyBatchDraft {
  return {
    session: normalizeSession(workout.session),
    time_text: String(workout.time ?? "").trim(),
    date_iso: String(workout.dateISO ?? "").trim(),
    location: String(workout.location ?? "").trim(),
    title: String(workout.title ?? "").trim(),
    details: String(workout.details ?? "").trim(),
    categories: sanitizeBatchCategories(workout.categories),
  };
}

function toWeeklyBatchPatchFromDraft(
  draft: WeeklyBatchDraft,
  dirtyKeys: WeeklyBatchEditableField[]
): Partial<TeamWorkoutRow> {
  const payload: Partial<TeamWorkoutRow> = {};
  dirtyKeys.forEach((key) => {
    if (key === "time_text") payload.time_text = String(draft.time_text ?? "");
    if (key === "location") payload.location = String(draft.location ?? "");
    if (key === "title") payload.title = String(draft.title ?? "");
  });
  return payload;
}

function normalizeWorkoutAccentColors(
  categoryNames: string[],
  categories: WorkoutCategory[],
  fallback = "#e0e8f6"
): string[] {
  const names = (Array.isArray(categoryNames) ? categoryNames : [])
    .map((cat) => String(cat ?? "").trim())
    .filter(Boolean);
  if (names.length === 0) return [fallback];
  const limited = names.slice(0, 4);
  const colors = limited.map((name) => categoryColorByName(categories, name)).filter(Boolean);
  return colors.length > 0 ? colors : [fallback];
}

function buildConicGradient(colors: string[]): string {
  const safe = colors.slice(0, 4);
  if (safe.length <= 1) return safe[0] ?? "#6B7280";
  const step = 360 / safe.length;
  const stops = safe.map((color, idx) => {
    const start = idx * step;
    const end = (idx + 1) * step;
    return `${color} ${start}deg ${end}deg`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

function MonthWorkoutDot({ colors, size = 8 }: { colors: string[]; size?: number }) {
  const palette = Array.isArray(colors) ? colors.filter(Boolean) : [];
  const visible = palette.length > 0 ? palette.slice(0, 4) : ["#6B7280"];
  const baseStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: visible[0],
    marginRight: 6,
    overflow: "hidden" as const,
  } as const;

  if (visible.length <= 1) {
    return <View style={baseStyle} />;
  }

  if (visible.length === 2) {
    return (
      <View style={baseStyle}>
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ flex: 1, backgroundColor: visible[0] }} />
          <View style={{ flex: 1, backgroundColor: visible[1] }} />
        </View>
      </View>
    );
  }

  if (visible.length === 4) {
    return (
      <View style={baseStyle}>
        <View style={{ flex: 1 }}>
          <View style={{ flex: 1, flexDirection: "row" }}>
            <View style={{ flex: 1, backgroundColor: visible[0] }} />
            <View style={{ flex: 1, backgroundColor: visible[1] }} />
          </View>
          <View style={{ flex: 1, flexDirection: "row" }}>
            <View style={{ flex: 1, backgroundColor: visible[2] }} />
            <View style={{ flex: 1, backgroundColor: visible[3] }} />
          </View>
        </View>
      </View>
    );
  }

  if (Platform.OS === "web" && visible.length === 3) {
    return <View style={{ ...(baseStyle as any), backgroundImage: buildConicGradient(visible) }} />;
  }

  return <View style={{ ...baseStyle, backgroundColor: visible[0] }} />;
}

function getWeekLabelToneColors(tone: ReturnType<typeof getWeekLabelTone>) {
  if (tone === "competition") {
    return { border: "rgba(220,38,38,0.34)", bg: "rgba(220,38,38,0.1)", text: "#991b1b" };
  }
  if (tone === "break") {
    return { border: "rgba(14,116,144,0.34)", bg: "rgba(14,116,144,0.1)", text: "#0e7490" };
  }
  if (tone === "camp") {
    return { border: "rgba(22,163,74,0.34)", bg: "rgba(22,163,74,0.1)", text: "#166534" };
  }
  return { border: "rgba(15,23,42,0.2)", bg: "rgba(15,23,42,0.06)", text: "#334155" };
}

function classifyMonthWorkoutPriority(args: { title: string; categories: string[] }): 0 | 1 | 2 {
  const title = String(args.title ?? "").trim().toLowerCase();
  const categoryText = (Array.isArray(args.categories) ? args.categories : [])
    .map((v) => String(v ?? "").trim().toLowerCase())
    .join(" ");
  const combined = `${title} ${categoryText}`.trim();
  const hasRace = combined.includes("race");
  const hasRecoveryOrOff = combined.includes("recovery") || combined.includes(" off") || combined.startsWith("off");
  if (hasRace) return 0;
  if (hasRecoveryOrOff) return 2;
  return 1;
}

function normalizeDetailsText(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function hasValidWorkoutTime(value: string | undefined): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  return !!normalizeWorkoutTimeInput(raw);
}

function isOffCategoryName(value: string): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "off" || normalized === "off / rest" || normalized === "rest";
}

function hasOffCategory(categories: string[]): boolean {
  return (Array.isArray(categories) ? categories : []).some((value) => isOffCategoryName(value));
}

function compareWorkoutTimes(a: string | undefined, b: string | undefined): number {
  const aTime = normalizeWorkoutTimeInput(String(a ?? "").trim()) ?? "";
  const bTime = normalizeWorkoutTimeInput(String(b ?? "").trim()) ?? "";
  return aTime.localeCompare(bTime);
}

function compareWeeklyWorkoutSections(a: WeeklyWorkoutSection, b: WeeklyWorkoutSection): number {
  const aOff = hasOffCategory(a.categories);
  const bOff = hasOffCategory(b.categories);
  if (aOff !== bOff) return aOff ? 1 : -1;

  const sessionRank = (session: string) => (normalizeSession(session) === "AM" ? 0 : 1);
  const sessionOrder = sessionRank(a.session) - sessionRank(b.session);
  if (sessionOrder !== 0) return sessionOrder;

  const aTimed = hasValidWorkoutTime(a.time);
  const bTimed = hasValidWorkoutTime(b.time);
  if (aTimed !== bTimed) return aTimed ? -1 : 1;
  if (aTimed && bTimed) {
    const byTime = compareWorkoutTimes(a.time, b.time);
    if (byTime !== 0) return byTime;
  }

  return a.title.localeCompare(b.title);
}

function sortWeeklyDayWorkoutsForDisplay(workouts: WeeklyWorkoutSection[]): WeeklyWorkoutSection[] {
  return [...workouts].sort(compareWeeklyWorkoutSections);
}

function getWeekWorkoutVisibilityStatus(workouts: CoachCalendarWorkout[]): WeekWorkoutVisibilityStatus {
  if (workouts.length === 0) return "empty";
  const visibleCount = workouts.filter((workout) => workout.athleteVisible !== false).length;
  if (visibleCount === 0) return "hidden";
  if (visibleCount === workouts.length) return "published";
  return "mixed";
}

function athleteLastNamePreview(workout: WeeklyWorkoutSection): string {
  const lastNames = new Set<string>();
  workout.groups.forEach((group) => {
    group.lines.forEach((line) => {
      line.athleteNames.forEach((name) => {
        const trimmed = String(name ?? "").trim();
        if (!trimmed) return;
        if (trimmed.includes(",")) {
          lastNames.add(trimmed.split(",")[0].trim());
          return;
        }
        const parts = trimmed.split(/\s+/).filter(Boolean);
        if (parts.length > 0) lastNames.add(parts[parts.length - 1]);
      });
    });
  });
  const list = Array.from(lastNames).sort((a, b) => a.localeCompare(b));
  if (list.length === 0) return "No athletes";
  return list.join(", ");
}

function getWorkoutLocation(w: CoachCalendarWorkout): string {
  return String(w.calendarLocation ?? "").trim();
}

function getAthleteFallbackName(w: CoachCalendarWorkout): string {
  const candidate = String(w.athleteName ?? w.athleteDisplayName ?? "").trim();
  if (!candidate) return "";
  const normalized = candidate.toLowerCase();
  if (normalized === "athlete" || normalized === "unknown athlete") return "";
  return candidate;
}

function normalizeWorkoutTimeLabel(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return normalizeWorkoutTimeInput(raw) ?? raw;
}

function compareGroupIdForMasterRow(a: string, b: string): number {
  const aNorm = String(a ?? "").trim();
  const bNorm = String(b ?? "").trim();
  const aUngrouped = !aNorm;
  const bUngrouped = !bNorm;
  if (aUngrouped && !bUngrouped) return -1;
  if (!aUngrouped && bUngrouped) return 1;
  const aNum = Number(aNorm);
  const bNum = Number(bNorm);
  const aIsNum = Number.isFinite(aNum) && /^\d+$/.test(aNorm);
  const bIsNum = Number.isFinite(bNum) && /^\d+$/.test(bNorm);
  if (aIsNum && bIsNum && aNum !== bNum) return aNum - bNum;
  if (aIsNum && !bIsNum) return -1;
  if (!aIsNum && bIsNum) return 1;
  return aNorm.localeCompare(bNorm, undefined, { numeric: true });
}

function pickMasterWorkoutRow(rows: CoachCalendarWorkout[]): CoachCalendarWorkout {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("pickMasterWorkoutRow requires at least one workout row.");
  }
  return [...rows].sort((a, b) => {
    const groupOrder = compareGroupIdForMasterRow(
      String(a.groupId ?? "").trim(),
      String(b.groupId ?? "").trim()
    );
    if (groupOrder !== 0) return groupOrder;

    const aCreated = Number(a.createdAt ?? Number.POSITIVE_INFINITY);
    const bCreated = Number(b.createdAt ?? Number.POSITIVE_INFINITY);
    if (aCreated !== bCreated) return aCreated - bCreated;

    return String(a.id ?? "").localeCompare(String(b.id ?? ""), undefined, { numeric: true });
  })[0];
}

function parseDisplayName(fullName: string): ParsedDisplayName {
  const full = String(fullName ?? "").trim().replace(/\s+/g, " ");
  if (!full) {
    return { full: "Unknown athlete", last: "", first: "", firstInitial: "", secondInitial: "" };
  }
  const parts = full.split(" ").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const givenParts = parts.slice(0, -1);
  const first = givenParts[0] ?? "";
  const second = givenParts[1] ?? "";
  return {
    full,
    last,
    first,
    firstInitial: first ? first.charAt(0).toUpperCase() : "",
    secondInitial: second ? second.charAt(0).toUpperCase() : "",
  };
}

function buildCompactWeeklyAthleteLabels(records: Array<{ athleteId: string; resolvedName: string }>): Map<string, string> {
  const parsedById = new Map<string, ParsedDisplayName>();
  for (const record of records) {
    if (!record.athleteId) continue;
    if (!parsedById.has(record.athleteId)) {
      parsedById.set(record.athleteId, parseDisplayName(record.resolvedName));
    }
  }

  const byLast = new Map<string, string[]>();
  for (const [athleteId, parsed] of parsedById.entries()) {
    const lastKey = parsed.last.toLowerCase();
    const list = byLast.get(lastKey) ?? [];
    list.push(athleteId);
    byLast.set(lastKey, list);
  }

  const out = new Map<string, string>();
  for (const athleteIds of byLast.values()) {
    if (athleteIds.length === 1) {
      const athleteId = athleteIds[0];
      const parsed = parsedById.get(athleteId);
      if (!parsed) continue;
      out.set(athleteId, parsed.last || parsed.full || "Unknown athlete");
      continue;
    }

    const labelWithFirstInitial = new Map<string, string>();
    athleteIds.forEach((athleteId) => {
      const parsed = parsedById.get(athleteId);
      if (!parsed) return;
      const label = parsed.last
        ? `${parsed.last}, ${parsed.firstInitial || "?"}.`
        : parsed.full;
      labelWithFirstInitial.set(athleteId, label);
    });

    const initialCounts = new Map<string, number>();
    for (const label of labelWithFirstInitial.values()) {
      initialCounts.set(label, (initialCounts.get(label) ?? 0) + 1);
    }

    const labelWithSecondInitial = new Map<string, string>();
    athleteIds.forEach((athleteId) => {
      const parsed = parsedById.get(athleteId);
      const base = labelWithFirstInitial.get(athleteId) ?? "Unknown athlete";
      if (!parsed) {
        labelWithSecondInitial.set(athleteId, base);
        return;
      }
      if ((initialCounts.get(base) ?? 0) <= 1) {
        labelWithSecondInitial.set(athleteId, base);
        return;
      }
      if (parsed.secondInitial) {
        labelWithSecondInitial.set(athleteId, `${parsed.last}, ${parsed.firstInitial}.${parsed.secondInitial}.`);
        return;
      }
      labelWithSecondInitial.set(athleteId, parsed.last ? `${parsed.last}, ${parsed.first}` : parsed.full);
    });

    const secondCounts = new Map<string, number>();
    for (const label of labelWithSecondInitial.values()) {
      secondCounts.set(label, (secondCounts.get(label) ?? 0) + 1);
    }

    athleteIds.forEach((athleteId) => {
      const parsed = parsedById.get(athleteId);
      const candidate = labelWithSecondInitial.get(athleteId) ?? "Unknown athlete";
      if ((secondCounts.get(candidate) ?? 0) > 1) {
        out.set(athleteId, parsed?.full || candidate || "Unknown athlete");
      } else {
        out.set(athleteId, candidate);
      }
    });
  }

  return out;
}

function toLegacyWorkout(row: TeamWorkoutRow): CoachCalendarWorkout {
  const rowWithDisplay = row as TeamWorkoutRow & {
    athlete_display_name?: string | null;
    display_name?: string | null;
    athlete_name?: string | null;
  };
  return {
    id: row.id,
    athleteId: row.athlete_profile_id,
    athleteName:
      String(
        rowWithDisplay.athlete_display_name ??
          rowWithDisplay.display_name ??
          rowWithDisplay.athlete_name ??
          ""
      ).trim() || "Athlete",
    dateISO: row.date_iso,
    session: row.session,
    time: row.time_text ?? undefined,
    title: row.title ?? "Workout",
    details: row.details ?? undefined,
    calendarLocation: row.location ?? undefined,
    athleteDisplayName:
      rowWithDisplay.athlete_display_name ??
      rowWithDisplay.display_name ??
      rowWithDisplay.athlete_name ??
      undefined,
    category: row.primary_category ?? "Other",
    categories: row.categories ?? undefined,
    batchId: row.batch_id ?? undefined,
    groupId: row.group_id ?? undefined,
    preRoutineIds: row.pre_routine_ids ?? undefined,
    postRoutineIds: row.post_routine_ids ?? undefined,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined,
    athleteVisible: row.athlete_visible !== false,
  };
}

export default function CoachCalendarMonth() {
  const teamStore = teamDataStore.use();
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const { saved, view } = useLocalSearchParams<{ saved?: string | string[]; view?: string | string[] }>();

  const [calendarMode, setCalendarMode] = useState<"month" | "week">("month");
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [allWorkouts, setAllWorkouts] = useState<CoachCalendarWorkout[]>([]);
  const [selectedAthleteIds, setSelectedAthleteIds] = useState<string[]>([]);
  const [athleteFilterOptions, setAthleteFilterOptions] = useState<AthleteFilterOption[]>([]);
  const [athleteFilterOpen, setAthleteFilterOpen] = useState(false);
  const [trainingGroupFilterOpen, setTrainingGroupFilterOpen] = useState(false);
  const [seasonFilterOpen, setSeasonFilterOpen] = useState(false);
  const [categories, setCategories] = useState<WorkoutCategory[]>(() => getCachedCoachCategories());
  const [auxiliaryRoutines, setAuxiliaryRoutines] = useState<AuxiliaryRoutine[]>([]);
  const [rosterNameById, setRosterNameById] = useState<Map<string, string>>(new Map());
  const [anchorMonth, setAnchorMonth] = useState(() => monthStart(new Date()));
  const [anchorWeekStart, setAnchorWeekStart] = useState(() => startOfWeek(new Date(), 1));
  const [showSavedBanner, setShowSavedBanner] = useState(false);
  const [expandedWeeklyWorkouts, setExpandedWeeklyWorkouts] = useState<Record<string, boolean>>({});
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingTrainingPlanPdf, setExportingTrainingPlanPdf] = useState(false);
  const [trainingPlanExportOpen, setTrainingPlanExportOpen] = useState(false);
  const [trainingPlanExportError, setTrainingPlanExportError] = useState<string | null>(null);
  const [trainingPlanExportSeasonId, setTrainingPlanExportSeasonId] = useState<string | null>(null);
  const [exportStartDateISO, setExportStartDateISO] = useState(() => toISODate(startOfWeek(new Date(), 1)));
  const [exportEndDateISO, setExportEndDateISO] = useState(() => toISODate(addDays(startOfWeek(new Date(), 1), 27)));
  const [copyingWeek, setCopyingWeek] = useState(false);
  const [copyWeekModalOpen, setCopyWeekModalOpen] = useState(false);
  const [copySourceDateInput, setCopySourceDateInput] = useState(() => toISODate(addDays(startOfWeek(new Date(), 1), -7)));
  const [copyWeekError, setCopyWeekError] = useState<string | null>(null);
  const [clearingWeek, setClearingWeek] = useState(false);
  const [weekVisibilityBusy, setWeekVisibilityBusy] = useState(false);
  const [trainingVisibilityOpen, setTrainingVisibilityOpen] = useState(false);
  const [trainingVisibilityAction, setTrainingVisibilityAction] = useState<TrainingVisibilityAction>("publish");
  const [trainingVisibilityContent, setTrainingVisibilityContent] = useState<TrainingVisibilityContent>("workouts");
  const [trainingVisibilityRange, setTrainingVisibilityRange] = useState<TrainingVisibilityRange>("week");
  const [trainingVisibilityStartISO, setTrainingVisibilityStartISO] = useState(() => toISODate(startOfWeek(new Date(), 1)));
  const [trainingVisibilityEndISO, setTrainingVisibilityEndISO] = useState(() => toISODate(addDays(startOfWeek(new Date(), 1), 6)));
  const [trainingVisibilityApplying, setTrainingVisibilityApplying] = useState(false);
  const [trainingVisibilityError, setTrainingVisibilityError] = useState<string | null>(null);
  const [jumpToWeekOpen, setJumpToWeekOpen] = useState(false);
  const [jumpDateInput, setJumpDateInput] = useState(() => toISODate(new Date()));
  const [weekLabelsByStart, setWeekLabelsByStart] = useState<Record<string, string>>({});
  const [weekLabelDraft, setWeekLabelDraft] = useState("");
  const [isWeekLabelEditing, setIsWeekLabelEditing] = useState(false);
  const [weekLabelSaveState, setWeekLabelSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [weeklyBatchHeaderNotesByKey, setWeeklyBatchHeaderNotesByKey] = useState<Record<string, string>>({});
  const [weeklyBatchHeaderNotesByBaseKey, setWeeklyBatchHeaderNotesByBaseKey] = useState<Record<string, string>>({});
  const [weeklyBatchDrafts, setWeeklyBatchDrafts] = useState<Record<string, WeeklyBatchDraft>>({});
  const [weeklyBatchSaveState, setWeeklyBatchSaveState] = useState<Record<string, WeeklySaveState>>({});
  const [weeklyBatchDirtyFields, setWeeklyBatchDirtyFields] = useState<
    Record<string, Partial<Record<WeeklyBatchEditableField, boolean>>>
  >({});
  const [currentTeamRole, setCurrentTeamRole] = useState<TeamRole | null>(null);

  const weeklyBatchDraftsRef = useRef<Record<string, WeeklyBatchDraft>>({});
  const weeklyBatchDirtyFieldsRef = useRef<Record<string, Partial<Record<WeeklyBatchEditableField, boolean>>>>({});
  const weeklyBatchSaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const weekLabelSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const weekLabelEditingWeekRef = useRef<string | null>(null);
  const weekLabelSaveSeqRef = useRef(0);
  const restoredCalendarPrefsRef = useRef(false);
  const [calendarPrefsReady, setCalendarPrefsReady] = useState(false);
  const [athleteFilterPrefsReady, setAthleteFilterPrefsReady] = useState(false);
  const lastCalendarFetchKeyRef = useRef<string | null>(null);
  const lastCalendarFetchAtRef = useRef(0);
  const inFlightCalendarFetchRef = useRef<Promise<void> | null>(null);
  const inFlightCalendarFetchKeyRef = useRef<string | null>(null);

  const isWebDesktop = Platform.OS === "web";
  const canEditCalendarTraining = canEditTraining(currentTeamRole);
  const canPublishCalendarTraining = canPublishTraining(currentTeamRole);
  const canExportCalendar = canExport(currentTeamRole);
  const todayISO = useMemo(() => toISODate(new Date()), []);
  const selectedTrainingGroupIds = teamStore.sharedSelectedTrainingGroupIds;
  const selectedSeasonId = teamStore.sharedSelectedSeasonId;

  useEffect(() => {
    let active = true;
    getCurrentTeamRole()
      .then((role) => {
        if (active) setCurrentTeamRole(role);
      })
      .catch((error) => {
        console.warn("[coach-calendar] role load failed", error);
        if (active) setCurrentTeamRole(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const prefs = await loadJSON<{
          mode?: "month" | "week";
          monthISO?: string;
          weekStartISO?: string;
        }>(COACH_CALENDAR_VIEW_PREFS_KEY, {});
        if (!active) return;
        const requestedView = Array.isArray(view) ? view[0] : view;
        const forceMonthlyView = requestedView === "monthly" || requestedView === "month";
        const mode = forceMonthlyView ? "month" : prefs?.mode === "week" ? "week" : prefs?.mode === "month" ? "month" : null;
        if (mode) setCalendarMode(mode);
        if (typeof prefs?.monthISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(prefs.monthISO)) {
          setAnchorMonth(monthStart(new Date(`${prefs.monthISO}T00:00:00`)));
        }
        if (typeof prefs?.weekStartISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(prefs.weekStartISO)) {
          setAnchorWeekStart(new Date(`${prefs.weekStartISO}T00:00:00`));
        }
      } finally {
        if (!active) return;
        restoredCalendarPrefsRef.current = true;
        setCalendarPrefsReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [view]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(COACH_CALENDAR_ATHLETE_FILTER_KEY);
        if (!active) return;
        const parsed = raw ? JSON.parse(raw) : [];
        const next = Array.isArray(parsed)
          ? parsed.map((value) => String(value ?? "").trim()).filter(Boolean)
          : [];
        setSelectedAthleteIds(next);
      } finally {
        if (!active) return;
        setAthleteFilterPrefsReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!restoredCalendarPrefsRef.current) return;
    void saveJSON(COACH_CALENDAR_VIEW_PREFS_KEY, {
      mode: calendarMode,
      monthISO: toISODate(anchorMonth),
      weekStartISO: toISODate(anchorWeekStart),
    });
  }, [anchorMonth, anchorWeekStart, calendarMode]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(COACH_CALENDAR_WORKOUTS_CACHE_KEY);
        if (!active || !raw) return;
        const parsed = JSON.parse(raw) as { workouts?: CoachCalendarWorkout[] };
        const cached = Array.isArray(parsed?.workouts) ? parsed.workouts : [];
        if (cached.length > 0) {
          setAllWorkouts((prev) => (prev.length > 0 ? prev : cached));
        }
      } catch {}
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const categoryDefs = await loadCoachCategoriesFromTeamKV();
        if (!active) return;
        setCategories(getCategoryOptions({ categories: categoryDefs }));
      } catch {}
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadCalendarWeekStartSetting = useCallback(async () => {
    const weekStartResult = await loadWeekStartSetting();
    const normalized: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
    debugCalendar("[coach-calendar] week start loaded via shared helper", {
      raw: weekStartResult.raw,
      normalized,
    });
    setWeekStartsOn(normalized);
    return normalized;
  }, []);

  const loadCalendarData = useCallback(async (opts?: { force?: boolean }) => {
    const force = !!opts?.force;
    const normalizedWeekStartsOn = await loadCalendarWeekStartSetting();
    const visibleMonthCells = buildMonthGrid(anchorMonth, normalizedWeekStartsOn);
    const monthStartISO = visibleMonthCells[0]?.dateISO ?? toISODate(monthStart(anchorMonth));
    const monthEndISO = visibleMonthCells[visibleMonthCells.length - 1]?.dateISO ?? monthStartISO;
    const visibleWeekStartISO = toISODate(anchorWeekStart);
    const visibleWeekEndISO = toISODate(addDays(anchorWeekStart, 6));
    const fetchStartISO = monthStartISO < visibleWeekStartISO ? monthStartISO : visibleWeekStartISO;
    const fetchEndISO = monthEndISO > visibleWeekEndISO ? monthEndISO : visibleWeekEndISO;
    const fetchKey = `${fetchStartISO}:${fetchEndISO}:${normalizedWeekStartsOn}`;
    const now = Date.now();

    if (!force && lastCalendarFetchKeyRef.current === fetchKey && now - lastCalendarFetchAtRef.current < 20_000) {
      return;
    }
    if (
      !force &&
      inFlightCalendarFetchRef.current &&
      inFlightCalendarFetchKeyRef.current === fetchKey
    ) {
      await inFlightCalendarFetchRef.current;
      return;
    }

    const run = async () => {
      const workoutsPromise = listTeamWorkoutsInRange(fetchStartISO, fetchEndISO);
      const metadataPromise = Promise.all([
        loadCoachCategoriesFromTeamKV(),
        getRosterMapById().catch(() => new Map<string, string>()),
        loadTeamRoster().catch(() => []),
        loadAuxiliaryRoutines().catch(() => []),
        loadCoachWeekLabels().catch(() => ({})),
      ]);

      // Hydrate metadata as soon as it resolves so category colors are ready
      // for first visible workout render (especially when workouts come from cache).
      const metadataHydrationPromise = metadataPromise.then(
        ([categoryDefs, rosterMap, rosterRows, savedAuxiliaryRoutines, weekLabels]) => {
          setCategories(getCategoryOptions({ categories: categoryDefs }));
          setAuxiliaryRoutines(Array.isArray(savedAuxiliaryRoutines) ? savedAuxiliaryRoutines : []);
          setRosterNameById(rosterMap);
          setWeekLabelsByStart(weekLabels ?? {});
        }
      );

      const workoutRows = await workoutsPromise;
      debugCalendar("[coach-calendar] workouts fetch", {
        start: fetchStartISO,
        end: fetchEndISO,
        count: workoutRows?.length ?? 0,
      });
      const nextWorkouts = (workoutRows ?? []).map(toLegacyWorkout);
      setAllWorkouts(nextWorkouts);
      void AsyncStorage.setItem(
        COACH_CALENDAR_WORKOUTS_CACHE_KEY,
        JSON.stringify({ workouts: nextWorkouts, updatedAt: Date.now() })
      ).catch(() => {});

      const [, rosterMapForOptions, rosterRowsForOptions] = await metadataPromise;
      const activeOptions = (Array.isArray(rosterRowsForOptions) ? rosterRowsForOptions : [])
        .filter((athlete) => athlete.isActive !== false)
        .map((athlete) => ({
          id: String(athlete.id ?? "").trim(),
          label: String(athlete.displayName ?? "").trim() || "Athlete",
        }))
        .filter((athlete) => !!athlete.id);
      const byId = new Map<string, string>();
      activeOptions.forEach((option) => byId.set(option.id, option.label));
      (nextWorkouts ?? []).forEach((workout) => {
        const athleteId = String(workout.athleteId ?? "").trim();
        if (!athleteId || byId.has(athleteId)) return;
        const label = resolveAthleteDisplayName(
          athleteId,
          rosterMapForOptions,
          String(workout.athleteName ?? "").trim()
        );
        byId.set(athleteId, String(label ?? "").trim() || "Athlete");
      });
      const nextOptions = Array.from(byId.entries())
        .map(([id, label]) => ({ id, label: String(label ?? "").trim() || "Athlete" }))
        .sort((a, b) => compareAthleteDisplayNamesByLastName(a.label, b.label));
      setAthleteFilterOptions(nextOptions);

      await metadataHydrationPromise;
      lastCalendarFetchKeyRef.current = fetchKey;
      lastCalendarFetchAtRef.current = Date.now();
    };

    const pending = run().catch((error) => {
      console.warn("[coach-calendar] loadCalendarData failed", error);
    });
    inFlightCalendarFetchRef.current = pending;
    inFlightCalendarFetchKeyRef.current = fetchKey;
    await pending;
    if (inFlightCalendarFetchRef.current === pending) {
      inFlightCalendarFetchRef.current = null;
      inFlightCalendarFetchKeyRef.current = null;
    }
  }, [anchorMonth, anchorWeekStart, loadCalendarWeekStartSetting]);

  useFocusEffect(
    useCallback(() => {
      if (!calendarPrefsReady) return;
      void loadCalendarData();
    }, [calendarPrefsReady, loadCalendarData])
  );

  useFocusEffect(
    useCallback(() => {
      if (!calendarPrefsReady) return;
      void teamDataStore.actions.loadSharedCoachFilters();
      void teamDataStore.actions.loadTrainingGroups();
      void teamDataStore.actions.loadTeamSeasons();
      void teamDataStore.actions.loadAthleteSeasonOverrides();
    }, [calendarPrefsReady])
  );

  useEffect(() => {
    const raw = Array.isArray(saved) ? saved[0] : saved;
    if (String(raw ?? "") !== "1") return;
    setShowSavedBanner(true);
    const timer = setTimeout(() => setShowSavedBanner(false), 2200);
    return () => clearTimeout(timer);
  }, [saved]);

  const monthCells = useMemo(() => buildMonthGrid(anchorMonth, weekStartsOn), [anchorMonth, weekStartsOn]);

  useEffect(() => {
    if (!athleteFilterPrefsReady) return;
    const validIds = new Set(athleteFilterOptions.map((option) => option.id));
    const next = selectedAthleteIds.filter((id) => validIds.has(id));
    if (next.length !== selectedAthleteIds.length) {
      setSelectedAthleteIds(next);
    }
  }, [athleteFilterOptions, athleteFilterPrefsReady, selectedAthleteIds]);

  useEffect(() => {
    if (!athleteFilterPrefsReady) return;
    void AsyncStorage.setItem(COACH_CALENDAR_ATHLETE_FILTER_KEY, JSON.stringify(selectedAthleteIds)).catch(() => {});
  }, [athleteFilterPrefsReady, selectedAthleteIds]);

  const trainingGroupFilterOptions = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; archived: boolean }>();
    (Array.isArray(teamStore.trainingGroups) ? teamStore.trainingGroups : []).forEach((group) => {
      const id = String(group?.id ?? "").trim();
      if (!id) return;
      const label = String(group?.name ?? "").trim() || "Training Group";
      const archived = !!group?.archived_at;
      if (!archived) {
        byId.set(id, { id, label, archived });
      }
    });
    selectedTrainingGroupIds.forEach((idRaw) => {
      const id = String(idRaw ?? "").trim();
      if (!id || byId.has(id)) return;
      const match = (teamStore.trainingGroups ?? []).find((group) => String(group?.id ?? "").trim() === id);
      const label = String(match?.name ?? "").trim() || `Group (${id.slice(-6)})`;
      byId.set(id, { id, label, archived: !!match?.archived_at });
    });
    return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [selectedTrainingGroupIds, teamStore.trainingGroups]);

  useEffect(() => {
    if (!teamStore.sharedCoachFiltersLoaded) return;
    if (!teamStore.trainingGroupsLoaded) return;
    const validIds = new Set(trainingGroupFilterOptions.map((option) => option.id));
    const next = selectedTrainingGroupIds.filter((id) => validIds.has(id));
    if (next.length !== selectedTrainingGroupIds.length) {
      void teamDataStore.actions.setSharedSelectedTrainingGroupIds(next);
    }
  }, [
    selectedTrainingGroupIds,
    teamStore.sharedCoachFiltersLoaded,
    teamStore.trainingGroupsLoaded,
    trainingGroupFilterOptions,
  ]);

  const seasonFilterOptions = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; archived: boolean }>();
    (Array.isArray(teamStore.teamSeasons) ? teamStore.teamSeasons : []).forEach((season) => {
      const id = String(season?.id ?? "").trim();
      if (!id) return;
      const label = String(season?.name ?? "").trim() || "Season";
      const archived = !!season?.archived_at;
      if (!archived) byId.set(id, { id, label, archived });
    });
    const selectedId = String(selectedSeasonId ?? "").trim();
    if (selectedId && !byId.has(selectedId)) {
      const match = (teamStore.teamSeasons ?? []).find((season) => String(season?.id ?? "").trim() === selectedId);
      const label = String(match?.name ?? "").trim() || `Season (${selectedId.slice(-6)})`;
      byId.set(selectedId, { id: selectedId, label, archived: !!match?.archived_at });
    }
    const order = new Map<string, number>();
    (Array.isArray(teamStore.teamSeasons) ? teamStore.teamSeasons : []).forEach((season, idx) => {
      const id = String(season?.id ?? "").trim();
      if (id) order.set(id, idx);
    });
    return Array.from(byId.values()).sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [selectedSeasonId, teamStore.teamSeasons]);

  useEffect(() => {
    if (!teamStore.sharedCoachFiltersLoaded) return;
    if (!teamStore.teamSeasonsLoaded) return;
    const selectedId = String(selectedSeasonId ?? "").trim();
    if (!selectedId) return;
    const validIds = new Set(seasonFilterOptions.map((option) => option.id));
    if (!validIds.has(selectedId)) void teamDataStore.actions.setSharedSelectedSeasonId(null);
  }, [seasonFilterOptions, selectedSeasonId, teamStore.sharedCoachFiltersLoaded, teamStore.teamSeasonsLoaded]);

  const trainingGroupAthleteIdsByGroupId = useMemo(() => {
    const map = new Map<string, Set<string>>();
    (Array.isArray(teamStore.trainingGroupMemberships) ? teamStore.trainingGroupMemberships : []).forEach((row) => {
      if (!isActiveTrainingGroupMembership(row)) return;
      const groupId = String(row?.group_id ?? "").trim();
      const athleteId = String(row?.athlete_profile_id ?? "").trim();
      if (!groupId || !athleteId) return;
      const prev = map.get(groupId) ?? new Set<string>();
      prev.add(athleteId);
      map.set(groupId, prev);
    });
    return map;
  }, [teamStore.trainingGroupMemberships]);

  const selectedTrainingGroupAthleteIds = useMemo(() => {
    const out = new Set<string>();
    selectedTrainingGroupIds.forEach((groupId) => {
      const ids = trainingGroupAthleteIdsByGroupId.get(String(groupId ?? "").trim());
      if (!ids) return;
      ids.forEach((id) => out.add(id));
    });
    return out;
  }, [selectedTrainingGroupIds, trainingGroupAthleteIdsByGroupId]);

  const athleteSeasonOverridesBySeasonAndAthlete = useMemo(() => {
    const map = new Map<string, (typeof teamStore.athleteSeasonOverrides)[number]>();
    (Array.isArray(teamStore.athleteSeasonOverrides) ? teamStore.athleteSeasonOverrides : []).forEach((override) => {
      const seasonId = String(override?.season_id ?? "").trim();
      const athleteId = String(override?.athlete_profile_id ?? "").trim();
      if (!seasonId || !athleteId) return;
      map.set(`${seasonId}:${athleteId}`, override);
    });
    return map;
  }, [teamStore.athleteSeasonOverrides]);

  const selectedSeason = useMemo(
    () =>
      selectedSeasonId
        ? (teamStore.teamSeasons ?? []).find((season) => String(season?.id ?? "").trim() === String(selectedSeasonId ?? "").trim()) ?? null
        : null,
    [selectedSeasonId, teamStore.teamSeasons]
  );

  const filteredWorkouts = useMemo(() => {
    const athleteSelectedSet = new Set(selectedAthleteIds);
    return allWorkouts.filter((workout) => {
      const athleteId = String(workout.athleteId ?? "").trim();
      const athletePass =
        selectedAthleteIds.length === 0 ? true : athleteSelectedSet.has(athleteId);
      const groupPass =
        selectedTrainingGroupIds.length === 0 ? true : selectedTrainingGroupAthleteIds.has(athleteId);
      const workoutDateISO = getWorkoutDateISO(workout);
      const seasonPass = (() => {
        if (!selectedSeason) return true;
        const override = athleteId
          ? athleteSeasonOverridesBySeasonAndAthlete.get(`${String(selectedSeason.id ?? "").trim()}:${athleteId}`) ?? null
          : null;
        const resolvedWindow = teamDataStore.resolveAthleteSeasonWindow(selectedSeason, override);
        return (
          workoutDateISO >= String(resolvedWindow.start_date ?? "") &&
          workoutDateISO <= String(resolvedWindow.end_date ?? "")
        );
      })();
      return athletePass && groupPass && seasonPass;
    });
  }, [
    athleteSeasonOverridesBySeasonAndAthlete,
    allWorkouts,
    selectedAthleteIds,
    selectedSeason,
    selectedTrainingGroupAthleteIds,
    selectedTrainingGroupIds.length,
  ]);

  const selectedAthleteLabel = useMemo(() => {
    if (selectedAthleteIds.length === 0) return "Athletes: All";
    if (selectedAthleteIds.length === 1) {
      const match = athleteFilterOptions.find((option) => option.id === selectedAthleteIds[0]);
      return match?.label ? `Athlete: ${match.label}` : "Athletes: 1 selected";
    }
    return `Athletes: ${selectedAthleteIds.length} selected`;
  }, [athleteFilterOptions, selectedAthleteIds]);

  const selectedTrainingGroupLabel = useMemo(() => {
    if (selectedTrainingGroupIds.length === 0) return "Groups: All";
    if (selectedTrainingGroupIds.length === 1) {
      const match = trainingGroupFilterOptions.find((option) => option.id === selectedTrainingGroupIds[0]);
      return match?.label ? `Group: ${match.label}` : "Groups: 1 selected";
    }
    return `Groups: ${selectedTrainingGroupIds.length} selected`;
  }, [selectedTrainingGroupIds, trainingGroupFilterOptions]);

  const selectedSeasonLabel = useMemo(() => {
    if (!selectedSeasonId) return "Season: All";
    const match = seasonFilterOptions.find((option) => option.id === selectedSeasonId);
    return match?.label ? `Season: ${match.label}` : "Season: Selected";
  }, [seasonFilterOptions, selectedSeasonId]);

  const monthRows = useMemo(() => {
    const rows: MonthCell[][] = [];
    for (let i = 0; i < monthCells.length; i += 7) rows.push(monthCells.slice(i, i + 7));
    return rows;
  }, [monthCells]);

  const weekDates = useMemo(() => {
    return Array.from({ length: 7 }, (_, idx) => addDays(anchorWeekStart, idx));
  }, [anchorWeekStart]);
  const weekDateISOs = useMemo(() => weekDates.map((d) => toISODate(d)), [weekDates]);
  const currentWeekStartISO = weekDateISOs[0] ?? toISODate(anchorWeekStart);
  const currentWeekEndISO = weekDateISOs[6] ?? currentWeekStartISO;
  const displayedWeekWorkouts = useMemo(
    () => filteredWorkouts.filter((workout) => {
      const dateISO = getWorkoutDateISO(workout);
      return dateISO >= currentWeekStartISO && dateISO <= currentWeekEndISO;
    }),
    [currentWeekEndISO, currentWeekStartISO, filteredWorkouts]
  );
  const calendarWeekVisibilityStatus = useMemo(
    () => getWeekWorkoutVisibilityStatus(displayedWeekWorkouts),
    [displayedWeekWorkouts]
  );
  const calendarWeekVisibilityLabel = useMemo(() => {
    switch (calendarWeekVisibilityStatus) {
      case "empty":
        return "No workouts";
      case "hidden":
        return "Hidden from athletes";
      case "mixed":
        return "Mixed visibility";
      case "published":
      default:
        return "Published";
    }
  }, [calendarWeekVisibilityStatus]);
  const setCalendarWeekVisibility = useCallback(async (visible: boolean) => {
    setWeekVisibilityBusy(true);
    try {
      const athleteIds = Array.from(new Set(displayedWeekWorkouts.map((workout) => String(workout.athleteId ?? "").trim()).filter(Boolean)));
      await setWorkoutVisibilityByDateRange({
        startISO: currentWeekStartISO,
        endISO: currentWeekEndISO,
        athleteIds,
        visible,
      });
      await loadCalendarData({ force: true });
    } catch (error: any) {
      Alert.alert("Visibility update failed", String(error?.message ?? error ?? "Could not update workout visibility."));
    } finally {
      setWeekVisibilityBusy(false);
    }
  }, [currentWeekEndISO, currentWeekStartISO, displayedWeekWorkouts, loadCalendarData]);

  const calendarBulkAthleteIds = useMemo(() => {
    const activeRoster = (teamStore.roster ?? []).filter((athlete) => {
      const status = String(athlete?.roster_status ?? "active").trim().toLowerCase();
      return !status || status === "active";
    });
    const selectedSet = new Set(selectedAthleteIds.map((id) => String(id ?? "").trim()).filter(Boolean));
    return activeRoster
      .filter((athlete) => {
        const athleteId = String(athlete?.id ?? "").trim();
        if (!athleteId) return false;
        if (selectedSet.size > 0 && !selectedSet.has(athleteId)) return false;
        if (selectedTrainingGroupIds.length > 0 && !selectedTrainingGroupAthleteIds.has(athleteId)) return false;
        return true;
      })
      .map((athlete) => String(athlete.id ?? "").trim())
      .filter(Boolean);
  }, [selectedAthleteIds, selectedTrainingGroupAthleteIds, selectedTrainingGroupIds.length, teamStore.roster]);

  const openTrainingVisibilityModal = useCallback((content: TrainingVisibilityContent = "workouts") => {
    setTrainingVisibilityContent(content);
    setTrainingVisibilityRange("week");
    setTrainingVisibilityStartISO(currentWeekStartISO);
    setTrainingVisibilityEndISO(currentWeekEndISO);
    setTrainingVisibilityError(null);
    setTrainingVisibilityOpen(true);
  }, [currentWeekEndISO, currentWeekStartISO]);

  const applyTrainingVisibilityNow = useCallback(async () => {
    const visible = trainingVisibilityAction === "publish";
    const includeWorkouts = trainingVisibilityContent === "workouts" || trainingVisibilityContent === "both";
    const includeMileage = trainingVisibilityContent === "mileage" || trainingVisibilityContent === "both";
    const weekStartsOnForMileage = weekStartsOn === 0 ? 0 : 1;
    const athleteIds = calendarBulkAthleteIds;
    setTrainingVisibilityError(null);

    const showValidation = (title: string, message: string) => {
      setTrainingVisibilityError(message);
      Alert.alert(title, message);
    };

    if (!includeWorkouts && !includeMileage) {
      showValidation("Choose training", "Select workouts, mileage, or both.");
      return;
    }
    if (athleteIds.length === 0) {
      showValidation("No athletes", "There are no athletes in the current visibility scope.");
      return;
    }

    const customStart = String(trainingVisibilityStartISO ?? "").trim();
    const customEnd = String(trainingVisibilityEndISO ?? "").trim();
    if (trainingVisibilityRange === "custom" && (!isValidISODate(customStart) || !isValidISODate(customEnd) || customStart > customEnd)) {
      showValidation("Invalid range", "Enter a valid start and end date.");
      return;
    }
    if (trainingVisibilityRange === "season" && !selectedSeason) {
      showValidation("No season selected", "Select a season before applying visibility.");
      return;
    }

    const seasonWindows: Array<{ athleteId: string; startISO: string; endISO: string }> = [];
    let targetAthleteCount = athleteIds.length;
    if (trainingVisibilityRange === "season" && selectedSeason) {
      const seasonId = String(selectedSeason.id ?? "").trim();
      if (!seasonId) {
        showValidation("No season selected", "Select a season before applying visibility.");
        return;
      }
      const rosterById = new Map((teamStore.roster ?? []).map((athlete) => [String(athlete?.id ?? "").trim(), athlete]));
      for (const athleteId of athleteIds) {
        if (isAthleteExcludedFromSeason(athleteId, seasonId, teamStore.athleteSeasonOverrides ?? [])) continue;
        const athlete = rosterById.get(athleteId) ?? null;
        const override = athleteSeasonOverridesBySeasonAndAthlete.get(`${seasonId}:${athleteId}`) ?? null;
        const resolved = resolveAthleteSeasonWindowWithTenure(athlete as any, selectedSeason as any, override as any);
        const startISO = String(resolved.start_date ?? "").trim();
        const endISO = String(resolved.end_date ?? "").trim();
        if (!isValidISODate(startISO) || !isValidISODate(endISO) || startISO > endISO) continue;
        seasonWindows.push({ athleteId, startISO, endISO });
      }
      targetAthleteCount = seasonWindows.length;
      if (seasonWindows.length === 0) {
        showValidation("No eligible athletes", "No eligible athletes found for this season.");
        return;
      }
    }

    const run = async () => {
      setTrainingVisibilityApplying(true);
      try {
        let workoutRows = 0;
        let mileageRows = 0;
        if (trainingVisibilityRange === "season" && selectedSeason) {
          for (const { athleteId, startISO, endISO } of seasonWindows) {
            if (includeWorkouts) {
              workoutRows += await setWorkoutVisibilityByDateRange({ startISO, endISO, athleteIds: [athleteId], visible });
            }
            if (includeMileage) {
              const result = await setMileageVisibilityByDateRange({
                athleteIds: [athleteId],
                startISO,
                endISO,
                visible,
                weekStartsOn: weekStartsOnForMileage,
              });
              mileageRows += result.rowCount;
            }
          }
        } else {
          const startISO = trainingVisibilityRange === "week" ? currentWeekStartISO : customStart;
          const endISO = trainingVisibilityRange === "week" ? currentWeekEndISO : customEnd;
          if (includeWorkouts) {
            workoutRows = await setWorkoutVisibilityByDateRange({ startISO, endISO, athleteIds, visible });
          }
          if (includeMileage) {
            const result = await setMileageVisibilityByDateRange({
              athleteIds,
              startISO,
              endISO,
              visible,
              weekStartsOn: weekStartsOnForMileage,
            });
            mileageRows = result.rowCount;
          }
        }

        if ((includeWorkouts ? workoutRows : 0) === 0 && (includeMileage ? mileageRows : 0) === 0) {
          const message =
            trainingVisibilityRange === "season"
              ? "No matching workouts or mileage weeks were found for this season."
              : "No matching workouts or mileage weeks were found for this range.";
          setTrainingVisibilityError(message);
          Alert.alert("Nothing found", message);
          return;
        }

        await loadCalendarData({ force: true });
        setTrainingVisibilityOpen(false);
        const verb = visible ? "Published" : "Hid";
        const updatedParts = [
          includeWorkouts ? `${workoutRows} workout${workoutRows === 1 ? "" : "s"}` : "",
          includeMileage ? `${mileageRows} mileage week row${mileageRows === 1 ? "" : "s"}` : "",
        ].filter(Boolean);
        Alert.alert(
          "Visibility updated",
          `${verb} ${includeWorkouts ? "workouts" : ""}${includeWorkouts && includeMileage ? " and " : ""}${includeMileage ? "mileage" : ""} for ${targetAthleteCount} athlete${targetAthleteCount === 1 ? "" : "s"}. Updated ${updatedParts.join(" and ")}.`
        );
      } catch (error: any) {
        const message = String(error?.message ?? error ?? "Could not update training visibility.");
        console.error("[coach-calendar] training visibility apply failed", {
          rangeMode: trainingVisibilityRange,
          content: trainingVisibilityContent,
          action: trainingVisibilityAction,
          selectedSeasonId: selectedSeason ? String(selectedSeason.id ?? "") : null,
          athleteCount: athleteIds.length,
          error,
        });
        setTrainingVisibilityError(message);
        Alert.alert("Visibility update failed", message);
      } finally {
        setTrainingVisibilityApplying(false);
      }
    };

    const actionText = visible ? "Publish training to athletes?" : "Hide training from athletes?";
    const body = visible
      ? "Athletes will be able to see this training and submit feedback."
      : "Coaches will still see this training. Hidden training will not appear on athlete Dashboard, Calendar, or Log.";
    const confirmMessage = `${body}\n\nMileage visibility is week-based. Any week touched by this range will be affected.`;
    if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.confirm === "function") {
      if (window.confirm(`${actionText}\n\n${confirmMessage}`)) void run();
      return;
    }
    Alert.alert(actionText, confirmMessage, [
      { text: "Cancel", style: "cancel" },
      { text: visible ? "Publish" : "Hide", style: visible ? "default" : "destructive", onPress: () => void run() },
    ]);
  }, [
    athleteSeasonOverridesBySeasonAndAthlete,
    calendarBulkAthleteIds,
    currentWeekEndISO,
    currentWeekStartISO,
    loadCalendarData,
    selectedSeason,
    teamStore.athleteSeasonOverrides,
    teamStore.roster,
    trainingVisibilityAction,
    trainingVisibilityContent,
    trainingVisibilityEndISO,
    trainingVisibilityRange,
    trainingVisibilityStartISO,
    weekStartsOn,
  ]);
  const copyTargetWeekLabel = useMemo(() => formatWeekRangeFromStartISO(currentWeekStartISO), [currentWeekStartISO]);
  const copySourceWeekStartISO = useMemo(() => {
    const raw = String(copySourceDateInput ?? "").trim();
    if (!isValidISODate(raw)) return "";
    return toISODate(startOfWeek(parseISODate(raw), weekStartsOn));
  }, [copySourceDateInput, weekStartsOn]);
  const copySourceWeekLabel = useMemo(
    () => (copySourceWeekStartISO ? formatWeekRangeFromStartISO(copySourceWeekStartISO) : "Invalid source week"),
    [copySourceWeekStartISO]
  );

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const startISO = weekDateISOs[0] ?? "";
        const endISO = weekDateISOs[6] ?? startISO;
        const rowsByDate = startISO
          ? await listTeamWorkoutBatchHeadersInRange(startISO, endISO).catch(() => [])
          : [];
        if (!active) return;
        const next: Record<string, string> = {};
        const nextBase: Record<string, string> = {};
        rowsByDate.forEach((row) => {
          const batchId = String(row.batch_id ?? "").trim();
          if (!batchId) return;
          const key = toWorkoutBatchHeaderNotesKey(row.date_iso, batchId, row.session);
          const value = String(row.header_notes ?? "").trim();
          next[key] = value;
          if (value) {
            const baseKey = toWorkoutBatchHeaderNotesBaseKey(row.date_iso, batchId);
            if (!nextBase[baseKey]) nextBase[baseKey] = value;
          }
        });
        setWeeklyBatchHeaderNotesByKey(next);
        setWeeklyBatchHeaderNotesByBaseKey(nextBase);
      } catch {
        if (!active) return;
        setWeeklyBatchHeaderNotesByKey({});
        setWeeklyBatchHeaderNotesByBaseKey({});
      }
    })();
    return () => {
      active = false;
    };
  }, [weekDateISOs]);

  const monthLabel = useMemo(
    () =>
      anchorMonth.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      }),
    [anchorMonth]
  );

  const weekLabel = useMemo(() => {
    const start = weekDates[0];
    const end = weekDates[6];
    if (!start || !end) return "";
    const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `${startLabel} - ${endLabel}`;
  }, [weekDates]);

  const currentWeekAnnotation = useMemo(
    () => String(weekLabelsByStart[currentWeekStartISO] ?? ""),
    [currentWeekStartISO, weekLabelsByStart]
  );
  const relativeWeekStatus = useMemo(() => {
    const nowWeekStartISO = toISODate(startOfWeek(new Date(), weekStartsOn));
    const weekOffset = Math.round(diffISODateDays(nowWeekStartISO, currentWeekStartISO) / 7);
    if (weekOffset === 0) return { label: "This week", status: "current" as const };
    if (weekOffset === 1) return { label: "Next week", status: "future" as const };
    if (weekOffset > 1) return { label: `In ${weekOffset} weeks`, status: "future" as const };
    if (weekOffset === -1) return { label: "Last week", status: "past" as const };
    return { label: `${Math.abs(weekOffset)} weeks ago`, status: "past" as const };
  }, [currentWeekStartISO, weekStartsOn]);
  const activeWeekLabelText = useMemo(
    () => String(currentWeekAnnotation || weekLabelDraft || "").trim(),
    [currentWeekAnnotation, weekLabelDraft]
  );
  const activeWeekLabelTone = useMemo(
    () => getWeekLabelTone(activeWeekLabelText),
    [activeWeekLabelText]
  );
  const activeWeekLabelToneText = useMemo(
    () => getWeekLabelToneText(activeWeekLabelTone),
    [activeWeekLabelTone]
  );
  const activeWeekToneColors = useMemo(() => {
    return getWeekLabelToneColors(activeWeekLabelTone);
  }, [activeWeekLabelTone]);

  useEffect(() => {
    const editingSameWeek = isWeekLabelEditing && weekLabelEditingWeekRef.current === currentWeekStartISO;
    if (editingSameWeek) return;
    setWeekLabelDraft(currentWeekAnnotation);
  }, [currentWeekAnnotation, currentWeekStartISO, isWeekLabelEditing]);

  const weekdayLabels = useMemo(() => {
    const arr: string[] = [];
    for (let i = 0; i < 7; i++) arr.push(WEEKDAY_LABELS[(weekStartsOn + i) % 7]);
    return arr;
  }, [weekStartsOn]);

  const workoutCountByDate = useMemo(() => {
    const grouped = new Map<string, Set<string>>();

    for (const w of filteredWorkouts) {
      const dateISO = getWorkoutDateISO(w);
      if (!dateISO) continue;

      const batchId = String(w.batchId ?? "").trim();
      const groupId = String(w.groupId ?? "1").trim() || "1";
      const fallbackId = String(w.id ?? "");
      const workoutKey = batchId ? `${batchId}::${groupId}` : `single::${fallbackId}`;

      const set = grouped.get(dateISO) ?? new Set<string>();
      set.add(workoutKey);
      grouped.set(dateISO, set);
    }

    const counts = new Map<string, number>();
    for (const [dateISO, set] of grouped.entries()) counts.set(dateISO, set.size);
    return counts;
  }, [filteredWorkouts]);

  const weeklyTitleRowsByDate = useMemo(() => {
    const map = new Map<string, MonthWorkoutSummaryRow[]>();
    const grouped = new Map<string, Map<string, MonthWorkoutSummaryRow>>();
    let globalOrder = 0;

    for (const w of filteredWorkouts) {
      const dateISO = getWorkoutDateISO(w);
      if (!dateISO) continue;

      const title = String(w.title ?? "").trim() || "Workout";
      const categoryNames = workoutCategoryNames(w);
      const category = String(categoryNames[0] ?? w.category ?? "Other");
      const color = categoryColorByName(categories, category);
      const dotColors = normalizeWorkoutAccentColors(categoryNames, categories, color);
      const batchId = String(w.batchId ?? "").trim();
      const uniqueKey = batchId ? `batch:${batchId}` : `single:${String(w.id ?? "")}`;
      const nextPriority = classifyMonthWorkoutPriority({ title, categories: categoryNames });

      const byDate = grouped.get(dateISO) ?? new Map<string, MonthWorkoutSummaryRow>();
      const existing = byDate.get(uniqueKey);
      if (existing) {
        existing.count += 1;
        const mergedDotColors = [...existing.dotColors];
        for (const nextColor of dotColors) {
          if (!mergedDotColors.includes(nextColor)) mergedDotColors.push(nextColor);
        }
        existing.dotColors = mergedDotColors.slice(0, 4);
        if (nextPriority < existing.priority) {
          existing.priority = nextPriority;
        }
      } else {
        byDate.set(uniqueKey, {
          title,
          color,
          dotColors: dotColors.slice(0, 4),
          count: 1,
          priority: nextPriority,
          firstSeenOrder: globalOrder++,
        });
      }
      grouped.set(dateISO, byDate);
    }

    for (const [dateISO, rows] of grouped.entries()) {
      map.set(
        dateISO,
        Array.from(rows.values()).sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          return a.firstSeenOrder - b.firstSeenOrder;
        })
      );
    }

    return map;
  }, [categories, filteredWorkouts]);

  const buildWeeklyDaySectionsForExport = useCallback((args: {
    workouts: CoachCalendarWorkout[];
    weekDates: Date[];
    weekDateISOs: string[];
    headerByKey: Record<string, string>;
    headerByBaseKey: Record<string, string>;
    headerByBatchId: Record<string, string>;
  }): WeeklyDaySection[] => {
    const { workouts, weekDates, weekDateISOs, headerByKey, headerByBaseKey, headerByBatchId } = args;
    const athleteOptionNameById = new Map(
      athleteFilterOptions
        .map((option) => [String(option.id ?? "").trim(), String(option.label ?? "").trim()] as const)
        .filter(([id, label]) => !!id && !!label)
    );
    const rosterNameLookup = new Map<string, string>([...athleteOptionNameById, ...rosterNameById]);

    const weeklyAthleteLabelById = buildCompactWeeklyAthleteLabels(
      workouts
        .filter((w) => weekDateISOs.includes(getWorkoutDateISO(w)))
        .map((w) => {
          const athleteId = String(w.athleteId ?? "").trim();
          const resolvedName = resolveAthleteDisplayName(
            athleteId,
            rosterNameLookup,
            getAthleteFallbackName(w)
          );
          return { athleteId, resolvedName: resolvedName || "Unknown athlete" };
        })
    );

    const dateSet = new Set(weekDateISOs);
    const workoutsByDate = new Map<
      string,
      Map<
        string,
        {
          key: string;
          saveKey: string;
          rows: CoachCalendarWorkout[];
        }
      >
    >();

    for (const workout of workouts) {
      const dateISO = getWorkoutDateISO(workout);
      if (!dateSet.has(dateISO)) continue;
      const workoutKey = getWorkoutBatchKey(workout);
      const byDate = workoutsByDate.get(dateISO) ?? new Map();
      const existing = byDate.get(workoutKey) ?? {
        key: `${dateISO}::${workoutKey}`,
        saveKey: workoutKey,
        rows: [] as CoachCalendarWorkout[],
      };
      existing.rows.push(workout);
      byDate.set(workoutKey, existing);
      workoutsByDate.set(dateISO, byDate);
    }

    return weekDates.map((dateObj, idx) => {
      const dateISO = weekDateISOs[idx];
      const entries = Array.from(
        (workoutsByDate.get(dateISO) ?? new Map<string, { key: string; saveKey: string; rows: CoachCalendarWorkout[] }>()).values()
      );

      const workouts = entries
        .map((entry): WeeklyWorkoutSection => {
          const rows = entry.rows;
          const first = pickMasterWorkoutRow(rows);
          const workoutTimeLabel = normalizeWorkoutTimeLabel(first.time);
          const distinctWorkoutTimes = new Set(
            rows.map((r) => normalizeWorkoutTimeLabel(r.time)).filter(Boolean)
          );
          const hasMixedGroupTimes = distinctWorkoutTimes.size > 1;
          const categoriesForWorkout: string[] = Array.from(
            new Set(rows.flatMap((r) => workoutCategoryNames(r).map((c) => String(c).trim()).filter(Boolean)))
          );
          const categoryColor = categoryColorByName(categories, categoriesForWorkout[0] ?? "Other");
          const athleteIds = new Set(rows.map((r) => String(r.athleteId ?? "").trim()).filter(Boolean));
          const groupIds = new Set(rows.map((r) => String(r.groupId ?? "").trim() || "Ungrouped"));

          const groupsMap = new Map<string, CoachCalendarWorkout[]>();
          rows.forEach((r) => {
            const groupId = String(r.groupId ?? "").trim() || "Ungrouped";
            const groupRows = groupsMap.get(groupId) ?? [];
            groupRows.push(r);
            groupsMap.set(groupId, groupRows);
          });

          const batchIdForNotes = String(first.batchId ?? "").trim();
          const mainBatchNotes = (() => {
            if (batchIdForNotes) {
              const headerKey = toWorkoutBatchHeaderNotesKey(dateISO, batchIdForNotes, String(first.session ?? ""));
              const headerNotes = String(headerByKey[headerKey] ?? "").trim();
              if (headerNotes && headerNotes.toLowerCase() !== "no notes") return headerNotes;
              const baseKey = toWorkoutBatchHeaderNotesBaseKey(dateISO, batchIdForNotes);
              const baseHeaderNotes = String(headerByBaseKey[baseKey] ?? "").trim();
              if (baseHeaderNotes && baseHeaderNotes.toLowerCase() !== "no notes") return baseHeaderNotes;
              const batchHeaderNotes = String(headerByBatchId[batchIdForNotes] ?? "").trim();
              if (batchHeaderNotes && batchHeaderNotes.toLowerCase() !== "no notes") return batchHeaderNotes;
            }
            const rowNotes = rows
              .map((row) => normalizeDetailsText(row.details))
              .filter((note) => !!note && note.toLowerCase() !== "no notes");
            if (rowNotes.length === 0) return "";
            return rowNotes.reduce((longest, current) => (current.length > longest.length ? current : longest), "");
          })();
          const normalizedMainBatchNotes = normalizeDetailsText(mainBatchNotes).toLowerCase();

          const groups = Array.from(groupsMap.entries())
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([groupId, groupRows], groupIndex) => {
              const distinctGroupTimes = new Set(
                groupRows.map((r) => normalizeWorkoutTimeLabel(r.time)).filter(Boolean)
              );
              const groupTimeLabel = distinctGroupTimes.size === 1 ? Array.from(distinctGroupTimes)[0] : "";
              const showGroupTimePrefix =
                hasMixedGroupTimes &&
                !!groupTimeLabel;
              const detailsBuckets = new Map<string, { individualNotes?: string; names: Set<string> }>();
              groupRows.forEach((r) => {
                const rawDetails = normalizeDetailsText(r.details);
                const hasRawDetails = !!rawDetails && rawDetails.toLowerCase() !== "no notes";
                const matchesMain =
                  hasRawDetails &&
                  rawDetails.toLowerCase() === normalizedMainBatchNotes &&
                  normalizedMainBatchNotes.length > 0;
                const individualNotes = !hasRawDetails || matchesMain
                  ? ""
                  : showGroupTimePrefix
                    ? `${groupTimeLabel} • ${rawDetails}`
                    : rawDetails;
                const key = individualNotes || "__no_individual_notes__";
                const bucket = detailsBuckets.get(key) ?? { individualNotes: individualNotes || undefined, names: new Set<string>() };
                const athleteId = String(r.athleteId ?? "").trim();
                const resolvedName = resolveAthleteDisplayName(
                  athleteId,
                  rosterNameLookup,
                  getAthleteFallbackName(r)
                );
                const compactName =
                  (athleteId ? weeklyAthleteLabelById.get(athleteId) : null) ??
                  resolvedName ??
                  "Unknown athlete";
                bucket.names.add(compactName);
                detailsBuckets.set(key, bucket);
              });

              const lines: WeeklyGroupLine[] = Array.from(detailsBuckets.values()).map((bucket) => ({
                individualNotes: bucket.individualNotes,
                athleteNames: Array.from(bucket.names).sort((a, b) => a.localeCompare(b)),
              }));

              return {
                key: `${entry.key}::group:${groupId}`,
                label: `Group ${groupIndex + 1}`,
                lines,
              };
            });

          return {
            key: entry.key,
            saveKey: entry.saveKey,
            dateISO,
            title: String(first.title ?? "").trim() || "Workout",
            session: String(first.session ?? ""),
            time: String(first.time ?? "").trim() || undefined,
            location: getWorkoutLocation(first) || undefined,
            details: mainBatchNotes || undefined,
            categories: categoriesForWorkout,
            preRoutineIds: sanitizeRoutineIds(first.preRoutineIds),
            postRoutineIds: sanitizeRoutineIds(first.postRoutineIds),
            categoryColor,
            athleteCount: athleteIds.size || (rows.length > 0 ? 1 : 0),
            groupCount: groupIds.size || 1,
            groups,
            visibilityStatus: getWeekWorkoutVisibilityStatus(rows),
          };
        })
        .sort(compareWeeklyWorkoutSections);

      return {
        dateISO,
        weekday: dateObj.toLocaleDateString(undefined, { weekday: "long" }),
        fullDate: dateObj.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }),
        workouts,
      };
    });
  }, [athleteFilterOptions, categories, rosterNameById]);

  const weeklyDaySections = useMemo<WeeklyDaySection[]>(() => {
    const headerByBatchId: Record<string, string> = {};
    Object.entries(weeklyBatchHeaderNotesByBaseKey).forEach(([baseKey, value]) => {
      const notes = String(value ?? "").trim();
      if (!notes || notes.toLowerCase() === "no notes") return;
      const parts = String(baseKey ?? "").split("::");
      const batchId = String(parts[1] ?? "").trim();
      if (!batchId) return;
      const prev = String(headerByBatchId[batchId] ?? "").trim();
      if (!prev || notes.length > prev.length) headerByBatchId[batchId] = notes;
    });
    return buildWeeklyDaySectionsForExport({
      workouts: filteredWorkouts,
      weekDates,
      weekDateISOs,
      headerByKey: weeklyBatchHeaderNotesByKey,
      headerByBaseKey: weeklyBatchHeaderNotesByBaseKey,
      headerByBatchId,
    });
  }, [
    buildWeeklyDaySectionsForExport,
    filteredWorkouts,
    weekDateISOs,
    weekDates,
    weeklyBatchHeaderNotesByBaseKey,
    weeklyBatchHeaderNotesByKey,
  ]);

  const weeklyDaySectionsForDisplay = useMemo<WeeklyDaySection[]>(() => {
    return weeklyDaySections.map((day) => ({
      ...day,
      workouts: sortWeeklyDayWorkoutsForDisplay(day.workouts),
    }));
  }, [weeklyDaySections]);

  useEffect(() => {
    weeklyBatchDraftsRef.current = weeklyBatchDrafts;
  }, [weeklyBatchDrafts]);

  useEffect(() => {
    weeklyBatchDirtyFieldsRef.current = weeklyBatchDirtyFields;
  }, [weeklyBatchDirtyFields]);

  useEffect(() => {
    setWeeklyBatchDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      weeklyDaySections.forEach((day) => {
        day.workouts.forEach((workout) => {
          if (!next[workout.saveKey]) {
            next[workout.saveKey] = toWeeklyBatchDraft(workout);
            changed = true;
          }
        });
      });
      if (!changed) return prev;
      weeklyBatchDraftsRef.current = next;
      return next;
    });
  }, [weeklyDaySections]);

  const setWeeklySavedSoonIdle = useCallback((batchKey: string) => {
    setTimeout(() => {
      setWeeklyBatchSaveState((prev) => {
        if (prev[batchKey]?.status !== "saved") return prev;
        const next = { ...prev };
        next[batchKey] = { status: "idle" };
        return next;
      });
    }, 2200);
  }, []);

  const commitWeeklyBatchEdit = useCallback(async (batchKey: string) => {
    const dirty = weeklyBatchDirtyFieldsRef.current[batchKey] ?? {};
    const dirtyKeys = Object.keys(dirty) as WeeklyBatchEditableField[];
    if (dirtyKeys.length === 0) return;

    const draft = weeklyBatchDraftsRef.current[batchKey];
    if (!draft) return;

    const payload = toWeeklyBatchPatchFromDraft(draft, dirtyKeys);
    if (Object.keys(payload).length === 0) return;

    setWeeklyBatchSaveState((prev) => ({ ...prev, [batchKey]: { status: "saving" } }));

    try {
      const parsed = parseWeeklyBatchKey(batchKey);
      if (parsed.isBatch) {
        await updateTeamWorkoutsByBatchId(parsed.id, payload);
      } else {
        await updateTeamWorkoutById(parsed.id, payload);
      }

      weeklyBatchDirtyFieldsRef.current = { ...weeklyBatchDirtyFieldsRef.current, [batchKey]: {} };
      setWeeklyBatchDirtyFields((prev) => ({ ...prev, [batchKey]: {} }));
      setWeeklyBatchSaveState((prev) => ({ ...prev, [batchKey]: { status: "saved" } }));
      setWeeklySavedSoonIdle(batchKey);
    } catch (e: any) {
      setWeeklyBatchSaveState((prev) => ({
        ...prev,
        [batchKey]: { status: "error", message: String(e?.message ?? "Save failed") },
      }));
    }
  }, [setWeeklySavedSoonIdle]);

  const scheduleWeeklyBatchSave = useCallback((batchKey: string, delayMs = 450) => {
    const current = weeklyBatchSaveTimersRef.current[batchKey];
    if (current) clearTimeout(current);
    weeklyBatchSaveTimersRef.current[batchKey] = setTimeout(() => {
      void commitWeeklyBatchEdit(batchKey);
    }, delayMs);
  }, [commitWeeklyBatchEdit]);

  const applyWeeklyBatchOptimisticRows = useCallback((batchKey: string, field: WeeklyBatchEditableField, value: string | string[]) => {
    const parsed = parseWeeklyBatchKey(batchKey);
    setAllWorkouts((prev) =>
      prev.map((workout) => {
        const match = parsed.isBatch
          ? String(workout.batchId ?? "").trim() === parsed.id
          : String(workout.id ?? "") === parsed.id;
        if (!match) return workout;

        if (field === "time_text") return { ...workout, time: String(value ?? "") };
        if (field === "location") return { ...workout, calendarLocation: String(value ?? "") };
        if (field === "title") return { ...workout, title: String(value ?? "") };
        return workout;
      })
    );
  }, []);

  const onEditWeeklyBatchField = useCallback((batchKey: string, field: WeeklyBatchEditableField, value: string | string[]) => {
    setWeeklyBatchDrafts((prev) => {
      const current = prev[batchKey] ?? {
        session: "PM",
        time_text: "",
        date_iso: "",
        location: "",
        title: "",
        details: "",
        categories: [],
      };
      const nextDraft: WeeklyBatchDraft = {
        ...current,
        [field]: String(value ?? ""),
      };
      const next = { ...prev, [batchKey]: nextDraft };
      weeklyBatchDraftsRef.current = next;
      return next;
    });

    setWeeklyBatchDirtyFields((prev) => {
      const next = { ...prev, [batchKey]: { ...(prev[batchKey] ?? {}), [field]: true } };
      weeklyBatchDirtyFieldsRef.current = next;
      return next;
    });

    applyWeeklyBatchOptimisticRows(batchKey, field, value);
    scheduleWeeklyBatchSave(batchKey);
  }, [applyWeeklyBatchOptimisticRows, scheduleWeeklyBatchSave]);

  useEffect(() => {
    return () => {
      Object.values(weeklyBatchSaveTimersRef.current).forEach((timer) => clearTimeout(timer));
      if (weekLabelSaveTimerRef.current) clearTimeout(weekLabelSaveTimerRef.current);
    };
  }, []);

  const auxiliaryRoutineById = useMemo(() => {
    const map = new Map<string, AuxiliaryRoutine>();
    auxiliaryRoutines.forEach((routine) => {
      const id = String(routine.id ?? "").trim();
      if (id) map.set(id, routine);
    });
    return map;
  }, [auxiliaryRoutines]);

  const weeklyPlannerLaneHeight = useMemo(() => Math.max(440, Math.floor(windowHeight - 214)), [windowHeight]);

  const openRoutineDetails = useCallback((routineId: string) => {
    const routine = auxiliaryRoutineById.get(String(routineId ?? "").trim());
    if (!routine) return;
    Alert.alert(String(routine.title ?? "Routine"), String(routine.details ?? "").trim() || "No details");
  }, [auxiliaryRoutineById]);

  const renderWeeklyExpandedWorkout = useCallback((workout: WeeklyWorkoutSection) => {
    const batchDetails = normalizeDetailsText(workout.details);
    const showBatchDetails = !!batchDetails && batchDetails.toLowerCase() !== "no notes";
    const visibilityStatus = workout.visibilityStatus ?? "published";
    const visibilityText =
      visibilityStatus === "hidden"
        ? "Hidden"
        : visibilityStatus === "mixed"
          ? "Mixed"
          : visibilityStatus === "published"
            ? "Published"
            : "";
    const visibilityStyle =
      visibilityStatus === "hidden"
        ? [styles.weekWorkoutVisibilityBadge, styles.weekWorkoutVisibilityBadgeHidden]
        : visibilityStatus === "mixed"
          ? [styles.weekWorkoutVisibilityBadge, styles.weekWorkoutVisibilityBadgeMixed]
          : [styles.weekWorkoutVisibilityBadge, styles.weekWorkoutVisibilityBadgePublished];
    const visibilityTextStyle =
      visibilityStatus === "hidden"
        ? [styles.weekWorkoutVisibilityBadgeText, styles.weekWorkoutVisibilityBadgeTextHidden]
        : visibilityStatus === "mixed"
          ? [styles.weekWorkoutVisibilityBadgeText, styles.weekWorkoutVisibilityBadgeTextMixed]
          : [styles.weekWorkoutVisibilityBadgeText, styles.weekWorkoutVisibilityBadgeTextPublished];

    const renderRoutineBlock = (label: string, ids: string[], keyPrefix: string) => {
      if (ids.length === 0) return null;
      return (
        <View style={styles.weekRoutineBlock}>
          <Text style={styles.weekExpandedSectionLabel}>{label}</Text>
          <View style={styles.weekRoutineList}>
            {ids.map((routineId) => {
              const routine = auxiliaryRoutineById.get(routineId);
              if (!routine) return null;
              return (
                <Pressable
                  key={`${workout.key}-${keyPrefix}-${routineId}`}
                  onPress={() => openRoutineDetails(routineId)}
                  style={styles.weekRoutinePill}
                >
                  <Text style={styles.weekRoutinePillText}>{routine.title}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      );
    };

    const hasGroupContent = workout.groups.some((group) =>
      group.lines.some((line) => line.athleteNames.length > 0 || !!String(line.individualNotes ?? "").trim())
    );
    const hasAnyDetails =
      showBatchDetails ||
      workout.preRoutineIds.length > 0 ||
      workout.postRoutineIds.length > 0 ||
      hasGroupContent;

    return (
      <View style={styles.weekExpandedBody}>
        <View style={styles.weekExpandedHeaderRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.weekExpandedTitle}>{workout.title}</Text>
            <Text style={styles.weekExpandedMeta}>
              {[workout.time || workout.session, workout.location ? `@ ${workout.location}` : ""].filter(Boolean).join(" ")}
            </Text>
          </View>
          {visibilityText ? (
            <View style={visibilityStyle}>
              <Text style={visibilityTextStyle}>{visibilityText}</Text>
            </View>
          ) : null}
        </View>

        {showBatchDetails ? (
          <View style={styles.weekExpandedSection}>
            <Text style={styles.weekExpandedSectionLabel}>Workout details</Text>
            <Text style={styles.weekExpandedDetailsText}>{batchDetails}</Text>
          </View>
        ) : null}

        {renderRoutineBlock("Pre-run", workout.preRoutineIds, "pre")}
        {renderRoutineBlock("Post-run", workout.postRoutineIds, "post")}

        {workout.groups.length > 0 ? (
          <View style={styles.weekExpandedSection}>
            <Text style={styles.weekExpandedSectionLabel}>Groups</Text>
            {workout.groups.map((group) => {
              const groupAthletes = Array.from(
                new Set(
                  group.lines
                    .flatMap((line) => line.athleteNames)
                    .map((name) => String(name ?? "").trim())
                    .filter(Boolean)
                )
              );
              const noteLines = group.lines
                .map((line) => ({
                  athleteNames: line.athleteNames.map((name) => String(name ?? "").trim()).filter(Boolean),
                  note: normalizeDetailsText(line.individualNotes),
                }))
                .filter((line) => line.athleteNames.length > 0 || !!line.note);
              const linesWithNotes = noteLines.filter((line) => !!line.note);
              const hasSharedNote = linesWithNotes.length === 1;
              return (
                <View key={group.key} style={styles.weekGroupDetailBlock}>
                  <Text style={styles.weekGroupLabel}>{group.label}</Text>
                  {groupAthletes.length > 0 ? (
                    <Text style={styles.weekGroupAthletesText}>
                      Athletes: {groupAthletes.join(", ")}
                    </Text>
                  ) : null}
                  {hasSharedNote ? (
                    <View style={styles.weekGroupNotesBlock}>
                      <Text style={styles.weekGroupNotesLabel}>Notes</Text>
                      <Text style={styles.weekGroupNoteText}>{linesWithNotes[0]?.note}</Text>
                    </View>
                  ) : linesWithNotes.length > 1 ? (
                    <View style={styles.weekGroupNotesBlock}>
                      {noteLines.map((line, idx) => (
                        <Text key={`${group.key}-detail-${idx}`} style={line.note ? styles.weekGroupNoteText : styles.weekGroupNoNoteText}>
                          {line.athleteNames.join(", ")}
                          {line.note ? ` - ${line.note}` : ""}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        {!hasAnyDetails ? (
          <Text style={styles.weekExpandedEmptyText}>No additional details for this workout.</Text>
        ) : null}
      </View>
    );
  }, [auxiliaryRoutineById, openRoutineDetails]);

  const shiftMonth = useCallback((delta: number) => {
    setAnchorMonth((prev) => addMonths(prev, delta));
  }, []);

  const shiftWeek = useCallback((delta: number) => {
    setAnchorWeekStart((prev) => addDays(prev, delta * 7));
  }, []);

  const translateX = useSharedValue(0);

  const goToToday = useCallback(() => {
    const now = new Date();
    setAnchorMonth(monthStart(now));
    setAnchorWeekStart(startOfWeek(now, weekStartsOn));
    translateX.value = 0;
  }, [translateX, weekStartsOn]);

  const jumpToWeekFromDateISO = useCallback(
    (dateISO: string) => {
      const trimmed = String(dateISO ?? "").trim();
      if (!isValidISODate(trimmed)) return false;
      const [y, m, d] = trimmed.split("-").map(Number);
      const target = startOfWeek(new Date(y, (m ?? 1) - 1, d ?? 1), weekStartsOn);
      setAnchorWeekStart(target);
      setAnchorMonth(monthStart(target));
      translateX.value = 0;
      return true;
    },
    [translateX, weekStartsOn]
  );

  const applyJumpToWeekInput = useCallback(() => {
    const ok = jumpToWeekFromDateISO(jumpDateInput);
    if (!ok) {
      Alert.alert("Jump to Week", "Enter a valid date as YYYY-MM-DD.");
      return;
    }
    setJumpToWeekOpen(false);
  }, [jumpDateInput, jumpToWeekFromDateISO]);

  const commitSwipe = useCallback(
    (dir: "prev" | "next") => {
      const delta = dir === "prev" ? -1 : 1;
      translateX.value = withTiming(dir === "prev" ? SCREEN_W : -SCREEN_W, { duration: 140 }, (finished) => {
        if (finished) {
          if (calendarMode === "month") {
            runOnJS(shiftMonth)(delta);
          } else {
            runOnJS(shiftWeek)(delta);
          }
          translateX.value = 0;
        }
      });
    },
    [calendarMode, shiftMonth, shiftWeek, translateX]
  );

  const pan = Gesture.Pan()
    .onChange((e) => {
      translateX.value = e.translationX;
    })
    .onEnd((e) => {
      const threshold = SCREEN_W * 0.22;
      if (e.translationX > threshold) {
        runOnJS(commitSwipe)("prev");
        return;
      }
      if (e.translationX < -threshold) {
        runOnJS(commitSwipe)("next");
        return;
      }
      translateX.value = withSpring(0);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const quickNewSessionDateISO = useMemo(() => {
    if (calendarMode === "month") {
      const today = new Date();
      if (
        today.getFullYear() === anchorMonth.getFullYear() &&
        today.getMonth() === anchorMonth.getMonth()
      ) {
        return todayISO;
      }
      return toISODate(monthStart(anchorMonth));
    }

    const startISO = toISODate(weekDates[0]);
    const endISO = toISODate(weekDates[6]);
    if (todayISO >= startISO && todayISO <= endISO) return todayISO;
    return startISO;
  }, [anchorMonth, calendarMode, todayISO, weekDates]);

  const handleExportWeekPdf = useCallback(async () => {
    if (calendarMode !== "week" || exportingPdf) return;
    debugCalendar("[weekly-pdf] export start", {
      weekLabel,
      dayCount: weeklyDaySectionsForDisplay.length,
    });
    debugCalendar("[weekly-pdf] Print module keys", Object.keys(Print || {}));
    setExportingPdf(true);
    try {
      const generatedAtLabel = new Date().toLocaleString();
      const exportHeaderStartISO = weekDateISOs[0] ?? "";
      const exportHeaderEndISO = weekDateISOs[6] ?? exportHeaderStartISO;
      const headerRowsByDate = exportHeaderStartISO
        ? await listTeamWorkoutBatchHeadersInRange(exportHeaderStartISO, exportHeaderEndISO).catch(() => [])
        : [];
      const exportHeaderByKey: Record<string, string> = {};
      const exportHeaderByBaseKey: Record<string, string> = {};
      const exportHeaderByBatchId: Record<string, string> = {};
      headerRowsByDate.forEach((row) => {
        const batchId = String(row.batch_id ?? "").trim();
        if (!batchId) return;
        const value = String(row.header_notes ?? "").trim();
        const key = toWorkoutBatchHeaderNotesKey(row.date_iso, batchId, row.session);
        exportHeaderByKey[key] = value;
        if (value) {
          const baseKey = toWorkoutBatchHeaderNotesBaseKey(row.date_iso, batchId);
          if (!exportHeaderByBaseKey[baseKey]) exportHeaderByBaseKey[baseKey] = value;
          const prev = String(exportHeaderByBatchId[batchId] ?? "").trim();
          if (!prev || value.length > prev.length) exportHeaderByBatchId[batchId] = value;
        }
      });
      const exportDays = applyHeaderNotesToWeeklySections(
        weeklyDaySectionsForDisplay,
        exportHeaderByKey,
        exportHeaderByBaseKey,
        exportHeaderByBatchId
      );
      if ((weekDateISOs[0] ?? "") === "2026-11-09") {
        debugCalendar("[weekly-pdf][debug:2026-11-09] map-keys", {
          exactCount: Object.keys(exportHeaderByKey).length,
          baseCount: Object.keys(exportHeaderByBaseKey).length,
          batchCount: Object.keys(exportHeaderByBatchId).length,
          exactKeysSample: Object.keys(exportHeaderByKey).slice(0, 30),
        });
        debugCalendar("[weekly-pdf][debug:2026-11-09] sections-before", summarizeWeeklySectionDetails(weeklyDaySectionsForDisplay));
        debugCalendar("[weekly-pdf][debug:2026-11-09] sections-after", summarizeWeeklySectionDetails(exportDays));
      }
      const html = buildWeeklyHandoutHtml({
        weekLabel,
        weekAnnotation: currentWeekAnnotation || "",
        weekAnnotationTone: getWeekLabelTone(currentWeekAnnotation || ""),
        generatedAtLabel,
        days: exportDays,
        categories,
      });
      debugCalendar("[weekly-pdf] using handout html builder");
      debugCalendar("[weekly-pdf] html preview", html.slice(0, 400));
      debugCalendar("[weekly-pdf] html built", { length: html.length });

      if (Platform.OS === "web") {
        printHtmlInWebWindow(html);
        debugCalendar("[weekly-pdf] web print window opened");
        Alert.alert("Export PDF", "Print dialog opened.");
      } else {
        const result = await Print.printToFileAsync({ html });
        debugCalendar("[weekly-pdf] print result", result);
        const canShare = await Sharing.isAvailableAsync();
        debugCalendar("[weekly-pdf] sharing available", canShare);

        if (canShare) {
          await Sharing.shareAsync(result.uri);
        } else {
          Alert.alert("PDF created", result.uri);
        }
      }
    } catch (e: any) {
      debugCalendar("[weekly-pdf] export error", e);
      Alert.alert("Export failed", String(e?.message ?? "Could not export weekly PDF."));
    } finally {
      setExportingPdf(false);
    }
  }, [calendarMode, categories, currentWeekAnnotation, exportingPdf, weekDateISOs, weekLabel, weeklyDaySectionsForDisplay]);

  const openTrainingPlanExport = useCallback(() => {
    const startISO = currentWeekStartISO;
    const endISO = shiftISODateByDays(startISO, 27);
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(COACH_TRAINING_PLAN_EXPORT_RANGE_KEY);
        const parsed = raw ? JSON.parse(raw) as { startDateISO?: string; endDateISO?: string; seasonId?: string | null } : null;
        const savedStart = String(parsed?.startDateISO ?? "").trim();
        const savedEnd = String(parsed?.endDateISO ?? "").trim();
        const savedSeasonId = String(parsed?.seasonId ?? "").trim() || null;
        setExportStartDateISO(isValidISODate(savedStart) ? savedStart : startISO);
        setExportEndDateISO(isValidISODate(savedEnd) ? savedEnd : endISO);
        setTrainingPlanExportSeasonId(savedSeasonId);
      } catch {
        setExportStartDateISO(startISO);
        setExportEndDateISO(endISO);
        setTrainingPlanExportSeasonId(null);
      }
      setTrainingPlanExportError(null);
      setTrainingPlanExportOpen(true);
    })();
  }, [currentWeekStartISO]);

  const trainingPlanExportSeasonOptions = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; archived: boolean }>();
    (Array.isArray(teamStore.teamSeasons) ? teamStore.teamSeasons : []).forEach((season) => {
      const id = String(season?.id ?? "").trim();
      if (!id) return;
      const archived = !!season?.archived_at;
      if (!archived) byId.set(id, { id, label: String(season?.name ?? "").trim() || "Season", archived });
    });
    const selectedId = String(trainingPlanExportSeasonId ?? "").trim();
    if (selectedId && !byId.has(selectedId)) {
      const match = (teamStore.teamSeasons ?? []).find((season) => String(season?.id ?? "").trim() === selectedId);
      if (match) byId.set(selectedId, { id: selectedId, label: String(match.name ?? "").trim() || "Season", archived: !!match.archived_at });
    }
    const order = new Map<string, number>();
    (Array.isArray(teamStore.teamSeasons) ? teamStore.teamSeasons : []).forEach((season, idx) => {
      const id = String(season?.id ?? "").trim();
      if (id) order.set(id, idx);
    });
    return Array.from(byId.values()).sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));
  }, [teamStore.teamSeasons, trainingPlanExportSeasonId]);

  const applyTrainingPlanSeasonRange = useCallback((seasonId: string | null) => {
    const normalized = String(seasonId ?? "").trim();
    if (!normalized) {
      setTrainingPlanExportSeasonId(null);
      return;
    }
    const season = (teamStore.teamSeasons ?? []).find((row) => String(row?.id ?? "").trim() === normalized);
    if (!season) return;
    const singleAthleteId = selectedAthleteIds.length === 1 ? String(selectedAthleteIds[0] ?? "").trim() : "";
    const override = singleAthleteId
      ? athleteSeasonOverridesBySeasonAndAthlete.get(`${normalized}:${singleAthleteId}`) ?? null
      : null;
    const resolved = teamDataStore.resolveAthleteSeasonWindow(season, override ?? null);
    setExportStartDateISO(String(resolved.start_date ?? season.start_date ?? "").trim());
    setExportEndDateISO(String(resolved.end_date ?? season.end_date ?? "").trim());
    setTrainingPlanExportSeasonId(normalized);
    setTrainingPlanExportError(null);
  }, [athleteSeasonOverridesBySeasonAndAthlete, selectedAthleteIds, teamStore.teamSeasons]);

  const shiftTrainingPlanExportDate = useCallback((field: "start" | "end", deltaDays: number) => {
    const current = field === "start" ? exportStartDateISO : exportEndDateISO;
    const shifted = shiftISODateByDays(current, deltaDays);
    if (field === "start") setExportStartDateISO(shifted);
    else setExportEndDateISO(shifted);
    if (trainingPlanExportSeasonId) setTrainingPlanExportSeasonId(null);
    setTrainingPlanExportError(null);
  }, [exportEndDateISO, exportStartDateISO, trainingPlanExportSeasonId]);

  const handleExportTrainingPlanPdf = useCallback(async () => {
    if (exportingTrainingPlanPdf) return;
    const startISO = String(exportStartDateISO ?? "").trim();
    const endISO = String(exportEndDateISO ?? "").trim();

    if (!isValidISODate(startISO) || !isValidISODate(endISO)) {
      const message = "Use valid YYYY-MM-DD dates.";
      setTrainingPlanExportError(message);
      Alert.alert("Invalid date range", message);
      return;
    }
    if (endISO < startISO) {
      const message = "End date must be on or after start date.";
      setTrainingPlanExportError(message);
      Alert.alert("Invalid date range", message);
      return;
    }
    const spanDays = diffISODateDays(startISO, endISO) + 1;
    if (spanDays > MAX_TRAINING_PLAN_EXPORT_RANGE_DAYS) {
      const message = `Range too large. Maximum is ${MAX_TRAINING_PLAN_EXPORT_RANGE_DAYS} days.`;
      setTrainingPlanExportError(message);
      Alert.alert("Range too large", message);
      return;
    }

    setTrainingPlanExportError(null);
    setExportingTrainingPlanPdf(true);
    try {
      const rows = await listTeamWorkoutsInRange(startISO, endISO);
      const debugDateSet = new Set(["2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15", "2026-05-16", "2026-05-17"]);
      const countRowsByDate = (items: Array<{ dateISO: string }>) =>
        Array.from(debugDateSet.values()).reduce<Record<string, number>>((acc, dateISO) => {
          acc[dateISO] = items.filter((item) => item.dateISO === dateISO).length;
          return acc;
        }, {});
      const rawRows = Array.isArray(rows) ? rows : [];
      debugCalendar("[training-plan-pdf] fetched raw rows", {
        count: rawRows.length,
        uniqueDates: Array.from(new Set(rawRows.map((row) => String(row.date_iso ?? "").trim()))).sort(),
        countsByDate: countRowsByDate(rawRows.map((row) => ({ dateISO: String(row.date_iso ?? "").trim() }))),
      });
      debugCalendar(
        "[training-plan-pdf] fetched raw rows detail (May 13-17)",
        rawRows
          .filter((row) => debugDateSet.has(String(row.date_iso ?? "").trim()) && String(row.date_iso ?? "").trim() >= "2026-05-13")
          .map((row) => ({
            id: row.id,
            date_iso: row.date_iso,
            athlete_profile_id: row.athlete_profile_id,
            session: row.session,
            title: row.title,
            batch_id: row.batch_id,
            group_id: row.group_id,
          }))
      );
      const workoutsInRange: CoachCalendarWorkout[] = (Array.isArray(rows) ? rows : []).map((row) => toLegacyWorkout(row));
      const isInExportRange = (dateISO: string) => dateISO >= startISO && dateISO <= endISO;
      const [startY, startM, startD] = startISO.split("-").map(Number);
      const [endY, endM, endD] = endISO.split("-").map(Number);

      debugCalendar("[training-plan-pdf] export range", {
        exportStartDateISO: startISO,
        exportEndDateISO: endISO,
        dayCountInclusive: diffISODateDays(startISO, endISO) + 1,
      });
      debugCalendar("[training-plan-pdf] fetched workouts", {
        count: workoutsInRange.length,
        countsByDate: countRowsByDate(
          workoutsInRange.map((workout) => ({ dateISO: String(getWorkoutDateISO(workout) ?? "").trim() }))
        ),
      });

      const athleteSelectedSet = new Set(selectedAthleteIds);
      const debugFilterDrops: Array<{
        workoutId: string;
        athleteId: string;
        workoutDateISO: string;
        athletePass: boolean;
        groupPass: boolean;
        seasonPass: boolean;
        selectedSeasonId: string | null;
        resolvedStart: string | null;
        resolvedEnd: string | null;
      }> = [];
      const filteredRangeWorkouts = workoutsInRange.filter((workout) => {
        const workoutDateISO = getWorkoutDateISO(workout);
        if (!isInExportRange(workoutDateISO)) return false;
        const athleteId = String(workout.athleteId ?? "").trim();
        const athletePass = selectedAthleteIds.length === 0 ? true : athleteSelectedSet.has(athleteId);
        const groupPass =
          selectedTrainingGroupIds.length === 0 ? true : selectedTrainingGroupAthleteIds.has(athleteId);
        const { seasonPass, resolvedStart, resolvedEnd } = (() => {
          if (!selectedSeason) {
            return { seasonPass: true, resolvedStart: null, resolvedEnd: null };
          }
          const override = athleteId
            ? athleteSeasonOverridesBySeasonAndAthlete.get(`${String(selectedSeason.id ?? "").trim()}:${athleteId}`) ?? null
            : null;
          const resolvedWindow = teamDataStore.resolveAthleteSeasonWindow(selectedSeason, override);
          const start = String(resolvedWindow.start_date ?? "");
          const end = String(resolvedWindow.end_date ?? "");
          return {
            seasonPass: workoutDateISO >= start && workoutDateISO <= end,
            resolvedStart: start,
            resolvedEnd: end,
          };
        })();
        const finalPass = athletePass && groupPass && seasonPass;
        if (!finalPass && debugDateSet.has(workoutDateISO)) {
          debugFilterDrops.push({
            workoutId: String(workout.id ?? ""),
            athleteId,
            workoutDateISO,
            athletePass,
            groupPass,
            seasonPass,
            selectedSeasonId: selectedSeason ? String(selectedSeason.id ?? "") : null,
            resolvedStart: resolvedStart ?? null,
            resolvedEnd: resolvedEnd ?? null,
          });
        }
        return finalPass;
      });
      debugCalendar("[training-plan-pdf] filtered workouts", {
        count: filteredRangeWorkouts.length,
        uniqueDates: Array.from(new Set(filteredRangeWorkouts.map((w) => getWorkoutDateISO(w)))).sort(),
        countsByDate: countRowsByDate(
          filteredRangeWorkouts.map((workout) => ({ dateISO: String(getWorkoutDateISO(workout) ?? "").trim() }))
        ),
        selectedAthleteIds,
        selectedTrainingGroupIds,
        selectedSeasonId: selectedSeason ? String(selectedSeason.id ?? "") : null,
      });
      debugCalendar("[training-plan-pdf] final-week filter drops", debugFilterDrops);
      Array.from(debugDateSet.values()).forEach((dateISO) => {
        const count = filteredRangeWorkouts.filter((w) => getWorkoutDateISO(w) === dateISO).length;
        debugCalendar("[training-plan-pdf] date workout count", { dateISO, count });
      });

      const startDate = new Date(startY, startM - 1, startD);
      const endDate = new Date(endY, endM - 1, endD);
      const firstWeekStartISO = toISODate(startOfWeek(startDate, weekStartsOn));
      const lastWeekStartISO = toISODate(startOfWeek(endDate, weekStartsOn));
      const weekStartISOs: string[] = [];
      for (let cursorISO = firstWeekStartISO; cursorISO <= lastWeekStartISO; cursorISO = shiftISODateByDays(cursorISO, 7)) {
        weekStartISOs.push(cursorISO);
      }
      debugCalendar("[training-plan-pdf] weeks", {
        firstWeekStartISO,
        lastWeekStartISO,
        generatedWeekStarts: weekStartISOs,
      });

      const singleAthleteMileageId =
        selectedAthleteIds.length === 1 ? String(selectedAthleteIds[0] ?? "").trim() : "";
      const suggestedMileageByDateSession = new Map<string, string>();
      if (singleAthleteMileageId) {
        const mileageFirstWeekStartISO = getWeekStartISO(startISO, weekStartsOn);
        const mileageLastWeekStartISO = getWeekStartISO(endISO, weekStartsOn);
        const mileageWeekStarts: string[] = [];
        for (
          let cursorISO = mileageFirstWeekStartISO;
          cursorISO <= mileageLastWeekStartISO;
          cursorISO = shiftISODateByDays(cursorISO, 7)
        ) {
          mileageWeekStarts.push(cursorISO);
        }

        await Promise.all(mileageWeekStarts.map((weekStartISO) => teamDataStore.actions.loadMileageWeek(weekStartISO).catch(() => {})));
        const mileageState = teamDataStore.getState();
        mileageWeekStarts.forEach((weekStartISO) => {
          const weekCells = Array.isArray(mileageState.mileageCellsByWeek[weekStartISO])
            ? mileageState.mileageCellsByWeek[weekStartISO]
            : [];
          weekCells.forEach((cell) => {
            const athleteId = String(cell?.athlete_profile_id ?? "").trim();
            if (athleteId !== singleAthleteMileageId) return;
            const dayIdx = Number(cell?.day_idx);
            if (!Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) return;
            const dateISO = shiftISODateByDays(weekStartISO, dayIdx);
            if (dateISO < startISO || dateISO > endISO) return;
            const resolvedWeekStartISO = getWeekStartISO(dateISO, weekStartsOn);
            const resolvedDayIdx = getWeekIndex(dateISO, resolvedWeekStartISO);
            if (resolvedWeekStartISO !== weekStartISO || resolvedDayIdx !== dayIdx) return;
            const session = normalizeSession(String(cell?.session ?? "PM"));
            const mileageText = String(formatMileageForSheet(cell?.value as any) ?? "").trim();
            if (!mileageText) return;
            suggestedMileageByDateSession.set(trainingPlanMileageSessionKey(dateISO, session), mileageText);
          });
        });
      }

      const rangeFetchStartISO = weekStartISOs[0] ?? startISO;
      const rangeFetchEndISO = weekStartISOs.length > 0
        ? shiftISODateByDays(weekStartISOs[weekStartISOs.length - 1] ?? endISO, 6)
        : endISO;
      const headerRowsByDate = await listTeamWorkoutBatchHeadersInRange(rangeFetchStartISO, rangeFetchEndISO);
      const exportHeaderByKey: Record<string, string> = {};
      const exportHeaderByBaseKey: Record<string, string> = {};
      const exportHeaderByBatchId: Record<string, string> = {};
      headerRowsByDate.forEach((row) => {
        const batchId = String(row.batch_id ?? "").trim();
        if (!batchId) return;
        const value = String(row.header_notes ?? "").trim();
        const key = toWorkoutBatchHeaderNotesKey(row.date_iso, batchId, row.session);
        exportHeaderByKey[key] = value;
        if (value) {
          const baseKey = toWorkoutBatchHeaderNotesBaseKey(row.date_iso, batchId);
          if (!exportHeaderByBaseKey[baseKey]) exportHeaderByBaseKey[baseKey] = value;
          const prev = String(exportHeaderByBatchId[batchId] ?? "").trim();
          if (!prev || value.length > prev.length) exportHeaderByBatchId[batchId] = value;
        }
      });

      const sectionsByWeek = weekStartISOs.map((weekStartISO) => {
        const weekDateISOs = Array.from({ length: 7 }, (_, idx) => shiftISODateByDays(weekStartISO, idx));
        const weekDates = weekDateISOs.map((iso) => {
          const [y, m, d] = iso.split("-").map(Number);
          return new Date(y, (m ?? 1) - 1, d ?? 1);
        });
        const weekEndISO = weekDateISOs[6] ?? "";
        const days = buildWeeklyDaySectionsForExport({
          workouts: filteredRangeWorkouts.filter((w) => isInExportRange(getWorkoutDateISO(w))),
          weekDates,
          weekDateISOs,
          headerByKey: exportHeaderByKey,
          headerByBaseKey: exportHeaderByBaseKey,
          headerByBatchId: exportHeaderByBatchId,
        });
        if (weekStartISO === "2026-11-09" || weekStartISO === "2026-11-16") {
          debugCalendar("[training-plan-pdf][debug] map-keys", {
            weekStartISO,
            exactCount: Object.keys(exportHeaderByKey).length,
            baseCount: Object.keys(exportHeaderByBaseKey).length,
            batchCount: Object.keys(exportHeaderByBatchId).length,
            exactKeysSample: Object.keys(exportHeaderByKey)
              .filter((key) => key.startsWith("2026-11-"))
              .slice(0, 50),
          });
          debugCalendar("[training-plan-pdf][debug] sections-before", {
            weekStartISO,
            sections: summarizeWeeklySectionDetails(days),
          });
        }
        const daysWithHeaderOverrides = applyHeaderNotesToWeeklySections(
          days,
          exportHeaderByKey,
          exportHeaderByBaseKey,
          exportHeaderByBatchId
        );
        if (weekStartISO === "2026-11-09" || weekStartISO === "2026-11-16") {
          debugCalendar("[training-plan-pdf][debug] sections-after", {
            weekStartISO,
            sections: summarizeWeeklySectionDetails(daysWithHeaderOverrides),
          });
        }

        return {
          weekStartISO,
          weekLabel: `${weekDates[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${weekDates[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`,
          days: daysWithHeaderOverrides.map((day) =>
            !isInExportRange(day.dateISO) ? { ...day, workouts: [] } : day
          ),
          weekEndISO,
        };
      });
      const may11Week = sectionsByWeek.find((week) => week.weekStartISO === "2026-05-11");
      debugCalendar("[training-plan-pdf] bucket counts week of May 11", {
        weekFound: !!may11Week,
        countsByDate: may11Week
          ? may11Week.days.reduce<Record<string, number>>((acc, day) => {
              acc[day.dateISO] = day.workouts.length;
              return acc;
            }, {})
          : null,
      });

      const exportWeeksBase: TrainingPlanWeekSection[] = sectionsByWeek.map((week) => ({
        weekStartISO: week.weekStartISO,
        weekLabel: week.weekLabel,
        days: week.days,
      }));
      const exportWeeks = singleAthleteMileageId
        ? applySuggestedMileageToTrainingPlanWeeks(exportWeeksBase, suggestedMileageByDateSession)
        : exportWeeksBase;

      const generatedAtLabel = new Date().toLocaleString();
      const html = buildTrainingPlanRangeHtml({
        title: "Training Plan",
        rangeLabel: formatTrainingPlanRangeLabel(startISO, endISO),
        generatedAtLabel,
        weeks: exportWeeks,
        categories,
      });

      if (Platform.OS === "web") {
        printHtmlInWebWindow(html);
        Alert.alert("Export PDF", "Print dialog opened.");
      } else {
        const result = await Print.printToFileAsync({ html });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) await Sharing.shareAsync(result.uri);
        else Alert.alert("PDF created", result.uri);
      }
      await AsyncStorage.setItem(
        COACH_TRAINING_PLAN_EXPORT_RANGE_KEY,
        JSON.stringify({
          startDateISO: startISO,
          endDateISO: endISO,
          seasonId: trainingPlanExportSeasonId ?? null,
        })
      ).catch(() => {});
      setTrainingPlanExportOpen(false);
    } catch (e: any) {
      const message = String(e?.message ?? "Could not export training plan PDF.");
      setTrainingPlanExportError(message);
      Alert.alert("Export failed", message);
    } finally {
      setExportingTrainingPlanPdf(false);
    }
  }, [
    athleteSeasonOverridesBySeasonAndAthlete,
    athleteFilterOptions,
    categories,
    exportEndDateISO,
    exportStartDateISO,
    exportingTrainingPlanPdf,
    rosterNameById,
    selectedAthleteIds,
    selectedSeason,
    selectedTrainingGroupAthleteIds,
    selectedTrainingGroupIds.length,
    trainingPlanExportSeasonId,
    weekStartsOn,
  ]);

  const persistWeekLabelDraft = useCallback(async (targetWeekStartISO: string, nextDraftRaw: string) => {
    const seq = ++weekLabelSaveSeqRef.current;
    setWeekLabelSaveState("saving");
    try {
      const next = await saveCoachWeekLabel(targetWeekStartISO, nextDraftRaw);
      if (seq !== weekLabelSaveSeqRef.current) return;
      setWeekLabelsByStart(next ?? {});
      setWeekLabelSaveState("saved");
    } catch (error: any) {
      if (seq !== weekLabelSaveSeqRef.current) return;
      setWeekLabelSaveState("error");
      Alert.alert("Week label", String(error?.message ?? "Could not save week label."));
    }
  }, []);

  useEffect(() => {
    if (calendarMode !== "week" || !isWeekLabelEditing) return;
    if (weekLabelEditingWeekRef.current !== currentWeekStartISO) return;
    if (weekLabelDraft === currentWeekAnnotation) return;

    if (weekLabelSaveTimerRef.current) clearTimeout(weekLabelSaveTimerRef.current);
    setWeekLabelSaveState("idle");
    weekLabelSaveTimerRef.current = setTimeout(() => {
      weekLabelSaveTimerRef.current = null;
      void persistWeekLabelDraft(currentWeekStartISO, weekLabelDraft);
    }, 650);

    return () => {
      if (weekLabelSaveTimerRef.current) {
        clearTimeout(weekLabelSaveTimerRef.current);
        weekLabelSaveTimerRef.current = null;
      }
    };
  }, [calendarMode, currentWeekAnnotation, currentWeekStartISO, isWeekLabelEditing, persistWeekLabelDraft, weekLabelDraft]);

  const handleWeekLabelFocus = useCallback(() => {
    weekLabelEditingWeekRef.current = currentWeekStartISO;
    setIsWeekLabelEditing(true);
    setWeekLabelSaveState("idle");
  }, [currentWeekStartISO]);

  const handleWeekLabelBlur = useCallback(() => {
    if (weekLabelSaveTimerRef.current) {
      clearTimeout(weekLabelSaveTimerRef.current);
      weekLabelSaveTimerRef.current = null;
    }
    const editingWeek = weekLabelEditingWeekRef.current;
    const draftAtBlur = weekLabelDraft;
    const savedAtBlur = currentWeekAnnotation;
    setIsWeekLabelEditing(false);
    weekLabelEditingWeekRef.current = null;
    if (editingWeek && draftAtBlur !== savedAtBlur) {
      void persistWeekLabelDraft(editingWeek, draftAtBlur);
    }
  }, [currentWeekAnnotation, persistWeekLabelDraft, weekLabelDraft]);

  const runCopyWeekFromSource = useCallback(async (sourceWeekStartISO: string) => {
    if (copyingWeek || clearingWeek) return;
    const normalizedSourceWeekStartISO = String(sourceWeekStartISO ?? "").trim();
    if (!isValidISODate(normalizedSourceWeekStartISO)) {
      Alert.alert("Copy Week", "Please choose a valid source week.");
      return;
    }
    debugCalendar("[coach-calendar] runCopyWeekFromSource start");
    setCopyingWeek(true);
    try {
      const currentWeekStartISO = toISODate(anchorWeekStart);
      const sourceWeekEndISO = toISODate(addDays(parseISODate(normalizedSourceWeekStartISO), 6));
      const sourceWeekRows = await listTeamWorkoutsInRange(normalizedSourceWeekStartISO, sourceWeekEndISO);
      debugCalendar("[coach-calendar] copy week range", {
        currentWeekStartISO,
        sourceWeekStartISO: normalizedSourceWeekStartISO,
        sourceWeekEndISO,
      });

      if (!Array.isArray(sourceWeekRows) || sourceWeekRows.length === 0) {
        Alert.alert("Copy Week", "No workouts found in the selected source week.");
        return;
      }

      const sourceHeaderRows = await listTeamWorkoutBatchHeadersInRange(
        normalizedSourceWeekStartISO,
        sourceWeekEndISO
      ).catch(() => []);
      const sourceMainNotesByBatchId = new Map<string, string>();
      const sourceMainNotesByBatchAndDate = new Map<string, string>();
      sourceHeaderRows.forEach((headerRow) => {
          const batchId = String(headerRow.batch_id ?? "").trim();
          const dateISO = String(headerRow.date_iso ?? "").trim();
          const notes = String(headerRow.header_notes ?? "").trim();
          if (!batchId || !dateISO || !notes || notes.toLowerCase() === "no notes") return;
          const byDateKey = `${batchId}::${dateISO}`;
          const prevByDate = String(sourceMainNotesByBatchAndDate.get(byDateKey) ?? "").trim();
          if (!prevByDate || notes.length > prevByDate.length) sourceMainNotesByBatchAndDate.set(byDateKey, notes);
          const prevByBatch = String(sourceMainNotesByBatchId.get(batchId) ?? "").trim();
          if (!prevByBatch || notes.length > prevByBatch.length) sourceMainNotesByBatchId.set(batchId, notes);
      });
      debugCalendar(
        "[coach-calendar] copy week source dates",
        sourceWeekRows.slice(0, 6).map((row) => String(row.date_iso ?? ""))
      );

      const copiedBatchIdBySourceBatchId = new Map<string, string>();
      const copiedHeaderNotesByBatchDateKey = new Map<string, { batchId: string; dateISO: string; notes: string }>();
      const mappedDateSamples: Array<{ source: string; dest: string; offsetDays: number }> = [];
      const insertRows = sourceWeekRows.map((row) => {
        const sourceBatchId = String(row.batch_id ?? "").trim();
        let nextBatchId: string | null = null;
        if (sourceBatchId) {
          let mapped = copiedBatchIdBySourceBatchId.get(sourceBatchId);
          if (!mapped) {
            mapped = generateCopiedBatchId();
            copiedBatchIdBySourceBatchId.set(sourceBatchId, mapped);
          }
          nextBatchId = mapped;
        }
        const sourceDateISO = String(row.date_iso ?? "");
        const offsetDays = diffISODateDays(normalizedSourceWeekStartISO, sourceDateISO);
        const nextDateISO = shiftISODateByDays(currentWeekStartISO, offsetDays);
        if (sourceBatchId && nextBatchId) {
          const notesByDateKey = `${sourceBatchId}::${sourceDateISO}`;
          const fromHeaderByDate = String(sourceMainNotesByBatchAndDate.get(notesByDateKey) ?? "").trim();
          const fromHeaderByBatch = String(sourceMainNotesByBatchId.get(sourceBatchId) ?? "").trim();
          const fromRowDetails = String(row.details ?? "").trim();
          const sourceMainNotes = [fromHeaderByDate, fromHeaderByBatch, fromRowDetails]
            .map((value) => String(value ?? "").trim())
            .find((value) => value.length > 0 && value.toLowerCase() !== "no notes");
          if (sourceMainNotes) {
            copiedHeaderNotesByBatchDateKey.set(`${nextBatchId}::${nextDateISO}`, {
              batchId: nextBatchId,
              dateISO: nextDateISO,
              notes: sourceMainNotes,
            });
          }
        }
        if (mappedDateSamples.length < 6) {
          mappedDateSamples.push({ source: sourceDateISO, dest: nextDateISO, offsetDays });
        }

        return {
          athlete_profile_id: String(row.athlete_profile_id ?? ""),
          created_by: row.created_by ?? null,
          date_iso: nextDateISO,
          session: String(row.session ?? "").toUpperCase() === "AM" ? ("AM" as const) : ("PM" as const),
          location: row.location ?? null,
          time_text: row.time_text ?? null,
          title: String(row.title ?? "").trim() || "Workout",
          details: row.details ?? null,
          primary_category: row.primary_category ?? null,
          categories: Array.isArray(row.categories) ? row.categories.map((c) => String(c ?? "").trim()).filter(Boolean) : [],
          batch_id: nextBatchId,
          group_id: row.group_id ?? null,
          pre_routine_ids: Array.isArray(row.pre_routine_ids) ? row.pre_routine_ids.map((id) => String(id ?? "").trim()).filter(Boolean) : null,
          post_routine_ids: Array.isArray(row.post_routine_ids) ? row.post_routine_ids.map((id) => String(id ?? "").trim()).filter(Boolean) : null,
          planned_distance: typeof row.planned_distance === "number" ? row.planned_distance : null,
          planned_distance_unit:
            row.planned_distance_unit === "mi" || row.planned_distance_unit === "km" ? row.planned_distance_unit : null,
        };
      });
      debugCalendar("[coach-calendar] copy week mapped dates", mappedDateSamples);
      debugCalendar("[coach-calendar] copy week insert count", { count: insertRows.length });
      debugCalendar("[coach-calendar] copy week notes save keys", {
        count: copiedHeaderNotesByBatchDateKey.size,
        sample: Array.from(copiedHeaderNotesByBatchDateKey.values())
          .slice(0, 8)
          .map((item) => ({ batchId: item.batchId, dateISO: item.dateISO, notes: item.notes })),
      });

      await createTeamWorkoutBatch(insertRows);
      const copiedBatchMainNotesWrites = Array.from(copiedHeaderNotesByBatchDateKey.values()).map((item) =>
        Promise.all([
          saveTeamWorkoutBatchHeaderNotes({
            batch_id: item.batchId,
            date_iso: item.dateISO,
            session: "AM",
            header_notes: item.notes,
          }),
          saveTeamWorkoutBatchHeaderNotes({
            batch_id: item.batchId,
            date_iso: item.dateISO,
            session: "PM",
            header_notes: item.notes,
          }),
        ])
      );
      if (copiedBatchMainNotesWrites.length > 0) {
        await Promise.all(copiedBatchMainNotesWrites);
      }
      await loadCalendarData({ force: true });
      Alert.alert(
        "Copy Week",
        `Copied ${insertRows.length} workout${insertRows.length === 1 ? "" : "s"} into week of ${currentWeekStartISO}.`
      );
    } catch (error: any) {
      Alert.alert("Copy failed", String(error?.message ?? "Could not copy week."));
    } finally {
      setCopyingWeek(false);
    }
  }, [anchorWeekStart, clearingWeek, copyingWeek, loadCalendarData]);

  const openCopyWeekModal = useCallback(() => {
    if (calendarMode !== "week" || copyingWeek || clearingWeek) return;
    setCopySourceDateInput(toISODate(addDays(anchorWeekStart, -7)));
    setCopyWeekError(null);
    setCopyWeekModalOpen(true);
  }, [anchorWeekStart, calendarMode, clearingWeek, copyingWeek]);

  const shiftCopySourceWeek = useCallback((deltaWeeks: number) => {
    const baseISO =
      copySourceWeekStartISO && isValidISODate(copySourceWeekStartISO)
        ? copySourceWeekStartISO
        : toISODate(addDays(anchorWeekStart, -7));
    const nextISO = toISODate(addDays(parseISODate(baseISO), deltaWeeks * 7));
    setCopySourceDateInput(nextISO);
    setCopyWeekError(null);
  }, [anchorWeekStart, copySourceWeekStartISO]);

  const confirmCopyWeek = useCallback(() => {
    if (!copySourceWeekStartISO || !isValidISODate(copySourceWeekStartISO)) {
      setCopyWeekError("Choose a valid source week date (YYYY-MM-DD).");
      return;
    }
    if (copySourceWeekStartISO === currentWeekStartISO) {
      setCopyWeekError("Source week and target week cannot be the same.");
      return;
    }
    setCopyWeekError(null);
    const message = `Copy all workouts from ${copySourceWeekLabel} into ${copyTargetWeekLabel}? This will add workouts to the target week. Existing workouts will not be removed.`;
    if (Platform.OS === "web") {
      const confirmed = window.confirm(message);
      if (confirmed) {
        setCopyWeekModalOpen(false);
        void runCopyWeekFromSource(copySourceWeekStartISO);
      }
      return;
    }
    Alert.alert("Copy Week", message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Copy Week",
        onPress: () => {
          setCopyWeekModalOpen(false);
          void runCopyWeekFromSource(copySourceWeekStartISO);
        },
      },
    ]);
  }, [copySourceWeekLabel, copySourceWeekStartISO, copyTargetWeekLabel, currentWeekStartISO, runCopyWeekFromSource]);

  const runClearThisWeek = useCallback(async () => {
    if (copyingWeek || clearingWeek) return;
    debugCalendar("[coach-calendar] runClearThisWeek start");
    setClearingWeek(true);
    try {
      const currentWeekStartISO = toISODate(anchorWeekStart);
      const currentWeekEndISO = toISODate(addDays(anchorWeekStart, 6));
      const currentWeekRows = await listTeamWorkoutsInRange(currentWeekStartISO, currentWeekEndISO);

      if (!Array.isArray(currentWeekRows) || currentWeekRows.length === 0) {
        Alert.alert("Clear This Week", "No workouts found in this week.");
        return;
      }

      const batchIds = new Set<string>();
      const singleRowIds: string[] = [];
      currentWeekRows.forEach((row) => {
        const batchId = String(row.batch_id ?? "").trim();
        if (batchId) {
          batchIds.add(batchId);
        } else {
          singleRowIds.push(String(row.id ?? ""));
        }
      });

      for (const batchId of batchIds) {
        await deleteWorkoutBatch(batchId);
      }
      for (const rowId of singleRowIds) {
        if (!rowId) continue;
        await deleteTeamWorkout(rowId);
      }

      await loadCalendarData({ force: true });
      Alert.alert("Clear This Week", "All workouts for the visible week were removed.");
    } catch (error: any) {
      Alert.alert("Clear failed", String(error?.message ?? "Could not clear this week."));
    } finally {
      setClearingWeek(false);
    }
  }, [anchorWeekStart, clearingWeek, copyingWeek, loadCalendarData]);

  const handleClearThisWeek = useCallback(() => {
    if (calendarMode !== "week" || copyingWeek || clearingWeek) return;
    if (Platform.OS === "web") {
      const confirmed = window.confirm("Delete all workouts in the currently visible week? This cannot be undone.");
      if (confirmed) {
        void runClearThisWeek();
      }
      return;
    }
    Alert.alert(
      "Clear This Week",
      "Delete all workouts in the currently visible week? This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void runClearThisWeek() },
      ]
    );
  }, [calendarMode, clearingWeek, copyingWeek, runClearThisWeek]);

  return (
    <View style={styles.container}>
      <View style={[styles.headerCard, calendarMode === "month" && isWebDesktop && styles.monthDesktopInset]}>
        <View style={styles.headerTopRow}>
          <View style={styles.headerLeftGroup}>
            <Pressable onPress={() => commitSwipe("prev")} style={styles.todayBtn}>
              <Text style={styles.todayBtnText}>Prev</Text>
            </Pressable>
            {calendarMode === "week" ? (
              <View style={styles.weekLabelInlineWrap}>
                <Text style={styles.weekLabelInlineLabel}>Week label</Text>
                <TextInput
                  value={weekLabelDraft}
                  onChangeText={setWeekLabelDraft}
                  placeholder="Week label"
                  autoCorrect={false}
                  onFocus={handleWeekLabelFocus}
                  onBlur={handleWeekLabelBlur}
                  editable={canEditCalendarTraining}
                  style={[styles.weekLabelInlineInput, { borderColor: activeWeekToneColors.border }]}
                />
                <Text style={styles.weekLabelSaveText}>
                  {weekLabelSaveState === "saving"
                    ? "Saving..."
                    : weekLabelSaveState === "saved"
                      ? "Saved"
                      : weekLabelSaveState === "error"
                        ? "Error"
                        : ""}
                </Text>
                <View style={[styles.weekLabelToneChip, { borderColor: activeWeekToneColors.border, backgroundColor: activeWeekToneColors.bg }]}>
                  <Text style={[styles.weekLabelToneChipText, { color: activeWeekToneColors.text }]}>
                    {activeWeekLabelToneText}
                  </Text>
                </View>
              </View>
            ) : null}
          </View>

          <View style={styles.headerCenter}>
            <Text style={styles.monthLabel}>{calendarMode === "month" ? monthLabel : weekLabel}</Text>
            {calendarMode === "month" ? (
              <Text style={styles.subLabel}>Tap a day to view all workouts</Text>
            ) : null}
            {calendarMode === "week" ? (
              <View
                style={{
                  marginTop: 2,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor:
                    relativeWeekStatus.status === "current"
                      ? "rgba(34,197,94,0.35)"
                      : relativeWeekStatus.status === "past"
                        ? "rgba(100,116,139,0.35)"
                        : "rgba(245,158,11,0.4)",
                  backgroundColor:
                    relativeWeekStatus.status === "current"
                      ? "rgba(34,197,94,0.12)"
                      : relativeWeekStatus.status === "past"
                        ? "rgba(100,116,139,0.1)"
                        : "rgba(245,158,11,0.12)",
                }}
              >
                <Text
                  style={{
                    fontSize: 10,
                    fontWeight: "800",
                    color:
                      relativeWeekStatus.status === "current"
                        ? "#166534"
                        : relativeWeekStatus.status === "past"
                          ? "#64748b"
                          : "#b45309",
                  }}
                >
                  {relativeWeekStatus.label}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.headerRight}>
            {canEditCalendarTraining ? (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/(coach)/(tabs)/planner",
                    params: { date: quickNewSessionDateISO, returnTo: "calendar" },
                  })
                }
                style={styles.createSessionTopBtn}
              >
                <Ionicons name="create-outline" size={12} color="#fff" />
                <Text style={styles.createSessionTopBtnText}>Create Session</Text>
              </Pressable>
            ) : null}
            {calendarMode === "week" ? (
              <>
                {canPublishCalendarTraining ? (
                  <View style={styles.visibilityControl}>
                  {calendarWeekVisibilityStatus === "mixed" ? (
                    <View style={[styles.weekVisibilityBadge, styles.weekVisibilityBadgeMixed]}>
                      <Text style={[styles.weekVisibilityBadgeText, styles.weekVisibilityBadgeTextMixed]}>
                        Mixed visibility
                      </Text>
                    </View>
                  ) : calendarWeekVisibilityStatus === "published" ? (
                    <View style={[styles.weekVisibilityBadge, styles.weekVisibilityBadgePublished]}>
                      <Text style={[styles.weekVisibilityBadgeText, styles.weekVisibilityBadgeTextPublished]}>
                        Published
                      </Text>
                    </View>
                  ) : calendarWeekVisibilityStatus === "empty" ? (
                    <Text style={styles.visibilityText}>{calendarWeekVisibilityLabel}</Text>
                  ) : null}
                  <Pressable
                    onPress={() => openTrainingVisibilityModal("workouts")}
                    style={styles.visibilityBtn}
                  >
                    <Text style={styles.visibilityBtnText}>Visibility</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void setCalendarWeekVisibility(true)}
                    disabled={weekVisibilityBusy || displayedWeekWorkouts.length === 0}
                    style={[styles.visibilityBtn, (weekVisibilityBusy || displayedWeekWorkouts.length === 0) && styles.visibilityBtnDisabled]}
                  >
                    <Text style={styles.visibilityBtnText}>Publish Week</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void setCalendarWeekVisibility(false)}
                    disabled={weekVisibilityBusy || displayedWeekWorkouts.length === 0}
                    style={[styles.visibilityBtn, (weekVisibilityBusy || displayedWeekWorkouts.length === 0) && styles.visibilityBtnDisabled]}
                  >
                    <Text style={styles.visibilityBtnText}>Hide Week</Text>
                  </Pressable>
                  </View>
                ) : null}
                <Pressable onPress={goToToday} style={styles.todayBtn}>
                  <Text style={styles.todayBtnText}>Current Week</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setJumpDateInput(currentWeekStartISO);
                    setJumpToWeekOpen((prev) => !prev);
                  }}
                  style={styles.todayBtn}
                >
                  <Text style={styles.todayBtnText}>{jumpToWeekOpen ? "Cancel Jump" : "Jump to Week"}</Text>
                </Pressable>
              </>
            ) : (
              <Pressable onPress={goToToday} style={styles.todayBtn}>
                <Text style={styles.todayBtnText}>Today</Text>
              </Pressable>
            )}
            <Pressable onPress={() => commitSwipe("next")} style={styles.todayBtn}>
              <Text style={styles.todayBtnText}>Next</Text>
            </Pressable>
          </View>
        </View>

        {calendarMode === "week" && jumpToWeekOpen ? (
          <View style={styles.jumpWeekPanel}>
            <Text style={styles.jumpWeekHint}>Enter any date (YYYY-MM-DD) to jump to that week</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <TextInput
                value={jumpDateInput}
                onChangeText={setJumpDateInput}
                placeholder="YYYY-MM-DD"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.jumpWeekInput}
              />
              <Pressable onPress={applyJumpToWeekInput} style={styles.todayBtn}>
                <Text style={styles.todayBtnText}>Go</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {calendarMode === "week" && calendarWeekVisibilityStatus === "hidden" ? (
          <View style={styles.weekHiddenBanner}>
            <View style={styles.weekHiddenBannerIcon}>
              <Ionicons name="eye-off-outline" size={16} color="#991b1b" />
            </View>
            <View style={styles.weekHiddenBannerCopy}>
              <Text style={styles.weekHiddenBannerTitle}>Hidden from athletes</Text>
              <Text style={styles.weekHiddenBannerText}>Coaches can still view and edit this week.</Text>
            </View>
          </View>
        ) : calendarMode === "week" && calendarWeekVisibilityStatus === "mixed" ? (
          <View style={styles.weekMixedNotice}>
            <View style={[styles.weekVisibilityBadge, styles.weekVisibilityBadgeMixed]}>
              <Text style={[styles.weekVisibilityBadgeText, styles.weekVisibilityBadgeTextMixed]}>
                Mixed visibility
              </Text>
            </View>
            <Text style={styles.weekMixedNoticeText}>Some workouts are hidden from athletes.</Text>
          </View>
        ) : null}

        {calendarMode === "week" && !canEditCalendarTraining ? (
          <View style={styles.readOnlyNotice}>
            <Text style={styles.readOnlyNoticeText}>Viewer access: editing is disabled.</Text>
          </View>
        ) : null}

        {calendarMode === "week" ? (
          <View style={styles.weekActionsRow}>
            {canEditCalendarTraining ? (
              <>
                <Pressable onPress={openCopyWeekModal} style={styles.todayBtn} disabled={copyingWeek || clearingWeek}>
                  <Text style={styles.todayBtnText}>{copyingWeek ? "Copying..." : "Copy Week..."}</Text>
                </Pressable>
                <Pressable onPress={handleClearThisWeek} style={styles.todayBtn} disabled={copyingWeek || clearingWeek}>
                  <Text style={styles.todayBtnText}>{clearingWeek ? "Clearing..." : "Clear This Week"}</Text>
                </Pressable>
              </>
            ) : null}
            {canExportCalendar ? (
              <>
                <Pressable onPress={() => void handleExportWeekPdf()} style={styles.todayBtn} disabled={exportingPdf || copyingWeek || clearingWeek}>
                  <Text style={styles.todayBtnText}>{exportingPdf ? "Exporting..." : "Export PDF"}</Text>
                </Pressable>
                <Pressable onPress={openTrainingPlanExport} style={styles.todayBtn} disabled={exportingTrainingPlanPdf || copyingWeek || clearingWeek}>
                  <Text style={styles.todayBtnText}>{exportingTrainingPlanPdf ? "Exporting..." : "Export Training Plan"}</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={[styles.modeRow, calendarMode === "month" && isWebDesktop && styles.monthDesktopInset]}>
        <Pressable
          onPress={() => setCalendarMode("month")}
          style={[styles.modePill, calendarMode === "month" && styles.modePillActive]}
        >
          <Text style={[styles.modePillText, calendarMode === "month" && styles.modePillTextActive]}>Monthly</Text>
        </Pressable>
        <Pressable
          onPress={() => setCalendarMode("week")}
          style={[styles.modePill, calendarMode === "week" && styles.modePillActive]}
        >
          <Text style={[styles.modePillText, calendarMode === "week" && styles.modePillTextActive]}>Weekly</Text>
        </Pressable>
        <View style={styles.athleteFilterWrap}>
          <Text style={styles.athleteFilterLabel}>Athletes</Text>
          <Pressable
            onPress={() => setAthleteFilterOpen((prev) => !prev)}
            style={styles.athleteFilterTrigger}
          >
            <Text numberOfLines={1} style={styles.athleteFilterTriggerText}>
              {selectedAthleteLabel}
            </Text>
            <Text style={styles.athleteFilterChevron}>{athleteFilterOpen ? "▴" : "▾"}</Text>
          </Pressable>
          {athleteFilterOpen ? (
            <View style={styles.athleteFilterMenu}>
              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 230 }}>
                <Pressable
                  onPress={() => {
                    setSelectedAthleteIds([]);
                    setAthleteFilterOpen(false);
                  }}
                  style={[
                    styles.athleteFilterItem,
                    selectedAthleteIds.length === 0 && styles.athleteFilterItemSelected,
                  ]}
                >
                  <Text style={styles.athleteFilterItemText}>All athletes (clear)</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setSelectedAthleteIds(athleteFilterOptions.map((option) => option.id));
                    setAthleteFilterOpen(false);
                  }}
                  style={styles.athleteFilterItem}
                >
                  <Text style={styles.athleteFilterItemText}>Select all</Text>
                </Pressable>
                {athleteFilterOptions.map((option) => (
                  <Pressable
                    key={`calendar-filter-${option.id}`}
                    onPress={() => {
                      setSelectedAthleteIds((prev) =>
                        prev.includes(option.id)
                          ? prev.filter((id) => id !== option.id)
                          : [...prev, option.id]
                      );
                    }}
                    style={[
                      styles.athleteFilterItem,
                      selectedAthleteIds.includes(option.id) && styles.athleteFilterItemSelected,
                    ]}
                  >
                    <Text style={styles.athleteFilterItemText}>
                      {selectedAthleteIds.includes(option.id) ? "☑ " : "☐ "}
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}
        </View>
        <View style={styles.groupFilterWrap}>
          <Text style={styles.groupFilterLabel}>Groups</Text>
          <Pressable
            onPress={() => setTrainingGroupFilterOpen((prev) => !prev)}
            style={styles.groupFilterTrigger}
          >
            <Text numberOfLines={1} style={styles.groupFilterTriggerText}>
              {selectedTrainingGroupLabel}
            </Text>
            <Text style={styles.groupFilterChevron}>{trainingGroupFilterOpen ? "▴" : "▾"}</Text>
          </Pressable>
          {trainingGroupFilterOpen ? (
            <View style={styles.groupFilterMenu}>
              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 230 }}>
                <Pressable
                  onPress={() => {
                    void teamDataStore.actions.setSharedSelectedTrainingGroupIds([]);
                    setTrainingGroupFilterOpen(false);
                  }}
                  style={[
                    styles.groupFilterItem,
                    selectedTrainingGroupIds.length === 0 && styles.groupFilterItemSelected,
                  ]}
                >
                  <Text style={styles.groupFilterItemText}>All groups (clear)</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    void teamDataStore.actions.setSharedSelectedTrainingGroupIds(
                      trainingGroupFilterOptions.map((option) => option.id)
                    );
                    setTrainingGroupFilterOpen(false);
                  }}
                  style={styles.groupFilterItem}
                >
                  <Text style={styles.groupFilterItemText}>Select all</Text>
                </Pressable>
                {trainingGroupFilterOptions.map((option) => (
                  <Pressable
                    key={`calendar-group-filter-${option.id}`}
                    onPress={() => {
                      const next = selectedTrainingGroupIds.includes(option.id)
                        ? selectedTrainingGroupIds.filter((id) => id !== option.id)
                        : [...selectedTrainingGroupIds, option.id];
                      void teamDataStore.actions.setSharedSelectedTrainingGroupIds(next);
                    }}
                    style={[
                      styles.groupFilterItem,
                      selectedTrainingGroupIds.includes(option.id) && styles.groupFilterItemSelected,
                    ]}
                  >
                    <Text style={styles.groupFilterItemText}>
                      {selectedTrainingGroupIds.includes(option.id) ? "☑ " : "☐ "}
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}
        </View>
        <View style={styles.groupFilterWrap}>
          <Text style={styles.groupFilterLabel}>Season</Text>
          <Pressable
            onPress={() => setSeasonFilterOpen((prev) => !prev)}
            style={styles.groupFilterTrigger}
          >
            <Text numberOfLines={1} style={styles.groupFilterTriggerText}>
              {selectedSeasonLabel}
            </Text>
            <Text style={styles.groupFilterChevron}>{seasonFilterOpen ? "▴" : "▾"}</Text>
          </Pressable>
          {seasonFilterOpen ? (
            <View style={styles.groupFilterMenu}>
              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 230 }}>
                <Pressable
                  onPress={() => {
                    void teamDataStore.actions.setSharedSelectedSeasonId(null);
                    setSeasonFilterOpen(false);
                  }}
                  style={[
                    styles.groupFilterItem,
                    !selectedSeasonId && styles.groupFilterItemSelected,
                  ]}
                >
                  <Text style={styles.groupFilterItemText}>All seasons (clear)</Text>
                </Pressable>
                {seasonFilterOptions.map((option) => (
                  <Pressable
                    key={`calendar-season-filter-${option.id}`}
                    onPress={() => {
                      void teamDataStore.actions.setSharedSelectedSeasonId(option.id);
                      setSeasonFilterOpen(false);
                    }}
                    style={[
                      styles.groupFilterItem,
                      selectedSeasonId === option.id && styles.groupFilterItemSelected,
                    ]}
                  >
                    <Text style={styles.groupFilterItemText}>
                      {selectedSeasonId === option.id ? "◉ " : "○ "}
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}
          <Text style={{ fontSize: 10, fontWeight: "700", color: "#64748b", marginTop: 4, marginLeft: 4 }}>
            Uses athlete-specific dates where set.
          </Text>
        </View>
      </View>

      {calendarMode === "month" ? (
        isWebDesktop ? (
          <>
            <View style={[styles.weekdayRow, styles.monthWeekdayRowDense]}>
              {weekdayLabels.map((d) => (
                <Text key={d} style={[styles.weekdayText, styles.monthWeekdayTextDense]}>
                  {d}
                </Text>
              ))}
            </View>

            <View style={styles.monthSheet}>
              {monthRows.map((row, rowIndex) => (
                <View key={`row-${rowIndex}`} style={[styles.monthSheetRow, rowIndex === 5 && styles.monthSheetRowLast]}>
                  {row.map((cell, cellIndex) => {
                    const iso = cell.dateISO;
                    const summaries = weeklyTitleRowsByDate.get(iso) ?? [];
                    const visibleSummaries = summaries.slice(0, 4);
                    const hiddenSummaryCount = Math.max(0, summaries.length - visibleSummaries.length);
                    const rowWeekStartISO = row[0]?.dateISO ?? "";
                    const rowWeekLabel = String(weekLabelsByStart[rowWeekStartISO] ?? "").trim();
                    const rowWeekTone = getWeekLabelTone(rowWeekLabel);
                    const rowWeekToneColors = getWeekLabelToneColors(rowWeekTone);
                    const showWeekTab = cellIndex === 0;
                    return (
                      <Pressable
                        key={iso}
                        onPress={() =>
                          router.push({
                            pathname: "/(coach)/workouts",
                            params: { date: iso },
                          })
                        }
                        style={({ pressed }) => [
                          styles.monthSheetCell,
                          cellIndex === 6 && styles.monthSheetCellLast,
                          showWeekTab && styles.monthSheetCellWithWeekLabel,
                          !cell.inMonth && styles.outsideMonth,
                          iso === todayISO && styles.todayCell,
                          pressed && styles.pressed,
                        ]}
                      >
                        {showWeekTab ? (
                          <View
                            style={[
                              styles.monthWeekLabelRail,
                              rowWeekLabel
                                ? {
                                    borderColor: rowWeekToneColors.border,
                                    backgroundColor: rowWeekToneColors.bg,
                                  }
                                : styles.monthWeekLabelRailEmpty,
                            ]}
                          >
                            {rowWeekLabel ? (
                              <Text
                                style={[
                                  styles.monthWeekLabelRailText,
                                  { color: rowWeekToneColors.text },
                                ]}
                              >
                                {rowWeekLabel}
                              </Text>
                            ) : null}
                          </View>
                        ) : null}
                        <View style={styles.monthDayTopRow}>
                          <Text style={[styles.dayNum, !cell.inMonth && styles.dayNumMuted]}>{cell.dayNumber}</Text>
                        </View>
                        {visibleSummaries.map((rowItem, idx) => (
                          <View key={`${iso}-summary-${idx}`} style={styles.monthSummaryRow}>
                            <MonthWorkoutDot colors={rowItem.dotColors} />
                            <Text numberOfLines={1} style={styles.monthSummaryText}>
                              {rowItem.title}
                              {rowItem.count > 1 ? ` (${rowItem.count})` : ""}
                            </Text>
                          </View>
                        ))}
                        {hiddenSummaryCount > 0 ? (
                          <Text style={styles.monthOverflowCount}>+{hiddenSummaryCount}</Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
          </>
        ) : (
          <>
            <View style={styles.weekdayRow}>
              {weekdayLabels.map((d) => (
                <Text key={d} style={styles.weekdayText}>
                  {d}
                </Text>
              ))}
            </View>

            <GestureDetector gesture={pan}>
              <Animated.View style={[styles.gridWrap, animatedStyle]}>
                <View style={styles.grid}>
                  {monthRows.map((row, rowIndex) => (
                    <View key={`row-${rowIndex}`} style={styles.weekRow}>
                      {row.map((cell, cellIndex) => {
                        const iso = cell.dateISO;
                        const workoutCount = workoutCountByDate.get(iso) ?? 0;
                        const rowWeekStartISO = row[0]?.dateISO ?? "";
                        const rowWeekLabel = String(weekLabelsByStart[rowWeekStartISO] ?? "").trim();
                        const rowWeekTone = getWeekLabelTone(rowWeekLabel);
                        const rowWeekToneColors = getWeekLabelToneColors(rowWeekTone);
                        const showRowWeekLabel = cellIndex === 0 && !!rowWeekLabel;

                        return (
                          <Pressable
                            key={iso}
                            onPress={() =>
                              router.push({
                                pathname: "/(coach)/workouts",
                                params: { date: iso },
                              })
                            }
                            style={({ pressed }) => [
                              styles.cell,
                              showRowWeekLabel && styles.monthCellWithWeekLabel,
                              cellIndex < 6 && styles.cellGapRight,
                              !cell.inMonth && styles.outsideMonth,
                              iso === todayISO && styles.todayCell,
                              pressed && styles.pressed,
                              styles.emptyCell,
                            ]}
                          >
                            {showRowWeekLabel ? (
                              <View
                                style={[
                                  styles.monthWeekLabelRail,
                                  {
                                    borderColor: rowWeekToneColors.border,
                                    backgroundColor: rowWeekToneColors.bg,
                                  },
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.monthWeekLabelRailText,
                                    { color: rowWeekToneColors.text },
                                  ]}
                                >
                                  {rowWeekLabel}
                                </Text>
                              </View>
                            ) : null}
                            <Text style={[styles.dayNum, !cell.inMonth && styles.dayNumMuted]}>{cell.dayNumber}</Text>
                            {workoutCount > 0 ? <Text style={styles.workoutCountText}>{workoutCount}</Text> : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  ))}
                </View>
              </Animated.View>
            </GestureDetector>
          </>
        )
      ) : isWebDesktop ? (
        <ScrollView
          horizontal
          style={[
            styles.weekPlannerScrollX,
            calendarWeekVisibilityStatus === "hidden" && styles.weekBoardMuted,
          ]}
          contentContainerStyle={styles.weekPlannerScrollXContent}
        >
          <View style={styles.weekPlannerGrid}>
            {weeklyDaySectionsForDisplay.map((day) => {
              const isToday = day.dateISO === todayISO;
              return (
                <View key={day.dateISO} style={[styles.weekPlannerDayColumn, isToday && styles.weekPlannerDayColumnToday]}>
                  <View style={[styles.weekPlannerDayHeader, isToday && styles.weekPlannerDayHeaderToday]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={styles.weekSectionWeekday}>
                        {toShortWeekdayLabel(day.weekday)}
                      </Text>
                      <Text style={styles.weekSectionDate}>{day.fullDate}</Text>
                    </View>
                    <Pressable
                      onPress={() =>
                        router.push({
                          pathname: "/(coach)/workouts",
                          params: { date: day.dateISO },
                        })
                      }
                      style={styles.weekOpenDayButton}
                    >
                      <Ionicons name="arrow-forward-circle-outline" size={12} color="#25528a" />
                      <Text style={styles.weekSectionOpenDay}>Open Day</Text>
                    </Pressable>
                  </View>

                  <ScrollView
                    style={[styles.weekPlannerDayBody, { height: weeklyPlannerLaneHeight }]}
                    contentContainerStyle={styles.weekPlannerDayBodyContent}
                  >
                    {day.workouts.length === 0 ? (
                      <Text style={styles.weekNoWorkouts}>No workouts</Text>
                    ) : (
                      day.workouts.map((workout) => {
                        const expanded = !!expandedWeeklyWorkouts[workout.key];
                        const timeText = String(workout.time ?? "").trim();
                        const locationText = String(workout.location ?? "").trim();
                        const titleText = String(workout.title ?? "").trim() || "Workout";
                        const athletePreview = athleteLastNamePreview(workout);
                        const visibleCategories = workout.categories
                          .map((cat) => String(cat ?? "").trim())
                          .filter(Boolean);
                        const accentColors = normalizeWorkoutAccentColors(visibleCategories, categories);
                        const accentBaseColor = accentColors[0] ?? "#e0e8f6";
                        return (
                          <View key={workout.key} style={styles.weekWorkoutBox}>
                            <View style={styles.weekWorkoutRow}>
                              <View style={[styles.weekWorkoutAccentStrip, { backgroundColor: accentBaseColor }]}>
                                {accentColors.length > 1
                                  ? accentColors.map((color, index) => (
                                      <View
                                        key={`${workout.key}-accent-${index}-${color}`}
                                        style={[styles.weekWorkoutAccentSegment, { backgroundColor: color }]}
                                      />
                                    ))
                                  : null}
                              </View>
                              <View style={styles.weekWorkoutMain}>
                                <View style={styles.weekPlannerWorkoutBody}>
                                  {timeText || locationText ? (
                                    <View style={styles.weekPlannerPrimaryRow}>
                                      {timeText ? (
                                        <Text numberOfLines={1} style={styles.weekPlannerTimeText}>
                                          {timeText}
                                        </Text>
                                      ) : null}
                                      {locationText ? (
                                        <Text style={styles.weekPlannerLocationText}>
                                          {locationText}
                                        </Text>
                                      ) : null}
                                    </View>
                                  ) : null}

                                  <Text numberOfLines={3} style={styles.weekPlannerTitleText}>
                                    {titleText}
                                  </Text>

                                  {visibleCategories.length > 0 ? (
                                    <View style={styles.weekPlannerCategoriesRow}>
                                      {visibleCategories.map((cat) => (
                                        <View key={`${workout.key}-${cat}`} style={styles.weekCategoryChip}>
                                          <View
                                            style={[
                                              styles.workoutDot,
                                              { backgroundColor: categoryColorByName(categories, cat), marginRight: 5 },
                                            ]}
                                          />
                                          <Text numberOfLines={1} style={styles.weekCategoryChipText}>
                                            {cat}
                                          </Text>
                                        </View>
                                      ))}
                                    </View>
                                  ) : null}

                                  <Text style={styles.weekPlannerAthletePreviewText}>
                                    {athletePreview}
                                  </Text>

                                  <View style={styles.weekPlannerMetaRow}>
                                    <Text style={styles.weekCompactMeta}>{`${workout.athleteCount} Ath • ${workout.groupCount} Gr`}</Text>
                                    <Pressable
                                      onPress={() =>
                                        setExpandedWeeklyWorkouts((prev) => ({
                                          ...prev,
                                          [workout.key]: !prev[workout.key],
                                        }))
                                      }
                                      style={styles.weekExpandButton}
                                    >
                                      <Text style={styles.weekExpandChevron}>{expanded ? "▾" : "▸"}</Text>
                                    </Pressable>
                                  </View>
                                </View>

                                {expanded ? renderWeeklyExpandedWorkout(workout) : null}
                              </View>
                            </View>
                          </View>
                        );
                      })
                    )}
                  </ScrollView>
                </View>
              );
            })}
          </View>
        </ScrollView>
      ) : (
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              animatedStyle,
              calendarWeekVisibilityStatus === "hidden" && styles.weekBoardMuted,
            ]}
          >
            <ScrollView style={styles.weekScroll} contentContainerStyle={styles.weekScrollContent}>
              {weeklyDaySectionsForDisplay.map((day) => {
                const isToday = day.dateISO === todayISO;
                return (
                  <View key={day.dateISO} style={[styles.weekDaySection, isToday && styles.todayCell]}>
                    <Pressable
                      onPress={() =>
                        router.push({
                          pathname: "/(coach)/workouts",
                          params: { date: day.dateISO },
                        })
                      }
                      style={styles.weekDaySectionHeader}
                    >
                      <View>
                        <Text style={styles.weekSectionWeekday}>{day.weekday}</Text>
                        <Text style={styles.weekSectionDate}>{day.fullDate}</Text>
                      </View>
                      <Text style={styles.weekSectionOpenDay}>Open Day</Text>
                    </Pressable>

                    {day.workouts.length === 0 ? (
                      <Text style={styles.weekNoWorkouts}>No workouts</Text>
                    ) : (
                      day.workouts.map((workout) => {
                        const expanded = !!expandedWeeklyWorkouts[workout.key];
                        const visibleCategories = workout.categories
                          .map((cat) => String(cat ?? "").trim())
                          .filter(Boolean);
                        const accentColors = normalizeWorkoutAccentColors(visibleCategories, categories);
                        const accentBaseColor = accentColors[0] ?? "#e0e8f6";
                        return (
                          <View key={workout.key} style={styles.weekWorkoutBox}>
                            <View style={styles.weekWorkoutRow}>
                              <View style={[styles.weekWorkoutAccentStrip, { backgroundColor: accentBaseColor }]}>
                                {accentColors.length > 1
                                  ? accentColors.map((color, index) => (
                                      <View
                                        key={`${workout.key}-mobile-accent-${index}-${color}`}
                                        style={[styles.weekWorkoutAccentSegment, { backgroundColor: color }]}
                                      />
                                    ))
                                  : null}
                              </View>
                              <View style={styles.weekWorkoutMain}>
                                <Pressable
                                  onPress={() =>
                                    setExpandedWeeklyWorkouts((prev) => ({
                                      ...prev,
                                      [workout.key]: !prev[workout.key],
                                    }))
                                  }
                                  style={styles.weekWorkoutHeader}
                                >
                                  <View style={{ flex: 1 }}>
                                    <Text style={styles.weekWorkoutTitle}>{workout.title}</Text>
                                    <Text style={styles.weekWorkoutMeta}>
                                      {workout.session}
                                      {workout.time ? ` • ${workout.time}` : ""}
                                      {workout.location ? ` • ${workout.location}` : ""}
                                      {` • ${workout.athleteCount} athletes • ${workout.groupCount} groups`}
                                    </Text>
                                  </View>
                                  <Text style={styles.weekExpandChevron}>{expanded ? "▾" : "▸"}</Text>
                                </Pressable>

                                {expanded ? renderWeeklyExpandedWorkout(workout) : null}
                              </View>
                            </View>
                          </View>
                        );
                      })
                    )}
                  </View>
                );
              })}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      )}

      {showSavedBanner ? (
        <View style={styles.savedBanner}>
          <Text style={styles.savedBannerText}>Training session saved</Text>
        </View>
      ) : null}

      <Modal
        visible={trainingVisibilityOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTrainingVisibilityOpen(false)}
      >
        <Pressable style={styles.exportModalBackdrop} onPress={() => setTrainingVisibilityOpen(false)}>
          <Pressable style={styles.exportModalCard} onPress={() => {}}>
            <Text style={styles.exportModalTitle}>Training Visibility</Text>
            <Text style={styles.exportModalHint}>
              Current scope: {calendarBulkAthleteIds.length} athlete{calendarBulkAthleteIds.length === 1 ? "" : "s"} from current filters.
            </Text>

            <View style={styles.exportModalField}>
              <Text style={styles.exportModalLabel}>Action</Text>
              <View style={styles.visibilityChoiceRow}>
                {(["publish", "hide"] as TrainingVisibilityAction[]).map((value) => (
                  <Pressable
                    key={`visibility-action-${value}`}
                    onPress={() => setTrainingVisibilityAction(value)}
                    style={[styles.visibilityChoice, trainingVisibilityAction === value && styles.visibilityChoiceSelected]}
                  >
                    <Text style={styles.visibilityChoiceText}>{value === "publish" ? "Publish to athletes" : "Hide from athletes"}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.exportModalField}>
              <Text style={styles.exportModalLabel}>Content</Text>
              <View style={styles.visibilityChoiceRow}>
                {([
                  ["workouts", "Workouts only"],
                  ["mileage", "Mileage only"],
                  ["both", "Workouts + Mileage"],
                ] as Array<[TrainingVisibilityContent, string]>).map(([value, label]) => (
                  <Pressable
                    key={`visibility-content-${value}`}
                    onPress={() => setTrainingVisibilityContent(value)}
                    style={[styles.visibilityChoice, trainingVisibilityContent === value && styles.visibilityChoiceSelected]}
                  >
                    <Text style={styles.visibilityChoiceText}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.exportModalField}>
              <Text style={styles.exportModalLabel}>Range</Text>
              <View style={styles.visibilityChoiceRow}>
                {([
                  ["week", "Current week"],
                  ["custom", "Custom range"],
                  ["season", "Selected season"],
                ] as Array<[TrainingVisibilityRange, string]>).map(([value, label]) => (
                  <Pressable
                    key={`visibility-range-${value}`}
                    onPress={() => setTrainingVisibilityRange(value)}
                    style={[styles.visibilityChoice, trainingVisibilityRange === value && styles.visibilityChoiceSelected]}
                  >
                    <Text style={styles.visibilityChoiceText}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              {trainingVisibilityRange === "season" ? (
                <Text style={styles.exportModalHint}>Season: {selectedSeasonLabel}</Text>
              ) : null}
            </View>

            {trainingVisibilityRange === "custom" ? (
              <>
                <View style={styles.exportModalField}>
                  <Text style={styles.exportModalLabel}>Start date</Text>
                  <TextInput
                    value={trainingVisibilityStartISO}
                    onChangeText={setTrainingVisibilityStartISO}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="YYYY-MM-DD"
                    style={styles.exportModalInput}
                  />
                </View>
                <View style={styles.exportModalField}>
                  <Text style={styles.exportModalLabel}>End date</Text>
                  <TextInput
                    value={trainingVisibilityEndISO}
                    onChangeText={setTrainingVisibilityEndISO}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="YYYY-MM-DD"
                    style={styles.exportModalInput}
                  />
                </View>
              </>
            ) : null}

            <Text style={styles.exportModalHint}>
              Mileage visibility is week-based. Any week touched by this range will be affected.
            </Text>
            {trainingVisibilityError ? (
              <Text style={styles.trainingVisibilityError}>{trainingVisibilityError}</Text>
            ) : null}

            <View style={styles.exportModalActions}>
              <Pressable style={styles.todayBtn} onPress={() => setTrainingVisibilityOpen(false)} disabled={trainingVisibilityApplying}>
                <Text style={styles.todayBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.todayBtn} onPress={() => void applyTrainingVisibilityNow()} disabled={trainingVisibilityApplying}>
                <Text style={styles.todayBtnText}>{trainingVisibilityApplying ? "Applying..." : "Apply"}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={trainingPlanExportOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTrainingPlanExportOpen(false)}
      >
        <Pressable style={styles.exportModalBackdrop} onPress={() => setTrainingPlanExportOpen(false)}>
          <Pressable style={styles.exportModalCard} onPress={() => {}}>
            <Text style={styles.exportModalTitle}>Export Training Plan</Text>
            <Text style={styles.exportModalHint}>Pick a date range (max {MAX_TRAINING_PLAN_EXPORT_RANGE_DAYS} days).</Text>
            <View style={styles.exportModalField}>
              <Text style={styles.exportModalLabel}>Season quick-pick</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                <Pressable
                  onPress={() => setTrainingPlanExportSeasonId(null)}
                  style={[styles.todayBtn, !trainingPlanExportSeasonId ? { backgroundColor: "rgba(37,99,235,0.12)" } : null]}
                >
                  <Text style={styles.todayBtnText}>Custom range</Text>
                </Pressable>
                {trainingPlanExportSeasonOptions.map((option) => (
                  <Pressable
                    key={`training-plan-export-season-${option.id}`}
                    onPress={() => applyTrainingPlanSeasonRange(option.id)}
                    style={[styles.todayBtn, trainingPlanExportSeasonId === option.id ? { backgroundColor: "rgba(37,99,235,0.12)" } : null]}
                  >
                    <Text style={styles.todayBtnText}>{option.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
            <View style={styles.exportModalField}>
              <Text style={styles.exportModalLabel}>Start date</Text>
              <Text style={[styles.exportModalInput, { paddingTop: 10 }]}>{exportStartDateISO}</Text>
              <View style={styles.exportModalActions}>
                <Pressable style={styles.todayBtn} onPress={() => shiftTrainingPlanExportDate("start", -7)}>
                  <Text style={styles.todayBtnText}>-1w</Text>
                </Pressable>
                <Pressable style={styles.todayBtn} onPress={() => shiftTrainingPlanExportDate("start", -1)}>
                  <Text style={styles.todayBtnText}>-1d</Text>
                </Pressable>
                <Pressable style={styles.todayBtn} onPress={() => {
                  setExportStartDateISO(toISODate(new Date()));
                  if (trainingPlanExportSeasonId) setTrainingPlanExportSeasonId(null);
                }}>
                  <Text style={styles.todayBtnText}>Today</Text>
                </Pressable>
                <Pressable style={styles.todayBtn} onPress={() => shiftTrainingPlanExportDate("start", 1)}>
                  <Text style={styles.todayBtnText}>+1d</Text>
                </Pressable>
                <Pressable style={styles.todayBtn} onPress={() => shiftTrainingPlanExportDate("start", 7)}>
                  <Text style={styles.todayBtnText}>+1w</Text>
                </Pressable>
              </View>
            </View>
            <View style={styles.exportModalField}>
              <Text style={styles.exportModalLabel}>End date</Text>
              <Text style={[styles.exportModalInput, { paddingTop: 10 }]}>{exportEndDateISO}</Text>
              <View style={styles.exportModalActions}>
                <Pressable style={styles.todayBtn} onPress={() => shiftTrainingPlanExportDate("end", -7)}>
                  <Text style={styles.todayBtnText}>-1w</Text>
                </Pressable>
                <Pressable style={styles.todayBtn} onPress={() => shiftTrainingPlanExportDate("end", -1)}>
                  <Text style={styles.todayBtnText}>-1d</Text>
                </Pressable>
                <Pressable style={styles.todayBtn} onPress={() => {
                  setExportEndDateISO(toISODate(new Date()));
                  if (trainingPlanExportSeasonId) setTrainingPlanExportSeasonId(null);
                }}>
                  <Text style={styles.todayBtnText}>Today</Text>
                </Pressable>
                <Pressable style={styles.todayBtn} onPress={() => shiftTrainingPlanExportDate("end", 1)}>
                  <Text style={styles.todayBtnText}>+1d</Text>
                </Pressable>
                <Pressable style={styles.todayBtn} onPress={() => shiftTrainingPlanExportDate("end", 7)}>
                  <Text style={styles.todayBtnText}>+1w</Text>
                </Pressable>
              </View>
            </View>
            {trainingPlanExportError ? (
              <Text style={styles.exportModalError}>{trainingPlanExportError}</Text>
            ) : null}
            <View style={styles.exportModalActions}>
              <Pressable style={styles.todayBtn} onPress={() => setTrainingPlanExportOpen(false)} disabled={exportingTrainingPlanPdf}>
                <Text style={styles.todayBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.todayBtn} onPress={() => void handleExportTrainingPlanPdf()} disabled={exportingTrainingPlanPdf}>
                <Text style={styles.todayBtnText}>{exportingTrainingPlanPdf ? "Exporting..." : "Export PDF"}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={copyWeekModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCopyWeekModalOpen(false)}
      >
        <Pressable style={styles.exportModalBackdrop} onPress={() => setCopyWeekModalOpen(false)}>
          <Pressable style={styles.exportModalCard} onPress={() => {}}>
            <Text style={styles.exportModalTitle}>Copy workouts from week</Text>
            <Text style={styles.exportModalHint}>Copy into {copyTargetWeekLabel}</Text>
            <View style={styles.exportModalField}>
              <Text style={styles.exportModalLabel}>Source date (snaps to week)</Text>
              <TextInput
                value={copySourceDateInput}
                onChangeText={(text) => {
                  setCopySourceDateInput(text);
                  setCopyWeekError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="YYYY-MM-DD"
                style={styles.exportModalInput}
              />
              <Text style={styles.exportModalHint}>Source week: {copySourceWeekLabel}</Text>
            </View>
            <View style={styles.exportModalActions}>
              <Pressable style={styles.todayBtn} onPress={() => shiftCopySourceWeek(-1)} disabled={copyingWeek}>
                <Text style={styles.todayBtnText}>Prev Source Week</Text>
              </Pressable>
              <Pressable style={styles.todayBtn} onPress={() => shiftCopySourceWeek(1)} disabled={copyingWeek}>
                <Text style={styles.todayBtnText}>Next Source Week</Text>
              </Pressable>
              <Pressable
                style={styles.todayBtn}
                onPress={() => {
                  setCopySourceDateInput(toISODate(addDays(anchorWeekStart, -7)));
                  setCopyWeekError(null);
                }}
                disabled={copyingWeek}
              >
                <Text style={styles.todayBtnText}>Use Previous Week</Text>
              </Pressable>
            </View>
            {copyWeekError ? (
              <Text style={styles.exportModalError}>{copyWeekError}</Text>
            ) : null}
            <View style={styles.exportModalActions}>
              <Pressable style={styles.todayBtn} onPress={() => setCopyWeekModalOpen(false)} disabled={copyingWeek}>
                <Text style={styles.todayBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.todayBtn} onPress={confirmCopyWeek} disabled={copyingWeek || clearingWeek}>
                <Text style={styles.todayBtnText}>{copyingWeek ? "Copying..." : "Copy Week"}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 92, backgroundColor: "#fff" },

  headerCard: {
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 12,
    backgroundColor: "#f8fbff",
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
  },
  headerTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  headerLeftGroup: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 },
  headerCenter: { alignItems: "center", flex: 1, minWidth: 220, gap: 0 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" },
  todayBtn: {
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#d7d7d7",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  todayBtnText: { fontSize: 12, fontWeight: "800", color: "#222" },
  monthLabel: { fontSize: 18, fontWeight: "800", color: "#111" },
  subLabel: { marginTop: 1, fontSize: 11, fontWeight: "600", color: "#6b6b6b" },
  weekLabelInlineWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderColor: "rgba(15,23,42,0.12)",
    borderRadius: 999,
    backgroundColor: "#fff",
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  weekLabelInlineLabel: { fontSize: 10, fontWeight: "700", color: "#6b7280" },
  weekLabelInlineInput: {
    width: 118,
    height: 26,
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 999,
    paddingHorizontal: 9,
    backgroundColor: "#fff",
    color: "#111",
    fontSize: 11,
    fontWeight: "600",
  },
  weekLabelSaveText: { fontSize: 9, fontWeight: "700", color: "#6b7280", minWidth: 44, textAlign: "center" },
  weekLabelToneChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  weekLabelToneChipText: {
    fontSize: 9,
    fontWeight: "800",
  },
  weekActionsRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  jumpWeekPanel: {
    borderWidth: 1,
    borderColor: "rgba(15,23,42,0.1)",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: "#fff",
    gap: 5,
  },
  jumpWeekHint: { fontSize: 11, fontWeight: "700", color: "#6b7280" },
  jumpWeekInput: {
    minWidth: 150,
    height: 32,
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    paddingHorizontal: 10,
    color: "#111",
    backgroundColor: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },

  modeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
    position: "relative",
    zIndex: 400,
    overflow: "visible",
  },
  modePill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#fff",
  },
  modePillActive: { borderColor: "#111", backgroundColor: "#111" },
  modePillText: { fontWeight: "800", color: "#555" },
  modePillTextActive: { color: "#fff" },
  athleteFilterWrap: {
    position: "relative",
    minWidth: 210,
    zIndex: 600,
    marginLeft: 4,
  },
  athleteFilterLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: "#64748b",
    marginBottom: 2,
    marginLeft: 4,
  },
  athleteFilterTrigger: {
    height: 34,
    borderWidth: 1,
    borderColor: "#d7d7d7",
    borderRadius: 10,
    backgroundColor: "#fff",
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  athleteFilterTriggerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
    color: "#1f2937",
  },
  athleteFilterChevron: { fontSize: 11, fontWeight: "900", color: "#64748b" },
  athleteFilterMenu: {
    position: "absolute",
    top: 40,
    left: 0,
    right: 0,
    borderWidth: 1,
    borderColor: "#dbe2ee",
    borderRadius: 8,
    backgroundColor: "#fff",
    zIndex: 700,
    ...(Platform.OS === "web"
      ? ({
          boxShadow: "0 10px 28px rgba(15, 23, 42, 0.18)",
        } as any)
      : null),
    ...(Platform.OS === "android" ? { elevation: 8 } : null),
  },
  athleteFilterItem: {
    borderBottomWidth: 1,
    borderBottomColor: "#edf2f7",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  athleteFilterItemSelected: {
    backgroundColor: "#eff6ff",
  },
  athleteFilterItemText: { fontSize: 12, fontWeight: "700", color: "#334155" },
  groupFilterWrap: {
    position: "relative",
    minWidth: 210,
    zIndex: 590,
    marginLeft: 4,
  },
  groupFilterLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: "#64748b",
    marginBottom: 2,
    marginLeft: 4,
  },
  groupFilterTrigger: {
    height: 34,
    borderWidth: 1,
    borderColor: "#d7d7d7",
    borderRadius: 10,
    backgroundColor: "#fff",
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  groupFilterTriggerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
    color: "#1f2937",
  },
  groupFilterChevron: { fontSize: 11, fontWeight: "900", color: "#64748b" },
  groupFilterMenu: {
    position: "absolute",
    top: 40,
    left: 0,
    right: 0,
    borderWidth: 1,
    borderColor: "#dbe2ee",
    borderRadius: 8,
    backgroundColor: "#fff",
    zIndex: 700,
    ...(Platform.OS === "web"
      ? ({
          boxShadow: "0 10px 28px rgba(15, 23, 42, 0.18)",
        } as any)
      : null),
    ...(Platform.OS === "android" ? { elevation: 8 } : null),
  },
  groupFilterItem: {
    borderBottomWidth: 1,
    borderBottomColor: "#edf2f7",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  groupFilterItemSelected: {
    backgroundColor: "#eff6ff",
  },
  groupFilterItemText: { fontSize: 12, fontWeight: "700", color: "#334155" },
  monthDesktopInset: {
    marginLeft: 22,
  },

  weekdayRow: { flexDirection: "row", marginBottom: 8 },
  weekdayText: {
    width: (SCREEN_W - 32) / 7,
    textAlign: "center",
    fontSize: 12,
    fontWeight: "800",
    color: "#6b6b6b",
  },

  gridWrap: { borderWidth: 1, borderColor: "#ececec", borderRadius: 14, padding: 8, backgroundColor: "#fafafa" },
  grid: {},
  weekRow: { flexDirection: "row", marginBottom: 6 },

  cell: {
    flex: 1,
    minHeight: 76,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#efefef",
    backgroundColor: "#fff",
  },
  cellGapRight: { marginRight: 6 },
  emptyCell: { backgroundColor: "#fff" },

  outsideMonth: { opacity: 0.45 },
  todayCell: { borderColor: "#0a84ff", borderWidth: 2 },
  pressed: { opacity: 0.75 },

  dayNum: { fontSize: 13, fontWeight: "800", color: "#1e1e1e" },
  dayNumMuted: { color: "#7a7a7a" },
  dotRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    gap: 4,
  },
  workoutDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 0.5,
    borderColor: "rgba(0,0,0,0.2)",
  },
  moreDotsText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#666",
    marginLeft: 2,
  },
  workoutCountText: {
    marginTop: 6,
    fontSize: 10,
    fontWeight: "800",
    color: "#666",
  },
  monthWeekdayRowDense: {
    marginBottom: 4,
    marginLeft: 22,
    borderWidth: 1,
    borderColor: "#dbe4f0",
    borderBottomWidth: 0,
    borderRadius: 6,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    overflow: "hidden",
  },
  monthWeekdayTextDense: {
    flex: 1,
    width: undefined as any,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderRightColor: "#e3eaf4",
    backgroundColor: "#f3f7fc",
    color: "#42526a",
  },
  monthSheet: {
    marginLeft: 22,
    borderWidth: 1,
    borderColor: "#dbe4f0",
    borderTopWidth: 0,
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
    overflow: "visible",
  },
  monthSheetRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e6edf6" },
  monthSheetRowLast: { borderBottomWidth: 0 },
  monthSheetCell: {
    flex: 1,
    minHeight: 88,
    paddingHorizontal: 6,
    paddingVertical: 5,
    paddingBottom: 16,
    borderRightWidth: 1,
    borderRightColor: "#e6edf6",
    backgroundColor: "#fff",
    position: "relative",
  },
  monthSheetCellWithWeekLabel: {
    paddingLeft: 20,
  },
  monthSheetCellLast: { borderRightWidth: 0 },
  monthDayTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 3 },
  monthDayCount: { fontSize: 11, fontWeight: "800", color: "#5a6a83" },
  monthSummaryRow: { flexDirection: "row", alignItems: "center", marginTop: 2 },
  monthSummaryText: { flex: 1, fontSize: 10.5, lineHeight: 13, fontWeight: "700", color: "#1d2a3f" },
  monthOverflowCount: {
    position: "absolute",
    right: 5,
    bottom: 3,
    fontSize: 10,
    fontWeight: "900",
    color: "#64748b",
  },
  monthWeekLabelRail: {
    position: "absolute",
    left: -22,
    top: 2,
    bottom: 2,
    width: 20,
    borderWidth: 1,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    zIndex: 8,
    shadowColor: "#0f172a",
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  monthWeekLabelRailEmpty: {
    borderColor: "rgba(15,23,42,0.12)",
    backgroundColor: "rgba(255,255,255,0.9)",
  },
  monthWeekLabelRailText: {
    width: 96,
    fontSize: 8,
    fontWeight: "900",
    lineHeight: 9.5,
    textAlign: "center",
    letterSpacing: 0.15,
    transform: [{ rotate: "-90deg" }],
  },
  monthCellWithWeekLabel: {
    paddingLeft: 18,
  },

  weekSheetScrollX: {
    borderWidth: 1,
    borderColor: "#d7e0ec",
    borderRadius: 6,
    backgroundColor: "#f8fbff",
  },
  weekSheetScrollXContent: { paddingBottom: 104 },
  weekSheet: { minWidth: 210 + 7 * 170, backgroundColor: "#fff" },
  weekSheetHeaderRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#d7e0ec", backgroundColor: "#eef4fb" },
  weekSheetRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e6edf6" },
  weekSheetLabelCell: {
    width: 210,
    minWidth: 210,
    maxWidth: 210,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderRightColor: "#dfe7f2",
  },
  weekSheetDayCell: {
    width: 170,
    minWidth: 170,
    maxWidth: 170,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderRightColor: "#e6edf6",
  },
  weekSheetHeaderCell: { backgroundColor: "#eef4fb" },
  weekSheetDataCell: { minHeight: 56, backgroundColor: "#fff", justifyContent: "center" },
  weekSheetHeaderText: { fontSize: 12, fontWeight: "900", color: "#24334a" },
  weekSheetHeaderSubText: { marginTop: 2, fontSize: 10, fontWeight: "700", color: "#5e718c" },
  weekSheetLabelText: { fontSize: 12, fontWeight: "800", color: "#18263a" },
  weekSheetCellTitle: { fontSize: 12, fontWeight: "900", color: "#0f1b2d" },
  weekSheetCellMeta: { marginTop: 2, fontSize: 10, fontWeight: "700", color: "#5d6e86" },

  weekScroll: {
    borderWidth: 1,
    borderColor: "#ececec",
    borderRadius: 14,
    backgroundColor: "#fafafa",
  },
  weekPlannerScrollX: {
    borderWidth: 1,
    borderColor: "#ececec",
    borderRadius: 14,
    backgroundColor: "#fafafa",
  },
  weekPlannerScrollXContent: {
    padding: 8,
    paddingBottom: 104,
  },
  weekPlannerGrid: {
    flexDirection: "row",
    gap: 8,
  },
  weekPlannerDayColumn: {
    width: 182,
    borderWidth: 1,
    borderColor: "#e4ebf5",
    borderRadius: 8,
    backgroundColor: "#fff",
    overflow: "hidden",
  },
  weekPlannerDayColumnToday: {
    borderColor: "#cddcf0",
    backgroundColor: "#fbfdff",
  },
  weekPlannerDayHeader: {
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: "#edf1f6",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#f7f9fc",
    gap: 8,
  },
  weekPlannerDayHeaderToday: {
    backgroundColor: "#f3f7fc",
    borderBottomColor: "#e2ebf7",
  },
  weekPlannerDayBody: {
    flex: 1,
  },
  weekPlannerDayBodyContent: {
    paddingVertical: 4,
  },
  weekPlannerWorkoutBody: {
    paddingHorizontal: 8,
    paddingVertical: 7,
    gap: 7,
    backgroundColor: "#fff",
  },
  weekPlannerPrimaryRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  weekPlannerInputTime: {
    width: 70,
    paddingVertical: 4,
  },
  weekPlannerInputLocation: {
    flex: 1,
    minWidth: 108,
    paddingVertical: 4,
  },
  weekPlannerInputTitle: {
    width: "100%",
    paddingVertical: 4,
  },
  weekPlannerTimeText: {
    width: 56,
    fontSize: 11,
    fontWeight: "900",
    color: "#22334c",
    lineHeight: 14,
    paddingTop: 1,
  },
  weekPlannerLocationText: {
    flex: 1,
    fontSize: 11,
    fontWeight: "700",
    color: "#4a5d79",
    lineHeight: 14,
    flexShrink: 1,
  },
  weekPlannerTitleText: {
    fontSize: 13,
    fontWeight: "900",
    color: "#0e223d",
    lineHeight: 17,
  },
  weekPlannerCategoriesRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    minHeight: 22,
  },
  weekPlannerMetaRow: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  weekPlannerAthletePreviewText: {
    width: "100%",
    fontSize: 10.5,
    fontWeight: "600",
    color: "#5f6f87",
    lineHeight: 14,
  },
  weekPlannerStatusRow: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  weekPlannerDetailsReadOnly: {
    width: "100%",
    fontSize: 11,
    fontWeight: "600",
    color: "#55657d",
    lineHeight: 15,
  },
  weekScrollContent: {
    padding: 10,
    paddingBottom: 104,
  },
  weekScrollContentDesktop: {
    paddingHorizontal: 6,
    paddingTop: 6,
  },
  weekDaySection: {
    borderWidth: 1,
    borderColor: "#dfe6f1",
    borderRadius: 8,
    backgroundColor: "#fff",
    marginBottom: 10,
    overflow: "hidden",
  },
  weekDaySectionHeader: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#edf1f6",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#f7f9fc",
  },
  weekSectionWeekday: { fontSize: 13, fontWeight: "900", color: "#162338", flexShrink: 1 },
  weekSectionDate: { marginTop: 2, fontSize: 11, fontWeight: "700", color: "#60728c" },
  weekOpenDayButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: "#d4e0ef",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: "#f8fbff",
  },
  weekSectionOpenDay: { fontSize: 11, fontWeight: "800", color: "#25528a" },
  weekWorkoutBox: {
    borderBottomWidth: 1,
    borderBottomColor: "#edf1f6",
    backgroundColor: "#fff",
    marginBottom: 7,
    marginHorizontal: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e8eef8",
    overflow: "hidden",
  },
  weekWorkoutRow: {
    flexDirection: "row",
    alignItems: "stretch",
    width: "100%",
  },
  weekWorkoutAccentStrip: {
    width: 3,
    minWidth: 3,
    overflow: "hidden",
  },
  weekWorkoutAccentSegment: {
    flex: 1,
  },
  weekWorkoutMain: {
    flex: 1,
    minWidth: 0,
  },
  weekWorkoutHeader: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  weekHeaderRight: {
    alignItems: "flex-end",
    gap: 8,
    minWidth: 80,
  },
  weekHeaderRightCompact: {
    minWidth: 88,
    paddingTop: 1,
  },
  weekCompactMainRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  weekCompactSecondaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  weekEditRow: {
    marginBottom: 6,
  },
  weekEditLabel: {
    fontSize: 10,
    fontWeight: "900",
    color: "#5f7089",
    marginBottom: 3,
  },
  weekReadonlyValue: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: "#f8fafc",
    fontSize: 12,
    fontWeight: "700",
    color: "#334155",
  },
  weekReadonlyValueMuted: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: "#f8fafc",
    fontSize: 12,
    fontWeight: "700",
    color: "#94a3b8",
  },
  weekEditInput: {
    borderWidth: 1,
    borderColor: "#e3eaf3",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: "#fff",
    fontSize: 11,
    fontWeight: "700",
    color: "#0f1f33",
  },
  weekPlannerTitleInput: {
    fontSize: 12,
    fontWeight: "800",
    color: "#0e223d",
  },
  weekEditInputNotes: {
    minHeight: 56,
    textAlignVertical: "top",
  },
  weekSessionToggleRow: {
    flexDirection: "row",
    gap: 6,
  },
  weekSessionToggleRowCompact: {
    width: 88,
  },
  weekSessionToggle: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: "#fff",
  },
  weekSessionToggleCompact: {
    flex: 1,
    paddingHorizontal: 0,
    alignItems: "center",
  },
  weekSessionToggleActive: {
    borderColor: "#0f172a",
    backgroundColor: "#0f172a",
  },
  weekSessionToggleText: {
    fontSize: 11,
    fontWeight: "900",
    color: "#334155",
  },
  weekSessionToggleTextActive: {
    color: "#fff",
  },
  weekExpandButton: {
    borderWidth: 1,
    borderColor: "#d8e3f1",
    borderRadius: 999,
    backgroundColor: "#f6f9fd",
    minWidth: 28,
    height: 24,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  weekWorkoutTitle: { fontSize: 13, fontWeight: "900", color: "#0f1f33" },
  weekWorkoutMeta: { marginTop: 2, fontSize: 11, fontWeight: "700", color: "#5f7089" },
  weekExpandChevron: { fontSize: 13, fontWeight: "900", color: "#5a6d86" },
  weekCompactInputTime: {
    width: 96,
  },
  weekCompactInputLocation: {
    width: 180,
  },
  weekCompactInputTitle: {
    flex: 1,
    minWidth: 180,
  },
  weekCompactNotesInput: {
    flex: 1,
    minWidth: 180,
    paddingVertical: 4,
  },
  weekCompactCategoriesText: {
    flexShrink: 1,
    maxWidth: 260,
    fontSize: 10,
    fontWeight: "800",
    color: "#334155",
  },
  weekCompactCategoriesMuted: {
    flexShrink: 1,
    maxWidth: 260,
    fontSize: 10,
    fontWeight: "700",
    color: "#94a3b8",
  },
  weekCompactMeta: {
    fontSize: 10,
    fontWeight: "500",
    color: "#8b98ac",
  },
  weekCategoriesRow: {
    marginTop: 6,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  weekCategoryChip: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e4ebf5",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    backgroundColor: "#fbfdff",
  },
  weekCategoryChipText: { fontSize: 10, fontWeight: "700", color: "#2a3d59" },
  weekExpandedBody: {
    paddingHorizontal: 10,
    paddingBottom: 10,
    paddingTop: 8,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#e8eef7",
    backgroundColor: "#fcfdff",
  },
  weekExpandedHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 8,
  },
  weekExpandedTitle: {
    fontSize: 11,
    fontWeight: "900",
    color: "#172033",
  },
  weekExpandedMeta: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: "700",
    color: "#64748b",
  },
  weekWorkoutVisibilityBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  weekWorkoutVisibilityBadgeText: {
    fontSize: 9,
    fontWeight: "900",
  },
  weekWorkoutVisibilityBadgeHidden: {
    borderColor: "#fecaca",
    backgroundColor: "#fee2e2",
  },
  weekWorkoutVisibilityBadgeTextHidden: {
    color: "#991b1b",
  },
  weekWorkoutVisibilityBadgeMixed: {
    borderColor: "rgba(245,158,11,0.42)",
    backgroundColor: "rgba(245,158,11,0.14)",
  },
  weekWorkoutVisibilityBadgeTextMixed: {
    color: "#92400e",
  },
  weekWorkoutVisibilityBadgePublished: {
    borderColor: "rgba(22,163,74,0.28)",
    backgroundColor: "rgba(22,163,74,0.09)",
  },
  weekWorkoutVisibilityBadgeTextPublished: {
    color: "#166534",
  },
  weekExpandedSection: {
    marginBottom: 8,
  },
  weekExpandedSectionLabel: {
    fontSize: 10,
    fontWeight: "900",
    color: "#51627b",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  weekExpandedDetailsText: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: "700",
    color: "#26364d",
  },
  weekExpandedEmptyText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#94a3b8",
  },
  weekRoutineBlock: {
    marginBottom: 6,
  },
  weekRoutineHeader: {
    fontSize: 10,
    fontWeight: "900",
    color: "#51627b",
    marginBottom: 4,
  },
  weekRoutineList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
  },
  weekRoutinePill: {
    borderWidth: 1,
    borderColor: "#cfdcf0",
    borderRadius: 999,
    backgroundColor: "#f7fbff",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  weekRoutinePillText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#22406e",
  },
  weekGroupBlock: {
    paddingTop: 6,
  },
  weekGroupDetailBlock: {
    borderWidth: 1,
    borderColor: "#e4ebf5",
    borderRadius: 8,
    backgroundColor: "#f8fbff",
    paddingHorizontal: 8,
    paddingVertical: 7,
    marginBottom: 6,
  },
  weekGroupLabel: {
    fontSize: 11,
    fontWeight: "900",
    color: "#22334c",
    marginBottom: 4,
  },
  weekGroupAthletesText: {
    fontSize: 10,
    lineHeight: 15,
    fontWeight: "700",
    color: "#475569",
  },
  weekGroupNotesBlock: {
    marginTop: 5,
    gap: 3,
  },
  weekGroupNotesLabel: {
    fontSize: 9,
    fontWeight: "900",
    color: "#64748b",
    textTransform: "uppercase",
  },
  weekGroupNoteText: {
    fontSize: 10,
    lineHeight: 15,
    fontWeight: "800",
    color: "#26364d",
  },
  weekGroupNoNoteText: {
    fontSize: 10,
    lineHeight: 15,
    fontWeight: "700",
    color: "#64748b",
  },
  weekGroupLineText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#334762",
    marginBottom: 3,
  },
  weekDayCard: {
    borderWidth: 1,
    borderColor: "#ececec",
    borderRadius: 12,
    backgroundColor: "#fff",
    padding: 10,
    marginBottom: 8,
  },
  weekDayHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  weekDayLabel: {
    fontSize: 14,
    fontWeight: "900",
    color: "#111",
  },
  weekDayMeta: {
    fontSize: 12,
    color: "#666",
    fontWeight: "800",
  },
  weekNoWorkouts: {
    marginTop: 6,
    fontSize: 12,
    color: "#888",
    fontWeight: "700",
  },
  weekTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
  },
  weekTitleText: {
    flex: 1,
    fontSize: 13,
    color: "#222",
    fontWeight: "700",
  },
  savedBanner: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 88,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#178342",
    backgroundColor: "#1f9d50",
    alignItems: "center",
    paddingVertical: 10,
  },
  savedBannerText: { color: "#fff", fontWeight: "900" },
  readOnlyNotice: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    backgroundColor: "#f8fafc",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  readOnlyNoticeText: { fontSize: 12, fontWeight: "800", color: "#475569" },
  createSessionTopBtn: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 5,
    backgroundColor: "#0f172a",
  },
  createSessionTopBtnText: { fontSize: 12, fontWeight: "900", color: "#fff" },
  visibilityControl: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  visibilityText: {
    fontSize: 11,
    fontWeight: "900",
    color: "#64748b",
  },
  weekVisibilityBadge: {
    minHeight: 24,
    paddingHorizontal: 9,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  weekVisibilityBadgeText: {
    fontSize: 10,
    fontWeight: "900",
  },
  weekVisibilityBadgePublished: {
    borderColor: "rgba(22,163,74,0.32)",
    backgroundColor: "rgba(22,163,74,0.1)",
  },
  weekVisibilityBadgeTextPublished: {
    color: "#166534",
  },
  weekVisibilityBadgeMixed: {
    borderColor: "rgba(245,158,11,0.42)",
    backgroundColor: "rgba(245,158,11,0.14)",
  },
  weekVisibilityBadgeTextMixed: {
    color: "#92400e",
  },
  weekHiddenBanner: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#fecaca",
    borderRadius: 10,
    backgroundColor: "#fef2f2",
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  weekHiddenBannerIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: "#fecaca",
    backgroundColor: "#fee2e2",
    alignItems: "center",
    justifyContent: "center",
  },
  weekHiddenBannerCopy: {
    flex: 1,
    minWidth: 0,
  },
  weekHiddenBannerTitle: {
    fontSize: 14,
    fontWeight: "900",
    color: "#991b1b",
  },
  weekHiddenBannerText: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: "700",
    color: "#7f1d1d",
  },
  weekMixedNotice: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  weekMixedNoticeText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#92400e",
  },
  weekBoardMuted: {
    opacity: 0.78,
    borderRadius: 12,
    backgroundColor: "rgba(254,242,242,0.55)",
  },
  visibilityBtn: {
    height: 30,
    paddingHorizontal: 9,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  visibilityBtnDisabled: {
    opacity: 0.5,
  },
  visibilityBtnText: {
    fontSize: 11,
    fontWeight: "900",
    color: "#0f172a",
  },
  visibilityChoiceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  visibilityChoice: {
    minHeight: 32,
    paddingHorizontal: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  visibilityChoiceSelected: {
    borderColor: "#2563eb",
    backgroundColor: "rgba(37,99,235,0.12)",
  },
  visibilityChoiceText: {
    fontSize: 11,
    fontWeight: "900",
    color: "#0f172a",
  },
  exportModalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.28)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  exportModalCard: {
    width: "100%",
    maxWidth: 430,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#dbe3ee",
    backgroundColor: "#fff",
    padding: 12,
    gap: 8,
  },
  exportModalTitle: {
    fontSize: 16,
    fontWeight: "900",
    color: "#0f172a",
  },
  exportModalHint: {
    fontSize: 11,
    fontWeight: "700",
    color: "#64748b",
  },
  trainingVisibilityError: {
    fontSize: 11,
    fontWeight: "800",
    color: "#b91c1c",
  },
  exportModalField: {
    gap: 4,
  },
  exportModalLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: "#475569",
  },
  exportModalInput: {
    height: 36,
    borderWidth: 1,
    borderColor: "#d7dfea",
    borderRadius: 8,
    paddingHorizontal: 10,
    backgroundColor: "#fff",
    color: "#111827",
    fontSize: 12,
    fontWeight: "700",
  },
  exportModalError: {
    fontSize: 11,
    fontWeight: "700",
    color: "#b00020",
  },
  exportModalActions: {
    marginTop: 4,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
});
