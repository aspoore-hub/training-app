import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { GridCellBinding } from "./GridTypes";

const DEBUG_CATEGORY_SELECT = false;
function debugCategorySelect(...args: unknown[]) {
  if (DEBUG_CATEGORY_SELECT) console.log(...args);
}

function optionMatches(option: string, query: string) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const o = String(option ?? "").toLowerCase();
  return o.startsWith(q) || o.includes(q);
}

function isDisallowedOther(value: string) {
  return String(value ?? "").trim().toLowerCase() === "other";
}

export function CategorySelectCellEditor({
  value,
  options,
  onChange,
  binding,
  onActivate,
  onOpenChange,
}: {
  value: string[];
  options: string[];
  onChange: (next: string[]) => void;
  binding?: GridCellBinding;
  onActivate?: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const lastAppliedValueRef = useRef<string>("");
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput | HTMLInputElement | null>(null);

  const normalizedOptions = useMemo(
    () =>
      (Array.isArray(options) ? options : [])
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
        .filter((v) => !isDisallowedOther(v))
        .filter((v, idx, arr) => arr.indexOf(v) === idx),
    [options]
  );

  const filteredOptions = useMemo(
    () => normalizedOptions.filter((opt) => optionMatches(opt, query)),
    [normalizedOptions, query]
  );

  const selectedValues = useMemo(
    () =>
      (Array.isArray(value) ? value : [])
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
        .filter((v) => !isDisallowedOther(v))
        .filter((v, idx, arr) => arr.indexOf(v) === idx),
    [value]
  );
  useEffect(() => {
    const incoming = JSON.stringify(selectedValues);
    if (!open && lastAppliedValueRef.current !== incoming) {
      setSelectedCategories(selectedValues);
      lastAppliedValueRef.current = incoming;
    }
  }, [open, selectedValues]);

  useEffect(() => {
    if (!open) return;
    setHighlightIndex(0);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    if (filteredOptions.length === 0) {
      if (highlightIndex !== 0) setHighlightIndex(0);
      return;
    }
    if (highlightIndex < 0 || highlightIndex >= filteredOptions.length) {
      setHighlightIndex(0);
    }
  }, [filteredOptions, highlightIndex, open]);

  useEffect(() => {
    debugCategorySelect("[CategorySelectCellEditor] loaded options", normalizedOptions);
  }, [normalizedOptions]);

  useEffect(() => {
    debugCategorySelect("[CategorySelectCellEditor] filtered options", filteredOptions);
  }, [filteredOptions]);

  const close = () => {
    setOpen(false);
    setQuery("");
    onOpenChange?.(false);
  };

  const commitOption = (rawOption: string) => {
    const option = String(rawOption ?? "").trim();
    if (!option || isDisallowedOther(option)) return false;
    const next = selectedCategories.includes(option)
      ? selectedCategories
      : [...selectedCategories, option];
    setSelectedCategories(next);
    lastAppliedValueRef.current = JSON.stringify(next);
    onChange(next);
    debugCategorySelect("[CategorySelectCellEditor] selected after commit", next);
    setQuery("");
    setHighlightIndex(0);
    return true;
  };

  const commitHighlightedOption = () => {
    const option = filteredOptions[highlightIndex];
    if (!option) return false;
    return commitOption(option);
  };

  const clearValue = () => {
    setSelectedCategories([]);
    lastAppliedValueRef.current = JSON.stringify([]);
    onChange([]);
    debugCategorySelect("[CategorySelectCellEditor] selected after clear", []);
    setQuery("");
    setOpen(false);
    onOpenChange?.(false);
  };

  const removeCategory = (name: string) => {
    const target = String(name ?? "").trim();
    if (!target) return;
    const updated = selectedCategories.filter((v) => v !== target);
    setSelectedCategories(updated);
    lastAppliedValueRef.current = JSON.stringify(updated);
    onChange(updated);
    debugCategorySelect("[CategorySelectCellEditor] selected after remove", updated);
  };

  const removeLast = () => {
    if (selectedCategories.length === 0) return;
    const updated = selectedCategories.slice(0, -1);
    setSelectedCategories(updated);
    lastAppliedValueRef.current = JSON.stringify(updated);
    onChange(updated);
    debugCategorySelect("[CategorySelectCellEditor] selected after remove-last", updated);
  };

  return (
    <View style={{ minHeight: 26, justifyContent: "center", position: "relative" }}>
      <Pressable
        onPressIn={(e: any) => {
          onActivate?.();
          binding?.handlers?.onMouseDown?.(e);
          if (blurTimerRef.current) {
            clearTimeout(blurTimerRef.current);
            blurTimerRef.current = null;
          }
          setOpen(true);
          onOpenChange?.(true);
          setTimeout(() => inputRef.current?.focus?.(), 0);
        }}
        style={{ minHeight: 24, justifyContent: "center", paddingVertical: 2, paddingRight: 20 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
          {selectedCategories.length === 0 ? (
            <Text numberOfLines={1} ellipsizeMode="tail" style={{ fontSize: 12, fontWeight: "700", color: "#94a3b8", flexShrink: 1 }}>
              Category
            </Text>
          ) : (
            <>
              {selectedCategories.map((label) => (
                <View
                  key={`cell-cat-${label}`}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    borderWidth: 1,
                    borderColor: "#d1d9e6",
                    borderRadius: 999,
                    paddingHorizontal: 6,
                    paddingVertical: 1,
                    backgroundColor: "#f8fafc",
                    maxWidth: 160,
                  }}
                >
                  <Text numberOfLines={1} style={{ fontSize: 10, fontWeight: "800", color: "#334155", maxWidth: 122 }}>
                    {label}
                  </Text>
                  <Pressable onPress={() => removeCategory(label)} hitSlop={6} style={{ marginLeft: 4 }}>
                    <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>x</Text>
                  </Pressable>
                </View>
              ))}
            </>
          )}
        </View>
      </Pressable>

      <Pressable
        onPress={() => {
          onActivate?.();
          setOpen(true);
          onOpenChange?.(true);
          setTimeout(() => inputRef.current?.focus?.(), 0);
        }}
        style={{
          position: "absolute",
          right: 0,
          top: 2,
          width: 18,
          height: 18,
          borderRadius: 9,
          borderWidth: 1,
          borderColor: "#cbd5e1",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#fff",
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", color: "#334155" }}>+</Text>
      </Pressable>

      {open ? (
        <View
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 2,
            borderWidth: 1,
            borderColor: "#d1d9e6",
            borderRadius: 8,
            backgroundColor: "#fff",
            zIndex: 60,
            maxHeight: 210,
            shadowColor: "#000",
            shadowOpacity: 0.08,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
            elevation: 4,
          }}
        >
          <View style={{ paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" }}>
            {Platform.OS === "web" ? (
              <input
                ref={(el) => {
                  inputRef.current = el as any;
                  binding?.ref(el as any);
                }}
                value={query}
                onChange={(e: any) => setQuery(String(e?.target?.value ?? ""))}
                onFocus={(e: any) => {
                  onActivate?.();
                  binding?.handlers?.onFocus?.(e);
                }}
                onBlur={() => {
                  blurTimerRef.current = setTimeout(() => close(), 120);
                }}
                onKeyDown={(e: any) => {
                  onActivate?.();
                  const key = String(e?.key ?? "");
                  const ctrlMeta = !!(e?.ctrlKey || e?.metaKey);

                  if (ctrlMeta) {
                    binding?.handlers?.onKeyDown?.(e);
                    return;
                  }

                  if (key === "ArrowDown") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (filteredOptions.length > 0) {
                      setHighlightIndex((prev) => (prev + 1) % filteredOptions.length);
                    }
                    return;
                  }

                  if (key === "ArrowUp") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (filteredOptions.length > 0) {
                      setHighlightIndex((prev) => (prev - 1 + filteredOptions.length) % filteredOptions.length);
                    }
                    return;
                  }

                  if (key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    const didCommit = commitHighlightedOption();
                    debugCategorySelect("CATEGORY ENTER", {
                      highlightedIndex: highlightIndex,
                      filteredOptions,
                      didCommit,
                    });
                    return;
                  }

                  if (key === "Tab") {
                    e.preventDefault();
                    e.stopPropagation();
                    const didCommit = commitHighlightedOption();
                    close();
                    if (didCommit) {
                      binding?.handlers?.onKeyDown?.({
                        ...e,
                        key: "Tab",
                        preventDefault: () => {},
                      });
                    }
                    return;
                  }

                  if (key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    close();
                    return;
                  }

                  if ((key === "Backspace" || key === "Delete") && !query && selectedCategories.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    removeLast();
                    return;
                  }
                }}
                onPaste={binding?.handlers?.onPaste as any}
                onCopy={binding?.handlers?.onCopy as any}
                placeholder="Type to search..."
                style={{
                  width: "100%",
                  border: "none",
                  outline: "none",
                  fontSize: "12px",
                  fontWeight: 700,
                  color: "#334155",
                  background: "transparent",
                }}
              />
            ) : (
              <TextInput
                ref={(el) => {
                  inputRef.current = el;
                  binding?.ref(el);
                }}
                value={query}
                onChangeText={setQuery}
                onFocus={(e: any) => {
                  onActivate?.();
                  binding?.handlers?.onFocus?.(e);
                }}
                onBlur={() => {
                  blurTimerRef.current = setTimeout(() => close(), 120);
                }}
                placeholder="Type to search..."
                placeholderTextColor="#94a3b8"
                style={{ fontSize: 12, fontWeight: "700", color: "#334155", paddingVertical: 2 }}
              />
            )}
            <Text style={{ fontSize: 10, fontWeight: "800", color: "#64748b", marginTop: 2 }}>
              Loaded categories: {normalizedOptions.length}
            </Text>
            <Text style={{ fontSize: 10, fontWeight: "800", color: "#64748b", marginTop: 2 }}>
              Highlighted: {filteredOptions[highlightIndex] || "NONE"} | Count: {filteredOptions.length}
            </Text>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled">
            {filteredOptions.length === 0 ? (
              <Text style={{ paddingHorizontal: 8, paddingVertical: 7, fontSize: 11, fontWeight: "700", color: "#94a3b8" }}>
                No matches
              </Text>
            ) : (
              filteredOptions.map((opt, idx) => {
                const highlighted = idx === highlightIndex;
                const selected = selectedCategories.includes(opt);
                return (
                  <Pressable
                    key={`cat-opt-${opt}`}
                    {...(Platform.OS === "web"
                      ? ({
                          onMouseDown: (e: any) => e?.preventDefault?.(),
                        } as any)
                      : null)}
                    onPress={() => {
                      setHighlightIndex(idx);
                      commitOption(opt);
                    }}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 7,
                      backgroundColor: highlighted ? "#eff6ff" : "#fff",
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: "800", color: highlighted ? "#1d4ed8" : "#334155" }}>
                      {opt}
                    </Text>
                    {selected ? <Text style={{ fontSize: 11, fontWeight: "900", color: "#1d4ed8" }}>Selected</Text> : null}
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
