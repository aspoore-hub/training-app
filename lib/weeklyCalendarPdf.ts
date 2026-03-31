export type WeeklyCalendarPdfLine = {
  details: string;
  athleteNames: string[];
};

export type WeeklyCalendarPdfGroup = {
  key: string;
  label: string;
  lines: WeeklyCalendarPdfLine[];
};

export type WeeklyCalendarPdfWorkout = {
  key: string;
  title: string;
  session: string;
  time?: string;
  location?: string;
  categories: string[];
  athleteCount: number;
  groupCount: number;
  groups: WeeklyCalendarPdfGroup[];
};

export type WeeklyCalendarPdfDay = {
  dateISO: string;
  weekday: string;
  fullDate: string;
  workouts: WeeklyCalendarPdfWorkout[];
};

export type BuildWeeklyCalendarPdfHtmlArgs = {
  weekLabel: string;
  weekAnnotation?: string;
  generatedAtLabel?: string;
  days: WeeklyCalendarPdfDay[];
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateShort(iso: string): string {
  const raw = String(iso ?? "").trim();
  const [y, m, d] = raw.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return raw;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return raw;
  const day = dt.getDate();
  const month = dt.toLocaleDateString("en-US", { month: "short" });
  return `${day}-${month}`;
}

function renderWorkoutHeaderLine(workout: WeeklyCalendarPdfWorkout): string {
  const time = String(workout.time ?? "").trim() || String(workout.session ?? "").trim();
  const location = String(workout.location ?? "").trim();
  if (time && location) return `${escapeHtml(time)} @ ${escapeHtml(location)}`;
  if (time) return escapeHtml(time);
  if (location) return `@ ${escapeHtml(location)}`;
  return "Workout";
}

function renderWorkout(workout: WeeklyCalendarPdfWorkout): string {
  const title = String(workout.title ?? "").trim();
  const groupHtml = (Array.isArray(workout.groups) ? workout.groups : [])
    .map((group) => {
      const linesHtml = (Array.isArray(group.lines) ? group.lines : [])
        .map((line) => {
          const names = (Array.isArray(line.athleteNames) ? line.athleteNames : [])
            .map((n) => escapeHtml(n))
            .join(", ");
          const rawDetails = String(line.details ?? "").trim();
          const hideDetails = !rawDetails || rawDetails.toLowerCase() === "no notes";
          if (hideDetails) {
            return `<div class="athlete-line">${names || "Unknown athlete"}</div>`;
          }
          return `
            <div class="group-detail-line">${escapeHtml(rawDetails)}</div>
            <div class="athlete-line">${names || "Unknown athlete"}</div>
          `;
        })
        .join("");
      return `
        <div class="group-block">
          ${linesHtml || `<div class="athlete-line">No athletes listed</div>`}
        </div>
      `;
    })
    .join("");

  return `
    <div class="workout-block">
      <div class="workout-header-line">${renderWorkoutHeaderLine(workout)}</div>
      ${title ? `<div class="workout-title-line">${escapeHtml(title)}</div>` : ""}
      ${groupHtml}
    </div>
  `;
}

function renderDay(day: WeeklyCalendarPdfDay): string {
  const workouts = Array.isArray(day.workouts) ? day.workouts : [];
  return `
    <tr>
      <td class="date-col">${escapeHtml(formatDateShort(day.dateISO || ""))}</td>
      <td class="weekday-col">${escapeHtml(day.weekday || "")}</td>
      <td class="details-col">
        ${
          workouts.length === 0
            ? `<div class="off-line">Off / No team workout scheduled</div>`
            : workouts.map((workout) => renderWorkout(workout)).join("")
        }
      </td>
    </tr>
  `;
}

export function buildWeeklyCalendarPdfHtml(args: BuildWeeklyCalendarPdfHtmlArgs): string {
  const weekLabel = escapeHtml(args.weekLabel || "");
  const weekAnnotation = escapeHtml(args.weekAnnotation || "");
  const generatedAtLabel = escapeHtml(args.generatedAtLabel || "");
  const days = Array.isArray(args.days) ? args.days : [];

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Weekly Training Plan</title>
    <style>
      @page {
        size: Letter portrait;
        size: Letter landscape;
        margin: 0.45in;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: #0f172a;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 11px;
        line-height: 1.25;
      }

      .page {
        width: 100%;
      }

      .header {
        margin-bottom: 10px;
      }

      .title {
        font-size: 20px;
        line-height: 1.05;
        font-weight: 800;
        margin: 0 0 2px 0;
      }

      .sub {
        font-size: 12px;
        font-weight: 700;
        color: #1f2937;
      }

      .schedule-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        border: 1px solid #374151;
      }

      .schedule-table thead th {
        border: 1px solid #6b7280;
        text-align: left;
        font-size: 11px;
        font-weight: 800;
        padding: 5px 6px;
        color: #111827;
        background: #ffffff;
      }

      .schedule-table td {
        border: 1px solid #9ca3af;
        vertical-align: top;
        padding: 5px 6px;
      }

      .date-col {
        width: 11%;
        font-weight: 800;
        font-size: 12px;
      }

      .weekday-col {
        width: 10%;
        font-weight: 800;
        font-size: 12px;
      }

      .details-col {
        width: 79%;
      }

      .workout-block {
        margin-bottom: 6px;
        padding-bottom: 4px;
        border-bottom: 1px solid #e5e7eb;
        break-inside: avoid;
        page-break-inside: avoid;
      }

      .workout-block:last-child {
        margin-bottom: 0;
        padding-bottom: 0;
        border-bottom: 0;
      }

      .workout-header-line {
        font-size: 11px;
        font-weight: 800;
        margin-bottom: 1px;
      }

      .workout-title-line {
        font-size: 11px;
        font-weight: 500;
        margin-bottom: 3px;
      }

      .group-block {
        margin-bottom: 2px;
      }

      .group-detail-line {
        font-size: 11px;
        margin-bottom: 0px;
      }

      .athlete-line {
        font-size: 10px;
        font-style: italic;
        color: #374151;
        margin-bottom: 2px;
      }

      .off-line {
        font-size: 11px;
        font-style: italic;
        color: #374151;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header class="header">
        <h1 class="title">Weekly Training Plan</h1>
        <div class="sub">Week: ${weekLabel || "-"}</div>
        ${weekAnnotation ? `<div class="sub">${weekAnnotation}</div>` : ""}
        ${generatedAtLabel ? `<div class="sub">Generated: ${generatedAtLabel}</div>` : ""}
      </header>
      <table class="schedule-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Day</th>
            <th>Workout Details</th>
          </tr>
        </thead>
        <tbody>
          ${days.map((day) => renderDay(day)).join("")}
        </tbody>
      </table>
    </div>
  </body>
</html>
`.trim();
}
