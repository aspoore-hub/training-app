import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  createAuxiliaryRoutine,
  createRoutineItemId,
  deleteAuxiliaryRoutine,
  loadAuxiliaryRoutines,
  updateAuxiliaryRoutine,
  type AuxiliaryRoutine,
  type DrillRoutineItem,
} from "../../lib/auxiliaryRoutines";
import { containsHttpUrl, LinkifiedText } from "../ui/LinkifiedText";
import {
  createDrillFolderDraft,
  createDrillLibraryItemDraft,
  createRoutineFolderDraft,
  loadDrillFolders,
  loadDrillLibraryItems,
  loadRoutineFolders,
  saveDrillFolders,
  saveDrillLibraryItems,
  saveRoutineFolders,
  type DrillFolder,
  type DrillLibraryItem,
  type RoutineFolder,
} from "../../lib/drillLibrary";
import { loadCoreCoachSettings } from "../../lib/settings";
import { getCurrentTeamRole, normalizeTeamRole, type TeamRole } from "../../lib/teamPermissions";
import type { WorkoutCategory } from "../../lib/types";

type AutosaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
type CategoryAssignmentTarget = "pre" | "post";
type ManagerTab = "routines" | "drills";
const ALL_FOLDERS_ID = "__all__";
const UNCATEGORIZED_FOLDER_ID = "__uncategorized__";

function getErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    const anyError = error as any;
    return (
      anyError.message ||
      anyError.error_description ||
      anyError.details ||
      anyError.hint ||
      anyError.code ||
      JSON.stringify(error)
    );
  }
  return String(error);
}

function buildDraftSnapshotFrom(
  id: string | null,
  title: string,
  description: string,
  details: string,
  preCategoryNames: string[],
  postCategoryNames: string[],
  folderId: string | null,
  items: DrillRoutineItem[]
) {
  return JSON.stringify({
    id,
    folderId,
    title: String(title ?? "").trim(),
    description: String(description ?? "").trim(),
    details: String(details ?? "").trim(),
    items,
    pre: [...preCategoryNames].sort(),
    post: [...postCategoryNames].sort(),
  });
}

function toggleDraftCategory(
  setList: React.Dispatch<React.SetStateAction<string[]>>,
  categoryName: string
) {
  const key = String(categoryName ?? "").trim();
  if (!key) return;

  setList((prev) =>
    prev.includes(key) ? prev.filter((name) => name !== key) : [...prev, key]
  );
}

