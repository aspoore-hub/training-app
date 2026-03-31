import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  Platform,
  Alert,
  Modal,
  Keyboard,
  useWindowDimensions,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { TabActions } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { AppText } from "../../../components/ui/AppText";
import { Screen } from "../../../components/ui/Screen";
import { useAppTheme } from "../../../components/ui/useAppTheme";
import { InlineSaveStatus } from "../../../components/shared/InlineSaveStatus";
import { loadJSON, saveJSON } from "../../../lib/storage";
import { supabase } from "../../../lib/supabase";
import { getCurrentTeamId } from "../../../lib/team";
import { buildTeamWorkoutInsertRows, createTeamWorkoutBatch } from "../../../lib/teamWorkoutsCloud";
import { normalizeWorkoutTimeInput } from "../../../lib/time";
import { loadCustomAthleteGroups, type CustomAthleteGroup } from "../../../lib/customGroups";
import {
  loadCoreCoachSettings,
  loadWeekStartSetting,
  type CoachCoreSettings,
  type WeekStartSetting,
} from "../../../lib/settings";
import {
  emptyPracticeTimeDefaults,
  getDefaultPracticeTime,
  loadPracticeTimeDefaults,
  type PracticeTimeDefaults,
} from "../../../lib/practiceDefaults";
import { loadWorkoutTemplates, type WorkoutTemplate } from "../../../lib/workoutTemplates";
import { deletePlannerDraft, loadPlannerDrafts, upsertPlannerDraft } from "../../../lib/plannerDrafts";
import { loadAuxiliaryRoutines, type AuxiliaryRoutine } from "../../../lib/auxiliaryRoutines";
import {
  loadCategoryRoutineDefaults,
  normalizeCategoryRoutineKey,
  type CategoryRoutineDefaults,
} from "../../../lib/categoryRoutineDefaults";
import {
  compareAthleteDisplayNamesByLastName,
  normalizeTeamRosterAthlete,
  searchRoster,
  sortRosterByName,
  type TeamRosterAthlete,
} from "../../../lib/teamRoster";
import { teamDataStore } from "../../../lib/teamDataStore";
import { useAppRuntime } from "../../../lib/appState";

import type { WorkoutCategory } from "../../../lib/types";

const KEY_PLANNER_SELECTED_ATHLETES = "training_app_planner_selected_athletes_v1";

type PlannerFieldKey =
  | "date"
  | "session"
  | "location"
  | "time"
  | "title"
  | "notes"
  | "category"
  | "athlete_search"
  | "athlete_list"
  | "create";

type MileageValue =
  | number
  | string
  | Record<string, any>
  | null
  | undefined;

type CreateFooterStatus = {
  status: "idle" | "saving" | "saved" | "error";
  message?: string;
};

