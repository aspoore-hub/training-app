import { useCallback, useMemo, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Swipeable } from "react-native-gesture-handler";
import type { WorkoutCategory } from "../../../lib/types";
import {
  createWorkoutTemplate,
  deleteWorkoutTemplate,
  loadWorkoutTemplates,
  updateWorkoutTemplate,
  type WorkoutTemplate,
} from "../../../lib/workoutTemplates";
import {
  createAuxiliaryRoutine,
  deleteAuxiliaryRoutine,
  loadAuxiliaryRoutines,
  updateAuxiliaryRoutine,
  type AuxiliaryRoutine,
} from "../../../lib/auxiliaryRoutines";
import { deletePlannerDraft, loadPlannerDrafts, type PlannerDraft } from "../../../lib/plannerDrafts";
import { getCategoryOptions, loadCoachSettings } from "../../../lib/settings";

type CreateType = "template" | "routine" | null;
type EditState =
  | { kind: "template"; item: WorkoutTemplate }
  | { kind: "routine"; item: AuxiliaryRoutine }
  | null;

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function compareByTitle(a: string, b: string) {
  return String(a ?? "").trim().toLowerCase().localeCompare(String(b ?? "").trim().toLowerCase());
}

function parseCategoryCsv(text: string): string[] {
  return Array.from(
    new Set(
      String(text ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    )
  );
}

function removeCategoryFromSides(
  categoryName: string,
  pre: string[],
  post: string[]
): { pre: string[]; post: string[] } {
  return {
    pre: pre.filter((name) => name !== categoryName),
    post: post.filter((name) => name !== categoryName),
  };
}

export default function CoachSavedTab() {
  const router = useRouter();
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [templates, setTemplates] = useState<WorkoutTemplate[]>([]);
  const [routines, setRoutines] = useState<AuxiliaryRoutine[]>([]);
  const [drafts, setDrafts] = useState<PlannerDraft[]>([]);

  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateCategoriesOpen, setTemplateCategoriesOpen] = useState<Record<string, boolean>>({});
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);

  const [createType, setCreateType] = useState<CreateType>(null);
  const [createTitle, setCreateTitle] = useState("");
  const [createDetails, setCreateDetails] = useState("");
  const [createCategories, setCreateCategories] = useState("");
  const [createRoutinePreCategories, setCreateRoutinePreCategories] = useState<string[]>([]);
  const [createRoutinePostCategories, setCreateRoutinePostCategories] = useState<string[]>([]);

  const [editState, setEditState] = useState<EditState>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDetails, setEditDetails] = useState("");
  const [editCategories, setEditCategories] = useState("");
  const [editRoutinePreCategories, setEditRoutinePreCategories] = useState<string[]>([]);
  const [editRoutinePostCategories, setEditRoutinePostCategories] = useState<string[]>([]);

  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const reload = useCallback(async () => {
    const [settings, storedTemplates, storedRoutines, storedDrafts] = await Promise.all([
      loadCoachSettings(),
      loadWorkoutTemplates(),
      loadAuxiliaryRoutines(),
      loadPlannerDrafts(),
    ]);
    setCategories(getCategoryOptions(settings));
    setTemplates(storedTemplates);
    setRoutines(storedRoutines);
    setDrafts(storedDrafts);
  }, []);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload])
  );

  const templatesByCategory = useMemo(() => {
    const categoryOrder = categories
      .map((c) => c.name.trim())
      .filter(Boolean)
      .sort(compareByTitle);
    const allTemplateCategories = new Set<string>();
    for (const t of templates) {
      const categories = t.categories.length > 0 ? t.categories : t.primaryCategory ? [t.primaryCategory] : [];
      for (const c of categories) {
        const cleaned = String(c ?? "").trim();
        if (cleaned) allTemplateCategories.add(cleaned);
      }
    }

    const extras = Array.from(allTemplateCategories)
      .filter((name) => !categoryOrder.includes(name))
      .sort(compareByTitle);
    const ordered = [...categoryOrder, ...extras];

    const rows = ordered
      .map((categoryName) => ({
        categoryName,
        templates: templates
          .filter((t) => {
            const templateCategories = t.categories.length > 0 ? t.categories : t.primaryCategory ? [t.primaryCategory] : [];
            return templateCategories.includes(categoryName);
          })
          .sort((a, b) => compareByTitle(a.title || "Workout", b.title || "Workout")),
      }))
      .filter((row) => row.templates.length > 0);

    return rows;
  }, [categories, templates]);

  const routinesSorted = useMemo(
    () => [...routines].sort((a, b) => compareByTitle(a.title || "Routine", b.title || "Routine")),
    [routines]
  );

  const draftsSorted = useMemo(() => {
    return [...drafts].sort((a, b) => {
      const byDate = String(a.dateISO ?? "").localeCompare(String(b.dateISO ?? ""));
      if (byDate !== 0) return byDate;
      const byTitle = compareByTitle(a.title || "Workout", b.title || "Workout");
      if (byTitle !== 0) return byTitle;
      return String(a.id ?? "").localeCompare(String(b.id ?? ""));
    });
  }, [drafts]);

  function openCreate(kind: "template" | "routine") {
    setCreateType(kind);
    setCreateTitle("");
    setCreateDetails("");
    setCreateCategories("");
    setCreateRoutinePreCategories([]);
    setCreateRoutinePostCategories([]);
    setTypePickerOpen(false);
    setCreateOpen(true);
  }

  async function saveCreate() {
    if (!createType) return;
    if (createType === "template") {
      await createWorkoutTemplate({
        title: createTitle.trim(),
        details: createDetails.trim(),
        categories: createCategories
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      });
    } else {
      const routineCategoryNames = Array.from(
        new Set([...createRoutinePreCategories, ...createRoutinePostCategories])
      );
      await createAuxiliaryRoutine({
        title: createTitle.trim(),
        details: createDetails.trim(),
        categoryNames: routineCategoryNames,
        preCategoryNames: createRoutinePreCategories,
        postCategoryNames: createRoutinePostCategories,
      });
    }
    setCreateOpen(false);
    await reload();
  }

  function openEditTemplate(item: WorkoutTemplate) {
    setEditState({ kind: "template", item });
    setEditTitle(item.title ?? "");
    setEditDetails(item.details ?? "");
    setEditCategories((item.categories.length > 0 ? item.categories : item.primaryCategory ? [item.primaryCategory] : []).join(", "));
    setEditOpen(true);
  }

  function openEditRoutine(item: AuxiliaryRoutine) {
    setEditState({ kind: "routine", item });
    setEditTitle(item.title ?? "");
    setEditDetails(item.details ?? "");
    const pre = Array.isArray(item.preCategoryNames) ? item.preCategoryNames : [];
    const post = Array.isArray(item.postCategoryNames) ? item.postCategoryNames : [];
    if (pre.length === 0 && post.length === 0) {
      const fallback = Array.isArray(item.categoryNames) ? item.categoryNames : [];
      setEditRoutinePreCategories(fallback);
      setEditRoutinePostCategories([]);
      setEditCategories(fallback.join(", "));
    } else {
      setEditRoutinePreCategories(pre);
      setEditRoutinePostCategories(post);
      setEditCategories(Array.from(new Set([...pre, ...post])).join(", "));
    }
    setEditOpen(true);
  }

  async function saveEdit() {
    if (!editState) return;
    if (editState.kind === "template") {
      await updateWorkoutTemplate(editState.item.id, {
        title: editTitle.trim(),
        details: editDetails.trim(),
        categories: editCategories
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      });
    } else {
      const routineCategoryNames = Array.from(
        new Set([...editRoutinePreCategories, ...editRoutinePostCategories])
      );
      await updateAuxiliaryRoutine(editState.item.id, {
        title: editTitle.trim(),
        details: editDetails.trim(),
        categoryNames: routineCategoryNames,
        preCategoryNames: editRoutinePreCategories,
        postCategoryNames: editRoutinePostCategories,
      });
    }
    setEditOpen(false);
    await reload();
  }

  async function confirmDeleteTemplate(item: WorkoutTemplate) {
    Alert.alert("Delete template?", `"${item.title}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteWorkoutTemplate(item.id);
          await reload();
        },
      },
    ]);
  }

  async function confirmDeleteRoutine(item: AuxiliaryRoutine) {
    Alert.alert("Delete routine?", `"${item.title}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteAuxiliaryRoutine(item.id);
          await reload();
        },
      },
    ]);
  }

  async function confirmDeleteDraft(item: PlannerDraft) {
    Alert.alert("Delete draft?", "This draft will be removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deletePlannerDraft(item.id);
          await reload();
        },
      },
    ]);
  }

  function promptRoutineCategorySide(
    categoryName: string,
    opts: {
      pre: string[];
      post: string[];
      setPre: React.Dispatch<React.SetStateAction<string[]>>;
      setPost: React.Dispatch<React.SetStateAction<string[]>>;
      setCategoriesText: React.Dispatch<React.SetStateAction<string>>;
    }
  ) {
    const currentlySelected = opts.pre.includes(categoryName) || opts.post.includes(categoryName);
    if (currentlySelected) {
      const next = removeCategoryFromSides(categoryName, opts.pre, opts.post);
      opts.setPre(next.pre);
      opts.setPost(next.post);
      opts.setCategoriesText(Array.from(new Set([...next.pre, ...next.post])).join(", "));
      return;
    }

    Alert.alert(`Assign ${categoryName}`, "Use this category for pre- or post-workout auto add?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Pre",
        onPress: () => {
          const nextPre = Array.from(new Set([...opts.pre, categoryName]));
          const nextPost = opts.post.filter((name) => name !== categoryName);
          opts.setPre(nextPre);
          opts.setPost(nextPost);
          opts.setCategoriesText(Array.from(new Set([...nextPre, ...nextPost])).join(", "));
        },
      },
      {
        text: "Post",
        onPress: () => {
          const nextPost = Array.from(new Set([...opts.post, categoryName]));
          const nextPre = opts.pre.filter((name) => name !== categoryName);
          opts.setPost(nextPost);
          opts.setPre(nextPre);
          opts.setCategoriesText(Array.from(new Set([...nextPre, ...nextPost])).join(", "));
        },
      },
    ]);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Saved</Text>
      <Text style={styles.subtitle}>Templates, auxiliary routines, and drafts.</Text>

      <ScrollView contentContainerStyle={{ paddingBottom: 110 }}>
        <View style={styles.block}>
          <Pressable style={styles.blockHeader} onPress={() => setTemplatesOpen((p) => !p)} hitSlop={10}>
            <Text style={styles.blockTitle}>Workout Templates</Text>
            <Text style={styles.blockChevron}>{templatesOpen ? "▾" : "▸"}</Text>
          </Pressable>
          {templatesOpen ? (
            <View style={{ marginTop: 8 }}>
              {templatesByCategory.map((group) => {
                const open = !!templateCategoriesOpen[group.categoryName];
                return (
                  <View key={`cat-${group.categoryName}`} style={styles.innerBlock}>
                    <Pressable
                      onPress={() =>
                        setTemplateCategoriesOpen((prev) => ({ ...prev, [group.categoryName]: !open }))
                      }
                      style={styles.innerHeader}
                    >
                      <Text style={styles.innerTitle}>{group.categoryName}</Text>
                      <Text style={styles.innerChevron}>{open ? "▾" : "▸"}</Text>
                    </Pressable>
                    {open ? (
                      <View style={{ marginTop: 6 }}>
                        {group.templates.map((item) => (
                          <Swipeable
                            key={`${group.categoryName}-${item.id}`}
                            overshootRight={false}
                            renderRightActions={() => (
                              <Pressable onPress={() => confirmDeleteTemplate(item)} style={styles.swipeDelete}>
                                <Text style={styles.swipeDeleteText}>Delete</Text>
                              </Pressable>
                            )}
                          >
                            <Pressable onPress={() => openEditTemplate(item)} style={styles.rowItem}>
                              <Text style={styles.rowTitle}>{item.title || "Workout"}</Text>
                            </Pressable>
                          </Swipeable>
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              })}
              {templatesByCategory.length === 0 ? <Text style={styles.emptyText}>No workout templates yet.</Text> : null}
            </View>
          ) : null}
        </View>

        <View style={styles.block}>
          <Pressable style={styles.blockHeader} onPress={() => setRoutinesOpen((p) => !p)} hitSlop={10}>
            <Text style={styles.blockTitle}>Auxiliary Routines</Text>
            <Text style={styles.blockChevron}>{routinesOpen ? "▾" : "▸"}</Text>
          </Pressable>
          {routinesOpen ? (
            <View style={{ marginTop: 8 }}>
              {routinesSorted.map((item) => (
                <Swipeable
                  key={item.id}
                  overshootRight={false}
                  renderRightActions={() => (
                    <Pressable onPress={() => confirmDeleteRoutine(item)} style={styles.swipeDelete}>
                      <Text style={styles.swipeDeleteText}>Delete</Text>
                    </Pressable>
                  )}
                >
                  <Pressable onPress={() => openEditRoutine(item)} style={styles.rowItem}>
                    <Text style={styles.rowTitle}>{item.title || "Routine"}</Text>
                  </Pressable>
                </Swipeable>
              ))}
              {routinesSorted.length === 0 ? <Text style={styles.emptyText}>No auxiliary routines yet.</Text> : null}
            </View>
          ) : null}
        </View>

        <View style={styles.block}>
          <Pressable style={styles.blockHeader} onPress={() => setDraftsOpen((p) => !p)} hitSlop={10}>
            <Text style={styles.blockTitle}>Drafts</Text>
            <Text style={styles.blockChevron}>{draftsOpen ? "▾" : "▸"}</Text>
          </Pressable>
          {draftsOpen ? (
            <View style={{ marginTop: 8 }}>
              {draftsSorted.map((item) => (
                <Swipeable
                  key={item.id}
                  overshootRight={false}
                  renderRightActions={() => (
                    <Pressable onPress={() => confirmDeleteDraft(item)} style={styles.swipeDelete}>
                      <Text style={styles.swipeDeleteText}>Delete</Text>
                    </Pressable>
                  )}
                >
                  <Pressable
                    onPress={() =>
                      router.push({
                        pathname: "/(coach)/(tabs)/planner",
                        params: {
                          draftId: item.id,
                          applyDraftToken: String(Date.now()),
                        },
                      })
                    }
                    style={styles.rowItem}
                  >
                    <Text style={styles.rowTitle}>
                      {formatDisplayDate(item.dateISO)} • {item.title || "Workout"}
                    </Text>
                  </Pressable>
                </Swipeable>
              ))}
              {draftsSorted.length === 0 ? <Text style={styles.emptyText}>No drafts yet.</Text> : null}
            </View>
          ) : null}
        </View>
      </ScrollView>

      <Pressable onPress={() => setTypePickerOpen(true)} style={styles.fabPlus}>
        <Text style={styles.fabPlusText}>+</Text>
      </Pressable>

      <Modal visible={typePickerOpen} transparent animationType="fade" onRequestClose={() => setTypePickerOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setTypePickerOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Create New</Text>
            <Pressable style={styles.modalAction} onPress={() => openCreate("routine")}>
              <Text style={styles.modalActionText}>Auxiliary Routine</Text>
            </Pressable>
            <Pressable style={styles.modalAction} onPress={() => openCreate("template")}>
              <Text style={styles.modalActionText}>Workout Template</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => setCreateOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setCreateOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>
              {createType === "template" ? "New Workout Template" : "New Auxiliary Routine"}
            </Text>
            <TextInput
              value={createTitle}
              onChangeText={setCreateTitle}
              placeholder={createType === "template" ? "Workout title" : "Routine title"}
              style={styles.input}
            />
            <TextInput
              value={createDetails}
              onChangeText={setCreateDetails}
              placeholder="Details"
              multiline
              style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
            />
            {(createType === "template" || createType === "routine") ? (
              <>
                <TextInput
                  value={createCategories}
                  onChangeText={setCreateCategories}
                  placeholder="Categories (comma-separated)"
                  style={styles.input}
                />
                {createType === "routine" ? (
                  <View style={[styles.input, { flexDirection: "row", flexWrap: "wrap", gap: 8 }]}>
                    {categories.map((category) => {
                      const preActive = createRoutinePreCategories.includes(category.name);
                      const postActive = createRoutinePostCategories.includes(category.name);
                      const active = preActive || postActive;
                      return (
                        <Pressable
                          key={`create-routine-cat-${category.id}`}
                          onPress={() =>
                            promptRoutineCategorySide(category.name, {
                              pre: createRoutinePreCategories,
                              post: createRoutinePostCategories,
                              setPre: setCreateRoutinePreCategories,
                              setPost: setCreateRoutinePostCategories,
                              setCategoriesText: setCreateCategories,
                            })
                          }
                          style={[
                            styles.categoryChip,
                            active && styles.categoryChipActive,
                            preActive ? styles.categoryChipPre : null,
                            postActive ? styles.categoryChipPost : null,
                          ]}
                        >
                          <Text style={[styles.categoryChipText, active && styles.categoryChipTextActive]}>
                            {category.name}
                            {preActive ? " (Pre)" : postActive ? " (Post)" : ""}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </>
            ) : null}
            <View style={styles.modalButtons}>
              <Pressable style={styles.secondaryBtn} onPress={() => setCreateOpen(false)}>
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.primaryBtn} onPress={saveCreate}>
                <Text style={styles.primaryBtnText}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={editOpen} transparent animationType="fade" onRequestClose={() => setEditOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setEditOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>
              {editState?.kind === "template" ? "Edit Workout Template" : "Edit Auxiliary Routine"}
            </Text>
            <TextInput value={editTitle} onChangeText={setEditTitle} placeholder="Title" style={styles.input} />
            <TextInput
              value={editDetails}
              onChangeText={setEditDetails}
              placeholder="Details"
              multiline
              style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
            />
            {(editState?.kind === "template" || editState?.kind === "routine") ? (
              <>
                <TextInput
                  value={editCategories}
                  onChangeText={setEditCategories}
                  placeholder="Categories (comma-separated)"
                  style={styles.input}
                />
                {editState?.kind === "routine" ? (
                  <View style={[styles.input, { flexDirection: "row", flexWrap: "wrap", gap: 8 }]}>
                    {categories.map((category) => {
                      const preActive = editRoutinePreCategories.includes(category.name);
                      const postActive = editRoutinePostCategories.includes(category.name);
                      const active = preActive || postActive;
                      return (
                        <Pressable
                          key={`edit-routine-cat-${category.id}`}
                          onPress={() =>
                            promptRoutineCategorySide(category.name, {
                              pre: editRoutinePreCategories,
                              post: editRoutinePostCategories,
                              setPre: setEditRoutinePreCategories,
                              setPost: setEditRoutinePostCategories,
                              setCategoriesText: setEditCategories,
                            })
                          }
                          style={[
                            styles.categoryChip,
                            active && styles.categoryChipActive,
                            preActive ? styles.categoryChipPre : null,
                            postActive ? styles.categoryChipPost : null,
                          ]}
                        >
                          <Text style={[styles.categoryChipText, active && styles.categoryChipTextActive]}>
                            {category.name}
                            {preActive ? " (Pre)" : postActive ? " (Post)" : ""}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </>
            ) : null}
            <View style={styles.modalButtons}>
              <Pressable style={styles.secondaryBtn} onPress={() => setEditOpen(false)}>
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.primaryBtn} onPress={saveEdit}>
                <Text style={styles.primaryBtnText}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", paddingHorizontal: 16, paddingTop: 14 },
  title: { fontSize: 22, fontWeight: "900", color: "#111" },
  subtitle: { marginTop: 4, color: "#666", fontWeight: "700", marginBottom: 8 },
  block: { marginTop: 10, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "#fafafa", padding: 10 },
  blockHeader: { minHeight: 38, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  blockTitle: { fontWeight: "900", color: "#111", fontSize: 16 },
  blockChevron: { fontWeight: "900", color: "#666", fontSize: 16 },
  innerBlock: { marginTop: 8, borderWidth: 1, borderColor: "#ececec", borderRadius: 10, backgroundColor: "#fff", padding: 8 },
  innerHeader: { minHeight: 34, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  innerTitle: { fontWeight: "800", color: "#222" },
  innerChevron: { fontWeight: "900", color: "#666" },
  rowItem: {
    borderWidth: 1,
    borderColor: "#eee",
    borderRadius: 10,
    backgroundColor: "#fff",
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 8,
  },
  rowTitle: { fontWeight: "800", color: "#111" },
  emptyText: { color: "#666", fontWeight: "700", marginTop: 4 },
  swipeDelete: {
    width: 96,
    marginBottom: 8,
    borderRadius: 10,
    backgroundColor: "#c62828",
    alignItems: "center",
    justifyContent: "center",
  },
  swipeDeleteText: { color: "#fff", fontWeight: "900" },
  fabPlus: {
    position: "absolute",
    right: 18,
    bottom: 18,
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111",
    borderWidth: 1,
    borderColor: "#111",
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  fabPlusText: { color: "#fff", fontSize: 30, fontWeight: "700", lineHeight: 34 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.28)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 18,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#fff",
    padding: 12,
  },
  modalTitle: { fontSize: 16, fontWeight: "900", color: "#111", marginBottom: 10 },
  modalAction: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "#fafafa",
    marginBottom: 8,
  },
  modalActionText: { fontWeight: "800", color: "#111" },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    backgroundColor: "#fff",
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 8,
    fontWeight: "700",
    color: "#111",
  },
  modalButtons: { marginTop: 2, flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  secondaryBtn: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#fff" },
  secondaryBtnText: { fontWeight: "800", color: "#111" },
  primaryBtn: { borderWidth: 1, borderColor: "#111", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#111" },
  primaryBtnText: { fontWeight: "900", color: "#fff" },
  categoryChip: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#fff",
  },
  categoryChipActive: {
    borderColor: "#111",
    backgroundColor: "#111",
  },
  categoryChipPre: {
    borderColor: "#0a84ff",
  },
  categoryChipPost: {
    borderColor: "#34a853",
  },
  categoryChipText: { fontWeight: "800", color: "#111" },
  categoryChipTextActive: { color: "#fff" },
});
