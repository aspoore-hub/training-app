import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { loadJSON, saveJSON } from "../../../lib/storage";
import type { WorkoutCategory } from "../../../lib/types";
import { CATEGORY_COLOR_PALETTE, CATEGORIES_KEY, normalizeCategories, newId, pickUnusedCategoryColor } from "../../../lib/categories";
import { bulkUpdateTeamWorkouts, listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";

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
  onSlideUp,
  onSlideDown,
}: {
  index: number;
  children: React.ReactNode;
  onSlideUp: () => void;
  onSlideDown: () => void;
}) {
  const translateY = useSharedValue(0);
  const active = useSharedValue(false);

  const pan = Gesture.Pan()
    .activateAfterLongPress(120)
    .onBegin(() => {
      active.value = true;
    })
    .onUpdate((e) => {
      translateY.value = e.translationY;
    })
    .onEnd((e) => {
      const threshold = 36;
      if (e.translationY < -threshold) runOnJS(onSlideUp)();
      if (e.translationY > threshold) runOnJS(onSlideDown)();
      translateY.value = withTiming(0, { duration: 130 });
      active.value = false;
    })
    .onFinalize(() => {
      translateY.value = withTiming(0, { duration: 130 });
      active.value = false;
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    zIndex: active.value ? 2 : 0,
    opacity: active.value ? 0.96 : 1,
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
  const [colorPickerForId, setColorPickerForId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const stored = await loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []);
      setCategories(normalizeCategories(stored));
    })();
  }, []);

  const ordered = useMemo(() => categories.slice(), [categories]);

  async function persist(next: WorkoutCategory[]) {
    setCategories(next);
    await saveJSON(CATEGORIES_KEY, next);
  }

  async function moveCategory(id: string, dir: "up" | "down") {
    const idx = categories.findIndex((c) => c.id === id);
    if (idx < 0) return;

    const target = dir === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= categories.length) return;

    const next = categories.slice();
    const temp = next[idx];
    next[idx] = next[target];
    next[target] = temp;
    await persist(next);
  }

  async function applyCategoryColor(categoryId: string, color: string) {
    const selectedCategory = categories.find((c) => c.id === categoryId);
    if (!selectedCategory) return;

    const takenBy = categories.find(
      (c) => c.id !== categoryId && (c.color ?? "").toLowerCase() === color.toLowerCase()
    );

    const next = categories.map((c) => {
      if (c.id === categoryId) return { ...c, color };
      if (takenBy && c.id === takenBy.id) return { ...c, color: selectedCategory.color };
      return c;
    });

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

  async function renameCategory(id: string, currentName: string) {
    Alert.prompt(
      "Rename category",
      "Enter a new name:",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          onPress: async (text?: string) => {
            const name = (text ?? "").trim();
            if (!name) return;

            const next = categories.map((c) => (c.id === id ? { ...c, name } : c));
            await persist(next);
          },
        },
      ],
      "plain-text",
      currentName
    );
  }

  async function deleteCategory(id: string, name: string) {
    // Load workouts so we can see impact and optionally migrate
    const allWorkouts = await listTeamWorkoutsInRange(MIN_DATE_ISO, MAX_DATE_ISO);

    // A workout can store category as string name or categoryId depending on earlier versions.
    const affected = allWorkouts.filter((w) => categoryMatch(w, name));

    // First: confirm delete
    Alert.alert(
      "Delete category?",
      affected.length > 0
        ? `"${name}" is used in ${affected.length} workout(s). What do you want to do?`
        : `Delete "${name}"?`,
      [
        { text: "Cancel", style: "cancel" },

        // Option 1: Leave as-is (do not touch workouts)
        {
          text: "Leave as-is",
          onPress: async () => {
            const nextCats = categories.filter((c) => c.id !== id);
            await persist(nextCats.length > 0 ? nextCats : normalizeCategories([]));
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
            await persist(nextCats.length > 0 ? nextCats : normalizeCategories([]));
          },
        },

        // Option 2: Choose existing category
        {
          text: "Choose existing…",
          onPress: () => {
            // We can't show a picker inside Alert reliably.
            // We’ll open a simple in-screen chooser using a transient state.
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
                    await persist(nextCats.length > 0 ? nextCats : normalizeCategories([]));
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
      <Text style={{ fontSize: 20, fontWeight: "900", marginBottom: 10 }}>Workout Categories</Text>

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
                  const allWorkouts = await listTeamWorkoutsInRange(MIN_DATE_ISO, MAX_DATE_ISO);
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
                  await persist(nextCats.length > 0 ? nextCats : normalizeCategories([]));

                  setChooserOpen(false);
                  setPendingDelete(null);
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

      {colorPickerForId ? (
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
          <Text style={{ fontWeight: "900", marginBottom: 10 }}>
            Pick color for "{ordered.find((c) => c.id === colorPickerForId)?.name ?? "Category"}"
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            {CATEGORY_COLOR_PALETTE.map((color) => {
              const active =
                (ordered.find((c) => c.id === colorPickerForId)?.color ?? "").toLowerCase() === color.toLowerCase();
              return (
                <Pressable
                  key={`picker-${color}`}
                  onPress={() => applyCategoryColor(colorPickerForId, color)}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    backgroundColor: color,
                    borderWidth: active ? 3 : 1,
                    borderColor: active ? "#111" : "rgba(0,0,0,0.20)",
                  }}
                />
              );
            })}
          </View>
          <Pressable
            onPress={() => setColorPickerForId(null)}
            style={{
              marginTop: 12,
              borderWidth: 1,
              borderColor: "#ddd",
              borderRadius: 10,
              paddingVertical: 10,
              alignItems: "center",
              backgroundColor: "#fff",
            }}
          >
            <Text style={{ fontWeight: "900" }}>Done</Text>
          </Pressable>
        </View>
      ) : null}

      {useVirtualizedList ? (
        <FlatList
          data={ordered}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          renderItem={({ item, index }) => (
            <DraggableRow
              index={index}
              onSlideUp={() => moveCategory(item.id, "up")}
              onSlideDown={() => moveCategory(item.id, "down")}
            >
              <View
                style={{
                  borderWidth: 1,
                  borderColor: "#eee",
                  borderRadius: 12,
                  padding: 12,
                  backgroundColor: "#fafafa",
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ fontSize: 15, color: "#777", fontWeight: "800" }}>≡</Text>
                    <Text style={{ fontSize: 14, fontWeight: "900" }}>{item.name}</Text>
                  </View>
                  <Pressable
                    onPress={() => setColorPickerForId(item.id)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      borderWidth: 1,
                      borderColor: "#ddd",
                      borderRadius: 999,
                      paddingVertical: 6,
                      paddingHorizontal: 10,
                      backgroundColor: "#fff",
                      gap: 8,
                    }}
                  >
                    <View
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 7,
                        backgroundColor: item.color ?? "#6B7280",
                        borderWidth: 1,
                        borderColor: "rgba(0,0,0,0.15)",
                      }}
                    />
                    <Text style={{ fontSize: 12, fontWeight: "800", color: "#444" }}>Color</Text>
                  </Pressable>
                </View>

                <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
                  <Pressable
                    onPress={() => renameCategory(item.id, item.name)}
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
                    <Text style={{ fontWeight: "900" }}>Rename</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => deleteCategory(item.id, item.name)}
                    style={{
                      flex: 1,
                      borderWidth: 1,
                      borderColor: "#f3c1c1",
                      borderRadius: 10,
                      paddingVertical: 10,
                      alignItems: "center",
                      backgroundColor: "#fff",
                    }}
                  >
                    <Text style={{ fontWeight: "900", color: "#b00020" }}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            </DraggableRow>
          )}
        />
      ) : (
        <View>
          {ordered.map((item, index) => (
            <View key={item.id} style={{ marginBottom: index === ordered.length - 1 ? 0 : 10 }}>
              <DraggableRow
                index={index}
                onSlideUp={() => moveCategory(item.id, "up")}
                onSlideDown={() => moveCategory(item.id, "down")}
              >
                <View
                  style={{
                    borderWidth: 1,
                    borderColor: "#eee",
                    borderRadius: 12,
                    padding: 12,
                    backgroundColor: "#fafafa",
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={{ fontSize: 15, color: "#777", fontWeight: "800" }}>≡</Text>
                      <Text style={{ fontSize: 14, fontWeight: "900" }}>{item.name}</Text>
                    </View>
                    <Pressable
                      onPress={() => setColorPickerForId(item.id)}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        borderWidth: 1,
                        borderColor: "#ddd",
                        borderRadius: 999,
                        paddingVertical: 6,
                        paddingHorizontal: 10,
                        backgroundColor: "#fff",
                        gap: 8,
                      }}
                    >
                      <View
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 7,
                          backgroundColor: item.color ?? "#6B7280",
                          borderWidth: 1,
                          borderColor: "rgba(0,0,0,0.15)",
                        }}
                      />
                      <Text style={{ fontSize: 12, fontWeight: "800", color: "#444" }}>Color</Text>
                    </Pressable>
                  </View>

                  <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
                    <Pressable
                      onPress={() => renameCategory(item.id, item.name)}
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
                      <Text style={{ fontWeight: "900" }}>Rename</Text>
                    </Pressable>

                    <Pressable
                      onPress={() => deleteCategory(item.id, item.name)}
                      style={{
                        flex: 1,
                        borderWidth: 1,
                        borderColor: "#f3c1c1",
                        borderRadius: 10,
                        paddingVertical: 10,
                        alignItems: "center",
                        backgroundColor: "#fff",
                      }}
                    >
                      <Text style={{ fontWeight: "900", color: "#b00020" }}>Delete</Text>
                    </Pressable>
                  </View>
                </View>
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