function isoDateOnly(d: Date): string {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${yr}-${mo}-${da}`;
}

function parseISODateOnly(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatShortDateLabel(iso: string): string {
  const d = parseISODateOnly(iso);
  const month = d.toLocaleDateString(undefined, { month: "short" });
  const day = d.getDate();
  const year = d.getFullYear();
  return `${month} ${day}, ${year}`;
}

function isISODateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = parseISODateOnly(value);
  return isoDateOnly(d) === value;
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

function buildMonthGrid(anchor: Date) {
  const first = monthStart(anchor);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i);
    return {
      dateISO: isoDateOnly(d),
      dayNumber: d.getDate(),
      inMonth: d.getMonth() === anchor.getMonth(),
    };
  });
}

function tryExtractMiles(
  v: MileageValue
): { kind: "none" | "exact" | "range" | "text"; exact?: number; min?: number; max?: number; text?: string } {
  if (v == null) return { kind: "none" };
  if (typeof v === "number") return { kind: "exact", exact: v };

  if (typeof v === "string") {
    const s = v.trim();
    const range = s.match(/^(\d+(\.\d+)?)\s*-\s*(\d+(\.\d+)?)$/);
    if (range) return { kind: "range", min: Number(range[1]), max: Number(range[3]) };
    const num = Number(s);
    if (!Number.isNaN(num)) return { kind: "exact", exact: num };
    return { kind: "none" };
  }

  if (typeof v === "object") {
    if ((v as any).kind === "time" && typeof (v as any).seconds === "number") {
      const minutes = Math.round((v as any).seconds / 60);
      return { kind: "text", text: `${minutes}min` };
    }
    if ((v as any).kind === "timeRange" && typeof (v as any).minSeconds === "number" && typeof (v as any).maxSeconds === "number") {
      const a = Math.round(Math.min((v as any).minSeconds, (v as any).maxSeconds) / 60);
      const b = Math.round(Math.max((v as any).minSeconds, (v as any).maxSeconds) / 60);
      return { kind: "text", text: a === b ? `${a}min` : `${a}-${b}min` };
    }
    if ((v as any).kind === "minutes" && typeof (v as any).value === "number") {
      return { kind: "text", text: `${Math.round((v as any).value)}min` };
    }
    if ((v as any).kind === "minutesRange" && typeof (v as any).min === "number" && typeof (v as any).max === "number") {
      const a = Math.round(Math.min((v as any).min, (v as any).max));
      const b = Math.round(Math.max((v as any).min, (v as any).max));
      return { kind: "text", text: a === b ? `${a}min` : `${a}-${b}min` };
    }
    if (typeof (v as any).exact === "number") return { kind: "exact", exact: (v as any).exact };
    const min = typeof (v as any).min === "number" ? (v as any).min : undefined;
    const max = typeof (v as any).max === "number" ? (v as any).max : undefined;
    if (min != null || max != null) return { kind: "range", min, max };
  }

  return { kind: "none" };
}

function fmtMiles(v: MileageValue): string | null {
  const t = tryExtractMiles(v);
  if (t.kind === "none") return null;
  if (t.kind === "text") return t.text ?? null;
  if (t.kind === "exact") return `${t.exact}`;
  const a = t.min != null ? String(t.min) : "";
  const b = t.max != null ? String(t.max) : "";
  return `${a}-${b}`.replace(/^-/, "").replace(/-$/, "");
}

function mileageValueToPlannedDistance(v: MileageValue): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
    const range = trimmed.match(/^(\d+(\.\d+)?)\s*-\s*(\d+(\.\d+)?)$/);
    if (!range) return null;
    const a = Number(range[1]);
    const b = Number(range[3]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return (Math.min(a, b) + Math.max(a, b)) / 2;
  }

  if (typeof v === "object") {
    const kind = String((v as any).kind ?? "");
    if (kind === "exact" && typeof (v as any).value === "number" && Number.isFinite((v as any).value)) {
      return (v as any).value;
    }
    if (kind === "range") {
      const min = typeof (v as any).min === "number" && Number.isFinite((v as any).min) ? (v as any).min : null;
      const max = typeof (v as any).max === "number" && Number.isFinite((v as any).max) ? (v as any).max : null;
      if (min == null && max == null) return null;
      if (min != null && max != null) return (Math.min(min, max) + Math.max(min, max)) / 2;
      return min ?? max;
    }
    if (kind === "choice" && Array.isArray((v as any).options)) {
      const options = (v as any).options as MileageValue[];
      for (const option of options) {
        const parsed = mileageValueToPlannedDistance(option);
        if (parsed != null) return parsed;
      }
      return null;
    }
    const exact = typeof (v as any).exact === "number" && Number.isFinite((v as any).exact) ? (v as any).exact : null;
    if (exact != null) return exact;
    const min = typeof (v as any).min === "number" && Number.isFinite((v as any).min) ? (v as any).min : null;
    const max = typeof (v as any).max === "number" && Number.isFinite((v as any).max) ? (v as any).max : null;
    if (min == null && max == null) return null;
    if (min != null && max != null) return (Math.min(min, max) + Math.max(min, max)) / 2;
    return min ?? max;
  }

  return null;
}

function weekStartsOn(setting: WeekStartSetting): 0 | 1 {
  if (setting === "sunday") return 0;
  return 1;
}

function getWeekStartISO(dateISO: string, ws: 0 | 1): string {
  const dt = parseISODateOnly(dateISO);
  const dow = dt.getDay();
  const offset = (dow - ws + 7) % 7;
  dt.setDate(dt.getDate() - offset);
  return isoDateOnly(dt);
}

function createBatchId(dateISO: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `bat_${dateISO}_${suffix}`;
}

function resolveDefaultSessionSlotAndTimeForDate(
  dateISO: string,
  defaults: PracticeTimeDefaults,
  fallbackSession: "AM" | "PM" = "AM",
  fallbackTime = ""
): { session: "AM" | "PM"; timeText: string } {
  const amTime = getDefaultPracticeTime(defaults, dateISO, "AM") ?? "";
  const pmTime = getDefaultPracticeTime(defaults, dateISO, "PM") ?? "";
  if (amTime) return { session: "AM", timeText: amTime };
  if (pmTime) return { session: "PM", timeText: pmTime };
  return { session: fallbackSession, timeText: fallbackTime };
}

function dayIndexInWeek(dateISO: string, weekStartISO: string): number {
  const a = parseISODateOnly(weekStartISO);
  const b = parseISODateOnly(dateISO);
  const diffMs = b.getTime() - a.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function Chip({
  label,
  active,
  color,
  onPress,
  pressableRef,
  webProps,
}: {
  label: string;
  active: boolean;
  color?: string;
  onPress: () => void;
  pressableRef?: any;
  webProps?: any;
}) {
  return (
    <Pressable
      ref={pressableRef}
      onPress={onPress}
      {...(Platform.OS === "web" ? (webProps as any) : null)}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? (color ?? "#111") : "#ddd",
        backgroundColor: active ? (color ? `${color}22` : "#11111110") : "transparent",
        margin: 4,
      }}
    >
      <Text
        style={{
          fontSize: 13,
          color: active ? "#111" : "#555",
          fontWeight: active ? "800" : "700",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function PlannerScreen() {
  const router = useRouter();
  useAppTheme();
  const navigation = useNavigation();
  const { patch: patchAppRuntime } = useAppRuntime();
  const { width } = useWindowDimensions();

  const isWeb = Platform.OS === "web";
  const maxContentWidth = isWeb ? 1180 : undefined;

  const params = useLocalSearchParams<{
    date?: string | string[];
    saved?: string | string[];
    templateId?: string | string[];
    applyToken?: string | string[];
    draftId?: string | string[];
    applyDraftToken?: string | string[];
  }>();

  const dateParam = useMemo(() => {
    const raw = params?.date;
    return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  }, [params?.date]);

  const savedParam = useMemo(() => {
    const raw = params?.saved;
    return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  }, [params?.saved]);

  const templateIdParam = useMemo(() => {
    const raw = params?.templateId;
    return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  }, [params?.templateId]);

  const applyTokenParam = useMemo(() => {
    const raw = params?.applyToken;
    return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  }, [params?.applyToken]);

  const draftIdParam = useMemo(() => {
    const raw = params?.draftId;
    return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  }, [params?.draftId]);

  const applyDraftTokenParam = useMemo(() => {
    const raw = params?.applyDraftToken;
    return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  }, [params?.applyDraftToken]);

  const [dateISO, setDateISO] = useState<string>(() => {
    const fromParams = String(dateParam ?? "").trim();
    if (fromParams && isISODateOnly(fromParams)) return fromParams;
    return isoDateOnly(new Date());
  });
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [pickerMonth, setPickerMonth] = useState<Date>(() => monthStart(new Date()));
  const [showSavedBanner, setShowSavedBanner] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitDebug, setSubmitDebug] = useState("idle");
  const [createFooterStatus, setCreateFooterStatus] = useState<CreateFooterStatus>({ status: "idle" });
  const [weekStartSetting, setWeekStartSetting] = useState<WeekStartSetting>("monday");

  const [roster, setRoster] = useState<TeamRosterAthlete[]>([]);
  const [selectedAthleteIds, setSelectedAthleteIds] = useState<string[]>([]);

  const [athleteDropdownOpen, setAthleteDropdownOpen] = useState(false);
  const [athleteSearch, setAthleteSearch] = useState("");

  const [customGroups, setCustomGroups] = useState<CustomAthleteGroup[]>([]);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [location, setLocation] = useState("");
  const [timeText, setTimeText] = useState("");
  const [timeManuallyEdited, setTimeManuallyEdited] = useState(false);
  const [coreCoachSettings, setCoreCoachSettings] = useState<CoachCoreSettings | null>(null);
  const [practiceDefaults, setPracticeDefaults] = useState<PracticeTimeDefaults>(emptyPracticeTimeDefaults());
  const [session, setSession] = useState<"AM" | "PM">("AM");
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const [activeCategorySlotIndex, setActiveCategorySlotIndex] = useState<number | null>(null);
  const [categorySearch, setCategorySearch] = useState("");
  const [categorySlotCount, setCategorySlotCount] = useState(1);

  const [templates, setTemplates] = useState<WorkoutTemplate[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  const [auxiliaryRoutines, setAuxiliaryRoutines] = useState<AuxiliaryRoutine[]>([]);
  const [categoryRoutineDefaults, setCategoryRoutineDefaults] = useState<CategoryRoutineDefaults>({});
  const [preRoutineIds, setPreRoutineIds] = useState<string[]>([]);
  const [postRoutineIds, setPostRoutineIds] = useState<string[]>([]);
  const [preRoutineDropdownOpen, setPreRoutineDropdownOpen] = useState(false);
  const [postRoutineDropdownOpen, setPostRoutineDropdownOpen] = useState(false);
  const [activePreRoutineSlotIndex, setActivePreRoutineSlotIndex] = useState<number | null>(null);
  const [activePostRoutineSlotIndex, setActivePostRoutineSlotIndex] = useState<number | null>(null);
  const [preRoutineSearch, setPreRoutineSearch] = useState("");
  const [postRoutineSearch, setPostRoutineSearch] = useState("");
  const [preRoutineSlotCount, setPreRoutineSlotCount] = useState(1);
  const [postRoutineSlotCount, setPostRoutineSlotCount] = useState(1);

  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [activeInput, setActiveInput] = useState<null | "location" | "time" | "title" | "details">(null);
  const [focusedFieldKey, setFocusedFieldKey] = useState<PlannerFieldKey>("date");

  const fieldOrder: PlannerFieldKey[] = [
    "date",
    "session",
    "location",
    "time",
    "title",
    "notes",
    "category",
    "athlete_search",
    "athlete_list",
    "create",
  ];

  const dateBtnRef = useRef<any>(null);
  const amChipRef = useRef<any>(null);
  const pmChipRef = useRef<any>(null);
  const categoryRef = useRef<any>(null);
  const athleteSearchRef = useRef<TextInput>(null);
  const createBtnRef = useRef<any>(null);
  const locationRef = useRef<TextInput>(null);
  const timeRef = useRef<TextInput>(null);
  const titleRef = useRef<TextInput>(null);
  const detailsRef = useRef<TextInput>(null);

  const lastAppliedTemplateTokenRef = useRef("");
  const lastAppliedDraftTokenRef = useRef("");
  const baselineRef = useRef("");
  const isDirtyRef = useRef(false);
  const suppressPromptRef = useRef(false);
  const [suppressPrompt, setSuppressPrompt] = useState(false);

  const snapshot = useMemo(
    () =>
      JSON.stringify({
        dateISO,
        session,
        location: location.trim(),
        timeText: timeText.trim(),
        title: title.trim(),
        details: details.trim(),
        categoryIds: [...categoryIds],
        selectedAthleteIds: [...selectedAthleteIds],
        preRoutineIds: [...preRoutineIds],
        postRoutineIds: [...postRoutineIds],
      }),
    [categoryIds, dateISO, details, location, postRoutineIds, preRoutineIds, selectedAthleteIds, session, timeText, title]
  );

  const isDirty = baselineRef.current !== "" && baselineRef.current !== snapshot;

  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    suppressPromptRef.current = suppressPrompt;
  }, [suppressPrompt]);

  useEffect(() => {
    const next = String(dateParam ?? "").trim();
    if (!next || !isISODateOnly(next)) return;
    setDateISO(next);
  }, [dateParam]);

  useEffect(() => {
    if (savedParam !== "1") return;
    setShowSavedBanner(true);
    const timer = setTimeout(() => setShowSavedBanner(false), 2200);
    return () => clearTimeout(timer);
  }, [savedParam]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;

      (async () => {
        patchAppRuntime({ lastSettingsLoadStatus: "loading" });

        try {
          const weekStartResult = await loadWeekStartSetting().catch(() => ({
            raw: "monday" as WeekStartSetting,
            normalized: "monday" as WeekStartSetting,
          }));
          const ws = weekStartResult.normalized;
          console.log("[planner] week start loaded via shared helper", {
            raw: weekStartResult.raw,
            normalized: ws,
          });

          await teamDataStore.actions.refreshRoster({ force: true }).catch((error) => {
            console.warn("[planner] teamDataStore refreshRoster failed", error);
          });

          const storeRoster = teamDataStore.getState().roster ?? [];
          const rosterResult = sortRosterByName(
            storeRoster
              .map((row) => normalizeTeamRosterAthlete(row))
              .filter((row): row is TeamRosterAthlete => !!row)
          );

          const savedSelected = await loadJSON<string[]>(KEY_PLANNER_SELECTED_ATHLETES, []).catch((error) => {
            console.warn("[planner] selected athletes load failed", error);
            return [];
          });

          const savedGroups = await loadCustomAthleteGroups().catch((error) => {
            console.warn("[planner] custom groups load failed", error);
            return [];
          });

          const savedCoreSettings = await loadCoreCoachSettings().catch((error) => {
            console.warn("[planner] core coach settings load failed", error);
            return null as CoachCoreSettings | null;
          });
          const savedPracticeDefaults = await loadPracticeTimeDefaults().catch((error) => {
            console.warn("[planner] practice defaults load failed", error);
            return emptyPracticeTimeDefaults();
          });

          const savedTemplates = await loadWorkoutTemplates().catch((error) => {
            console.warn("[planner] workout templates load failed", error);
            return [];
          });

          const savedAuxiliaryRoutines = await loadAuxiliaryRoutines().catch((error) => {
            console.warn("[planner] auxiliary routines load failed", error);
            return [];
          });

          const savedCategoryRoutineDefaults = await loadCategoryRoutineDefaults().catch((error) => {
            console.warn("[planner] category routine defaults load failed", error);
            return {};
          });

          if (!mounted) return;

          console.log("[planner] roster from teamDataStore", rosterResult.length, rosterResult);
          const plannerCategories = Array.isArray(savedCoreSettings?.categories) ? savedCoreSettings.categories : [];
          console.log("[planner] categories from coach settings", plannerCategories.length, plannerCategories);

          setWeekStartSetting(ws);
          setRoster(rosterResult);
          setCategories(plannerCategories);
          setCustomGroups(Array.isArray(savedGroups) ? savedGroups : []);
          setCoreCoachSettings(savedCoreSettings);
          setPracticeDefaults(savedPracticeDefaults);
          setTemplates(Array.isArray(savedTemplates) ? savedTemplates : []);
          setAuxiliaryRoutines(Array.isArray(savedAuxiliaryRoutines) ? savedAuxiliaryRoutines : []);
          setCategoryRoutineDefaults(savedCategoryRoutineDefaults ?? {});

          const shouldPreserveInProgressForm = isDirtyRef.current && !suppressPromptRef.current;
          if (shouldPreserveInProgressForm) {
            patchAppRuntime({
              lastSettingsLoadStatus: "loaded",
              lastSaveError: null,
            });
            return;
          }

          const rosterIdSet = new Set(rosterResult.map((a) => a.id));
          const cleaned = (savedSelected ?? []).filter((id) => rosterIdSet.has(id));
          const defaultsForDate = resolveDefaultSessionSlotAndTimeForDate(dateISO, savedPracticeDefaults, "AM", "");
          setSelectedAthleteIds(cleaned);
          setActiveDraftId(null);
          setSession(defaultsForDate.session);
          setTimeText(defaultsForDate.timeText);
          setTimeManuallyEdited(false);

          baselineRef.current = JSON.stringify({
            dateISO,
            session: defaultsForDate.session,
            location: "",
            timeText: defaultsForDate.timeText,
            title: "",
            details: "",
            categoryIds: [],
            selectedAthleteIds: cleaned,
            preRoutineIds: [],
            postRoutineIds: [],
          });

          patchAppRuntime({
            lastSettingsLoadStatus: "loaded",
            lastSaveError: null,
          });
        } catch (e: any) {
          const message = String(e?.message ?? e ?? "Planner load failed");
          console.warn("[planner] fatal planner load error", e);

          if (!mounted) return;

          setRoster([]);
          setCategories([]);
          setCustomGroups([]);
          setTemplates([]);
          setAuxiliaryRoutines([]);
          setCategoryRoutineDefaults({});

          patchAppRuntime({
            lastSettingsLoadStatus: "error",
            lastSaveError: message,
          });
        }
      })();

      return () => {
        mounted = false;
      };
    }, [])
  );

  useEffect(() => {
    patchAppRuntime({ activeDateISO: dateISO, plannerDraftId: activeDraftId });
  }, [activeDraftId, dateISO, patchAppRuntime]);

  useEffect(() => {
    patchAppRuntime({ lastPlannerSubmitDebug: submitDebug });
  }, [patchAppRuntime, submitDebug]);

  useEffect(() => {
    if (createFooterStatus.status !== "saved") return;
    const timer = setTimeout(() => setCreateFooterStatus({ status: "idle" }), 2200);
    return () => clearTimeout(timer);
  }, [createFooterStatus.status]);

  useEffect(() => {
    if (!suppressPrompt) return;
    const timer = setTimeout(() => setSuppressPrompt(false), 250);
    return () => clearTimeout(timer);
  }, [suppressPrompt]);

  const rosterSorted = useMemo(() => [...roster], [roster]);

  const rosterById = useMemo(() => {
    const m = new Map<string, TeamRosterAthlete>();
    for (const a of roster) m.set(a.id, a);
    return m;
  }, [roster]);

  const ws = useMemo(() => weekStartsOn(weekStartSetting), [weekStartSetting]);
  const weekStartISO = useMemo(() => getWeekStartISO(dateISO, ws), [dateISO, ws]);

  useEffect(() => {
    void teamDataStore.actions.loadMileageWeek(weekStartISO).catch((error) => {
      console.warn("[planner] loadMileageWeek failed", error);
    });
  }, [weekStartISO]);

  const resolvedDefaultTime = useMemo(
    () => getDefaultPracticeTime(practiceDefaults, dateISO, session) ?? "",
    [practiceDefaults, dateISO, session]
  );

  const pickerMonthLabel = useMemo(
    () => pickerMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    [pickerMonth]
  );

  const pickerCells = useMemo(() => buildMonthGrid(pickerMonth), [pickerMonth]);

  const categoryById = useMemo(() => {
    const m = new Map<string, WorkoutCategory>();
    for (const c of categories) m.set(c.id, c);
    return m;
  }, [categories]);

  const selectedCategories = useMemo(
    () => categoryIds.map((id) => categoryById.get(id)).filter((c): c is WorkoutCategory => !!c),
    [categoryById, categoryIds]
  );

  const selectedCategoryNamesNormalized = useMemo(() => {
    return categoryIds
      .map((id) => categoryById.get(id)?.name ?? "")
      .map((name) => normalizeCategoryRoutineKey(name))
      .filter(Boolean);
  }, [categoryById, categoryIds]);

  const derivedAutoPreRoutineIds = useMemo(() => {
    const taggedPre = auxiliaryRoutines.flatMap((routine) => {
      const preTags = Array.isArray(routine.preCategoryNames) ? routine.preCategoryNames : [];
      const postTags = Array.isArray(routine.postCategoryNames) ? routine.postCategoryNames : [];
      const hasExplicitTags = preTags.length > 0 || postTags.length > 0;
      const legacyTags = !hasExplicitTags && Array.isArray((routine as any).categoryNames) ? (routine as any).categoryNames : [];

      const matches =
        preTags.some((name) => selectedCategoryNamesNormalized.includes(normalizeCategoryRoutineKey(name))) ||
        legacyTags.some((name: string) => selectedCategoryNamesNormalized.includes(normalizeCategoryRoutineKey(name)));

      return matches ? [routine.id] : [];
    });

    const defaults = selectedCategoryNamesNormalized.flatMap((name) =>
      Array.isArray(categoryRoutineDefaults[name]) ? categoryRoutineDefaults[name] : []
    );

    return Array.from(new Set([...taggedPre, ...defaults]));
  }, [auxiliaryRoutines, categoryRoutineDefaults, selectedCategoryNamesNormalized]);

  const derivedAutoPostRoutineIds = useMemo(() => {
    const taggedPost = auxiliaryRoutines.flatMap((routine) => {
      const postTags = Array.isArray(routine.postCategoryNames) ? routine.postCategoryNames : [];
      const matches = postTags.some((name) =>
        selectedCategoryNamesNormalized.includes(normalizeCategoryRoutineKey(name))
      );
      return matches ? [routine.id] : [];
    });

    return Array.from(new Set(taggedPost));
  }, [auxiliaryRoutines, selectedCategoryNamesNormalized]);

  const effectivePreRoutineIds = useMemo(
    () => Array.from(new Set([...preRoutineIds, ...derivedAutoPreRoutineIds])),
    [preRoutineIds, derivedAutoPreRoutineIds]
  );

  const effectivePostRoutineIds = useMemo(
    () => Array.from(new Set([...postRoutineIds, ...derivedAutoPostRoutineIds])),
    [postRoutineIds, derivedAutoPostRoutineIds]
  );

  const footerSummary = useMemo(() => {
    const normalizedTime = normalizeWorkoutTimeInput(timeText.trim() || "") || timeText.trim() || "—";
    const categorySummary =
      selectedCategories.length > 0 ? selectedCategories.map((c) => c.name).join(", ") : "—";

    const selectedSet = new Set(selectedAthleteIds.map((id) => String(id)));
    const dayIdx = dayIndexInWeek(dateISO, weekStartISO);
    const mileageWeekCells = teamDataStore.getState().mileageCellsByWeek[weekStartISO] ?? [];
    const matchedAthletes = new Set<string>();
    for (const row of mileageWeekCells as any[]) {
      const athleteProfileId = String(row?.athlete_profile_id ?? "").trim();
      const rowDayIdx = Number(row?.day_idx);
      const rowSession = String(row?.session ?? "").toUpperCase();
      if (!athleteProfileId || !selectedSet.has(athleteProfileId)) continue;
      if (!Number.isInteger(rowDayIdx) || rowDayIdx !== dayIdx) continue;
      const sessionKey = rowSession === "PM" ? "PM" : "AM";
      if (sessionKey !== session) continue;
      const plannedValue = mileageValueToPlannedDistance(row?.value as MileageValue);
      if (typeof plannedValue === "number" && Number.isFinite(plannedValue)) {
        matchedAthletes.add(athleteProfileId);
      }
    }

    return {
      date: formatShortDateLabel(dateISO),
      session,
      time: normalizedTime,
      title: title.trim() || "Workout",
      category: categorySummary,
      athleteCount: selectedAthleteIds.length,
      preCount: effectivePreRoutineIds.length,
      postCount: effectivePostRoutineIds.length,
      mileageCoverage: `${matchedAthletes.size}/${selectedAthleteIds.length}`,
    };
  }, [
    dateISO,
    effectivePostRoutineIds.length,
    effectivePreRoutineIds.length,
    selectedAthleteIds,
    selectedCategories,
    session,
    timeText,
    title,
    weekStartISO,
  ]);

  const preSubmitWarnings = useMemo(() => {
    const warnings: string[] = [];
    const selectedCount = selectedAthleteIds.length;

    if (selectedCount === 0) {
      warnings.push("No athletes selected.");
    }

    const [matchedRaw, selectedRaw] = String(footerSummary.mileageCoverage ?? "0/0").split("/");
    const matched = Number(matchedRaw);
    const selectedFromCoverage = Number(selectedRaw);
    if (
      Number.isFinite(matched) &&
      Number.isFinite(selectedFromCoverage) &&
      selectedFromCoverage > 0 &&
      matched < selectedFromCoverage
    ) {
      warnings.push(`Mileage match is low (${matched}/${selectedFromCoverage}).`);
    }

    if (!title.trim()) {
      warnings.push('Title is blank (will use fallback "Workout").');
    }

    if (!details.trim()) {
      warnings.push("Details are blank.");
    }

    const rawTime = timeText.trim();
    if (rawTime) {
      const normalized = normalizeWorkoutTimeInput(rawTime);
      if (!normalized) {
        warnings.push("Time format looks unusual.");
      } else if (normalized !== rawTime) {
        warnings.push(`Time will be normalized to ${normalized}.`);
      }
    }

    return warnings;
  }, [details, footerSummary.mileageCoverage, selectedAthleteIds.length, timeText, title]);

  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === selectedTemplateId) ?? null,
    [selectedTemplateId, templates]
  );

  const plannerGroups = useMemo(() => {
    return [...customGroups]
      .map((group) => {
        const athleteIds = group.athleteIds.filter((id) => rosterById.has(id));
        return { ...group, athleteIds };
      })
      .filter((group) => group.athleteIds.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [customGroups, rosterById]);

  const rosterForPicker = useMemo(() => {
    return searchRoster(rosterSorted, athleteSearch);
  }, [athleteSearch, rosterSorted]);

  useEffect(() => {
    console.log("[planner] rendered roster length", roster.length);
    console.log("[planner] rendered rosterForPicker length", rosterForPicker.length);
    console.log("[planner] rendered categories length", categories.length);
  }, [roster, rosterForPicker, categories]);

  const categoriesForPicker = useMemo(() => {
    const q = String(categorySearch ?? "").trim().toLowerCase();
    const list = [...categories].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    if (!q) return list;
    return list.filter((c) => String(c.name ?? "").toLowerCase().includes(q));
  }, [categories, categorySearch]);

  const routinesForPrePicker = useMemo(() => {
    const q = String(preRoutineSearch ?? "").trim().toLowerCase();
    const list = [...auxiliaryRoutines].sort((a, b) =>
      String(a.title ?? "").localeCompare(String(b.title ?? ""))
    );
    if (!q) return list;
    return list.filter((r) => String(r.title ?? "").toLowerCase().includes(q));
  }, [auxiliaryRoutines, preRoutineSearch]);

  const routinesForPostPicker = useMemo(() => {
    const q = String(postRoutineSearch ?? "").trim().toLowerCase();
    const list = [...auxiliaryRoutines].sort((a, b) =>
      String(a.title ?? "").localeCompare(String(b.title ?? ""))
    );
    if (!q) return list;
    return list.filter((r) => String(r.title ?? "").toLowerCase().includes(q));
  }, [auxiliaryRoutines, postRoutineSearch]);

  const visibleCategorySlotCount = Math.max(1, categoryIds.length, categorySlotCount);
  const visiblePreRoutineSlotCount = Math.max(1, effectivePreRoutineIds.length, preRoutineSlotCount);
  const visiblePostRoutineSlotCount = Math.max(1, effectivePostRoutineIds.length, postRoutineSlotCount);

  useEffect(() => {
    if (timeManuallyEdited && timeText.trim()) return;
    setTimeText(resolvedDefaultTime || "");
  }, [resolvedDefaultTime, timeManuallyEdited, timeText]);

  useEffect(() => {
    setCategorySlotCount((prev) => Math.max(prev, Math.max(1, categoryIds.length)));
  }, [categoryIds.length]);

  useEffect(() => {
    setPreRoutineSlotCount((prev) => Math.max(prev, Math.max(1, effectivePreRoutineIds.length)));
  }, [effectivePreRoutineIds.length]);

  useEffect(() => {
    setPostRoutineSlotCount((prev) => Math.max(prev, Math.max(1, effectivePostRoutineIds.length)));
  }, [effectivePostRoutineIds.length]);

  const applyCustomGroup = useCallback(
    async (group: CustomAthleteGroup) => {
      const next = group.athleteIds.filter((id) => rosterById.has(id));
      setSelectedAthleteIds(next);
      await saveJSON(KEY_PLANNER_SELECTED_ATHLETES, next);
    },
    [rosterById]
  );

  const toggleAthlete = useCallback(async (athleteId: string) => {
    setSelectedAthleteIds((prev) => {
      const next = prev.includes(athleteId) ? prev.filter((x) => x !== athleteId) : [...prev, athleteId];
      saveJSON(KEY_PLANNER_SELECTED_ATHLETES, next).catch(() => {});
      return next;
    });
  }, []);

  const bumpDate = useCallback(
    (delta: number) => {
      const dt = parseISODateOnly(dateISO);
      dt.setDate(dt.getDate() + delta);
      setDateISO(isoDateOnly(dt));
    },
    [dateISO]
  );

  const openDatePicker = useCallback(() => {
    setPickerMonth(monthStart(parseISODateOnly(dateISO)));
    setDatePickerOpen(true);
  }, [dateISO]);

  const dismissKeyboard = useCallback(() => {
    locationRef.current?.blur();
    timeRef.current?.blur();
    titleRef.current?.blur();
    detailsRef.current?.blur();
    Keyboard.dismiss();
    setActiveInput(null);
  }, []);

  const applyTemplate = useCallback(
    (template: WorkoutTemplate) => {
      const byName = new Map(categories.map((cat) => [cat.name.trim().toLowerCase(), cat.id] as const));
      const templateCategoryNames =
        template.categories.length > 0
          ? template.categories
          : template.primaryCategory
            ? [template.primaryCategory]
            : [];

      const nextCategoryIds = templateCategoryNames
        .map((name) => byName.get(String(name ?? "").trim().toLowerCase()) ?? null)
        .filter((id): id is string => !!id);

      setCategoryIds(Array.from(new Set(nextCategoryIds)));
      setCategorySlotCount(Math.max(1, nextCategoryIds.length || 1));

      if (template.location != null) setLocation(String(template.location ?? ""));
      setTitle(String(template.title ?? ""));
      setDetails(String(template.details ?? ""));
      setSelectedTemplateId(template.id);
      setTemplatePickerOpen(false);
    },
    [categories]
  );

  useEffect(() => {
    if (!templateIdParam || !applyTokenParam || templates.length === 0) return;

    const token = `${templateIdParam}:${applyTokenParam}`;
    if (lastAppliedTemplateTokenRef.current === token) return;

    const template = templates.find((t) => t.id === templateIdParam);
    if (!template) return;

    lastAppliedTemplateTokenRef.current = token;
    applyTemplate(template);
  }, [applyTemplate, applyTokenParam, templateIdParam, templates]);

  useEffect(() => {
    if (!selectedTemplateId) return;
    if (templates.some((item) => item.id === selectedTemplateId)) return;
    setSelectedTemplateId("");
  }, [selectedTemplateId, templates]);

  useEffect(() => {
    if (!draftIdParam || !applyDraftTokenParam) return;
    const token = `${draftIdParam}:${applyDraftTokenParam}`;
    if (lastAppliedDraftTokenRef.current === token) return;
    lastAppliedDraftTokenRef.current = token;

    (async () => {
      const list = await loadPlannerDrafts();
      const draft = list.find((d) => d.id === draftIdParam);
      if (!draft) return;

      setDateISO(draft.dateISO);
      setPickerMonth(monthStart(parseISODateOnly(draft.dateISO)));
      setSession(draft.session);
      setLocation(draft.location ?? "");
      setTimeText(draft.timeText ?? "");
      setTimeManuallyEdited(!!String(draft.timeText ?? "").trim());
      setTitle(draft.title ?? "");
      setDetails(draft.details ?? "");
      setCategoryIds(Array.isArray(draft.categoryIds) ? draft.categoryIds : []);
      setCategorySlotCount(Math.max(1, Array.isArray(draft.categoryIds) ? draft.categoryIds.length || 1 : 1));
      setSelectedAthleteIds(Array.isArray(draft.selectedAthleteIds) ? draft.selectedAthleteIds : []);
      setPreRoutineIds(Array.isArray(draft.preRoutineIds) ? draft.preRoutineIds : []);
      setPostRoutineIds(Array.isArray(draft.postRoutineIds) ? draft.postRoutineIds : []);
      setActiveDraftId(draft.id);

      baselineRef.current = JSON.stringify({
        dateISO: draft.dateISO,
        session: draft.session,
        location: String(draft.location ?? "").trim(),
        timeText: String(draft.timeText ?? "").trim(),
        title: String(draft.title ?? "").trim(),
        details: String(draft.details ?? "").trim(),
        categoryIds: Array.isArray(draft.categoryIds) ? draft.categoryIds : [],
        selectedAthleteIds: Array.isArray(draft.selectedAthleteIds) ? draft.selectedAthleteIds : [],
        preRoutineIds: Array.isArray(draft.preRoutineIds) ? draft.preRoutineIds : [],
        postRoutineIds: Array.isArray(draft.postRoutineIds) ? draft.postRoutineIds : [],
      });
    })();
  }, [applyDraftTokenParam, draftIdParam]);

  const saveCurrentAsDraft = useCallback(async () => {
    const saved = await upsertPlannerDraft({
      id: activeDraftId ?? undefined,
      dateISO,
      session,
      location,
      timeText,
      title,
      details,
      categoryIds,
      selectedAthleteIds,
      preRoutineIds,
      postRoutineIds,
    });
    setActiveDraftId(saved.id);
    baselineRef.current = snapshot;
    return saved.id;
  }, [
    activeDraftId,
    categoryIds,
    dateISO,
    details,
    location,
    postRoutineIds,
    preRoutineIds,
    selectedAthleteIds,
    session,
    snapshot,
    timeText,
    title,
  ]);

  const resetPlannerToBaseline = useCallback(() => {
    try {
      const parsed = JSON.parse(baselineRef.current || "{}");
      if (typeof parsed !== "object" || parsed == null) return;
      if (typeof parsed.dateISO === "string" && isISODateOnly(parsed.dateISO)) setDateISO(parsed.dateISO);
      setSession(parsed.session === "PM" ? "PM" : "AM");
      setLocation(String(parsed.location ?? ""));
      setTimeText(String(parsed.timeText ?? ""));
      setTimeManuallyEdited(!!String(parsed.timeText ?? "").trim());
      setTitle(String(parsed.title ?? ""));
      setDetails(String(parsed.details ?? ""));
      setCategoryIds(Array.isArray(parsed.categoryIds) ? parsed.categoryIds : []);
      setCategorySlotCount(Math.max(1, Array.isArray(parsed.categoryIds) ? parsed.categoryIds.length || 1 : 1));
      setSelectedAthleteIds(Array.isArray(parsed.selectedAthleteIds) ? parsed.selectedAthleteIds : []);
      setPreRoutineIds(Array.isArray(parsed.preRoutineIds) ? parsed.preRoutineIds : []);
      setPostRoutineIds(Array.isArray(parsed.postRoutineIds) ? parsed.postRoutineIds : []);
      setActiveDraftId(null);
    } catch {
      //
    }
  }, []);

  const confirmLeavePlanner = useCallback(
    (onProceed: () => void) => {
      Alert.alert("Save draft?", "You have unfinished session changes. Save as draft or discard?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            setSuppressPrompt(true);
            resetPlannerToBaseline();
            requestAnimationFrame(() => {
              onProceed();
            });
          },
        },
        {
          text: "Save Draft",
          onPress: async () => {
            await saveCurrentAsDraft();
            setSuppressPrompt(true);
            requestAnimationFrame(() => {
              onProceed();
            });
          },
        },
      ]);
    },
    [resetPlannerToBaseline, saveCurrentAsDraft]
  );

  usePreventRemove(isDirty && !suppressPrompt, (e) => {
    confirmLeavePlanner(() => navigation.dispatch(e.data.action));
  });

  useFocusEffect(
    useCallback(() => {
      const parent = navigation.getParent();
      if (!parent) return;
      const parentAny = parent as any;

      const unsubscribe = parentAny.addListener("tabPress", (e: any) => {
        if (!isDirty || suppressPrompt) return;
        const state = parentAny.getState?.();
        const targetRoute = state?.routes?.find((r: any) => r.key === e.target);
        const targetName = String(targetRoute?.name ?? "");
        if (!targetName || targetName === "planner") return;

        e.preventDefault();
        confirmLeavePlanner(() => {
          parentAny.dispatch(TabActions.jumpTo(targetName));
        });
      });

      return unsubscribe;
    }, [confirmLeavePlanner, isDirty, navigation, suppressPrompt])
  );

  const updateManualPreFromEffectiveChange = useCallback(
    (nextEffectiveIds: string[]) => {
      const autoSet = new Set(derivedAutoPreRoutineIds);
      const nextManual = nextEffectiveIds.filter((id) => !autoSet.has(id));
      setPreRoutineIds(Array.from(new Set(nextManual)));
    },
    [derivedAutoPreRoutineIds]
  );

  const updateManualPostFromEffectiveChange = useCallback(
    (nextEffectiveIds: string[]) => {
      const autoSet = new Set(derivedAutoPostRoutineIds);
      const nextManual = nextEffectiveIds.filter((id) => !autoSet.has(id));
      setPostRoutineIds(Array.from(new Set(nextManual)));
    },
    [derivedAutoPostRoutineIds]
  );

  const selectPreRoutineIntoSlot = useCallback(
    (routineId: string) => {
      const cleaned = effectivePreRoutineIds.filter(Boolean);
      let nextEffective = [...cleaned];

      if (activePreRoutineSlotIndex == null) {
        if (!nextEffective.includes(routineId)) {
          nextEffective.push(routineId);
        }
        updateManualPreFromEffectiveChange(nextEffective);
        setPreRoutineDropdownOpen(false);
        setPreRoutineSearch("");
        setActivePreRoutineSlotIndex(null);
        return;
      }

      const existingIndex = nextEffective.findIndex((id) => id === routineId);

      if (existingIndex >= 0) {
        if (existingIndex !== activePreRoutineSlotIndex) {
          nextEffective.splice(existingIndex, 1);
          const adjustedTarget =
            existingIndex < activePreRoutineSlotIndex
              ? activePreRoutineSlotIndex - 1
              : activePreRoutineSlotIndex;
          nextEffective[adjustedTarget] = routineId;
        }
      } else {
        nextEffective[activePreRoutineSlotIndex] = routineId;
      }

      nextEffective = nextEffective.filter(Boolean);
      updateManualPreFromEffectiveChange(nextEffective);
      setPreRoutineDropdownOpen(false);
      setPreRoutineSearch("");
      setActivePreRoutineSlotIndex(null);
    },
    [activePreRoutineSlotIndex, effectivePreRoutineIds, updateManualPreFromEffectiveChange]
  );

  const selectPostRoutineIntoSlot = useCallback(
    (routineId: string) => {
      const cleaned = effectivePostRoutineIds.filter(Boolean);
      let nextEffective = [...cleaned];

      if (activePostRoutineSlotIndex == null) {
        if (!nextEffective.includes(routineId)) {
          nextEffective.push(routineId);
        }
        updateManualPostFromEffectiveChange(nextEffective);
        setPostRoutineDropdownOpen(false);
        setPostRoutineSearch("");
        setActivePostRoutineSlotIndex(null);
        return;
      }

      const existingIndex = nextEffective.findIndex((id) => id === routineId);

      if (existingIndex >= 0) {
        if (existingIndex !== activePostRoutineSlotIndex) {
          nextEffective.splice(existingIndex, 1);
          const adjustedTarget =
            existingIndex < activePostRoutineSlotIndex
              ? activePostRoutineSlotIndex - 1
              : activePostRoutineSlotIndex;
          nextEffective[adjustedTarget] = routineId;
        }
      } else {
        nextEffective[activePostRoutineSlotIndex] = routineId;
      }

      nextEffective = nextEffective.filter(Boolean);
      updateManualPostFromEffectiveChange(nextEffective);
      setPostRoutineDropdownOpen(false);
      setPostRoutineSearch("");
      setActivePostRoutineSlotIndex(null);
    },
    [activePostRoutineSlotIndex, effectivePostRoutineIds, updateManualPostFromEffectiveChange]
  );

  const removePreRoutineAtSlot = useCallback(
    (slotIndex: number) => {
      const targetId = effectivePreRoutineIds[slotIndex];
      if (!targetId) return;
      if (derivedAutoPreRoutineIds.includes(targetId)) return;

      setPreRoutineIds((prev) => prev.filter((id) => id !== targetId));
      setPreRoutineSlotCount((prev) => Math.max(1, prev - 1));

      if (activePreRoutineSlotIndex === slotIndex) {
        setActivePreRoutineSlotIndex(null);
        setPreRoutineDropdownOpen(false);
        setPreRoutineSearch("");
      }
    },
    [activePreRoutineSlotIndex, derivedAutoPreRoutineIds, effectivePreRoutineIds]
  );

  const removePostRoutineAtSlot = useCallback(
    (slotIndex: number) => {
      const targetId = effectivePostRoutineIds[slotIndex];
      if (!targetId) return;
      if (derivedAutoPostRoutineIds.includes(targetId)) return;

      setPostRoutineIds((prev) => prev.filter((id) => id !== targetId));
      setPostRoutineSlotCount((prev) => Math.max(1, prev - 1));

      if (activePostRoutineSlotIndex === slotIndex) {
        setActivePostRoutineSlotIndex(null);
        setPostRoutineDropdownOpen(false);
        setPostRoutineSearch("");
      }
    },
    [activePostRoutineSlotIndex, derivedAutoPostRoutineIds, effectivePostRoutineIds]
  );

  const handleCreateSession = useCallback(async () => {
    setSubmitDebug("button pressed");

    if (creating) return;
    setCreateFooterStatus({ status: "saving" });

    if (selectedAthleteIds.length === 0) {
      setSubmitDebug("no athletes selected");
      Alert.alert("No athletes selected", "Select at least one athlete before creating workouts.");
      setCreateFooterStatus({ status: "error", message: "Select at least one athlete." });
      return;
    }

    setCreating(true);

    try {
      const newBatchId = createBatchId(dateISO);
      setSubmitDebug(`batch id: ${newBatchId}`);

      const teamId = await getCurrentTeamId();
      patchAppRuntime({ currentTeamId: String(teamId ?? "").trim() || null });

      const rawTime = timeText.trim();
      const normalizedTime = rawTime ? normalizeWorkoutTimeInput(rawTime) : null;
      if (rawTime && !normalizedTime) {
        setSubmitDebug("invalid time");
        Alert.alert("Invalid time", "Enter time like 8a, 12p, 8:00am, or 20:00.");
        setCreateFooterStatus({ status: "error", message: "Invalid time format." });
        return;
      }

      const categoryNames = selectedCategories.map((c) => c.name);
      const primaryCategory = categoryNames[0] ?? null;
      const masterTitle = title.trim() || "Workout";
      const masterLocation = location.trim();
      const plannedDistanceUnit = coreCoachSettings?.distanceUnit ?? "mi";

      const orderedAthleteIds = [...selectedAthleteIds].sort((aId, bId) => {
        const aName = String(rosterById.get(aId)?.displayName ?? "");
        const bName = String(rosterById.get(bId)?.displayName ?? "");
        return compareAthleteDisplayNamesByLastName(aName, bName);
      });

      const dayIdx = dayIndexInWeek(dateISO, weekStartISO);
      const plannedDistanceByAthlete = new Map<string, number | null>();
      const mileageWeekCells = teamDataStore.getState().mileageCellsByWeek[weekStartISO] ?? [];
      const mileageByAthleteDaySession = new Map<string, any>();
      for (const row of mileageWeekCells as any[]) {
        const athleteProfileId = String(row?.athlete_profile_id ?? "").trim();
        const rowDayIdx = Number(row?.day_idx);
        const rowSession = String(row?.session ?? "").toUpperCase();
        if (!athleteProfileId || !Number.isInteger(rowDayIdx) || rowDayIdx < 0 || rowDayIdx > 6) continue;
        const sessionKey = rowSession === "PM" ? "PM" : "AM";
        mileageByAthleteDaySession.set(
          `${athleteProfileId}__${rowDayIdx}__${sessionKey}`,
          row?.value ?? null
        );
      }

      const createdBy = (await supabase.auth.getSession()).data.session?.user?.id ?? null;

      orderedAthleteIds.forEach((athleteId) => {
        const mileageValue = mileageByAthleteDaySession.get(
          `${athleteId}__${dayIdx}__${session}`
        ) as MileageValue;
        const plannedValue = mileageValueToPlannedDistance(mileageValue);

        plannedDistanceByAthlete.set(
          String(athleteId),
          typeof plannedValue === "number" && Number.isFinite(plannedValue) ? plannedValue : null
        );
      });

      const payload = buildTeamWorkoutInsertRows({
        selectedAthleteIds: orderedAthleteIds,
        date_iso: dateISO,
        session,
        location: masterLocation || null,
        time_text: normalizedTime || "",
        title: masterTitle,
        details: details.trim() || null,
        primary_category: primaryCategory,
        categories: categoryNames,
        plannedDistanceByAthlete,
        plannedDistanceUnit,
        batch_id: newBatchId,
        group_id: "1",
        team_id: teamId,
        created_by: createdBy,
        pre_routine_ids: effectivePreRoutineIds.length > 0 ? effectivePreRoutineIds : null,
        post_routine_ids: effectivePostRoutineIds.length > 0 ? effectivePostRoutineIds : null,
      });

      setSubmitDebug("payload rows: " + payload.length);

      const navigationParams = {
        date: dateISO,
        batch: newBatchId,
      };

      const insertedRows = await createTeamWorkoutBatch(payload);
      setSubmitDebug(`insert success (${insertedRows?.length ?? payload.length} rows)`);

      if (activeDraftId) {
        await deletePlannerDraft(activeDraftId);
        setActiveDraftId(null);
      }

      baselineRef.current = snapshot;
      setSuppressPrompt(true);
      setTimeManuallyEdited(false);
      setSubmitDebug(`navigating: ${JSON.stringify(navigationParams)}`);
      setCreateFooterStatus({ status: "saved" });

      router.push({
        pathname: "/(coach)/workouts",
        params: navigationParams,
      });
    } catch (e: any) {
      const message = String(e?.message ?? e ?? "Unknown error");
      setSubmitDebug(`insert error: ${message}`);
      Alert.alert("Create session failed", message);
      setCreateFooterStatus({ status: "error", message });
      patchAppRuntime({ lastSaveError: message });
    } finally {
      setCreating(false);
    }
  }, [
    activeDraftId,
    coreCoachSettings?.distanceUnit,
    creating,
    dateISO,
    details,
    effectivePostRoutineIds,
    effectivePreRoutineIds,
    location,
    patchAppRuntime,
    rosterById,
    router,
    selectedAthleteIds,
    selectedCategories,
    session,
    snapshot,
    timeText,
    title,
    weekStartISO,
  ]);

  const focusField = useCallback(
    (key: PlannerFieldKey) => {
      setFocusedFieldKey(key);
      if (key === "date") return dateBtnRef.current?.focus?.();
      if (key === "session") return (session === "PM" ? pmChipRef.current : amChipRef.current)?.focus?.();
      if (key === "location") return locationRef.current?.focus?.();
      if (key === "time") return timeRef.current?.focus?.();
      if (key === "title") return titleRef.current?.focus?.();
      if (key === "notes") return detailsRef.current?.focus?.();
      if (key === "category") return categoryRef.current?.focus?.();
      if (key === "athlete_search") return setTimeout(() => athleteSearchRef.current?.focus?.(), 0);
      if (key === "create") return createBtnRef.current?.focus?.();
    },
    [session]
  );

  const focusByTab = useCallback(
    (current: PlannerFieldKey, shift?: boolean) => {
      const idx = fieldOrder.indexOf(current);
      const nextIdx = shift ? Math.max(0, idx - 1) : Math.min(fieldOrder.length - 1, idx + 1);
      const next = fieldOrder[nextIdx];
      if (next) focusField(next);
    },
    [focusField]
  );

  const handleTabOnly = useCallback(
    (current: PlannerFieldKey, e: any) => {
      if (Platform.OS !== "web") return;
      if (String(e?.key ?? "") !== "Tab") return;
      e.preventDefault?.();
      focusByTab(current, !!e?.shiftKey);
    },
    [focusByTab]
  );

  const menuModalContainerStyle = isWeb
    ? ({ flex: 1, justifyContent: "center", backgroundColor: "rgba(0,0,0,0.3)", paddingHorizontal: 18 } as const)
    : ({ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.3)" } as const);

  const menuModalCardStyle = isWeb
    ? ({
        alignSelf: "center",
        width: 520,
        maxHeight: "80%",
        borderRadius: 16,
        backgroundColor: "white",
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 20,
      } as const)
    : ({
        maxHeight: "75%",
        backgroundColor: "white",
        borderTopLeftRadius: 18,
        borderTopRightRadius: 18,
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 20,
      } as const);

  return (
    <Screen padded={false} style={{ flex: 1 }}>
      <ScrollView
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 110 }}
        onScrollBeginDrag={() => {
          dismissKeyboard();
          if (isWeb) {
            setAthleteDropdownOpen(false);
            setAthleteSearch("");
            setCategoryDropdownOpen(false);
            setCategorySearch("");
            setActiveCategorySlotIndex(null);
            setPreRoutineDropdownOpen(false);
            setPreRoutineSearch("");
            setActivePreRoutineSlotIndex(null);
            setPostRoutineDropdownOpen(false);
            setPostRoutineSearch("");
            setActivePostRoutineSlotIndex(null);
          }
        }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ width: "100%", maxWidth: isWeb ? 1320 : maxContentWidth, alignSelf: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
            <View style={{ flex: 1 }}>
              <AppText variant="title">Create Session</AppText>
              <AppText variant="caption" color="mutedText" style={{ marginTop: 4 }}>
                Set session defaults, choose athletes, then edit in Daily View
              </AppText>
              {Platform.OS === "web" ? (
                <AppText variant="caption" color="mutedText" style={{ marginTop: 2 }}>
                  Focused: {focusedFieldKey}
                </AppText>
              ) : null}
            </View>
          </View>

          <View style={{ borderWidth: 1, borderColor: "#d9e2ef", borderRadius: 10, backgroundColor: "#fff", padding: 10, marginBottom: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <Text style={{ fontSize: 13, fontWeight: "900", color: "#0f172a" }}>Session Details</Text>
              <Pressable
                onPress={() => setTemplatePickerOpen(true)}
                style={{
                  borderWidth: 1,
                  borderColor: "#d3dbe8",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  backgroundColor: "#f8fafc",
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "900", color: "#0f172a" }}>
                  {selectedTemplate ? `Template: ${selectedTemplate.name}` : "Use Template"}
                </Text>
              </Pressable>
            </View>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
              <View style={{ minWidth: 120, maxWidth: 140 }}>
                <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Time</Text>
                <TextInput
                  ref={timeRef}
                  value={timeText}
                  onChangeText={(next) => {
                    setTimeText(next);
                    setTimeManuallyEdited(next.trim().length > 0);
                  }}
                  onFocus={() => {
                    setActiveInput("time");
                    setFocusedFieldKey("time");
                  }}
                  onBlur={() => {
                    const trimmed = timeText.trim();

                    if (!trimmed) {
                      setTimeText("");
                      setTimeManuallyEdited(false);
                      setActiveInput((prev) => (prev === "time" ? null : prev));
                      return;
                    }

                    const normalized = normalizeWorkoutTimeInput(trimmed);
                    if (normalized) {
                      setTimeText(normalized);
                    }

                    setTimeManuallyEdited(true);
                    setActiveInput((prev) => (prev === "time" ? null : prev));
                  }}
                  placeholder=""
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => titleRef.current?.focus()}
                  {...(Platform.OS === "web"
                    ? ({
                        onKeyDown: (e: any) => {
                          if (String(e?.key ?? "") === "Tab") {
                            e.preventDefault?.();
                            focusByTab("time", !!e?.shiftKey);
                          }
                        },
                      } as any)
                    : null)}
                  blurOnSubmit={false}
                  style={{
                    borderWidth: 1,
                    borderColor: "#d3dbe8",
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    backgroundColor: "#fff",
                    fontSize: 13,
                    fontWeight: "700",
                  }}
                />
              </View>

              <View style={{ width: 110 }}>
                <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>AM/PM</Text>
                <View style={{ flexDirection: "row" }}>
                  <Chip
                    label="AM"
                    active={session === "AM"}
                    onPress={() => setSession("AM")}
                    pressableRef={amChipRef}
                    webProps={{
                      tabIndex: 0,
                      onFocus: () => setFocusedFieldKey("session"),
                      onKeyDown: (e: any) => {
                        const key = String(e?.key ?? "");
                        if (key === "ArrowLeft" || key === "ArrowRight") {
                          e.preventDefault?.();
                          setSession((prev) => (prev === "AM" ? "PM" : "AM"));
                          return;
                        }
                        if (key === "Enter" || key === " ") {
                          e.preventDefault?.();
                          setSession("AM");
                          return;
                        }
                        handleTabOnly("session", e);
                      },
                    }}
                  />
                  <Chip
                    label="PM"
                    active={session === "PM"}
                    onPress={() => setSession("PM")}
                    pressableRef={pmChipRef}
                    webProps={{
                      tabIndex: 0,
                      onFocus: () => setFocusedFieldKey("session"),
                      onKeyDown: (e: any) => {
                        const key = String(e?.key ?? "");
                        if (key === "ArrowLeft" || key === "ArrowRight") {
                          e.preventDefault?.();
                          setSession((prev) => (prev === "AM" ? "PM" : "AM"));
                          return;
                        }
                        if (key === "Enter" || key === " ") {
                          e.preventDefault?.();
                          setSession("PM");
                          return;
                        }
                        handleTabOnly("session", e);
                      },
                    }}
                  />
                </View>
              </View>

              <View style={{ flex: 1, minWidth: 280 }}>
                <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Date</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Pressable
                    onPress={() => bumpDate(-1)}
                    style={{
                      width: 32,
                      height: 32,
                      borderWidth: 1,
                      borderColor: "#d3dbe8",
                      borderRadius: 8,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "#fff",
                    }}
                  >
                    <Ionicons name="chevron-back" size={14} color="#111" />
                  </Pressable>

                  <Pressable
                    ref={dateBtnRef}
                    onPress={openDatePicker}
                    onFocus={() => setFocusedFieldKey("date")}
                    {...(Platform.OS === "web"
                      ? ({
                          tabIndex: 0,
                          onKeyDown: (e: any) => {
                            const key = String(e?.key ?? "");
                            if (key === "Enter" || key === " ") {
                              e.preventDefault?.();
                              openDatePicker();
                              return;
                            }
                            handleTabOnly("date", e);
                          },
                        } as any)
                      : null)}
                    style={{
                      flex: 1,
                      borderWidth: 1,
                      borderColor: "#d3dbe8",
                      borderRadius: 8,
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      backgroundColor: "#fff",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 16,
                        fontWeight: "900",
                        color: "#111",
                        textAlign: "center",
                      }}
                    >
                      {parseISODateOnly(dateISO).toLocaleDateString(undefined, {
                        weekday: "long",
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={() => bumpDate(1)}
                    style={{
                      width: 32,
                      height: 32,
                      borderWidth: 1,
                      borderColor: "#d3dbe8",
                      borderRadius: 8,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "#fff",
                    }}
                  >
                    <Ionicons name="chevron-forward" size={14} color="#111" />
                  </Pressable>
                </View>
              </View>

              <View style={{ width: 150 }}>
                <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Location</Text>
                <TextInput
                  ref={locationRef}
                  value={location}
                  onChangeText={setLocation}
                  onFocus={() => {
                    setActiveInput("location");
                    setFocusedFieldKey("location");
                  }}
                  onBlur={() => setActiveInput((prev) => (prev === "location" ? null : prev))}
                  placeholder="Location"
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => titleRef.current?.focus()}
                  {...(Platform.OS === "web"
                    ? ({
                        onKeyDown: (e: any) => {
                          if (String(e?.key ?? "") === "Tab") {
                            e.preventDefault?.();
                            focusByTab("location", !!e?.shiftKey);
                          }
                        },
                      } as any)
                    : null)}
                  blurOnSubmit={false}
                  style={{
                    borderWidth: 1,
                    borderColor: "#d3dbe8",
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    backgroundColor: "#fff",
                    fontSize: 13,
                    fontWeight: "700",
                  }}
                />
              </View>
            </View>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
              <View style={{ minWidth: 260, flex: 1 }}>
                <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Title</Text>
                <TextInput
                  ref={titleRef}
                  value={title}
                  onChangeText={setTitle}
                  onFocus={() => {
                    setActiveInput("title");
                    setFocusedFieldKey("title");
                  }}
                  onBlur={() => setActiveInput((prev) => (prev === "title" ? null : prev))}
                  placeholder="Workout"
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => detailsRef.current?.focus()}
                  {...(Platform.OS === "web"
                    ? ({
                        onKeyDown: (e: any) => {
                          if (String(e?.key ?? "") === "Tab") {
                            e.preventDefault?.();
                            focusByTab("title", !!e?.shiftKey);
                          }
                        },
                      } as any)
                    : null)}
                  blurOnSubmit={false}
                  style={{
                    borderWidth: 1,
                    borderColor: "#d3dbe8",
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    backgroundColor: "#fff",
                    fontSize: 13,
                    fontWeight: "700",
                  }}
                />
              </View>

              <View style={{ minWidth: 220, flexGrow: 1 }}>
                <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Category</Text>

                <View style={{ gap: 8 }}>
                  {Array.from({ length: visibleCategorySlotCount }).map((_, slotIndex) => {
                    const selectedId = categoryIds[slotIndex] ?? "";
                    const selectedCategory = selectedId ? categoryById.get(selectedId) : null;

                    return (
                      <View key={`category-slot-${slotIndex}`} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                        <Pressable
                          ref={slotIndex === 0 ? categoryRef : undefined}
                          onFocus={() => setFocusedFieldKey("category")}
                          {...(Platform.OS === "web"
                            ? ({
                                tabIndex: slotIndex === 0 ? 0 : -1,
                                onKeyDown: (e: any) => handleTabOnly("category", e),
                              } as any)
                            : null)}
                          onPress={() => {
                            setActiveCategorySlotIndex(slotIndex);
                            setCategoryDropdownOpen((prev) => {
                              if (prev && activeCategorySlotIndex === slotIndex) return false;
                              return true;
                            });
                            setCategorySearch("");
                          }}
                          style={{
                            flex: 1,
                            borderWidth: 1,
                            borderColor: "#d3dbe8",
                            borderRadius: 8,
                            paddingHorizontal: 10,
                            paddingVertical: 10,
                            backgroundColor: "#fff",
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <Text style={{ fontSize: 13, fontWeight: "700", color: selectedCategory ? "#111" : "#94a3b8" }}>
                            {selectedCategory?.name ?? "Select category"}
                          </Text>
                          <Text style={{ fontSize: 14, fontWeight: "900", color: "#64748b" }}>
                            {categoryDropdownOpen ? "▴" : "▾"}
                          </Text>
                        </Pressable>

                        {slotIndex > 0 ? (
                          <Pressable
                            onPress={() => {
                              setCategoryIds((prev) => prev.filter((_, idx) => idx !== slotIndex));
                              setCategorySlotCount((prev) => Math.max(1, prev - 1));
                              if (activeCategorySlotIndex === slotIndex) {
                                setActiveCategorySlotIndex(null);
                                setCategoryDropdownOpen(false);
                                setCategorySearch("");
                              }
                            }}
                            style={{
                              width: 34,
                              height: 34,
                              borderWidth: 1,
                              borderColor: "#e2e8f0",
                              borderRadius: 8,
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor: "#fff",
                            }}
                          >
                            <Text style={{ fontSize: 16, fontWeight: "900", color: "#b91c1c" }}>−</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    );
                  })}

                  <Pressable
                    onPress={() => setCategorySlotCount((prev) => prev + 1)}
                    style={{
                      alignSelf: "flex-start",
                      borderWidth: 1,
                      borderColor: "#d3dbe8",
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      backgroundColor: "#f8fafc",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "800", color: "#0f172a" }}>+ Category</Text>
                  </Pressable>

                  {categoryDropdownOpen ? (
                    <View style={{ borderWidth: 1, borderColor: "#e5ebf3", borderRadius: 8, overflow: "hidden", backgroundColor: "#fff" }}>
                      <TextInput
                        value={categorySearch}
                        onChangeText={setCategorySearch}
                        placeholder="Search categories..."
                        autoCorrect={false}
                        style={{
                          borderBottomWidth: 1,
                          borderBottomColor: "#edf2f7",
                          paddingHorizontal: 10,
                          paddingVertical: 9,
                          backgroundColor: "#fff",
                          fontSize: 13,
                          fontWeight: "700",
                        }}
                      />

                      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 220 }}>
                        {categoriesForPicker.map((c) => {
                          const alreadySelected = categoryIds.includes(c.id);

                          return (
                            <Pressable
                              key={c.id}
                              onPress={() => {
                                setCategoryIds((prev) => {
                                  const cleaned = prev.filter(Boolean);

                                  // No slot selected: append if not already present
                                  if (activeCategorySlotIndex == null) {
                                    if (cleaned.includes(c.id)) return cleaned;
                                    return [...cleaned, c.id];
                                  }

                                  const next = [...cleaned];
                                  const existingIndex = next.findIndex((id) => id === c.id);

                                  // If picked category is already in another slot,
                                  // move it into the clicked slot and remove the old copy.
                                  if (existingIndex >= 0) {
                                    if (existingIndex === activeCategorySlotIndex) {
                                      return next;
                                    }

                                    next.splice(existingIndex, 1);

                                    const adjustedTargetIndex =
                                      existingIndex < activeCategorySlotIndex
                                        ? activeCategorySlotIndex - 1
                                        : activeCategorySlotIndex;

                                    next[adjustedTargetIndex] = c.id;
                                    return next.filter(Boolean);
                                  }

                                  // Normal replace behavior
                                  next[activeCategorySlotIndex] = c.id;
                                  return next.filter(Boolean);
                                });

                                setCategoryDropdownOpen(false);
                                setCategorySearch("");
                                setActiveCategorySlotIndex(null);
                              }}
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                justifyContent: "space-between",
                                paddingHorizontal: 10,
                                paddingVertical: 9,
                                borderBottomWidth: 1,
                                borderBottomColor: "#edf2f7",
                                backgroundColor: "#fff",
                              }}
                            >
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                                <View
                                  style={{
                                    width: 12,
                                    height: 12,
                                    borderRadius: 6,
                                    backgroundColor: c.color ?? "#64748b",
                                  }}
                                />
                                <Text style={{ fontSize: 13, fontWeight: "700", color: "#0f172a" }}>{c.name}</Text>
                              </View>

                              {alreadySelected ? (
                                <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>Added</Text>
                              ) : null}
                            </Pressable>
                          );
                        })}

                        {categoriesForPicker.length === 0 ? (
                          <Text style={{ padding: 10, color: "#64748b", fontWeight: "700", fontSize: 12 }}>
                            No categories found.
                          </Text>
                        ) : null}
                      </ScrollView>
                    </View>
                  ) : null}
                </View>
              </View>

              <View style={{ minWidth: 320, flex: 1.2 }}>
                <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Pre Workout</Text>

                <View style={{ gap: 8 }}>
                  {Array.from({ length: visiblePreRoutineSlotCount }).map((_, slotIndex) => {
                    const selectedId = effectivePreRoutineIds[slotIndex] ?? "";
                    const selectedRoutine = selectedId ? auxiliaryRoutines.find((r) => r.id === selectedId) : null;
                    const isAuto = !!selectedId && derivedAutoPreRoutineIds.includes(selectedId);

                    return (
                      <View key={`pre-routine-slot-${slotIndex}`} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                        <Pressable
                          onPress={() => {
                            setActivePreRoutineSlotIndex(slotIndex);
                            setPreRoutineDropdownOpen((prev) => {
                              if (prev && activePreRoutineSlotIndex === slotIndex) return false;
                              return true;
                            });
                            setPreRoutineSearch("");
                          }}
                          style={{
                            flex: 1,
                            borderWidth: 1,
                            borderColor: "#d3dbe8",
                            borderRadius: 8,
                            paddingHorizontal: 10,
                            paddingVertical: 10,
                            backgroundColor: "#fff",
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <View style={{ flex: 1, paddingRight: 8 }}>
                            <Text style={{ fontSize: 13, fontWeight: "700", color: selectedRoutine ? "#111" : "#94a3b8" }}>
                              {selectedRoutine?.title ?? "Select pre-workout routine"}
                            </Text>
                            {selectedRoutine?.details ? (
                              <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "600", color: "#64748b", marginTop: 2 }}>
                                {selectedRoutine.details}
                              </Text>
                            ) : null}
                          </View>
                          <Text style={{ fontSize: 14, fontWeight: "900", color: "#64748b" }}>
                            {preRoutineDropdownOpen ? "▴" : "▾"}
                          </Text>
                        </Pressable>

                        {slotIndex > 0 || (selectedId && !isAuto) ? (
                          <Pressable
                            onPress={() => removePreRoutineAtSlot(slotIndex)}
                            style={{
                              width: 34,
                              height: 34,
                              borderWidth: 1,
                              borderColor: isAuto ? "#e5e7eb" : "#e2e8f0",
                              borderRadius: 8,
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor: isAuto ? "#f8fafc" : "#fff",
                              opacity: isAuto ? 0.5 : 1,
                            }}
                          >
                            <Text style={{ fontSize: 16, fontWeight: "900", color: isAuto ? "#94a3b8" : "#b91c1c" }}>−</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    );
                  })}

                  <Pressable
                    onPress={() => setPreRoutineSlotCount((prev) => prev + 1)}
                    style={{
                      alignSelf: "flex-start",
                      borderWidth: 1,
                      borderColor: "#d3dbe8",
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      backgroundColor: "#f8fafc",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "800", color: "#0f172a" }}>+ Pre Routine</Text>
                  </Pressable>

                  {preRoutineDropdownOpen ? (
                    <View style={{ borderWidth: 1, borderColor: "#e5ebf3", borderRadius: 8, overflow: "hidden", backgroundColor: "#fff" }}>
                      <TextInput
                        value={preRoutineSearch}
                        onChangeText={setPreRoutineSearch}
                        placeholder="Search routines..."
                        autoCorrect={false}
                        style={{
                          borderBottomWidth: 1,
                          borderBottomColor: "#edf2f7",
                          paddingHorizontal: 10,
                          paddingVertical: 9,
                          backgroundColor: "#fff",
                          fontSize: 13,
                          fontWeight: "700",
                        }}
                      />

                      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 220 }}>
                        {routinesForPrePicker.map((routine) => {
                          const alreadySelected = effectivePreRoutineIds.includes(routine.id);

                          return (
                            <Pressable
                              key={routine.id}
                              onPress={() => selectPreRoutineIntoSlot(routine.id)}
                              style={{
                                paddingHorizontal: 10,
                                paddingVertical: 9,
                                borderBottomWidth: 1,
                                borderBottomColor: "#edf2f7",
                                backgroundColor: "#fff",
                              }}
                            >
                              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                <View style={{ flex: 1 }}>
                                  <Text style={{ fontSize: 13, fontWeight: "700", color: "#0f172a" }}>{routine.title}</Text>
                                  {routine.details ? (
                                    <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 11, fontWeight: "600", color: "#64748b" }}>
                                      {routine.details}
                                    </Text>
                                  ) : null}
                                </View>
                                {alreadySelected ? (
                                  <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>Added</Text>
                                ) : null}
                              </View>
                            </Pressable>
                          );
                        })}

                        {routinesForPrePicker.length === 0 ? (
                          <Text style={{ padding: 10, color: "#64748b", fontWeight: "700", fontSize: 12 }}>
                            No routines found.
                          </Text>
                        ) : null}
                      </ScrollView>
                    </View>
                  ) : null}
                </View>
              </View>

              <View style={{ minWidth: 320, flex: 1.2 }}>
                <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Post Workout</Text>

                <View style={{ gap: 8 }}>
                  {Array.from({ length: visiblePostRoutineSlotCount }).map((_, slotIndex) => {
                    const selectedId = effectivePostRoutineIds[slotIndex] ?? "";
                    const selectedRoutine = selectedId ? auxiliaryRoutines.find((r) => r.id === selectedId) : null;
                    const isAuto = !!selectedId && derivedAutoPostRoutineIds.includes(selectedId);

                    return (
                      <View key={`post-routine-slot-${slotIndex}`} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                        <Pressable
                          onPress={() => {
                            setActivePostRoutineSlotIndex(slotIndex);
                            setPostRoutineDropdownOpen((prev) => {
                              if (prev && activePostRoutineSlotIndex === slotIndex) return false;
                              return true;
                            });
                            setPostRoutineSearch("");
                          }}
                          style={{
                            flex: 1,
                            borderWidth: 1,
                            borderColor: "#d3dbe8",
                            borderRadius: 8,
                            paddingHorizontal: 10,
                            paddingVertical: 10,
                            backgroundColor: "#fff",
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <View style={{ flex: 1, paddingRight: 8 }}>
                            <Text style={{ fontSize: 13, fontWeight: "700", color: selectedRoutine ? "#111" : "#94a3b8" }}>
                              {selectedRoutine?.title ?? "Select post-workout routine"}
                            </Text>
                            {selectedRoutine?.details ? (
                              <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "600", color: "#64748b", marginTop: 2 }}>
                                {selectedRoutine.details}
                              </Text>
                            ) : null}
                          </View>
                          <Text style={{ fontSize: 14, fontWeight: "900", color: "#64748b" }}>
                            {postRoutineDropdownOpen ? "▴" : "▾"}
                          </Text>
                        </Pressable>

                        {slotIndex > 0 || (selectedId && !isAuto) ? (
                          <Pressable
                            onPress={() => removePostRoutineAtSlot(slotIndex)}
                            style={{
                              width: 34,
                              height: 34,
                              borderWidth: 1,
                              borderColor: isAuto ? "#e5e7eb" : "#e2e8f0",
                              borderRadius: 8,
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor: isAuto ? "#f8fafc" : "#fff",
                              opacity: isAuto ? 0.5 : 1,
                            }}
                          >
                            <Text style={{ fontSize: 16, fontWeight: "900", color: isAuto ? "#94a3b8" : "#b91c1c" }}>−</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    );
                  })}

                  <Pressable
                    onPress={() => setPostRoutineSlotCount((prev) => prev + 1)}
                    style={{
                      alignSelf: "flex-start",
                      borderWidth: 1,
                      borderColor: "#d3dbe8",
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      backgroundColor: "#f8fafc",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "800", color: "#0f172a" }}>+ Post Routine</Text>
                  </Pressable>

                  {postRoutineDropdownOpen ? (
                    <View style={{ borderWidth: 1, borderColor: "#e5ebf3", borderRadius: 8, overflow: "hidden", backgroundColor: "#fff" }}>
                      <TextInput
                        value={postRoutineSearch}
                        onChangeText={setPostRoutineSearch}
                        placeholder="Search routines..."
                        autoCorrect={false}
                        style={{
                          borderBottomWidth: 1,
                          borderBottomColor: "#edf2f7",
                          paddingHorizontal: 10,
                          paddingVertical: 9,
                          backgroundColor: "#fff",
                          fontSize: 13,
                          fontWeight: "700",
                        }}
                      />

                      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 220 }}>
                        {routinesForPostPicker.map((routine) => {
                          const alreadySelected = effectivePostRoutineIds.includes(routine.id);

                          return (
                            <Pressable
                              key={routine.id}
                              onPress={() => selectPostRoutineIntoSlot(routine.id)}
                              style={{
                                paddingHorizontal: 10,
                                paddingVertical: 9,
                                borderBottomWidth: 1,
                                borderBottomColor: "#edf2f7",
                                backgroundColor: "#fff",
                              }}
                            >
                              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                <View style={{ flex: 1 }}>
                                  <Text style={{ fontSize: 13, fontWeight: "700", color: "#0f172a" }}>{routine.title}</Text>
                                  {routine.details ? (
                                    <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 11, fontWeight: "600", color: "#64748b" }}>
                                      {routine.details}
                                    </Text>
                                  ) : null}
                                </View>
                                {alreadySelected ? (
                                  <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>Added</Text>
                                ) : null}
                              </View>
                            </Pressable>
                          );
                        })}

                        {routinesForPostPicker.length === 0 ? (
                          <Text style={{ padding: 10, color: "#64748b", fontWeight: "700", fontSize: 12 }}>
                            No routines found.
                          </Text>
                        ) : null}
                      </ScrollView>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>

            <View style={{ marginTop: 10 }}>
              <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b", marginBottom: 4 }}>Notes</Text>
              <TextInput
                ref={detailsRef}
                value={details}
                onChangeText={setDetails}
                onFocus={() => {
                  setActiveInput("details");
                  setFocusedFieldKey("notes");
                }}
                onBlur={() => setActiveInput((prev) => (prev === "details" ? null : prev))}
                placeholder="Workout notes..."
                multiline
                returnKeyType="done"
                onSubmitEditing={dismissKeyboard}
                {...(Platform.OS === "web"
                  ? ({
                      onKeyDown: (e: any) => {
                        const key = String(e?.key ?? "");
                        if (key === "Tab") {
                          e.preventDefault?.();
                          focusByTab("notes", !!e?.shiftKey);
                          return;
                        }
                        const ctrlMeta = !!(e?.ctrlKey || e?.metaKey);
                        if (ctrlMeta && key === "Enter") {
                          e.preventDefault?.();
                          focusByTab("notes", false);
                        }
                      },
                    } as any)
                  : null)}
                blurOnSubmit
                style={{
                  borderWidth: 1,
                  borderColor: "#d3dbe8",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  minHeight: 92,
                  backgroundColor: "#fff",
                  textAlignVertical: "top",
                  fontSize: 13,
                  fontWeight: "600",
                  width: "100%",
                }}
              />
            </View>
          </View>

          <View style={{ borderWidth: 1, borderColor: "#d9e2ef", borderRadius: 10, backgroundColor: "#f8fafc", paddingVertical: 8, paddingHorizontal: 10, marginBottom: 10 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", alignItems: "center", minWidth: 980 }}>
                {[
                  { label: "Date", value: formatShortDateLabel(dateISO), width: 130 },
                  { label: "AM/PM", value: session, width: 90 },
                  { label: "Location", value: location.trim() || "—", width: 170 },
                  { label: "Time", value: normalizeWorkoutTimeInput(timeText.trim() || "") || timeText.trim() || "—", width: 120 },
                  { label: "Title", value: title.trim() || "Workout", width: 220 },
                  { label: "Category", value: selectedCategories.length > 0 ? selectedCategories.map((c) => c.name).join(", ") : "—", width: 170 },
                  { label: "Athletes", value: `${selectedAthleteIds.length}`, width: 90 },
                ].map((col, idx) => (
                  <View key={`preview-${idx}`} style={{ width: col.width, paddingRight: 10 }}>
                    <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b", marginBottom: 3 }}>{col.label}</Text>
                    <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "800", color: "#0f172a" }}>
                      {col.value}
                    </Text>
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>

          <View style={{ borderWidth: 1, borderColor: "#d9e2ef", borderRadius: 10, backgroundColor: "#fff", padding: 10, marginBottom: 18 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <Text style={{ fontSize: 13, fontWeight: "900", color: "#0f172a" }}>Athletes</Text>
              <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>{selectedAthleteIds.length} selected</Text>
            </View>

            {plannerGroups.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: "row" }}>
                  {plannerGroups.map((group) => (
                    <Chip
                      key={group.id}
                      label={group.name}
                      active={false}
                      onPress={() => {
                        void applyCustomGroup(group);
                      }}
                    />
                  ))}
                </View>
              </ScrollView>
            ) : null}

            <View style={{ gap: 8 }}>
              <Pressable
                onPress={() => setAthleteDropdownOpen((prev) => !prev)}
                style={{
                  borderWidth: 1,
                  borderColor: "#d3dbe8",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 10,
                  backgroundColor: "#fff",
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "700", color: "#111" }}>
                  {selectedAthleteIds.length > 0
                    ? `${selectedAthleteIds.length} athlete${selectedAthleteIds.length === 1 ? "" : "s"} selected`
                    : "Select athletes"}
                </Text>
                <Text style={{ fontSize: 14, fontWeight: "900", color: "#64748b" }}>
                  {athleteDropdownOpen ? "▴" : "▾"}
                </Text>
              </Pressable>

              {athleteDropdownOpen ? (
                <>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TextInput
                      ref={athleteSearchRef}
                      value={athleteSearch}
                      onChangeText={setAthleteSearch}
                      placeholder="Search athletes..."
                      autoCorrect={false}
                      onFocus={() => setFocusedFieldKey("athlete_search")}
                      style={{
                        flex: 1,
                        borderWidth: 1,
                        borderColor: "#d3dbe8",
                        borderRadius: 8,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        backgroundColor: "#fff",
                        fontSize: 13,
                        fontWeight: "700",
                      }}
                    />
                    <Pressable
                      onPress={async () => {
                        const next = rosterSorted.map((a) => a.id);
                        setSelectedAthleteIds(next);
                        await saveJSON(KEY_PLANNER_SELECTED_ATHLETES, next);
                      }}
                      style={{
                        borderWidth: 1,
                        borderColor: "#d3dbe8",
                        borderRadius: 8,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        backgroundColor: "#f8fafc",
                      }}
                    >
                      <Text style={{ fontSize: 12, fontWeight: "800", color: "#0f172a" }}>All</Text>
                    </Pressable>
                    <Pressable
                      onPress={async () => {
                        setSelectedAthleteIds([]);
                        await saveJSON(KEY_PLANNER_SELECTED_ATHLETES, []);
                      }}
                      style={{
                        borderWidth: 1,
                        borderColor: "#d3dbe8",
                        borderRadius: 8,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        backgroundColor: "#f8fafc",
                      }}
                    >
                      <Text style={{ fontSize: 12, fontWeight: "800", color: "#0f172a" }}>Clear</Text>
                    </Pressable>
                  </View>

                  <View style={{ borderWidth: 1, borderColor: "#e5ebf3", borderRadius: 8, overflow: "hidden", maxHeight: 320 }}>
                    <ScrollView keyboardShouldPersistTaps="handled">
                      {rosterForPicker.map((a) => {
                        const active = selectedAthleteIds.includes(a.id);
                        return (
                          <Pressable
                            key={a.id}
                            onPress={() => {
                              void toggleAthlete(a.id);
                            }}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              justifyContent: "space-between",
                              paddingHorizontal: 10,
                              paddingVertical: 8,
                              borderBottomWidth: 1,
                              borderBottomColor: "#edf2f7",
                              backgroundColor: active ? "#eff6ff" : "#fff",
                            }}
                          >
                            <Text style={{ flex: 1, paddingRight: 10, fontSize: 13, fontWeight: "700", color: "#0f172a" }}>
                              {a.displayName}
                            </Text>
                            <View
                              style={{
                                width: 18,
                                height: 18,
                                borderRadius: 9,
                                borderWidth: 1.5,
                                borderColor: active ? "#111" : "#cbd5e1",
                                backgroundColor: active ? "#111" : "#fff",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {active ? <Text style={{ color: "#fff", fontWeight: "900", fontSize: 10 }}>✓</Text> : null}
                            </View>
                          </Pressable>
                        );
                      })}

                      {rosterForPicker.length === 0 ? (
                        <Text style={{ padding: 10, color: "#64748b", fontWeight: "700", fontSize: 12 }}>
                          No athletes found.
                        </Text>
                      ) : null}
                    </ScrollView>
                  </View>
                </>
              ) : null}
            </View>
          </View>

          <Modal visible={datePickerOpen} animationType="fade" transparent onRequestClose={() => setDatePickerOpen(false)}>
            <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.28)", justifyContent: "center", paddingHorizontal: 18 }}>
              <View style={{ borderRadius: 16, backgroundColor: "#fff", borderWidth: 1, borderColor: "#e6e6e6", padding: 12 }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <Pressable
                    onPress={() => setPickerMonth((prev) => addMonths(prev, -1))}
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: "#e6e6e6",
                      backgroundColor: "#fff",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Ionicons name="chevron-back" size={18} color="#111" />
                  </Pressable>
                  <Text style={{ fontWeight: "900", fontSize: 16 }}>{pickerMonthLabel}</Text>
                  <Pressable
                    onPress={() => setPickerMonth((prev) => addMonths(prev, 1))}
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: "#e6e6e6",
                      backgroundColor: "#fff",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Ionicons name="chevron-forward" size={18} color="#111" />
                  </Pressable>
                </View>

                <View style={{ flexDirection: "row", marginBottom: 4 }}>
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                    <View key={`picker-h-${d}`} style={{ width: `${100 / 7}%`, alignItems: "center", paddingVertical: 4 }}>
                      <Text style={{ fontSize: 12, fontWeight: "900", color: "#666" }}>{d}</Text>
                    </View>
                  ))}
                </View>

                <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                  {pickerCells.map((cell) => {
                    const active = cell.dateISO === dateISO;
                    return (
                      <Pressable
                        key={`picker-${cell.dateISO}`}
                        onPress={() => {
                          setDateISO(cell.dateISO);
                          setDatePickerOpen(false);
                        }}
                        style={{ width: `${100 / 7}%`, alignItems: "center", paddingVertical: 7 }}
                      >
                        <View
                          style={{
                            minWidth: 30,
                            height: 30,
                            borderRadius: 15,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: active ? "#111" : "transparent",
                          }}
                        >
                          <Text
                            style={{
                              color: active ? "#fff" : cell.inMonth ? "#111" : "#bbb",
                              fontWeight: active ? "900" : "700",
                            }}
                          >
                            {cell.dayNumber}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>

                <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 10 }}>
                  <Pressable
                    onPress={() => {
                      const today = isoDateOnly(new Date());
                      setDateISO(today);
                      setPickerMonth(monthStart(parseISODateOnly(today)));
                      setDatePickerOpen(false);
                    }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: "#ddd",
                      backgroundColor: "#fafafa",
                    }}
                  >
                    <Text style={{ fontWeight: "900" }}>Today</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setDatePickerOpen(false)}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: "#ddd",
                      backgroundColor: "#fff",
                    }}
                  >
                    <Text style={{ fontWeight: "900" }}>Close</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </Modal>

          <Modal
            visible={templatePickerOpen}
            animationType={isWeb ? "fade" : "slide"}
            transparent
            onRequestClose={() => setTemplatePickerOpen(false)}
          >
            <View style={menuModalContainerStyle}>
              <View style={menuModalCardStyle}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ fontSize: 18, fontWeight: "900" }}>Workout Templates</Text>
                  <Pressable onPress={() => setTemplatePickerOpen(false)}>
                    <Text style={{ fontWeight: "800", color: "#111" }}>Close</Text>
                  </Pressable>
                </View>

                <ScrollView contentContainerStyle={{ paddingBottom: 16, marginTop: 10 }}>
                  {templates.map((template) => (
                    <Pressable
                      key={template.id}
                      onPress={() => applyTemplate(template)}
                      style={{
                        borderWidth: 1,
                        borderColor: "#ececec",
                        borderRadius: 12,
                        padding: 12,
                        backgroundColor: "#fafafa",
                        marginBottom: 10,
                      }}
                    >
                      <Text style={{ fontWeight: "900", color: "#111" }}>{template.name}</Text>
                      <Text style={{ marginTop: 3, color: "#666", fontWeight: "700", fontSize: 12 }}>
                        {template.categories.length > 0
                          ? template.categories.join(", ")
                          : template.primaryCategory || "No categories"}
                      </Text>
                      <Text style={{ marginTop: 6, color: "#111", fontWeight: "800" }}>{template.title || "Workout"}</Text>
                      {template.details ? <Text style={{ marginTop: 4, color: "#444" }}>{template.details}</Text> : null}
                    </Pressable>
                  ))}

                  {templates.length === 0 ? (
                    <Text style={{ color: "#666", fontWeight: "700" }}>
                      No saved workouts yet.
                    </Text>
                  ) : null}
                </ScrollView>
              </View>
            </View>
          </Modal>

        </View>
      </ScrollView>

      <View
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: 14,
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderWidth: 1,
          borderColor: "#dbe2ee",
          borderRadius: 10,
          backgroundColor: "#fff",
        }}
      >
        <View
          style={{
            borderWidth: 1,
            borderColor: "#e6ebf3",
            borderRadius: 8,
            backgroundColor: "#f8fafc",
            paddingHorizontal: 8,
            paddingVertical: 6,
          }}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: "row", alignItems: "center", minWidth: 960 }}>
              {[
                { label: "Date", value: footerSummary.date, width: 118 },
                { label: "AM/PM", value: footerSummary.session, width: 80 },
                { label: "Time", value: footerSummary.time, width: 104 },
                { label: "Title", value: footerSummary.title, width: 180 },
                { label: "Category", value: footerSummary.category, width: 180 },
                { label: "Athletes", value: `${footerSummary.athleteCount}`, width: 84 },
                { label: "Pre", value: `${footerSummary.preCount}`, width: 70 },
                { label: "Post", value: `${footerSummary.postCount}`, width: 70 },
                { label: "Mileage", value: footerSummary.mileageCoverage, width: 116 },
              ].map((col, idx) => (
                <View key={`footer-preview-${idx}`} style={{ width: col.width, paddingRight: 8 }}>
                  <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b", marginBottom: 2 }}>{col.label}</Text>
                  <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "800", color: "#0f172a" }}>
                    {col.value}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>

        {preSubmitWarnings.length > 0 ? (
          <View
            style={{
              borderWidth: 1,
              borderColor: "#f1e5be",
              borderRadius: 8,
              backgroundColor: "#fffbeb",
              paddingHorizontal: 8,
              paddingVertical: 6,
              gap: 2,
            }}
          >
            <Text style={{ fontSize: 10, fontWeight: "900", color: "#7c5e10" }}>Pre-submit checks</Text>
            {preSubmitWarnings.map((warning) => (
              <Text key={warning} style={{ fontSize: 11, fontWeight: "700", color: "#8a6a15" }}>
                • {warning}
              </Text>
            ))}
          </View>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <Pressable
          onPress={() =>
            router.push({
              pathname: "/(coach)/(tabs)/calendar",
              params: { date: dateISO },
            })
          }
          style={{
            flex: 1,
            borderWidth: 1,
            borderColor: "#d1d9e6",
            borderRadius: 8,
            paddingVertical: 10,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#f8fafc",
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "900", color: "#334155" }}>Cancel</Text>
        </Pressable>

        <Pressable
          ref={createBtnRef}
          onPress={handleCreateSession}
          onFocus={() => setFocusedFieldKey("create")}
          disabled={selectedAthleteIds.length === 0 || creating}
          {...(Platform.OS === "web"
            ? ({
                tabIndex: 0,
                onKeyDown: (e: any) => {
                  const key = String(e?.key ?? "");
                  if (key === "Enter" || key === " ") {
                    e.preventDefault?.();
                    if (selectedAthleteIds.length > 0 && !creating) void handleCreateSession();
                    return;
                  }
                  handleTabOnly("create", e);
                },
              } as any)
            : null)}
          style={{
            flex: 1.4,
            height: 44,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#111",
            borderWidth: 1,
            borderColor: "#111",
            shadowColor: "#000",
            shadowOpacity: 0.22,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 3 },
            elevation: 3,
            opacity: selectedAthleteIds.length === 0 || creating ? 0.45 : 1,
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "900", color: "#fff" }}>
            {creating ? "Creating..." : "Create Session"}
          </Text>
        </Pressable>
        </View>

        <View style={{ minHeight: 18 }}>
          <InlineSaveStatus status={createFooterStatus.status} message={createFooterStatus.message} size="md" />
        </View>
      </View>

      {showSavedBanner ? (
        <View
          style={{
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
          }}
        >
          <Text style={{ color: "#fff", fontWeight: "900" }}>Training session saved</Text>
        </View>
      ) : null}
    </Screen>
  );
}
