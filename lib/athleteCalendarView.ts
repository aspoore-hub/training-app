export const ATHLETE_CALENDAR_VIEW_STATE_KEY = "training_app_athlete_calendar_view_state_v1";

export type AthleteCalendarViewState = {
  view?: "month" | "week";
  dateISO?: string;
};

