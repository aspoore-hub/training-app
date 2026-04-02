import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { WorkoutCategory } from "../../../lib/types";
import { CATEGORY_COLOR_PALETTE, isPermanentCategory, newId, pickUnusedCategoryColor } from "../../../lib/categories";
import {
  COACH_CATEGORIES_KEY,
  COACH_CATEGORIES_SOURCE,
  loadCoachCategoriesFromTeamKV,
  saveCoachCategoriesToTeamKV,
} from "../../../lib/settings";
import { bulkUpdateTeamWorkouts, listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";
import { getCurrentTeamId } from "../../../lib/team";

function ensureOther(list: WorkoutCategory[]) {
  const exists = list.some((c) => c.name.toLowerCase() === "other");
  return exists ? list : [...list, { id: newId(), name: "Other", color: pickUnusedCategoryColor(list) }];
}

const MIN_DATE_ISO = "1900-01-01";
const MAX_DATE_ISO = "9999-12-31";

function categoryMatch(workout: TeamWorkoutRow, categoryName: string) {
  const target = String(categoryName ?? "").trim().toLowerCase();
  if (!target) return false;
  if (String(workout.primary_category ?? "").trim().toLowerCase() === target) return true;
  const cats = Array.isArray(workout.categories) ? workout.categories : [];
  return cats.some((c) => String(c ?? "").trim().toLowerCase() === target);
}

function replaceCategoryValues(workout: TeamWorkoutRow, oldName: string, nextName: string) {
  const target = String(oldName ?? "").trim().toLowerCase();
  const normalizedNext = String(nextName ?? "").trim();
  if (!target || !normalizedNext) return null;

  const cats = Array.isArray(workout.categories) ? workout.categories : [];
  const hasInList = cats.some((c) => String(c ?? "").trim().toLowerCase() === target);
  const nextCats = hasInList
    ? Array.from(
        new Set(
          cats.map((c) => (String(c ?? "").trim().toLowerCase() === target ? normalizedNext : String(c ?? "").trim())).filter(Boolean)
        )
      )
    : cats;

  const primary = String(workout.primary_category ?? "").trim();
  const nextPrimary = primary.toLowerCase() === target ? normalizedNext : primary || (nextCats[0] ?? normalizedNext);

  if (nextPrimary === (workout.primary_category ?? null) && JSON.stringify(nextCats) === JSON.stringify(cats)) {
    return null;
  }

  return {
    primary_category: nextPrimary || null,
    categories: nextCats.length > 0 ? nextCats : [normalizedNext],
    category: nextPrimary || normalizedNext,
  };
}

function DraggableRow({
  index,
  children,
  rowId,
  restingOffsetY = 0,
  onDropBySteps,
  onDragStart,
  onDragStepsChange,
  onDragEnd,
}: {
  index: number;
  children: React.ReactNode;
  rowId: string;
  restingOffsetY?: number;
  onDropBySteps: (steps: number) => void;
  onDragStart?: (rowId: string, index: number) => void;
  onDragStepsChange?: (rowId: string, index: number, steps: number) => void;
  onDragEnd?: (rowId: string, index: number) => void;
}) {
  const translateY = useSharedValue(0);
  const active = useSharedValue(false);
  const stepCount = useSharedValue(0);
  const STEP_PX = 92;
  const DEAD_ZONE_PX = 20;

  const pan = Gesture.Pan()
    .activateAfterLongPress(120)
    .onBegin(() => {
      active.value = true;
      runOnJS(onDragStart ?? (() => {}))(rowId, index);
    })
    .onUpdate((e) => {
      translateY.value = e.translationY;
      const absY = Math.abs(e.translationY);
      let nextSteps = 0;
      if (absY > DEAD_ZONE_PX) {
        const magnitude = Math.round(absY / STEP_PX);
        nextSteps = e.translationY < 0 ? -magnitude : magnitude;
      }
      if (stepCount.value !== nextSteps) {
        stepCount.value = nextSteps;
        runOnJS(onDragStepsChange ?? (() => {}))(rowId, index, nextSteps);
      }
    })
    .onEnd(() => {
      runOnJS(onDropBySteps)(stepCount.value);
      translateY.value = withTiming(0, { duration: 130 });
      active.value = false;
      stepCount.value = 0;
      runOnJS(onDragEnd ?? (() => {}))(rowId, index);
    })
    .onFinalize(() => {
      translateY.value = withTiming(0, { duration: 130 });
      active.value = false;
      stepCount.value = 0;
      runOnJS(onDragStepsChange ?? (() => {}))(rowId, index, 0);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value + restingOffsetY }],
    zIndex: active.value ? 2 : 0,
    opacity: active.value ? 0.96 : 1,
    shadowColor: "#0f172a",
    shadowOpacity: active.value ? 0.2 : 0,
    shadowRadius: active.value ? 10 : 0,
    shadowOffset: { width: 0, height: active.value ? 6 : 0 },
    elevation: active.value ? 6 : 0,
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={animatedStyle}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

export function CategoriesContent({ useVirtualizedList = true }: { useVirtualizedList?: boolean } = {}) {
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [draft, setDraft] = useState("");
  const [chooserOpen, setChooserOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [pendingDeleteWorkouts, setPendingDeleteWorkouts] = useState<TeamWorkoutRow[] | null>(null);
  const [colorPickerForId, setColorPickerForId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingCategory, setRenamingCategory] = useState<{ id: string; currentName: string } | null>(null);
  const [debugTeamId, setDebugTeamId] = useState("(loading)");
  const [debugLoadSource, setDebugLoadSource] = useState(COACH_CATEGORIES_SOURCE);
  const [debugLoadedCount, setDebugLoadedCount] = useState(0);
  const [debugLastSaveStatus, setDebugLastSaveStatus] = useState("idle");
  const [debugLastSaveError, setDebugLastSaveError] = useState("");
  const listRef = useRef<FlatList<WorkoutCategory>>(null);
  const autoScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoScrollDirectionRef = useRef<0 | 1 | -1>(0);
  const autoScrollSpeedRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const [dragPreview, setDragPreview] = useState<{
    activeId: string | null;
    steps: number;
    targetId: string | null;
  }>({ activeId: null, steps: 0, targetId: null });

  useEffect(() => {
    (async () => {
      try {
        const [teamId, list] = await Promise.all([
          getCurrentTeamId().catch((error) => `error: ${error instanceof Error ? error.message : String(error)}`),
          loadCoachCategoriesFromTeamKV(),
        ]);
        console.log("[settings-categories] load result", {
          teamId,
          source: COACH_CATEGORIES_SOURCE,
          key: COACH_CATEGORIES_KEY,
          categoriesCount: list.length,
        });
        setDebugTeamId(String(teamId ?? ""));
        setDebugLoadSource(COACH_CATEGORIES_SOURCE);
        setDebugLoadedCount(list.length);
        setCategories(list);
      } catch (error) {
        console.error("[settings-categories] load failed", error);
        Alert.alert("Settings load failed", error instanceof Error ? error.message : String(error ?? "Unknown error"));
      }
    })();
  }, []);

  const ordered = useMemo(() => categories.slice(), [categories]);

  const updateDragPreview = useCallback(
    (rowId: string, index: number, steps: number) => {
      if (!steps) {
        setDragPreview((prev) =>
          prev.activeId === rowId ? { activeId: rowId, steps: 0, targetId: null } : prev
        );
        return;
      }
      const targetIndex = Math.max(0, Math.min(ordered.length - 1, index + steps));
      const targetId = String(ordered[targetIndex]?.id ?? "").trim() || null;
      setDragPreview({ activeId: rowId, steps, targetId: targetId && targetId !== rowId ? targetId : null });
    },
    [ordered]
  );

  const clearDragPreview = useCallback(() => {
    setDragPreview({ activeId: null, steps: 0, targetId: null });
  }, []);

  const stopAutoScroll = useCallback(() => {
    autoScrollDirectionRef.current = 0;
    autoScrollSpeedRef.current = 0;
    if (autoScrollTimerRef.current) {
      clearInterval(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }, []);

  const startAutoScroll = useCallback(
    (direction: 1 | -1, speed: number) => {
      autoScrollDirectionRef.current = direction;
      autoScrollSpeedRef.current = speed;
      if (autoScrollTimerRef.current) return;

      autoScrollTimerRef.current = setInterval(() => {
        const maxOffset = Math.max(0, contentHeightRef.current - viewportHeightRef.current);
        if (maxOffset <= 0) return;
        const current = scrollOffsetRef.current;
        const delta = autoScrollDirectionRef.current * autoScrollSpeedRef.current;
        const next = Math.max(0, Math.min(maxOffset, current + delta));
        if (next === current) return;
        scrollOffsetRef.current = next;
        listRef.current?.scrollToOffset({ offset: next, animated: false });
      }, 16);
    },
    []
  );

  const updateAutoScrollFromSteps = useCallback(
    (steps: number) => {
      if (!useVirtualizedList) return;
      if (!steps) {
        stopAutoScroll();
        return;
      }
      const direction: 1 | -1 = steps > 0 ? 1 : -1;
      const magnitude = Math.max(1, Math.abs(steps));
      const speed = Math.min(22, 8 + magnitude * 4);
      startAutoScroll(direction, speed);
    },
    [startAutoScroll, stopAutoScroll, useVirtualizedList]
  );

  useEffect(() => () => stopAutoScroll(), [stopAutoScroll]);

  async function persist(next: WorkoutCategory[]) {
    setDebugLastSaveStatus("saving");
    setDebugLastSaveError("");
    console.log("[settings-categories] save payload", {
      teamId: debugTeamId,
      source: COACH_CATEGORIES_SOURCE,
      key: COACH_CATEGORIES_KEY,
      categoriesCount: next.length,
    });
    try {
      const saved = await saveCoachCategoriesToTeamKV(next);
      console.log("[settings-categories] save response", {
        status: "success",
        categoriesCount: saved.length,
      });
      setCategories(saved);
      setDebugLoadedCount(saved.length);
      setDebugLastSaveStatus("success");
    } catch (error) {
      console.error("[settings-categories] save failed", error);
      setDebugLastSaveStatus("error");
      setDebugLastSaveError(error instanceof Error ? error.message : String(error ?? "Unknown error"));
      Alert.alert("Settings save failed", error instanceof Error ? error.message : String(error ?? "Unknown error"));
      throw error;
    }
  }

  async function moveCategoryBySteps(id: string, stepsRaw: number) {
    const steps = Math.trunc(stepsRaw);
    if (!steps) return;
    const idx = categories.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const target = Math.max(0, Math.min(categories.length - 1, idx + steps));
    if (target < 0 || target >= categories.length) return;
    if (target === idx) return;

    const next = categories.slice();
    const [moved] = next.splice(idx, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    const previous = categories.slice();
    setCategories(next);
    try {
      await persist(next);
    } catch {
      setCategories(previous);
    }
  }

  async function applyCategoryColor(categoryId: string, color: string) {
    const selectedCategory = categories.find((c) => c.id === categoryId);
    if (!selectedCategory) return;

    const next = categories.map((c) => (c.id === categoryId ? { ...c, color } : c));

    await persist(next);
    setColorPickerForId(null);
  }

  async function addCategory() {
    const name = draft.trim();
    if (!name) return;

    const exists = categories.some((c) => c.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      Alert.alert("Already exists", "That category already exists.");
      return;
    }

    const next = [...categories, { id: newId(), name, color: pickUnusedCategoryColor(categories) }];
    setDraft("");
    await persist(next);
  }

  function renameCategory(id: string, currentName: string) {
    if (isPermanentCategory({ id, name: currentName })) {
      Alert.alert("Built-in category", `"${currentName}" is permanent and cannot be renamed.`);
      return;
    }
    setRenamingCategory({ id, currentName });
    setRenameDraft(currentName);
  }

  async function saveRenameCategory() {
    console.log("[rename] clicked", { renamingCategory, renameDraft, count: categories.length });

    if (!renamingCategory) {
      console.log("[rename] no renamingCategory");
      return;
    }
    if (isPermanentCategory({ id: renamingCategory.id, name: renamingCategory.currentName })) {
      Alert.alert("Built-in category", `"${renamingCategory.currentName}" is permanent and cannot be renamed.`);
      setRenamingCategory(null);
      setRenameDraft("");
      return;
    }

    const name = renameDraft.trim();
    console.log("[rename] trimmed", { name });
    if (!name) {
      console.log("[rename] empty name");
      Alert.alert("Name required", "Enter a category name.");
      return;
    }

    const exists = categories.some(
      (c) =>
        c.id !== renamingCategory.id &&
        String(c.name ?? "").trim().toLowerCase() === name.toLowerCase()
    );
    console.log("[rename] exists check", { exists });

    if (exists) {
      Alert.alert("Already exists", "That category already exists.");
      return;
    }

    const next = categories.map((c) =>
      c.id === renamingCategory.id ? { ...c, name } : c
    );
    console.log("[rename] before persist", { nextCount: next.length, targetId: renamingCategory.id });

    await persist(next);
    console.log("[rename] after persist");
    setRenamingCategory(null);
    setRenameDraft("");
  }

  function cancelRenameCategory() {
    setRenamingCategory(null);
    setRenameDraft("");
  }

  async function deleteCategory(id: string, name: string) {
    if (isPermanentCategory({ id, name })) {
      Alert.alert("Built-in category", `"${name}" is permanent and cannot be deleted.`);
      return;
    }
    // Load workouts so we can see impact and optionally migrate
    const allWorkouts = await listTeamWorkoutsInRange(MIN_DATE_ISO, MAX_DATE_ISO);
    console.log("[coach-categories] workouts fetch", {
      purpose: "delete-category-impact-and-migrate",
      start: MIN_DATE_ISO,
      end: MAX_DATE_ISO,
      count: allWorkouts?.length ?? 0,
    });

    // A workout can store category as string name or categoryId depending on earlier versions.
    const affected = allWorkouts.filter((w) => categoryMatch(w, name));

    // First: confirm delete
    Alert.alert(
      "Delete category?",
      affected.length > 0
        ? `"${name}" is used in ${affected.length} workout(s). What do you want to do?`
        : `Delete "${name}"?`,
      [
        { text: "Cancel", style: "cancel", onPress: () => setPendingDeleteWorkouts(null) },

        // Option 1: Leave as-is (do not touch workouts)
        {
          text: "Leave as-is",
          onPress: async () => {
            setPendingDeleteWorkouts(null);
            const nextCats = categories.filter((c) => c.id !== id);
            await persist(nextCats.length > 0 ? nextCats : []);
          },
        },

        // Option 4: Reassign to Other
        {
          text: "Move to Other",
          onPress: async () => {
            let nextCats = categories.filter((c) => c.id !== id);
            nextCats = ensureOther(nextCats);

            const other = nextCats.find((c) => c.name.toLowerCase() === "other")!;
            const patches = allWorkouts
              .map((w) => {
                if (!categoryMatch(w, name)) return null;
                const patch = replaceCategoryValues(w, name, other.name);
                if (!patch) return null;
                return { id: w.id, patch };
              })
              .filter(Boolean) as Array<{ id: string; patch: any }>;
            if (patches.length > 0) await bulkUpdateTeamWorkouts(patches);
            setPendingDeleteWorkouts(null);
            await persist(nextCats.length > 0 ? nextCats : []);
          },
        },

        // Option 2: Choose existing category
        {
          text: "Choose existing…",
          onPress: () => {
            // We can't show a picker inside Alert reliably.
            // We’ll open a simple in-screen chooser using a transient state.
            setPendingDeleteWorkouts(allWorkouts);
            setPendingDelete({ id, name });
            setChooserOpen(true);
          },
        },

        // Option 3: Create new category + move
        {
          text: "Create new…",
          onPress: async () => {
            Alert.prompt(
              "Create new category",
              `Create a new category and move ${affected.length} workout(s) to it:`,
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Create",
                  onPress: async (text?: string) => {
                    const newName = (text ?? "").trim();
                    if (!newName) return;

                    // create new category
                    const newCat: WorkoutCategory = {
                      id: newId(),
                      name: newName,
                      color: pickUnusedCategoryColor(categories),
                    };
                    const nextCats = categories.filter((c) => c.id !== id).concat(newCat);

                    const patches = allWorkouts
                      .map((w) => {
                        if (!categoryMatch(w, name)) return null;
                        const patch = replaceCategoryValues(w, name, newCat.name);
                        if (!patch) return null;
                        return { id: w.id, patch };
                      })
                      .filter(Boolean) as Array<{ id: string; patch: any }>;
                    if (patches.length > 0) await bulkUpdateTeamWorkouts(patches);
                    setPendingDeleteWorkouts(null);
                    await persist(nextCats.length > 0 ? nextCats : []);
                  },
                },
              ],
              "plain-text"
            );
          },
        },
      ]
    );
  }

  return (
    <View style={{ flex: useVirtualizedList ? 1 : undefined, padding: 16, backgroundColor: "#fff" }}>
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 12 }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Add a category (e.g., Tempo)"
          style={{
            flex: 1,
            borderWidth: 1,
            borderColor: "#ddd",
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        />
        <Pressable
          onPress={addCategory}
          style={{
            paddingHorizontal: 14,
            borderRadius: 12,
            backgroundColor: "#111",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: "#fff", fontWeight: "900" }}>Add</Text>
        </Pressable>
      </View>

      {renamingCategory ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: "#eee",
            borderRadius: 12,
            padding: 12,
            marginBottom: 12,
            backgroundColor: "#fff",
          }}
        >
          <Text style={{ fontWeight: "900", marginBottom: 8 }}>
            Rename "{renamingCategory.currentName}"
          </Text>

          <TextInput
            value={renameDraft}
            onChangeText={setRenameDraft}
            placeholder="Category name"
            style={{
              borderWidth: 1,
              borderColor: "#ddd",
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: 10,
              marginBottom: 10,
            }}
            autoCapitalize="words"
            autoFocus
          />

          <View style={{ flexDirection: "row", gap: 10 }}>
            <Pressable
              onPress={saveRenameCategory}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: "#111",
                borderRadius: 10,
                paddingVertical: 10,
                alignItems: "center",
                backgroundColor: "#111",
              }}
            >
              <Text style={{ fontWeight: "900", color: "#fff" }}>Save</Text>
            </Pressable>

            <Pressable
              onPress={cancelRenameCategory}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: "#ddd",
                borderRadius: 10,
                paddingVertical: 10,
                alignItems: "center",
                backgroundColor: "#fff",
              }}
            >
              <Text style={{ fontWeight: "900" }}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {chooserOpen && pendingDelete ? (
        <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 12, padding: 12, marginBottom: 12, backgroundColor: "#fff" }}>
          <Text style={{ fontWeight: "900", marginBottom: 8 }}>
            Move "{pendingDelete.name}" workouts to:
          </Text>

          {ordered
            .filter((c) => c.id !== pendingDelete.id) // exclude the one being deleted
            .map((c) => (
              <Pressable
              key={c.id}
              onPress={async () => {
                  const allWorkouts = pendingDeleteWorkouts ?? [];
                  const nextCats = categories.filter((x) => x.id !== pendingDelete.id);
                  const patches = allWorkouts
                    .map((w) => {
                      if (!categoryMatch(w, pendingDelete.name)) return null;
                      const patch = replaceCategoryValues(w, pendingDelete.name, c.name);
                      if (!patch) return null;
                      return { id: w.id, patch };
                    })
                    .filter(Boolean) as Array<{ id: string; patch: any }>;
                  if (patches.length > 0) await bulkUpdateTeamWorkouts(patches);
                  await persist(nextCats.length > 0 ? nextCats : []);

                  setChooserOpen(false);
                  setPendingDelete(null);
                  setPendingDeleteWorkouts(null);
                }}
                style={{
                  borderWidth: 1,
                  borderColor: "#ddd",
                  borderRadius: 10,
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                  backgroundColor: "#fafafa",
                  marginBottom: 8,
                }}
              >
                <Text style={{ fontWeight: "900" }}>{c.name}</Text>
              </Pressable>
            ))}

          <Pressable
            onPress={() => {
              setChooserOpen(false);
              setPendingDelete(null);
              setPendingDeleteWorkouts(null);
            }}
            style={{
              borderWidth: 1,
              borderColor: "#ddd",
              borderRadius: 10,
              paddingVertical: 10,
              alignItems: "center",
              backgroundColor: "#fff",
            }}
          >
            <Text style={{ fontWeight: "900" }}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      {useVirtualizedList ? (
        <FlatList
          ref={listRef}
          data={ordered}
          keyExtractor={(item) => item.id}
          nestedScrollEnabled
          onLayout={(event) => {
            viewportHeightRef.current = Number(event.nativeEvent.layout.height ?? 0);
          }}
          onContentSizeChange={(_, height) => {
            contentHeightRef.current = Number(height ?? 0);
          }}
          onScroll={(event) => {
            scrollOffsetRef.current = Number(event.nativeEvent.contentOffset.y ?? 0);
          }}
          scrollEventThrottle={16}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          renderItem={({ item, index }) => (
            <DraggableRow
              rowId={item.id}
              index={index}
              restingOffsetY={
                dragPreview.activeId !== item.id && dragPreview.targetId === item.id
                  ? dragPreview.steps < 0
                    ? 10
                    : -10
                  : 0
              }
              onDropBySteps={(steps) => void moveCategoryBySteps(item.id, steps)}
              onDragStart={(rowId) => setDragPreview({ activeId: rowId, steps: 0, targetId: null })}
              onDragStepsChange={(rowId, rowIndex, steps) => {
                updateDragPreview(rowId, rowIndex, steps);
                updateAutoScrollFromSteps(steps);
              }}
              onDragEnd={() => {
                clearDragPreview();
                stopAutoScroll();
              }}
            >
              {(() => {
                const permanent = isPermanentCategory(item);
                const isDragging = dragPreview.activeId === item.id;
                const isDropTarget = !isDragging && dragPreview.targetId === item.id;
                return (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: isDropTarget ? "#93c5fd" : "#eee",
                  borderRadius: 12,
                  padding: 12,
                  backgroundColor: "#fafafa",
                }}
              >
                {isDropTarget && dragPreview.steps > 0 ? (
                  <View style={{ height: 3, borderRadius: 2, backgroundColor: "#3b82f6", marginBottom: 8 }} />
                ) : null}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 15, color: "#777", fontWeight: "800" }}>≡</Text>
                    <Text style={{ fontSize: 14, fontWeight: "900", flexShrink: 1 }}>{item.name}</Text>
                    <Pressable
                      onPress={() => setColorPickerForId((prev) => (prev === item.id ? null : item.id))}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        borderWidth: 1,
                        borderColor: "#ddd",
                        borderRadius: 999,
                        paddingVertical: 4,
                        paddingHorizontal: 8,
                        backgroundColor: "#fff",
                        gap: 6,
                      }}
                    >
                      <View
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 6,
                          backgroundColor: item.color ?? "#6B7280",
                          borderWidth: 1,
                          borderColor: "rgba(0,0,0,0.15)",
                        }}
                      />
                      <Text style={{ fontSize: 11, fontWeight: "800", color: "#444" }}>Color</Text>
                    </Pressable>
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, marginLeft: 10 }}>
                    <Pressable
                      onPress={() => {
                        if (permanent) return;
                        void renameCategory(item.id, item.name);
                      }}
                      style={{
                        borderWidth: 1,
                        borderColor: permanent ? "#e8ebf1" : "#ddd",
                        borderRadius: 9,
                        paddingVertical: 7,
                        paddingHorizontal: 12,
                        alignItems: "center",
                        backgroundColor: permanent ? "#f7f7f8" : "#fff",
                        opacity: permanent ? 0.7 : 1,
                      }}
                    >
                      <Text style={{ fontWeight: "900", fontSize: 12 }}>Rename</Text>
                    </Pressable>

                    <Pressable
                      onPress={() => {
                        if (permanent) return;
                        void deleteCategory(item.id, item.name);
                      }}
                      style={{
                        borderWidth: 1,
                        borderColor: permanent ? "#eedede" : "#f3c1c1",
                        borderRadius: 9,
                        paddingVertical: 7,
                        paddingHorizontal: 12,
                        alignItems: "center",
                        backgroundColor: permanent ? "#faf5f5" : "#fff",
                        opacity: permanent ? 0.7 : 1,
                      }}
                    >
                      <Text style={{ fontWeight: "900", fontSize: 12, color: "#b00020" }}>
                        {permanent ? "Built-In" : "Delete"}
                      </Text>
                    </Pressable>
                  </View>
                </View>
                {isDragging ? (
                  <Text style={{ marginTop: 8, fontSize: 11, fontWeight: "800", color: "#475569" }}>
                    {dragPreview.steps < 0
                      ? "Release to move up"
                      : dragPreview.steps > 0
                      ? "Release to move down"
                      : "Drag up or down to reorder"}
                  </Text>
                ) : null}

                {colorPickerForId === item.id ? (
                  <View
                    style={{
                      marginTop: 10,
                      borderWidth: 1,
                      borderColor: "#e5e7eb",
                      borderRadius: 10,
                      paddingVertical: 8,
                      paddingHorizontal: 8,
                      backgroundColor: "#fff",
                    }}
                  >
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {CATEGORY_COLOR_PALETTE.map((color) => {
                        const active = (item.color ?? "").toLowerCase() === color.toLowerCase();
                        return (
                          <Pressable
                            key={`row-picker-${item.id}-${color}`}
                            onPress={() => applyCategoryColor(item.id, color)}
                            style={{
                              width: 34,
                              height: 34,
                              borderRadius: 17,
                              backgroundColor: color,
                              borderWidth: active ? 3 : 1,
                              borderColor: active ? "#111" : "rgba(0,0,0,0.20)",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            {active ? <Text style={{ color: "#fff", fontSize: 12, fontWeight: "900" }}>✓</Text> : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}
                {isDropTarget && dragPreview.steps < 0 ? (
                  <View style={{ height: 3, borderRadius: 2, backgroundColor: "#3b82f6", marginTop: 8 }} />
                ) : null}
              </View>
                );
              })()}
            </DraggableRow>
          )}
        />
      ) : (
        <View>
          {ordered.map((item, index) => (
            <View key={item.id} style={{ marginBottom: index === ordered.length - 1 ? 0 : 10 }}>
              <DraggableRow
                rowId={item.id}
                index={index}
                restingOffsetY={
                  dragPreview.activeId !== item.id && dragPreview.targetId === item.id
                    ? dragPreview.steps < 0
                      ? 10
                      : -10
                    : 0
                }
              onDropBySteps={(steps) => void moveCategoryBySteps(item.id, steps)}
              onDragStart={(rowId) => setDragPreview({ activeId: rowId, steps: 0, targetId: null })}
              onDragStepsChange={(rowId, rowIndex, steps) => {
                updateDragPreview(rowId, rowIndex, steps);
                updateAutoScrollFromSteps(steps);
              }}
              onDragEnd={() => {
                clearDragPreview();
                stopAutoScroll();
              }}
              >
                {(() => {
                  const permanent = isPermanentCategory(item);
                  const isDragging = dragPreview.activeId === item.id;
                  const isDropTarget = !isDragging && dragPreview.targetId === item.id;
                  return (
                <View
                  style={{
                    borderWidth: 1,
                    borderColor: isDropTarget ? "#93c5fd" : "#eee",
                    borderRadius: 12,
                    padding: 12,
                    backgroundColor: "#fafafa",
                  }}
                >
                  {isDropTarget && dragPreview.steps > 0 ? (
                    <View style={{ height: 3, borderRadius: 2, backgroundColor: "#3b82f6", marginBottom: 8 }} />
                  ) : null}
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 15, color: "#777", fontWeight: "800" }}>≡</Text>
                      <Text style={{ fontSize: 14, fontWeight: "900", flexShrink: 1 }}>{item.name}</Text>
                      <Pressable
                        onPress={() => setColorPickerForId((prev) => (prev === item.id ? null : item.id))}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          borderWidth: 1,
                          borderColor: "#ddd",
                          borderRadius: 999,
                          paddingVertical: 4,
                          paddingHorizontal: 8,
                          backgroundColor: "#fff",
                          gap: 6,
                        }}
                      >
                        <View
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: 6,
                            backgroundColor: item.color ?? "#6B7280",
                            borderWidth: 1,
                            borderColor: "rgba(0,0,0,0.15)",
                          }}
                        />
                        <Text style={{ fontSize: 11, fontWeight: "800", color: "#444" }}>Color</Text>
                      </Pressable>
                    </View>
                    <View style={{ flexDirection: "row", gap: 8, marginLeft: 10 }}>
                      <Pressable
                        onPress={() => {
                          if (permanent) return;
                          void renameCategory(item.id, item.name);
                        }}
                        style={{
                          borderWidth: 1,
                          borderColor: permanent ? "#e8ebf1" : "#ddd",
                          borderRadius: 9,
                          paddingVertical: 7,
                          paddingHorizontal: 12,
                          alignItems: "center",
                          backgroundColor: permanent ? "#f7f7f8" : "#fff",
                          opacity: permanent ? 0.7 : 1,
                        }}
                      >
                        <Text style={{ fontWeight: "900", fontSize: 12 }}>Rename</Text>
                      </Pressable>

                      <Pressable
                        onPress={() => {
                          if (permanent) return;
                          void deleteCategory(item.id, item.name);
                        }}
                        style={{
                          borderWidth: 1,
                          borderColor: permanent ? "#eedede" : "#f3c1c1",
                          borderRadius: 9,
                          paddingVertical: 7,
                          paddingHorizontal: 12,
                          alignItems: "center",
                          backgroundColor: permanent ? "#faf5f5" : "#fff",
                          opacity: permanent ? 0.7 : 1,
                        }}
                      >
                        <Text style={{ fontWeight: "900", fontSize: 12, color: "#b00020" }}>
                          {permanent ? "Built-In" : "Delete"}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                  {isDragging ? (
                    <Text style={{ marginTop: 8, fontSize: 11, fontWeight: "800", color: "#475569" }}>
                      {dragPreview.steps < 0
                        ? "Release to move up"
                        : dragPreview.steps > 0
                        ? "Release to move down"
                        : "Drag up or down to reorder"}
                    </Text>
                  ) : null}

                    {colorPickerForId === item.id ? (
                      <View
                        style={{
                          marginTop: 10,
                          borderWidth: 1,
                          borderColor: "#e5e7eb",
                          borderRadius: 10,
                          paddingVertical: 8,
                          paddingHorizontal: 8,
                          backgroundColor: "#fff",
                        }}
                      >
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                          {CATEGORY_COLOR_PALETTE.map((color) => {
                            const active = (item.color ?? "").toLowerCase() === color.toLowerCase();
                            return (
                              <Pressable
                                key={`row-picker-${item.id}-${color}`}
                                onPress={() => applyCategoryColor(item.id, color)}
                                style={{
                                  width: 34,
                                  height: 34,
                                  borderRadius: 17,
                                  backgroundColor: color,
                                  borderWidth: active ? 3 : 1,
                                  borderColor: active ? "#111" : "rgba(0,0,0,0.20)",
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                {active ? <Text style={{ color: "#fff", fontSize: 12, fontWeight: "900" }}>✓</Text> : null}
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                    ) : null}
                    {isDropTarget && dragPreview.steps < 0 ? (
                      <View style={{ height: 3, borderRadius: 2, backgroundColor: "#3b82f6", marginTop: 8 }} />
                    ) : null}
                </View>
                  );
                })()}
              </DraggableRow>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export default function CoachCategoriesScreen() {
  return <CategoriesContent />;
}
