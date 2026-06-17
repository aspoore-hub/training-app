export type WorkoutCategoryName =
  | "Easy"
  | "Moderate"
  | "Threshold"
  | "VO2"
  | "5K"
  | "10K"
  | "Speed Endurance"
  | "Speed Development"
  | "Other";

export type WorkoutCategory = {
  id: string;      // stable id
  name: string;    // display label
  color?: string;  // optional hex like "#1f9d50"
};

export type WorkoutSession = "AM" | "PM";

export type Athlete = {
  id: string;           // stable, required
  firstName: string;    // required (can be "")
  lastName: string;     // required (can be "")
  email?: string;       // optional for now
  phone?: string;       // optional for now

  // optional future fields:
  // gradYear?: number;
  // notes?: string;
};

export function athleteDisplayName(a: Athlete) {
  const full = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim();
  return full || "Athlete";
}

export type AthleteWorkout = {
  id: string;                // unique id
  athleteName: string;       // from roster
  athleteId?: string;        // optional stable id when available
  batchId?: string;          // optional planner batch id for multi-athlete creation
  groupId?: string;          // optional subgroup number within a batch ("1", "2", ...)
  dateISO: string;           // YYYY-MM-DD
  session?: "AM" | "PM";     // AM or PM
  time?: string;             // optional start time label, independent from AM/PM
  location?: string;         // optional location label
  preRoutineIds?: string[];  // optional auxiliary routines before main workout
  postRoutineIds?: string[]; // optional auxiliary routines after main workout
  category: string;          // primary category (first selected)
  categories?: string[];     // all selected categories
  title?: string;            // optional short label
  details?: string;          // optional workout text
  plannedMiles?: number;     // optional for now
  plannedDistanceUnit?: "mi" | "km";
  completedMiles?: number;   // later from feedback
  completedTime?: string;    // athlete-reported time completed
  splitsOrPace?: string;     // athlete-reported splits / pace notes
  additionalFeedback?: string; // athlete extra notes
  feedback?: string;         // later
};

export type WeekStartDay = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 Sun ... 6 Sat

export type MileageValue =
  | { kind: "exact"; value: number }
  | { kind: "range"; min: number; max: number }
  | { kind: "time"; seconds: number; input?: "mm:ss" | "hh:mm:ss"; xt?: boolean }
  | { kind: "timeRange"; minSeconds: number; maxSeconds: number; input?: "mm:ss" | "hh:mm:ss"; xt?: boolean }
  | { kind: "choice"; options: [MileageValue, MileageValue] };

export type DailyMileageTarget = {
  am?: MileageValue;
  pm?: MileageValue;
  ncaaOff?: boolean;        // optional coach flag: NCAA off day
};

export type WeeklyMileagePlan = {
  athleteId: string;         // must match your roster athlete id
  weekStartISO: string;      // YYYY-MM-DD for the week’s first day (based on weekStart setting)
  days: Record<string, DailyMileageTarget>; // keys: "0".."6" where 0=weekStart day, 6=last day
  updatedAt: number;
};