export function AuxiliaryRoutinesManager() {
  const { width } = useWindowDimensions();
  const isDesktopWeb = Platform.OS === "web" && width >= 900;
  const [currentTeamRole, setCurrentTeamRole] = useState<TeamRole | null>(null);
  const readOnly = normalizeTeamRole(currentTeamRole) === "viewer";
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [auxiliaryRoutines, setAuxiliaryRoutines] = useState<AuxiliaryRoutine[]>([]);
  const [selectedAuxiliaryRoutineId, setSelectedAuxiliaryRoutineId] = useState<string | null>(null);
  const [auxiliaryTitleDraft, setAuxiliaryTitleDraft] = useState("");
  const [auxiliaryDescriptionDraft, setAuxiliaryDescriptionDraft] = useState("");
  const [auxiliaryDetailsDraft, setAuxiliaryDetailsDraft] = useState("");
  const [auxiliaryItemsDraft, setAuxiliaryItemsDraft] = useState<DrillRoutineItem[]>([]);
  const [auxiliaryFolderIdDraft, setAuxiliaryFolderIdDraft] = useState<string | null>(null);
  const [auxiliaryPreCategoryNamesDraft, setAuxiliaryPreCategoryNamesDraft] = useState<string[]>([]);
  const [auxiliaryPostCategoryNamesDraft, setAuxiliaryPostCategoryNamesDraft] = useState<string[]>([]);
  const [auxiliaryAutosaveStatus, setAuxiliaryAutosaveStatus] = useState<AutosaveStatus>("idle");
  const [auxiliaryDeleteBusy, setAuxiliaryDeleteBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ManagerTab>("routines");
  const [openCategorySelector, setOpenCategorySelector] = useState<CategoryAssignmentTarget | null>(null);
  const [routineFolders, setRoutineFolders] = useState<RoutineFolder[]>([]);
  const [drillFolders, setDrillFolders] = useState<DrillFolder[]>([]);
  const [drillLibraryItems, setDrillLibraryItems] = useState<DrillLibraryItem[]>([]);
  const [selectedFolderFilterId, setSelectedFolderFilterId] = useState(ALL_FOLDERS_ID);
  const [newRoutineFolderName, setNewRoutineFolderName] = useState("");
  const [newDrillFolderName, setNewDrillFolderName] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryFolderFilterId, setLibraryFolderFilterId] = useState(ALL_FOLDERS_ID);
  const [insertPickerOpen, setInsertPickerOpen] = useState(false);
  const [insertQuery, setInsertQuery] = useState("");
  const [insertFolderFilterId, setInsertFolderFilterId] = useState(ALL_FOLDERS_ID);
  const [expandedRoutineItemIds, setExpandedRoutineItemIds] = useState<Set<string>>(new Set());
  const [selectedDrillId, setSelectedDrillId] = useState<string | null>(null);
  const [drillNameDraft, setDrillNameDraft] = useState("");
  const [drillFolderIdDraft, setDrillFolderIdDraft] = useState<string | null>(null);
  const [drillVideoUrlDraft, setDrillVideoUrlDraft] = useState("");
  const [drillDetailsDraft, setDrillDetailsDraft] = useState("");
  const [drillBusy, setDrillBusy] = useState(false);
  const lastSavedSnapshotRef = React.useRef("");
  const saveSeqRef = React.useRef(0);
  const commitInFlightRef = React.useRef<Promise<boolean> | null>(null);
  const selectedRoutineIdRef = React.useRef<string | null>(null);
  const titleDraftRef = React.useRef("");
  const descriptionDraftRef = React.useRef("");
  const detailsDraftRef = React.useRef("");
  const itemsDraftRef = React.useRef<DrillRoutineItem[]>([]);
  const folderIdDraftRef = React.useRef<string | null>(null);
  const preCategoryNamesDraftRef = React.useRef<string[]>([]);
  const postCategoryNamesDraftRef = React.useRef<string[]>([]);
  const currentTeamRoleRef = React.useRef<TeamRole | null>(null);

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""))),
    [categories]
  );

  const sortedAuxiliaryRoutines = useMemo(
    () => [...auxiliaryRoutines].sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? ""))),
    [auxiliaryRoutines]
  );

  const visibleAuxiliaryRoutines = useMemo(() => {
    if (selectedFolderFilterId === ALL_FOLDERS_ID) return sortedAuxiliaryRoutines;
    if (selectedFolderFilterId === UNCATEGORIZED_FOLDER_ID) {
      return sortedAuxiliaryRoutines.filter((routine) => !String(routine.folderId ?? "").trim());
    }
    return sortedAuxiliaryRoutines.filter((routine) => String(routine.folderId ?? "").trim() === selectedFolderFilterId);
  }, [selectedFolderFilterId, sortedAuxiliaryRoutines]);

  const filteredDrillLibraryItems = useMemo(() => {
    const needle = libraryQuery.trim().toLowerCase();
    return drillLibraryItems.filter((item) => {
      const folderMatches =
        libraryFolderFilterId === ALL_FOLDERS_ID ||
        (libraryFolderFilterId === UNCATEGORIZED_FOLDER_ID
          ? !String(item.folderId ?? "").trim()
          : String(item.folderId ?? "").trim() === libraryFolderFilterId);
      if (!folderMatches) return false;
      if (!needle) return true;
      return [item.name, item.defaultDetails, item.videoUrl, ...(item.categoryNames ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [drillLibraryItems, libraryFolderFilterId, libraryQuery]);

  const insertableDrillLibraryItems = useMemo(() => {
    const needle = insertQuery.trim().toLowerCase();
    return drillLibraryItems.filter((item) => {
      const folderMatches =
        insertFolderFilterId === ALL_FOLDERS_ID ||
        (insertFolderFilterId === UNCATEGORIZED_FOLDER_ID
          ? !String(item.folderId ?? "").trim()
          : String(item.folderId ?? "").trim() === insertFolderFilterId);
      if (!folderMatches) return false;
      if (!needle) return true;
      return [item.name, item.defaultDetails, item.videoUrl, ...(item.categoryNames ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [drillLibraryItems, insertFolderFilterId, insertQuery]);

  const selectedAuxiliaryRoutine = useMemo(
    () => sortedAuxiliaryRoutines.find((routine) => routine.id === selectedAuxiliaryRoutineId) ?? null,
    [sortedAuxiliaryRoutines, selectedAuxiliaryRoutineId]
  );

  const selectedFilterFolder = useMemo(
    () => routineFolders.find((folder) => folder.id === selectedFolderFilterId) ?? null,
    [routineFolders, selectedFolderFilterId]
  );

  const selectedLibraryFilterFolder = useMemo(
    () => drillFolders.find((folder) => folder.id === libraryFolderFilterId) ?? null,
    [drillFolders, libraryFolderFilterId]
  );

  function routineFolderName(folderId?: string | null) {
    const id = String(folderId ?? "").trim();
    if (!id) return "Uncategorized";
    return routineFolders.find((folder) => folder.id === id)?.name ?? "Uncategorized";
  }

  function drillFolderName(folderId?: string | null) {
    const id = String(folderId ?? "").trim();
    if (!id) return "Uncategorized";
    return drillFolders.find((folder) => folder.id === id)?.name ?? "Uncategorized";
  }

  useEffect(() => {
    currentTeamRoleRef.current = currentTeamRole;
  }, [currentTeamRole]);

  useEffect(() => {
    selectedRoutineIdRef.current = selectedAuxiliaryRoutineId;
    titleDraftRef.current = auxiliaryTitleDraft;
    descriptionDraftRef.current = auxiliaryDescriptionDraft;
    detailsDraftRef.current = auxiliaryDetailsDraft;
    itemsDraftRef.current = auxiliaryItemsDraft;
    folderIdDraftRef.current = auxiliaryFolderIdDraft;
    preCategoryNamesDraftRef.current = auxiliaryPreCategoryNamesDraft;
    postCategoryNamesDraftRef.current = auxiliaryPostCategoryNamesDraft;
  }, [
    selectedAuxiliaryRoutineId,
    auxiliaryTitleDraft,
    auxiliaryDescriptionDraft,
    auxiliaryDetailsDraft,
    auxiliaryItemsDraft,
    auxiliaryFolderIdDraft,
    auxiliaryPreCategoryNamesDraft,
    auxiliaryPostCategoryNamesDraft,
  ]);

  const loadRoutineIntoDrafts = useCallback((routine: AuxiliaryRoutine | null) => {
    if (!routine) {
      setAuxiliaryTitleDraft("");
      setAuxiliaryDescriptionDraft("");
      setAuxiliaryDetailsDraft("");
      setAuxiliaryItemsDraft([]);
      setAuxiliaryFolderIdDraft(null);
      setAuxiliaryPreCategoryNamesDraft([]);
      setAuxiliaryPostCategoryNamesDraft([]);
      lastSavedSnapshotRef.current = "";
      setAuxiliaryAutosaveStatus("idle");
      return;
    }

    setAuxiliaryTitleDraft(String(routine.title ?? ""));
    setAuxiliaryDescriptionDraft(String(routine.description ?? ""));
    setAuxiliaryDetailsDraft(String(routine.details ?? ""));
    setAuxiliaryItemsDraft(Array.isArray(routine.items) ? routine.items : []);
    setAuxiliaryFolderIdDraft(String(routine.folderId ?? "").trim() || null);
    setAuxiliaryPreCategoryNamesDraft(Array.isArray(routine.preCategoryNames) ? routine.preCategoryNames : []);
    setAuxiliaryPostCategoryNamesDraft(Array.isArray(routine.postCategoryNames) ? routine.postCategoryNames : []);
    lastSavedSnapshotRef.current = buildDraftSnapshotFrom(
      routine.id,
      String(routine.title ?? ""),
      String(routine.description ?? ""),
      String(routine.details ?? ""),
      Array.isArray(routine.preCategoryNames) ? routine.preCategoryNames : [],
      Array.isArray(routine.postCategoryNames) ? routine.postCategoryNames : [],
      String(routine.folderId ?? "").trim() || null,
      Array.isArray(routine.items) ? routine.items : []
    );
    setAuxiliaryAutosaveStatus("idle");
  }, []);

  const setSelectedRoutine = useCallback(
    (routine: AuxiliaryRoutine | null) => {
      const nextId = routine?.id ?? null;
      selectedRoutineIdRef.current = nextId;
      setSelectedAuxiliaryRoutineId(nextId);
      loadRoutineIntoDrafts(routine);
    },
    [loadRoutineIntoDrafts]
  );

  const reloadAuxiliaryRoutines = useCallback(
    async (preferredRoutineId?: string | null) => {
      const loaded = await loadAuxiliaryRoutines();
      const sorted = [...loaded].sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? "")));
      setAuxiliaryRoutines(sorted);
      const targetId = preferredRoutineId ?? selectedRoutineIdRef.current;
      const selected = sorted.find((routine) => routine.id === targetId) ?? null;
      if (selected) {
        setSelectedAuxiliaryRoutineId(selected.id);
        loadRoutineIntoDrafts(selected);
        return;
      }
      setSelectedAuxiliaryRoutineId(null);
      loadRoutineIntoDrafts(null);
    },
    [loadRoutineIntoDrafts]
  );

  const loadManagerData = useCallback(
    async (isActive?: () => boolean) => {
      try {
        setLoadError(null);
        const [role, coreSettings, routines, routineFolderList, drillFolderList, libraryItems] = await Promise.all([
          getCurrentTeamRole(),
          loadCoreCoachSettings(),
          loadAuxiliaryRoutines(),
          loadRoutineFolders(),
          loadDrillFolders(),
          loadDrillLibraryItems(),
        ]);
        if (isActive && !isActive()) return;
        setCurrentTeamRole(role);
        setCategories(coreSettings.categories ?? []);
        setAuxiliaryRoutines(routines);
        setRoutineFolders(routineFolderList);
        setDrillFolders(drillFolderList);
        setDrillLibraryItems(libraryItems);
        const selected = routines.find((routine) => routine.id === selectedRoutineIdRef.current) ?? routines[0] ?? null;
        setSelectedRoutine(selected);
      } catch (error) {
        if (isActive && !isActive()) return;
        const message = getErrorMessage(error);
        console.error("[auxiliary-routines] load failed", error);
        setLoadError(message);
        Alert.alert("Drill routines load failed", message);
      }
    },
    [setSelectedRoutine]
  );

  useEffect(() => {
    let cancelled = false;
    void loadManagerData(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadManagerData]);

  const commitDraft = useCallback(
    async (reason: string, options?: { alertOnTitleRequired?: boolean }): Promise<boolean> => {
      if (normalizeTeamRole(currentTeamRoleRef.current) === "viewer") return true;

      if (commitInFlightRef.current) {
        await commitInFlightRef.current.catch(() => false);
      }

      const routineId = selectedRoutineIdRef.current;
      if (!routineId) return true;

      const titleDraft = titleDraftRef.current;
      const descriptionDraft = descriptionDraftRef.current;
      const detailsDraft = detailsDraftRef.current;
      const itemsDraft = itemsDraftRef.current;
      const folderIdDraft = folderIdDraftRef.current;
      const preDraft = preCategoryNamesDraftRef.current;
      const postDraft = postCategoryNamesDraftRef.current;
      const savedSnapshot = buildDraftSnapshotFrom(routineId, titleDraft, descriptionDraft, detailsDraft, preDraft, postDraft, folderIdDraft, itemsDraft);
      if (savedSnapshot === lastSavedSnapshotRef.current) return true;

      const title = String(titleDraft ?? "").trim();
      if (!title) {
        setAuxiliaryAutosaveStatus("error");
        if (options?.alertOnTitleRequired) {
          Alert.alert("Title required", "Enter a routine title.");
        }
        return false;
      }

      const saveSeq = ++saveSeqRef.current;
      const pre = Array.from(new Set(preDraft.map((name) => String(name ?? "").trim()).filter(Boolean)));
      const post = Array.from(new Set(postDraft.map((name) => String(name ?? "").trim()).filter(Boolean)));
      const details = String(detailsDraft ?? "").trim();

      const commitPromise = (async () => {
        setAuxiliaryAutosaveStatus("saving");
        await updateAuxiliaryRoutine(routineId, {
          title,
          description: String(descriptionDraft ?? "").trim(),
          details,
          items: itemsDraft,
          folderId: folderIdDraft,
          preCategoryNames: pre,
          postCategoryNames: post,
          categoryNames: Array.from(new Set([...pre, ...post])),
        });

        const loaded = await loadAuxiliaryRoutines();
        const sorted = [...loaded].sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? "")));
        setAuxiliaryRoutines(sorted);

        const latestDraftSnapshot = buildDraftSnapshotFrom(
          selectedRoutineIdRef.current,
          titleDraftRef.current,
          descriptionDraftRef.current,
          detailsDraftRef.current,
          preCategoryNamesDraftRef.current,
          postCategoryNamesDraftRef.current,
          folderIdDraftRef.current,
          itemsDraftRef.current
        );
        const stillEditingSameRoutine = selectedRoutineIdRef.current === routineId;
        const localDraftUnchangedSinceSave = latestDraftSnapshot === savedSnapshot;
        if (saveSeq === saveSeqRef.current && stillEditingSameRoutine && localDraftUnchangedSinceSave) {
          lastSavedSnapshotRef.current = savedSnapshot;
          setAuxiliaryAutosaveStatus("saved");
        } else if (stillEditingSameRoutine) {
          setAuxiliaryAutosaveStatus("dirty");
        }
        return true;
      })();

      commitInFlightRef.current = commitPromise;
      try {
        return await commitPromise;
      } catch (error) {
        console.error("[auxiliary-routines] save failed", { reason, error });
        setAuxiliaryAutosaveStatus("error");
        Alert.alert("Routine save failed", "Couldn't save routine. Your draft is still here.");
        return false;
      } finally {
        if (commitInFlightRef.current === commitPromise) {
          commitInFlightRef.current = null;
        }
      }
    },
    []
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void loadManagerData(() => !cancelled);
      return () => {
        cancelled = true;
        void commitDraft("screen-blur");
      };
    }, [commitDraft, loadManagerData])
  );

  useEffect(() => {
    if (!selectedAuxiliaryRoutineId) return;
      const snapshot = buildDraftSnapshotFrom(
      selectedAuxiliaryRoutineId,
      auxiliaryTitleDraft,
      auxiliaryDescriptionDraft,
      auxiliaryDetailsDraft,
      auxiliaryPreCategoryNamesDraft,
      auxiliaryPostCategoryNamesDraft,
      auxiliaryFolderIdDraft,
      auxiliaryItemsDraft
    );
    if (snapshot !== lastSavedSnapshotRef.current && auxiliaryAutosaveStatus !== "saving") {
      setAuxiliaryAutosaveStatus("dirty");
    }
  }, [
    selectedAuxiliaryRoutineId,
    auxiliaryTitleDraft,
    auxiliaryDescriptionDraft,
    auxiliaryDetailsDraft,
    auxiliaryItemsDraft,
    auxiliaryFolderIdDraft,
    auxiliaryPreCategoryNamesDraft,
    auxiliaryPostCategoryNamesDraft,
    auxiliaryAutosaveStatus,
  ]);

  const selectAuxiliaryRoutineById = useCallback(
    async (routineId: string | null) => {
      if (routineId === selectedRoutineIdRef.current) return;
      const committed = await commitDraft("routine-selection");
      if (!committed) return;
      setSelectedAuxiliaryRoutineId(routineId);
      const routine = sortedAuxiliaryRoutines.find((item) => item.id === routineId) ?? null;
      loadRoutineIntoDrafts(routine);
    },
    [commitDraft, loadRoutineIntoDrafts, sortedAuxiliaryRoutines]
  );

  const createNewAuxiliaryRoutine = useCallback(async () => {
    if (readOnly) {
      Alert.alert("Viewer access", "Only Owners and Editors can manage drill routines.");
      return;
    }
    const committed = await commitDraft("create-new-routine");
    if (!committed) return;
    const created = await createAuxiliaryRoutine({
      title: "New Routine",
      details: "",
      folderId:
        selectedFolderFilterId !== ALL_FOLDERS_ID && selectedFolderFilterId !== UNCATEGORIZED_FOLDER_ID
          ? selectedFolderFilterId
          : null,
      preCategoryNames: [],
      postCategoryNames: [],
    });
    await reloadAuxiliaryRoutines(created.id);
    setAuxiliaryAutosaveStatus("idle");
  }, [commitDraft, readOnly, reloadAuxiliaryRoutines, selectedFolderFilterId]);

  const saveSelectedAuxiliaryRoutine = useCallback(async () => {
    if (!selectedRoutineIdRef.current) {
      Alert.alert("Select a routine", "Choose or create a routine to edit.");
      return;
    }
    await commitDraft("explicit-save", { alertOnTitleRequired: true });
  }, [commitDraft]);

  const confirmDeleteSelectedAuxiliaryRoutine = useCallback(() => {
    if (readOnly) {
      Alert.alert("Viewer access", "Only Owners and Editors can manage drill routines.");
      return;
    }
    if (auxiliaryDeleteBusy) return;
    if (!selectedAuxiliaryRoutineId) {
      Alert.alert("Select a routine", "Choose a routine to delete.");
      return;
    }

    const routineId = selectedAuxiliaryRoutineId;
    const routine = sortedAuxiliaryRoutines.find((item) => item.id === routineId) ?? null;
    if (!routine) {
      Alert.alert("Routine not found", "Refresh Drill Routines and try again.");
      void reloadAuxiliaryRoutines(null);
      return;
    }

    const runDelete = async () => {
      const previous = [...sortedAuxiliaryRoutines];
      const index = previous.findIndex((item) => item.id === routineId);
      const next = previous.filter((item) => item.id !== routineId);
      const fallback = next[index] ?? next[index - 1] ?? next[0] ?? null;

      setAuxiliaryDeleteBusy(true);
      setAuxiliaryRoutines(next);
      setSelectedRoutine(fallback);

      try {
        await deleteAuxiliaryRoutine(routineId, { requireCloudSync: true });
        const refreshed = await loadAuxiliaryRoutines();
        const sorted = [...refreshed].sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? "")));
        setAuxiliaryRoutines(sorted);
        const selected = fallback ? sorted.find((item) => item.id === fallback.id) ?? sorted[0] ?? null : sorted[0] ?? null;
        setSelectedRoutine(selected);
      } catch (error) {
        const message = getErrorMessage(error);
        console.error("[auxiliary-routines] delete failed", { routineId, error });
        setAuxiliaryRoutines(previous);
        setSelectedRoutine(routine);
        Alert.alert("Routine delete failed", message || "Couldn't delete routine. Please try again.");
      } finally {
        setAuxiliaryDeleteBusy(false);
      }
    };

    const message = `"${routine.title || "Routine"}" will be removed from drill routines.`;
    if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.confirm === "function") {
      if (window.confirm(`Delete routine?\n\n${message}`)) void runDelete();
      return;
    }

    Alert.alert("Delete routine?", message, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void runDelete() },
    ]);
  }, [
    auxiliaryDeleteBusy,
    readOnly,
    reloadAuxiliaryRoutines,
    selectedAuxiliaryRoutineId,
    setSelectedRoutine,
    sortedAuxiliaryRoutines,
  ]);

  const createRoutineFolder = useCallback(async () => {
    if (readOnly) {
      Alert.alert("Viewer access", "Only Owners and Editors can manage routine folders.");
      return;
    }
    const name = newRoutineFolderName.trim();
    if (!name) {
      Alert.alert("Folder name required", "Enter a folder name.");
      return;
    }
    const next = createRoutineFolderDraft(name, routineFolders.length + 1);
    const updated = [...routineFolders, next].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    setRoutineFolders(updated);
    setNewRoutineFolderName("");
    setSelectedFolderFilterId(next.id);
    try {
      await saveRoutineFolders(updated);
    } catch (error) {
      const message = getErrorMessage(error);
      Alert.alert("Folder save failed", message);
      void loadManagerData();
    }
  }, [loadManagerData, newRoutineFolderName, readOnly, routineFolders]);

  const updateRoutineFolderName = useCallback(
    async (folderId: string, name: string) => {
      const cleaned = name.trim();
      if (!cleaned) return;
      const updated = routineFolders.map((folder) =>
        folder.id === folderId ? { ...folder, name: cleaned, updatedAt: Date.now() } : folder
      );
      setRoutineFolders(updated);
      await saveRoutineFolders(updated);
    },
    [routineFolders]
  );

  const createDrillFolder = useCallback(async () => {
    if (readOnly) {
      Alert.alert("Viewer access", "Only Owners and Editors can manage drill folders.");
      return;
    }
    const name = newDrillFolderName.trim();
    if (!name) {
      Alert.alert("Folder name required", "Enter a folder name.");
      return;
    }
    const next = createDrillFolderDraft(name, drillFolders.length + 1);
    const updated = [...drillFolders, next].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    setDrillFolders(updated);
    setNewDrillFolderName("");
    setLibraryFolderFilterId(next.id);
    try {
      await saveDrillFolders(updated);
    } catch (error) {
      const message = getErrorMessage(error);
      Alert.alert("Folder save failed", message);
      void loadManagerData();
    }
  }, [drillFolders, loadManagerData, newDrillFolderName, readOnly]);

  const updateDrillFolderName = useCallback(
    async (folderId: string, name: string) => {
      const cleaned = name.trim();
      if (!cleaned) return;
      const updated = drillFolders.map((folder) =>
        folder.id === folderId ? { ...folder, name: cleaned, updatedAt: Date.now() } : folder
      );
      setDrillFolders(updated);
      await saveDrillFolders(updated);
    },
    [drillFolders]
  );

  const selectDrillForEdit = useCallback((item: DrillLibraryItem | null) => {
    setSelectedDrillId(item?.id ?? null);
    setDrillNameDraft(item?.name ?? "");
    setDrillFolderIdDraft(String(item?.folderId ?? "").trim() || null);
    setDrillVideoUrlDraft(item?.videoUrl ?? "");
    setDrillDetailsDraft(item?.defaultDetails ?? "");
  }, []);

  const createNewDrillDraft = useCallback(() => {
    const draft = createDrillLibraryItemDraft(drillLibraryItems.length + 1);
    draft.folderId =
      libraryFolderFilterId !== ALL_FOLDERS_ID && libraryFolderFilterId !== UNCATEGORIZED_FOLDER_ID
        ? libraryFolderFilterId
        : null;
    selectDrillForEdit(draft);
  }, [drillLibraryItems.length, libraryFolderFilterId, selectDrillForEdit]);

  const saveSelectedDrill = useCallback(async () => {
    if (readOnly) {
      Alert.alert("Viewer access", "Only Owners and Editors can manage drill library items.");
      return;
    }
    const name = drillNameDraft.trim();
    if (!name) {
      Alert.alert("Drill name required", "Enter a drill name.");
      return;
    }
    const now = Date.now();
    const existing = selectedDrillId ? drillLibraryItems.find((item) => item.id === selectedDrillId) : null;
    const nextItem: DrillLibraryItem = {
      ...(existing ?? createDrillLibraryItemDraft(drillLibraryItems.length + 1)),
      id: existing?.id ?? selectedDrillId ?? createDrillLibraryItemDraft().id,
      name,
      folderId: String(drillFolderIdDraft ?? "").trim() || null,
      videoUrl: drillVideoUrlDraft.trim(),
      defaultDetails: drillDetailsDraft.trim(),
      categoryNames: [],
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    };
    const updated = existing
      ? drillLibraryItems.map((item) => (item.id === existing.id ? nextItem : item))
      : [...drillLibraryItems, nextItem];
    const sorted = updated.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    setDrillBusy(true);
    setDrillLibraryItems(sorted);
    selectDrillForEdit(nextItem);
    try {
      await saveDrillLibraryItems(sorted);
    } catch (error) {
      const message = getErrorMessage(error);
      Alert.alert("Drill save failed", message);
      void loadManagerData();
    } finally {
      setDrillBusy(false);
    }
  }, [
    drillDetailsDraft,
    drillFolderIdDraft,
    drillLibraryItems,
    drillNameDraft,
    drillVideoUrlDraft,
    loadManagerData,
    readOnly,
    selectDrillForEdit,
    selectedDrillId,
  ]);

  const deleteSelectedDrill = useCallback(async () => {
    if (!selectedDrillId) return;
    const updated = drillLibraryItems.filter((item) => item.id !== selectedDrillId);
    setDrillLibraryItems(updated);
    selectDrillForEdit(null);
    try {
      await saveDrillLibraryItems(updated);
    } catch (error) {
      const message = getErrorMessage(error);
      Alert.alert("Drill delete failed", message);
      void loadManagerData();
    }
  }, [drillLibraryItems, loadManagerData, selectDrillForEdit, selectedDrillId]);

  function resolveLibraryDrill(item: DrillRoutineItem) {
    if (item.kind !== "libraryDrill") return null;
    return drillLibraryItems.find((drill) => drill.id === item.drillId) ?? null;
  }

  function getLibraryDrillTitle(item: DrillRoutineItem) {
    if (item.kind !== "libraryDrill") return "";
    return resolveLibraryDrill(item)?.name || item.drillTitle || "Library drill";
  }

  function getLibraryDrillDetails(item: DrillRoutineItem) {
    if (item.kind !== "libraryDrill") return "";
    return resolveLibraryDrill(item)?.defaultDetails || item.drillDefaultDetails || "";
  }

  function getLibraryDrillVideoUrl(item: DrillRoutineItem) {
    if (item.kind !== "libraryDrill") return "";
    return resolveLibraryDrill(item)?.videoUrl || item.drillVideoUrl || "";
  }

  const insertDrillIntoRoutine = useCallback((item: DrillLibraryItem | null) => {
    if (!item) {
      Alert.alert("Select a drill", "Choose a drill from the library first.");
      return;
    }
    setAuxiliaryItemsDraft((current) => [
      ...current,
      {
        id: createRoutineItemId(),
        kind: "libraryDrill",
        drillId: item.id,
        prescription: "",
        customNotes: "",
        drillTitle: item.name,
        drillVideoUrl: item.videoUrl,
        drillDefaultDetails: item.defaultDetails,
      },
    ]);
    setAuxiliaryAutosaveStatus("dirty");
  }, []);

  const insertDrillAsTextIntoRoutine = useCallback((item: DrillLibraryItem | null) => {
    if (!item) {
      Alert.alert("Select a drill", "Choose a drill from the library first.");
      return;
    }
    const parts = [item.name.trim(), item.defaultDetails.trim(), item.videoUrl.trim()].filter(Boolean);
    const line = parts.join(" - ");
    if (!line) return;
    setAuxiliaryDetailsDraft((current) => `${current.trimEnd()}${current.trim() ? "\n" : ""}${line}`);
    setAuxiliaryAutosaveStatus("dirty");
  }, []);

  const addCustomRoutineTextItem = useCallback(() => {
    setAuxiliaryItemsDraft((current) => [
      ...current,
      { id: createRoutineItemId(), kind: "text", text: "" },
    ]);
    setAuxiliaryAutosaveStatus("dirty");
  }, []);

  const updateRoutineItem = useCallback((itemId: string, patch: Partial<DrillRoutineItem>) => {
    setAuxiliaryItemsDraft((current) =>
      current.map((item) => {
        if (item.id !== itemId) return item;
        if (item.kind === "libraryDrill") {
          return { ...item, ...patch, kind: "libraryDrill" } as DrillRoutineItem;
        }
        return { ...item, ...patch, kind: "text" } as DrillRoutineItem;
      })
    );
    setAuxiliaryAutosaveStatus("dirty");
  }, []);

  const moveRoutineItem = useCallback((itemId: string, direction: -1 | 1) => {
    setAuxiliaryItemsDraft((current) => {
      const index = current.findIndex((item) => item.id === itemId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
    setAuxiliaryAutosaveStatus("dirty");
  }, []);

  const removeRoutineItem = useCallback((itemId: string) => {
    setAuxiliaryItemsDraft((current) => current.filter((item) => item.id !== itemId));
    setExpandedRoutineItemIds((current) => {
      const next = new Set(current);
      next.delete(itemId);
      return next;
    });
    setAuxiliaryAutosaveStatus("dirty");
  }, []);

  function toggleRoutineItemExpanded(itemId: string) {
    setExpandedRoutineItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function formatCategorySummary(selectedNames: string[]) {
    if (selectedNames.length === 0) return "No categories selected";
    const preview = selectedNames.slice(0, 3).join(", ");
    return selectedNames.length > 3 ? `${preview} +${selectedNames.length - 3}` : preview;
  }

  function renderCategorySelector({
    label,
    target,
    selectedNames,
    setSelectedNames,
  }: {
    label: string;
    target: CategoryAssignmentTarget;
    selectedNames: string[];
    setSelectedNames: React.Dispatch<React.SetStateAction<string[]>>;
  }) {
    const open = openCategorySelector === target;
    const selectedSet = new Set(selectedNames);
    const visibleSelectedNames = selectedNames.slice(0, 4);
    const extraSelectedCount = Math.max(0, selectedNames.length - visibleSelectedNames.length);

    return (
      <View style={styles.assignmentBlock}>
        <View style={styles.assignmentHeaderRow}>
          <Pressable
            onPress={() => setOpenCategorySelector((current) => (current === target ? null : target))}
            style={styles.assignmentSummaryButton}
          >
            <Text style={styles.assignmentLabel}>{label}</Text>
            <Text style={styles.assignmentSummary}>
              {selectedNames.length} selected • {formatCategorySummary(selectedNames)}
            </Text>
          </Pressable>

          <View style={styles.assignmentActions}>
            {selectedNames.length > 0 && !readOnly ? (
              <Pressable onPress={() => setSelectedNames([])} style={styles.smallGhostBtn}>
                <Text style={styles.smallGhostBtnText}>Clear</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => setOpenCategorySelector((current) => (current === target ? null : target))}
              style={styles.smallActionBtn}
            >
              <Text style={styles.smallActionBtnText}>{open ? "Done" : "Edit"}</Text>
            </Pressable>
          </View>
        </View>

        {selectedNames.length > 0 ? (
          <View style={styles.selectedChipRow}>
            {visibleSelectedNames.map((name) => (
              <View key={`${target}-selected-${name}`} style={styles.selectedCategoryChip}>
                <Text style={styles.selectedCategoryChipText}>{name}</Text>
              </View>
            ))}
            {extraSelectedCount > 0 ? (
              <View style={styles.selectedCategoryChip}>
                <Text style={styles.selectedCategoryChipText}>+{extraSelectedCount}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {open ? (
          <View style={styles.selectorPanel}>
            {sortedCategories.length === 0 ? (
              <Text style={styles.cardHint}>No workout categories found.</Text>
            ) : (
              <ScrollView
                nestedScrollEnabled
                style={styles.selectorScroll}
                contentContainerStyle={styles.selectorChipWrap}
                keyboardShouldPersistTaps="handled"
              >
                {sortedCategories.map((category) => {
                  const active = selectedSet.has(category.name);
                  return (
                    <Pressable
                      key={`${target}-${category.id}`}
                      disabled={readOnly}
                      onPress={() => toggleDraftCategory(setSelectedNames, category.name)}
                      style={[styles.autoRoutineChip, active && styles.autoRoutineChipActive, readOnly && styles.disabledBtn]}
                    >
                      <Text style={[styles.autoRoutineChipText, active && styles.autoRoutineChipTextActive]}>
                        {category.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardTitle}>Drill Routines</Text>
          <Text style={styles.cardHint}>
            Manage assignable routines separately from reusable individual drills.
          </Text>
        </View>
      </View>

      {readOnly ? (
        <Text style={styles.warningText}>Viewer access: routine editing is disabled.</Text>
      ) : null}
      {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

      <View style={styles.tabRow}>
        {[
          { id: "routines" as ManagerTab, label: "Routines" },
          { id: "drills" as ManagerTab, label: "Drill Library" },
        ].map((tab) => {
          const active = activeTab === tab.id;
          return (
            <Pressable
              key={tab.id}
              onPress={() => setActiveTab(tab.id)}
              style={[styles.tabButton, active && styles.tabButtonActive]}
            >
              <Text style={[styles.tabButtonText, active && styles.tabButtonTextActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {activeTab === "routines" ? (
        <View style={[styles.workspace, isDesktopWeb && styles.workspaceDesktop]}>
          <View style={[styles.listPane, isDesktopWeb && styles.listPaneDesktop]}>
            <View style={styles.listHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.listTitle}>Routines</Text>
                <Text style={styles.listHeaderHint}>Full sets assigned to workouts</Text>
              </View>
              <Text style={styles.listCount}>{visibleAuxiliaryRoutines.length}</Text>
            </View>

            <View style={styles.folderPanelCompact}>
              <View style={styles.folderPanelHeader}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.sectionTitle}>Routine folders</Text>
                  <Text style={styles.cardHint}>Filter full routines.</Text>
                </View>
                <Pressable
                  onPress={createNewAuxiliaryRoutine}
                  disabled={readOnly}
                  style={[styles.smallActionBtn, readOnly && styles.disabledBtn]}
                >
                  <Text style={styles.smallActionBtnText}>New Routine</Text>
                </Pressable>
              </View>

              <View style={styles.newFolderRow}>
                <TextInput
                  value={newRoutineFolderName}
                  onChangeText={setNewRoutineFolderName}
                  placeholder="New routine folder"
                  style={[styles.compactInput, readOnly && styles.inputDisabled]}
                  editable={!readOnly}
                />
                <Pressable onPress={() => void createRoutineFolder()} disabled={readOnly} style={[styles.smallActionBtn, readOnly && styles.disabledBtn]}>
                  <Text style={styles.smallActionBtnText}>Add</Text>
                </Pressable>
              </View>

              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.folderChipRow}>
                {[
                  { id: ALL_FOLDERS_ID, name: "All" },
                  { id: UNCATEGORIZED_FOLDER_ID, name: "Uncategorized" },
                  ...routineFolders,
                ].map((folder) => {
                  const active = selectedFolderFilterId === folder.id;
                  return (
                    <Pressable
                      key={`routine-filter-${folder.id}`}
                      onPress={() => setSelectedFolderFilterId(folder.id)}
                      style={[styles.folderChip, active && styles.folderChipActive]}
                    >
                      <Text style={[styles.folderChipText, active && styles.folderChipTextActive]}>{folder.name}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {selectedFilterFolder && !readOnly ? (
                <View style={styles.renameFolderRow}>
                  <Text style={styles.label}>Rename selected routine folder</Text>
                  <TextInput
                    defaultValue={selectedFilterFolder.name}
                    onSubmitEditing={(event) => void updateRoutineFolderName(selectedFilterFolder.id, event.nativeEvent.text)}
                    onEndEditing={(event) => void updateRoutineFolderName(selectedFilterFolder.id, event.nativeEvent.text)}
                    style={styles.compactInput}
                  />
                </View>
              ) : null}
            </View>

            <ScrollView style={styles.listBody} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
              {visibleAuxiliaryRoutines.length === 0 ? (
                <Text style={styles.cardHint}>No routines found for this folder.</Text>
              ) : (
                visibleAuxiliaryRoutines.map((routine) => {
                  const preCount = Array.isArray(routine.preCategoryNames) ? routine.preCategoryNames.length : 0;
                  const postCount = Array.isArray(routine.postCategoryNames) ? routine.postCategoryNames.length : 0;
                  const active = routine.id === selectedAuxiliaryRoutineId;
                  return (
                    <Pressable
                      key={routine.id}
                      onPress={() => void selectAuxiliaryRoutineById(routine.id)}
                      style={[styles.listRow, active && styles.listRowActive]}
                    >
                      <Text style={[styles.listRowTitle, active && styles.listRowTitleActive]}>
                        {routine.title || "Routine"}
                      </Text>
                      <Text style={styles.listRowMeta}>
                        {routineFolderName(routine.folderId)} • {preCount} pre • {postCount} post
                      </Text>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </View>

          <View style={[styles.editorPane, isDesktopWeb && styles.editorPaneDesktop]}>
            {selectedAuxiliaryRoutine ? (
              <>
                <View style={styles.editorTitleRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.editorTitle}>Routine Editor</Text>
                    <Text style={styles.cardHint}>Edit the full routine athletes and workout batches use.</Text>
                  </View>
                </View>

                <Text style={styles.label}>Title</Text>
                <TextInput
                  value={auxiliaryTitleDraft}
                  onChangeText={setAuxiliaryTitleDraft}
                  onBlur={() => void commitDraft("title-blur")}
                  placeholder="Routine name"
                  style={[styles.input, readOnly && styles.inputDisabled]}
                  editable={!readOnly}
                />

                <Text style={[styles.label, { marginTop: 10 }]}>Routine folder</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.folderChipRow}>
                  {[{ id: "", name: "Uncategorized" }, ...routineFolders].map((folder) => {
                    const folderId = String(folder.id ?? "").trim() || null;
                    const active = (auxiliaryFolderIdDraft ?? null) === folderId;
                    return (
                      <Pressable
                        key={`routine-folder-${folder.id || "uncategorized"}`}
                        disabled={readOnly}
                        onPress={() => setAuxiliaryFolderIdDraft(folderId)}
                        style={[styles.folderChip, active && styles.folderChipActive, readOnly && styles.disabledBtn]}
                      >
                        <Text style={[styles.folderChipText, active && styles.folderChipTextActive]}>{folder.name}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>

                <Text style={[styles.label, { marginTop: 10 }]}>Description</Text>
                <Text style={styles.fieldHint}>General instructions for the full routine.</Text>
                <TextInput
                  value={auxiliaryDescriptionDraft}
                  onChangeText={setAuxiliaryDescriptionDraft}
                  onBlur={() => void commitDraft("description-blur")}
                  placeholder="Perform on grass or soft surface..."
                  style={[styles.input, styles.descriptionInput, readOnly && styles.inputDisabled]}
                  multiline
                  editable={!readOnly}
                />
                {auxiliaryDescriptionDraft.trim() ? (
                  <View style={styles.linkPreviewBox}>
                    <Text style={styles.linkPreviewLabel}>Routine description preview</Text>
                    <LinkifiedText text={auxiliaryDescriptionDraft} style={styles.linkPreviewText} />
                  </View>
                ) : null}

                <View style={styles.routineItemsPanel}>
                  <View style={styles.insertPanelHeader}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.sectionTitle}>Routine items</Text>
                      <Text style={styles.cardHint}>Build a structured routine from library drills and custom text.</Text>
                    </View>
                    <View style={styles.buttonRow}>
                      <Pressable onPress={() => setInsertPickerOpen((open) => !open)} disabled={readOnly} style={[styles.smallActionBtn, readOnly && styles.disabledBtn]}>
                        <Text style={styles.smallActionBtnText}>{insertPickerOpen ? "Close" : "Add from Drill Library"}</Text>
                      </Pressable>
                      <Pressable onPress={addCustomRoutineTextItem} disabled={readOnly} style={[styles.smallGhostBtn, readOnly && styles.disabledBtn]}>
                        <Text style={styles.smallGhostBtnText}>Add custom text</Text>
                      </Pressable>
                    </View>
                  </View>

                  {insertPickerOpen ? (
                    <View style={styles.insertPicker}>
                      <TextInput
                        value={insertQuery}
                        onChangeText={setInsertQuery}
                        placeholder="Search drills"
                        style={styles.compactInput}
                      />
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.folderChipRow}>
                        {[
                          { id: ALL_FOLDERS_ID, name: "All" },
                          { id: UNCATEGORIZED_FOLDER_ID, name: "Uncategorized" },
                          ...drillFolders,
                        ].map((folder) => {
                          const active = insertFolderFilterId === folder.id;
                          return (
                            <Pressable
                              key={`insert-folder-${folder.id}`}
                              onPress={() => setInsertFolderFilterId(folder.id)}
                              style={[styles.folderChip, active && styles.folderChipActive]}
                            >
                              <Text style={[styles.folderChipText, active && styles.folderChipTextActive]}>{folder.name}</Text>
                            </Pressable>
                          );
                        })}
                      </ScrollView>
                      <ScrollView style={styles.insertList} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
                        {insertableDrillLibraryItems.length === 0 ? (
                          <Text style={styles.cardHint}>No library drills found.</Text>
                        ) : (
                          insertableDrillLibraryItems.map((item) => (
                            <View key={`insert-drill-${item.id}`} style={styles.insertRow}>
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={styles.drillRowTitle}>{item.name}</Text>
                                <Text style={styles.drillRowMeta}>{drillFolderName(item.folderId)}</Text>
                                {item.defaultDetails ? (
                                  <Text numberOfLines={2} style={styles.drillRowDetails}>{item.defaultDetails}</Text>
                                ) : null}
                              </View>
                              <View style={styles.insertRowActions}>
                                <Pressable onPress={() => insertDrillIntoRoutine(item)} disabled={readOnly} style={[styles.smallActionBtn, readOnly && styles.disabledBtn]}>
                                  <Text style={styles.smallActionBtnText}>Add item</Text>
                                </Pressable>
                                <Pressable onPress={() => insertDrillAsTextIntoRoutine(item)} disabled={readOnly} style={[styles.smallGhostBtn, readOnly && styles.disabledBtn]}>
                                  <Text style={styles.smallGhostBtnText}>As text</Text>
                                </Pressable>
                              </View>
                            </View>
                          ))
                        )}
                      </ScrollView>
                    </View>
                  ) : null}

                  {auxiliaryItemsDraft.length === 0 ? (
                    <Text style={styles.cardHint}>No structured items yet. Add a drill or custom text block, or keep using additional notes below.</Text>
                  ) : (
                    <View style={styles.routineItemStack}>
                      {auxiliaryItemsDraft.map((item, itemIndex) => {
                        const expanded = expandedRoutineItemIds.has(item.id);
                        const isFirst = itemIndex === 0;
                        const isLast = itemIndex === auxiliaryItemsDraft.length - 1;
                        if (item.kind === "text") {
                          return (
                            <View key={item.id} style={styles.routineItemCard}>
                              <View style={styles.routineItemHeader}>
                                <Text style={styles.routineItemKicker}>Custom text</Text>
                                <View style={styles.itemActionRow}>
                                  <Pressable disabled={readOnly || isFirst} onPress={() => moveRoutineItem(item.id, -1)} style={[styles.miniBtn, (readOnly || isFirst) && styles.disabledBtn]}>
                                    <Text style={styles.miniBtnText}>Up</Text>
                                  </Pressable>
                                  <Pressable disabled={readOnly || isLast} onPress={() => moveRoutineItem(item.id, 1)} style={[styles.miniBtn, (readOnly || isLast) && styles.disabledBtn]}>
                                    <Text style={styles.miniBtnText}>Down</Text>
                                  </Pressable>
                                  <Pressable disabled={readOnly} onPress={() => removeRoutineItem(item.id)} style={[styles.miniDeleteBtn, readOnly && styles.disabledBtn]}>
                                    <Text style={styles.miniDeleteBtnText}>Remove</Text>
                                  </Pressable>
                                </View>
                              </View>
                              <TextInput
                                value={item.text}
                                onChangeText={(text) => updateRoutineItem(item.id, { text } as Partial<DrillRoutineItem>)}
                                onBlur={() => void commitDraft("routine-item-text-blur")}
                                placeholder="Custom instruction"
                                multiline
                                editable={!readOnly}
                                style={[styles.input, styles.routineItemTextInput, readOnly && styles.inputDisabled]}
                              />
                            </View>
                          );
                        }

                        const drillTitle = getLibraryDrillTitle(item);
                        const drillDetails = getLibraryDrillDetails(item);
                        const drillVideoUrl = getLibraryDrillVideoUrl(item);
                        return (
                          <View key={item.id} style={styles.routineItemCard}>
                            <View style={styles.routineItemHeader}>
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={styles.routineItemKicker}>Library drill</Text>
                                <View style={styles.drillTitleRow}>
                                  <Text style={styles.routineItemTitle}>{drillTitle}</Text>
                                  {drillVideoUrl ? (
                                    <LinkifiedText text={drillVideoUrl} style={styles.routineItemLink} />
                                  ) : null}
                                </View>
                              </View>
                              <View style={styles.itemActionRow}>
                                <Pressable disabled={readOnly || isFirst} onPress={() => moveRoutineItem(item.id, -1)} style={[styles.miniBtn, (readOnly || isFirst) && styles.disabledBtn]}>
                                  <Text style={styles.miniBtnText}>Up</Text>
                                </Pressable>
                                <Pressable disabled={readOnly || isLast} onPress={() => moveRoutineItem(item.id, 1)} style={[styles.miniBtn, (readOnly || isLast) && styles.disabledBtn]}>
                                  <Text style={styles.miniBtnText}>Down</Text>
                                </Pressable>
                                <Pressable disabled={readOnly} onPress={() => removeRoutineItem(item.id)} style={[styles.miniDeleteBtn, readOnly && styles.disabledBtn]}>
                                  <Text style={styles.miniDeleteBtnText}>Remove</Text>
                                </Pressable>
                              </View>
                            </View>
                            <Text style={styles.label}>Prescription</Text>
                            <TextInput
                              value={item.prescription}
                              onChangeText={(prescription) => updateRoutineItem(item.id, { prescription } as Partial<DrillRoutineItem>)}
                              onBlur={() => void commitDraft("routine-item-prescription-blur")}
                              placeholder="2 x 10, 3 x 30m, 60 sec..."
                              editable={!readOnly}
                              style={[styles.input, readOnly && styles.inputDisabled]}
                            />
                            <Pressable onPress={() => toggleRoutineItemExpanded(item.id)} style={styles.cuesToggle}>
                              <Text style={styles.cuesToggleText}>{expanded ? "Hide cues" : "Show cues / notes"}</Text>
                            </Pressable>
                            {expanded ? (
                              <View style={styles.cuesPanel}>
                                {drillDetails ? (
                                  <>
                                    <Text style={styles.label}>Library cues</Text>
                                    <LinkifiedText text={drillDetails} style={styles.linkPreviewText} />
                                  </>
                                ) : (
                                  <Text style={styles.cardHint}>No library cues saved.</Text>
                                )}
                                <Text style={[styles.label, { marginTop: 8 }]}>Custom notes for this routine</Text>
                                <TextInput
                                  value={item.customNotes ?? ""}
                                  onChangeText={(customNotes) => updateRoutineItem(item.id, { customNotes } as Partial<DrillRoutineItem>)}
                                  onBlur={() => void commitDraft("routine-item-notes-blur")}
                                  placeholder="Optional notes"
                                  multiline
                                  editable={!readOnly}
                                  style={[styles.input, styles.routineItemTextInput, readOnly && styles.inputDisabled]}
                                />
                              </View>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>

                <Text style={[styles.label, { marginTop: 10 }]}>Additional notes / legacy details</Text>
                <TextInput
                  value={auxiliaryDetailsDraft}
                  onChangeText={setAuxiliaryDetailsDraft}
                  onBlur={() => void commitDraft("details-blur")}
                  placeholder="Optional routine notes"
                  style={[styles.input, styles.detailsInput, isDesktopWeb && styles.detailsInputDesktop, readOnly && styles.inputDisabled]}
                  multiline
                  editable={!readOnly}
                />
                {containsHttpUrl(auxiliaryDetailsDraft) ? (
                  <View style={styles.linkPreviewBox}>
                    <Text style={styles.linkPreviewLabel}>Clickable link preview</Text>
                    <LinkifiedText text={auxiliaryDetailsDraft} style={styles.linkPreviewText} />
                  </View>
                ) : null}

                <View style={styles.assignmentStack}>
                  {renderCategorySelector({
                    label: "Pre-run auto-assign",
                    target: "pre",
                    selectedNames: auxiliaryPreCategoryNamesDraft,
                    setSelectedNames: setAuxiliaryPreCategoryNamesDraft,
                  })}
                  {renderCategorySelector({
                    label: "Post-run auto-assign",
                    target: "post",
                    selectedNames: auxiliaryPostCategoryNamesDraft,
                    setSelectedNames: setAuxiliaryPostCategoryNamesDraft,
                  })}
                </View>

                <View style={styles.editorFooter}>
                  <Text style={[styles.statusText, auxiliaryAutosaveStatus === "error" && styles.statusError]}>
                    {auxiliaryAutosaveStatus === "saving"
                      ? "Saving..."
                      : auxiliaryAutosaveStatus === "dirty"
                      ? "Unsaved changes"
                      : auxiliaryAutosaveStatus === "saved"
                      ? "Saved"
                      : auxiliaryAutosaveStatus === "error"
                      ? "Save failed"
                      : "Ready"}
                  </Text>

                  <View style={styles.buttonRow}>
                    <Pressable
                      onPress={() => void saveSelectedAuxiliaryRoutine()}
                      disabled={readOnly || auxiliaryAutosaveStatus === "saving" || auxiliaryDeleteBusy}
                      style={[
                        styles.actionBtn,
                        (readOnly || auxiliaryAutosaveStatus === "saving" || auxiliaryDeleteBusy) && styles.disabledBtn,
                      ]}
                    >
                      <Text style={styles.actionBtnText}>
                        {auxiliaryAutosaveStatus === "saving" ? "Saving..." : "Save Routine"}
                      </Text>
                    </Pressable>

                    <Pressable
                      onPress={confirmDeleteSelectedAuxiliaryRoutine}
                      disabled={readOnly || auxiliaryAutosaveStatus === "saving" || auxiliaryDeleteBusy}
                      style={[
                        styles.deleteBtn,
                        (readOnly || auxiliaryAutosaveStatus === "saving" || auxiliaryDeleteBusy) && styles.disabledBtn,
                      ]}
                    >
                      <Text style={styles.deleteBtnText}>{auxiliaryDeleteBusy ? "Deleting..." : "Delete"}</Text>
                    </Pressable>
                  </View>
                </View>
                {auxiliaryAutosaveStatus === "error" ? (
                  <Text style={[styles.errorText, { marginTop: 8 }]}>
                    Couldn't save routine. Your draft is still here.
                  </Text>
                ) : null}
              </>
            ) : (
              <View style={styles.emptyEditor}>
                <Text style={styles.cardTitle}>No routine selected</Text>
                <Text style={styles.cardHint}>Select a routine on the left, or create a new routine to begin editing.</Text>
                <Pressable
                  onPress={createNewAuxiliaryRoutine}
                  disabled={readOnly}
                  style={[styles.actionBtn, { alignSelf: "flex-start" }, readOnly && styles.disabledBtn]}
                >
                  <Text style={styles.actionBtnText}>Create Routine</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      ) : (
        <View style={[styles.workspace, isDesktopWeb && styles.workspaceDesktop]}>
          <View style={[styles.listPane, isDesktopWeb && styles.listPaneDesktop]}>
            <View style={styles.listHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.listTitle}>Drill Library</Text>
                <Text style={styles.listHeaderHint}>Reusable individual drills</Text>
              </View>
              <Text style={styles.listCount}>{filteredDrillLibraryItems.length}</Text>
            </View>

            <View style={styles.folderPanelCompact}>
              <View style={styles.folderPanelHeader}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.sectionTitle}>Drill folders</Text>
                  <Text style={styles.cardHint}>Filter individual drills.</Text>
                </View>
                <Pressable onPress={createNewDrillDraft} disabled={readOnly} style={[styles.smallActionBtn, readOnly && styles.disabledBtn]}>
                  <Text style={styles.smallActionBtnText}>New Drill</Text>
                </Pressable>
              </View>

              <View style={styles.newFolderRow}>
                <TextInput
                  value={newDrillFolderName}
                  onChangeText={setNewDrillFolderName}
                  placeholder="New drill folder"
                  style={[styles.compactInput, readOnly && styles.inputDisabled]}
                  editable={!readOnly}
                />
                <Pressable onPress={() => void createDrillFolder()} disabled={readOnly} style={[styles.smallActionBtn, readOnly && styles.disabledBtn]}>
                  <Text style={styles.smallActionBtnText}>Add</Text>
                </Pressable>
              </View>

              <TextInput
                value={libraryQuery}
                onChangeText={setLibraryQuery}
                placeholder="Search drills"
                style={styles.compactInput}
              />

              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.folderChipRow}>
                {[
                  { id: ALL_FOLDERS_ID, name: "All" },
                  { id: UNCATEGORIZED_FOLDER_ID, name: "Uncategorized" },
                  ...drillFolders,
                ].map((folder) => {
                  const active = libraryFolderFilterId === folder.id;
                  return (
                    <Pressable
                      key={`library-filter-${folder.id}`}
                      onPress={() => setLibraryFolderFilterId(folder.id)}
                      style={[styles.folderChip, active && styles.folderChipActive]}
                    >
                      <Text style={[styles.folderChipText, active && styles.folderChipTextActive]}>{folder.name}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {selectedLibraryFilterFolder && !readOnly ? (
                <View style={styles.renameFolderRow}>
                  <Text style={styles.label}>Rename selected drill folder</Text>
                  <TextInput
                    defaultValue={selectedLibraryFilterFolder.name}
                    onSubmitEditing={(event) => void updateDrillFolderName(selectedLibraryFilterFolder.id, event.nativeEvent.text)}
                    onEndEditing={(event) => void updateDrillFolderName(selectedLibraryFilterFolder.id, event.nativeEvent.text)}
                    style={styles.compactInput}
                  />
                </View>
              ) : null}
            </View>

            <ScrollView style={styles.listBody} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
              {filteredDrillLibraryItems.length === 0 ? (
                <Text style={styles.cardHint}>No library drills yet. Add drills here, then insert them into routines.</Text>
              ) : (
                filteredDrillLibraryItems.map((item) => {
                  const active = item.id === selectedDrillId;
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => selectDrillForEdit(item)}
                      style={[styles.drillRow, active && styles.drillRowActive]}
                    >
                      <Text style={styles.drillRowTitle}>{item.name}</Text>
                      <Text style={styles.drillRowMeta}>{drillFolderName(item.folderId)}</Text>
                      {item.defaultDetails ? (
                        <Text numberOfLines={2} style={styles.drillRowDetails}>{item.defaultDetails}</Text>
                      ) : null}
                      {item.videoUrl ? <Text style={styles.drillRowMeta}>Video link saved</Text> : null}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </View>

          <View style={[styles.editorPane, isDesktopWeb && styles.editorPaneDesktop]}>
            <View style={styles.drillEditorStandalone}>
              <View style={styles.editorTitleRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.editorTitle}>{selectedDrillId ? "Drill Editor" : "New Library Drill"}</Text>
                  <Text style={styles.cardHint}>Save reusable drills with default cues and video links.</Text>
                </View>
              </View>

              <Text style={styles.label}>Drill name</Text>
              <TextInput
                value={drillNameDraft}
                onChangeText={setDrillNameDraft}
                placeholder="Drill name"
                editable={!readOnly}
                style={[styles.input, readOnly && styles.inputDisabled]}
              />

              <Text style={[styles.label, { marginTop: 10 }]}>Drill folder</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.folderChipRow}>
                {[{ id: "", name: "Uncategorized" }, ...drillFolders].map((folder) => {
                  const folderId = String(folder.id ?? "").trim() || null;
                  const active = (drillFolderIdDraft ?? null) === folderId;
                  return (
                    <Pressable
                      key={`drill-folder-${folder.id || "uncategorized"}`}
                      disabled={readOnly}
                      onPress={() => setDrillFolderIdDraft(folderId)}
                      style={[styles.folderChip, active && styles.folderChipActive, readOnly && styles.disabledBtn]}
                    >
                      <Text style={[styles.folderChipText, active && styles.folderChipTextActive]}>{folder.name}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <Text style={[styles.label, { marginTop: 10 }]}>Default prescription / coaching cues</Text>
              <TextInput
                value={drillDetailsDraft}
                onChangeText={setDrillDetailsDraft}
                placeholder="Default prescription or coaching cues"
                editable={!readOnly}
                multiline
                style={[styles.input, styles.drillDetailsInputLarge, readOnly && styles.inputDisabled]}
              />

              <Text style={[styles.label, { marginTop: 10 }]}>Video URL</Text>
              <TextInput
                value={drillVideoUrlDraft}
                onChangeText={setDrillVideoUrlDraft}
                placeholder="https://..."
                autoCapitalize="none"
                editable={!readOnly}
                style={[styles.input, readOnly && styles.inputDisabled]}
              />
              {containsHttpUrl(drillVideoUrlDraft) ? (
                <View style={styles.linkPreviewBox}>
                  <Text style={styles.linkPreviewLabel}>Link preview</Text>
                  <LinkifiedText text={drillVideoUrlDraft} style={styles.linkPreviewText} />
                </View>
              ) : null}

              <View style={styles.editorFooter}>
                <Text style={styles.statusText}>{drillBusy ? "Saving..." : "Ready"}</Text>
                <View style={styles.buttonRow}>
                  <Pressable
                    onPress={() => void saveSelectedDrill()}
                    disabled={readOnly || drillBusy}
                    style={[styles.actionBtn, (readOnly || drillBusy) && styles.disabledBtn]}
                  >
                    <Text style={styles.actionBtnText}>{drillBusy ? "Saving..." : "Save Drill"}</Text>
                  </Pressable>
                  {selectedDrillId ? (
                    <Pressable
                      onPress={() => void deleteSelectedDrill()}
                      disabled={readOnly || drillBusy}
                      style={[styles.deleteBtn, (readOnly || drillBusy) && styles.disabledBtn]}
                    >
                      <Text style={styles.deleteBtnText}>Delete Drill</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: "#dbe3ef",
    borderRadius: 16,
    backgroundColor: "#fff",
    padding: 16,
    gap: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  cardTitle: { fontSize: 18, fontWeight: "900", color: "#172033" },
  cardHint: { color: "#68758d", lineHeight: 19, fontWeight: "700" },
  sectionTitle: { fontSize: 15, fontWeight: "900", color: "#172033" },
  tabRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tabButton: {
    borderWidth: 1,
    borderColor: "#d7deeb",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: "#fff",
  },
  tabButtonActive: {
    borderColor: "#1f2a44",
    backgroundColor: "#1f2a44",
  },
  tabButtonText: {
    color: "#334155",
    fontWeight: "900",
  },
  tabButtonTextActive: {
    color: "#fff",
  },
  folderPanel: {
    borderWidth: 1,
    borderColor: "#e1e7f2",
    borderRadius: 14,
    backgroundColor: "#fff",
    padding: 12,
    gap: 10,
  },
  folderPanelCompact: {
    borderBottomWidth: 1,
    borderBottomColor: "#e1e7f2",
    padding: 12,
    gap: 10,
    backgroundColor: "#fbfdff",
  },
  folderPanelHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  newFolderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  compactInput: {
    borderWidth: 1,
    borderColor: "#d7deeb",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#fff",
    color: "#111827",
    fontWeight: "700",
    minWidth: 150,
  },
  folderChipRow: {
    gap: 8,
    alignItems: "center",
    paddingVertical: 2,
  },
  folderChip: {
    borderWidth: 1,
    borderColor: "#d7deeb",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "#fff",
  },
  folderChipActive: {
    borderColor: "#1f2a44",
    backgroundColor: "#1f2a44",
  },
  folderChipText: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "900",
  },
  folderChipTextActive: {
    color: "#fff",
  },
  renameFolderRow: {
    borderTopWidth: 1,
    borderTopColor: "#e1e7f2",
    paddingTop: 10,
    gap: 6,
  },
  workspace: {
    borderWidth: 1,
    borderColor: "#e1e7f2",
    borderRadius: 14,
    backgroundColor: "#f8faff",
    overflow: "hidden",
  },
  workspaceDesktop: {
    flexDirection: "row",
    minHeight: 560,
  },
  listPane: {
    borderBottomWidth: 1,
    borderBottomColor: "#e1e7f2",
    backgroundColor: "#fff",
  },
  listPaneDesktop: {
    width: 300,
    borderBottomWidth: 0,
    borderRightWidth: 1,
    borderRightColor: "#e1e7f2",
  },
  listHeader: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e7f2",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  listTitle: { fontWeight: "900", color: "#172033" },
  listHeaderHint: {
    marginTop: 2,
    color: "#64748b",
    fontSize: 12,
    fontWeight: "800",
  },
  listCount: { fontWeight: "900", color: "#6b7280" },
  listBody: {
    maxHeight: 480,
    padding: 12,
  },
  listRow: {
    borderWidth: 1,
    borderColor: "#e1e7f2",
    borderRadius: 12,
    padding: 10,
    backgroundColor: "#fff",
  },
  listRowActive: {
    borderColor: "#1f2a44",
    backgroundColor: "#eef3ff",
  },
  listRowTitle: { fontWeight: "900", color: "#172033" },
  listRowTitleActive: { color: "#111827" },
  listRowMeta: { marginTop: 4, color: "#64748b", fontSize: 12, fontWeight: "800" },
  editorPane: {
    padding: 14,
    backgroundColor: "#fff",
  },
  editorPaneDesktop: {
    flex: 1,
    minWidth: 0,
  },
  editorTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 10,
  },
  editorTitle: { fontSize: 16, fontWeight: "900", color: "#172033", marginBottom: 10 },
  label: { fontSize: 12, fontWeight: "900", color: "#4f5f7a", marginBottom: 6 },
  fieldHint: {
    color: "#68758d",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d7deeb",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
    color: "#111827",
    fontWeight: "700",
  },
  inputDisabled: {
    backgroundColor: "#f3f4f6",
    color: "#6b7280",
  },
  detailsInput: {
    minHeight: 220,
    textAlignVertical: "top",
  },
  descriptionInput: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  detailsInputDesktop: {
    minHeight: 280,
  },
  linkPreviewBox: {
    borderWidth: 1,
    borderColor: "#bfdbfe",
    borderRadius: 12,
    backgroundColor: "#eff6ff",
    padding: 10,
    gap: 6,
    marginTop: 10,
  },
  linkPreviewLabel: {
    color: "#1e40af",
    fontSize: 12,
    fontWeight: "900",
  },
  linkPreviewText: {
    color: "#334155",
    lineHeight: 20,
    fontWeight: "700",
  },
  assignmentStack: {
    gap: 10,
    marginTop: 12,
  },
  insertPanel: {
    borderWidth: 1,
    borderColor: "#e1e7f2",
    borderRadius: 12,
    backgroundColor: "#f8faff",
    padding: 10,
    gap: 10,
    marginTop: 12,
  },
  routineItemsPanel: {
    borderWidth: 1,
    borderColor: "#e1e7f2",
    borderRadius: 12,
    backgroundColor: "#f8faff",
    padding: 10,
    gap: 10,
    marginTop: 12,
  },
  insertPanelHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  insertPicker: {
    borderTopWidth: 1,
    borderTopColor: "#e1e7f2",
    paddingTop: 10,
    gap: 8,
  },
  insertList: {
    maxHeight: 260,
  },
  insertRow: {
    borderWidth: 1,
    borderColor: "#e1e7f2",
    borderRadius: 12,
    padding: 10,
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  insertRowActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 8,
  },
  insertRowAction: {
    color: "#1f2a44",
    fontWeight: "900",
  },
  routineItemStack: {
    gap: 10,
  },
  routineItemCard: {
    borderWidth: 1,
    borderColor: "#dbe3ef",
    borderRadius: 12,
    backgroundColor: "#fff",
    padding: 10,
    gap: 8,
  },
  routineItemHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  routineItemKicker: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  routineItemTitle: {
    color: "#172033",
    fontSize: 15,
    fontWeight: "900",
  },
  drillTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  routineItemLink: {
    color: "#2563eb",
    fontSize: 12,
    fontWeight: "900",
  },
  itemActionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  miniBtn: {
    borderWidth: 1,
    borderColor: "#d7deeb",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: "#fff",
  },
  miniBtnText: {
    color: "#334155",
    fontSize: 11,
    fontWeight: "900",
  },
  miniDeleteBtn: {
    borderWidth: 1,
    borderColor: "#fecaca",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: "#fff",
  },
  miniDeleteBtnText: {
    color: "#b00020",
    fontSize: 11,
    fontWeight: "900",
  },
  routineItemTextInput: {
    minHeight: 72,
    textAlignVertical: "top",
  },
  cuesToggle: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#bfdbfe",
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "#eff6ff",
  },
  cuesToggleText: {
    color: "#1d4ed8",
    fontWeight: "900",
  },
  cuesPanel: {
    borderTopWidth: 1,
    borderTopColor: "#e1e7f2",
    paddingTop: 8,
    gap: 6,
  },
  drillRow: {
    borderWidth: 1,
    borderColor: "#e1e7f2",
    borderRadius: 12,
    padding: 10,
    backgroundColor: "#fff",
    gap: 4,
  },
  drillRowActive: {
    borderColor: "#1f2a44",
    backgroundColor: "#eef3ff",
  },
  drillRowTitle: { fontWeight: "900", color: "#172033" },
  drillRowMeta: { color: "#64748b", fontSize: 12, fontWeight: "800" },
  drillRowDetails: { color: "#475569", lineHeight: 18, fontWeight: "700" },
  drillEditorStandalone: {
    gap: 8,
  },
  drillDetailsInputLarge: {
    minHeight: 180,
    textAlignVertical: "top",
  },
  assignmentBlock: {
    borderWidth: 1,
    borderColor: "#e1e7f2",
    borderRadius: 12,
    backgroundColor: "#f8faff",
    padding: 10,
    gap: 8,
  },
  assignmentHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  assignmentSummaryButton: {
    flex: 1,
    minWidth: 220,
    gap: 3,
  },
  assignmentLabel: {
    fontSize: 12,
    fontWeight: "900",
    color: "#172033",
  },
  assignmentSummary: {
    fontSize: 12,
    fontWeight: "800",
    color: "#64748b",
  },
  assignmentActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  selectedChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  selectedCategoryChip: {
    borderWidth: 1,
    borderColor: "#d7deeb",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "#fff",
  },
  selectedCategoryChipText: {
    color: "#475569",
    fontSize: 11,
    fontWeight: "900",
  },
  selectorPanel: {
    borderTopWidth: 1,
    borderTopColor: "#e1e7f2",
    paddingTop: 8,
  },
  selectorScroll: {
    maxHeight: 170,
  },
  selectorChipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingBottom: 2,
  },
  autoRoutineChip: {
    borderWidth: 1,
    borderColor: "#d7deeb",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "#fff",
  },
  autoRoutineChipActive: {
    borderColor: "#111827",
    backgroundColor: "#111827",
  },
  autoRoutineChipText: { fontWeight: "800", color: "#222" },
  autoRoutineChipTextActive: { color: "#fff" },
  smallActionBtn: {
    borderWidth: 1,
    borderColor: "#1f2a44",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "#1f2a44",
  },
  smallActionBtnText: {
    color: "#fff",
    fontWeight: "900",
  },
  smallGhostBtn: {
    borderWidth: 1,
    borderColor: "#d3dbe8",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "#fff",
  },
  smallGhostBtnText: {
    color: "#475569",
    fontWeight: "900",
  },
  editorFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 14,
    flexWrap: "wrap",
  },
  statusText: { fontSize: 12, fontWeight: "900", color: "#666" },
  statusError: { color: "#b00020" },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  actionBtn: {
    borderWidth: 1,
    borderColor: "#d3dbe8",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#f8faff",
    alignItems: "center",
    justifyContent: "center",
  },
  actionBtnText: { fontWeight: "900", color: "#111" },
  deleteBtn: {
    borderWidth: 1,
    borderColor: "#f1c3c3",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  deleteBtnText: { fontWeight: "900", color: "#b00020" },
  disabledBtn: { opacity: 0.55 },
  warningText: { color: "#92400e", fontWeight: "800" },
  errorText: { color: "#b00020", fontWeight: "800" },
  emptyEditor: {
    gap: 10,
    minHeight: 220,
    justifyContent: "center",
  },
});
