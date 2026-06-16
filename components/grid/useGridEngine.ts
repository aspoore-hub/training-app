import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { parseTsv, toTsv } from "../../lib/grid/tsv";
import type { GridCellBinding, GridCoord, GridEngineOptions, GridSelectionRect } from "./GridTypes";

type GridChange<RowId extends string, ColKey extends string> = {
  rowId: RowId;
  colKey: ColKey;
  prev: string;
  next: string;
};

type EditStartMode = "replace" | "append" | "preserve";

type EditingCell<RowId extends string, ColKey extends string> = {
  rowId: RowId;
  colKey: ColKey;
  originalValue: string;
};

export function useGridEngine<RowId extends string, ColKey extends string>(
  options: GridEngineOptions<RowId, ColKey>
) {
  const {
    enabled,
    rowIds,
    colKeys,
    getValue,
    setValue,
    setValuesBatch,
    isEditorHandlingKeys,
    onFillDown,
    onSelectionChange,
    onActivate,
  } = options;
  const refs = useRef<Record<string, any>>({});
  const historyRef = useRef<Array<Array<GridChange<RowId, ColKey>>>>([]);
  const dragSelectingRef = useRef(false);
  const [clipboardText, setClipboardText] = useState("");
  const [active, setActive] = useState<GridCoord | null>(null);
  const [anchor, setAnchor] = useState<GridCoord | null>(null);
  const [selection, setSelection] = useState<GridSelectionRect | null>(null);
  const [editingCell, setEditingCell] = useState<EditingCell<RowId, ColKey> | null>(null);
  const editIntentRef = useRef<{
    rowId: RowId;
    colKey: ColKey;
    mode: EditStartMode;
    text?: string;
  } | null>(null);

  const clearEditState = useCallback(() => {
    setEditingCell(null);
    editIntentRef.current = null;
  }, []);

  const rowIndexById = useMemo(() => {
    const m = new Map<RowId, number>();
    rowIds.forEach((id, i) => m.set(id, i));
    return m;
  }, [rowIds]);

  const colIndexByKey = useMemo(() => {
    const m = new Map<ColKey, number>();
    colKeys.forEach((k, i) => m.set(k, i));
    return m;
  }, [colKeys]);

  const makeCellId = useCallback((rowId: RowId, colKey: ColKey) => `${rowId}:${String(colKey)}`, []);

  const makeRect = useCallback((from: GridCoord, to: GridCoord): GridSelectionRect => {
    return {
      r1: Math.min(from.rowIndex, to.rowIndex),
      c1: Math.min(from.colIndex, to.colIndex),
      r2: Math.max(from.rowIndex, to.rowIndex),
      c2: Math.max(from.colIndex, to.colIndex),
    };
  }, []);

  const clampCoord = useCallback(
    (rowIndex: number, colIndex: number): GridCoord => {
      const rMax = Math.max(0, rowIds.length - 1);
      const cMax = Math.max(0, colKeys.length - 1);
      return {
        rowIndex: Math.max(0, Math.min(rMax, rowIndex)),
        colIndex: Math.max(0, Math.min(cMax, colIndex)),
      };
    },
    [colKeys.length, rowIds.length]
  );

  const getSelectedCellCoords = useCallback((): GridCoord[] => {
    if (!selection) return active ? [active] : [];
    const out: GridCoord[] = [];
    for (let r = selection.r1; r <= selection.r2; r += 1) {
      for (let c = selection.c1; c <= selection.c2; c += 1) {
        out.push({ rowIndex: r, colIndex: c });
      }
    }
    return out;
  }, [active, selection]);

  const selectedColKeys = useMemo(() => {
    const colSet = new Set<ColKey>();
    const coords = getSelectedCellCoords();
    coords.forEach(({ colIndex }) => {
      if (colIndex >= 0 && colIndex < colKeys.length) colSet.add(colKeys[colIndex]);
    });
    return Array.from(colSet);
  }, [colKeys, getSelectedCellCoords]);

  const clearSelection = useCallback(() => {
    setSelection(null);
  }, []);

  const selectedRowIds = useMemo(() => {
    const rowSet = new Set<RowId>();
    const coords = getSelectedCellCoords();
    coords.forEach(({ rowIndex }) => {
      if (rowIndex >= 0 && rowIndex < rowIds.length) rowSet.add(rowIds[rowIndex]);
    });
    return Array.from(rowSet);
  }, [getSelectedCellCoords, rowIds]);

  const focusCellDeferred = useCallback(
    (rowId: RowId, colKey: ColKey, allowRetry = true) => {
      const rowIndex = rowIndexById.get(rowId) ?? 0;
      const colIndex = colIndexByKey.get(colKey) ?? 0;
      setActive({ rowIndex, colIndex });
      setTimeout(() => {
        requestAnimationFrame(() => {
          const ref = refs.current[makeCellId(rowId, colKey)];
          if (typeof ref?.focus === "function") {
            ref.focus();
            return;
          }
          if (allowRetry) {
            setTimeout(() => {
              const retryRef = refs.current[makeCellId(rowId, colKey)];
              if (typeof retryRef?.focus === "function") {
                requestAnimationFrame(() => retryRef.focus());
              }
            }, 0);
          }
        });
      }, 0);
    },
    [colIndexByKey, makeCellId, rowIndexById]
  );

  const focusCell = useCallback(
    (rowId: RowId, colKey: ColKey) => {
      focusCellDeferred(rowId, colKey);
    },
    [focusCellDeferred]
  );

  const moveFocus = useCallback(
    (rowIndex: number, colIndex: number) => {
      clearEditState();
      if (!rowIds.length || !colKeys.length) return;
      const r = Math.max(0, Math.min(rowIds.length - 1, rowIndex));
      const c = Math.max(0, Math.min(colKeys.length - 1, colIndex));
      setActive({ rowIndex: r, colIndex: c });
      setAnchor({ rowIndex: r, colIndex: c });
      setSelection(null);
      focusCell(rowIds[r], colKeys[c]);
    },
    [clearEditState, colKeys, focusCell, rowIds]
  );

  const applyChanges = useCallback(
    (changes: Array<GridChange<RowId, ColKey>>, pushHistory = true) => {
      const filtered = changes.filter((c) => c.prev !== c.next);
      if (filtered.length === 0) return;
      if (setValuesBatch && filtered.length > 1) {
        setValuesBatch(filtered.map((c) => ({ rowId: c.rowId, colKey: c.colKey, value: c.next })));
      } else {
        filtered.forEach((c) => setValue(c.rowId, c.colKey, c.next));
      }
      if (pushHistory) historyRef.current.push(filtered);
      if (historyRef.current.length > 60) {
        historyRef.current = historyRef.current.slice(historyRef.current.length - 60);
      }
    },
    [setValue, setValuesBatch]
  );

  const applyCellValue = useCallback(
    (rowId: RowId, colKey: ColKey, nextValue: string, pushHistory = true) => {
      const prev = getValue(rowId, colKey);
      applyChanges([{ rowId, colKey, prev, next: String(nextValue ?? "") }], pushHistory);
    },
    [applyChanges, getValue]
  );

  const moveActiveBy = useCallback(
    (dx: number, dy: number) => {
      clearEditState();
      if (!rowIds.length || !colKeys.length) return;
      const base = active ?? { rowIndex: 0, colIndex: 0 };
      const next = clampCoord(base.rowIndex + dy, base.colIndex + dx);
      setActive(next);
      setAnchor(next);
      setSelection(null);
      focusCell(rowIds[next.rowIndex], colKeys[next.colIndex]);
    },
    [active, clearEditState, clampCoord, colKeys, focusCell, rowIds]
  );

  const extendSelectionBy = useCallback(
    (dx: number, dy: number) => {
      clearEditState();
      if (!rowIds.length || !colKeys.length) return;
      const base = active ?? anchor ?? { rowIndex: 0, colIndex: 0 };
      const fixed = anchor ?? base;
      const edge = clampCoord(base.rowIndex + dy, base.colIndex + dx);
      setActive(edge);
      setSelection(makeRect(fixed, edge));
      if (!anchor) setAnchor(fixed);
      focusCell(rowIds[edge.rowIndex], colKeys[edge.colIndex]);
    },
    [active, anchor, clearEditState, clampCoord, colKeys, focusCell, makeRect, rowIds]
  );

  const clearSelectedCells = useCallback(() => {
    const coords = getSelectedCellCoords();
    const changes: Array<GridChange<RowId, ColKey>> = [];
    coords.forEach(({ rowIndex: r, colIndex: c }) => {
      if (r < 0 || r >= rowIds.length) return;
      if (c < 0 || c >= colKeys.length) return;
      const rowId = rowIds[r];
      const colKey = colKeys[c];
      changes.push({ rowId, colKey, prev: getValue(rowId, colKey), next: "" });
    });
    applyChanges(changes);
  }, [applyChanges, colKeys, getSelectedCellCoords, getValue, rowIds]);

  const selectionRect = useMemo(() => {
    if (selection) return selection;
    if (!active) return null;
    return { r1: active.rowIndex, c1: active.colIndex, r2: active.rowIndex, c2: active.colIndex };
  }, [active, selection]);

  const copySelectionToClipboard = useCallback(async () => {
    const rect = selectionRect;
    if (!rect) return "";
    const rows: string[][] = [];
    for (let r = rect.r1; r <= rect.r2; r += 1) {
      const vals: string[] = [];
      for (let c = rect.c1; c <= rect.c2; c += 1) {
        if (r < 0 || r >= rowIds.length || c < 0 || c >= colKeys.length) {
          vals.push("");
          continue;
        }
        vals.push(getValue(rowIds[r], colKeys[c]));
      }
      rows.push(vals);
    }
    const text = toTsv(rows);
    setClipboardText(text);
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {}
    }
    return text;
  }, [colKeys, getValue, rowIds, selectionRect]);

  const pasteTextAtSelection = useCallback(
    (rawText: string) => {
      const raw = String(rawText ?? "").trimEnd();
      if (!raw) return;
      const matrix = parseTsv(raw);
      const rect = selectionRect;
      const startRow = rect?.r1 ?? 0;
      const startCol = rect?.c1 ?? 0;
      const changes: Array<GridChange<RowId, ColKey>> = [];
      const isSingleValuePaste = matrix.length <= 1 && (matrix[0]?.length ?? 0) <= 1;

      if (isSingleValuePaste && rect) {
        const single = matrix[0]?.[0] ?? raw;
        for (let r = rect.r1; r <= rect.r2; r += 1) {
          for (let c = rect.c1; c <= rect.c2; c += 1) {
            if (r < 0 || r >= rowIds.length) continue;
            if (c < 0 || c >= colKeys.length) continue;
            const rowId = rowIds[r];
            const colKey = colKeys[c];
            changes.push({ rowId, colKey, prev: getValue(rowId, colKey), next: single });
          }
        }
      } else {
        matrix.forEach((row, rOffset) => {
          row.forEach((value, cOffset) => {
            const r = startRow + rOffset;
            const c = startCol + cOffset;
            if (r < 0 || r >= rowIds.length) return;
            if (c < 0 || c >= colKeys.length) return;
            const rowId = rowIds[r];
            const colKey = colKeys[c];
            changes.push({ rowId, colKey, prev: getValue(rowId, colKey), next: value });
          });
        });
      }
      if (!rect && isSingleValuePaste) {
        const r = startRow;
        const c = startCol;
        if (r >= 0 && r < rowIds.length && c >= 0 && c < colKeys.length) {
          const rowId = rowIds[r];
          const colKey = colKeys[c];
          changes.push({ rowId, colKey, prev: getValue(rowId, colKey), next: matrix[0]?.[0] ?? raw });
        }
      }

      applyChanges(changes);
      setClipboardText(raw);
    },
    [applyChanges, colKeys, getValue, rowIds, selectionRect]
  );

  const pasteFromClipboard = useCallback(async () => {
    let raw = "";
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      try {
        raw = String(await navigator.clipboard.readText());
      } catch {}
    }
    if (!raw) raw = clipboardText;
    if (!raw) return;
    pasteTextAtSelection(raw);
  }, [clipboardText, pasteTextAtSelection]);

  const isEditingCell = useCallback(
    (rowId: RowId, colKey: ColKey) =>
      editingCell?.rowId === rowId && editingCell?.colKey === colKey,
    [editingCell]
  );

  const consumeEditIntent = useCallback(
    (rowId: RowId, colKey: ColKey) => {
      const current = editIntentRef.current;
      if (!current) return;
      if (current.rowId === rowId && current.colKey === colKey) {
        editIntentRef.current = null;
      }
    },
    []
  );

  const beginEdit = useCallback(
    (rowId: RowId, colKey: ColKey, mode: EditStartMode = "preserve", text = "") => {
      const rowIndex = rowIndexById.get(rowId);
      const colIndex = colIndexByKey.get(colKey);
      if (rowIndex == null || colIndex == null) return;
      const originalValue = String(getValue(rowId, colKey) ?? "");
      setEditingCell({
        rowId,
        colKey,
        originalValue,
      });
      editIntentRef.current = { rowId, colKey, mode, text };
      setActive({ rowIndex, colIndex });
      setAnchor({ rowIndex, colIndex });
      setSelection(null);
      focusCellDeferred(rowId, colKey);
    },
    [colIndexByKey, focusCellDeferred, getValue, rowIndexById]
  );

  const stopEditing = useCallback((options?: { restoreFocus?: boolean }) => {
    if (!editingCell) {
      clearEditState();
      return;
    }
    const { rowId, colKey } = editingCell;
    clearEditState();
    if (options?.restoreFocus) {
      setTimeout(() => focusCell(rowId, colKey), 0);
    }
  }, [clearEditState, editingCell, focusCell]);

  const cancelEditing = useCallback(() => {
    if (!editingCell) {
      clearEditState();
      return;
    }
    const { rowId, colKey, originalValue } = editingCell;
    const current = String(getValue(rowId, colKey) ?? "");
    if (current !== originalValue) {
      applyChanges([{ rowId, colKey, prev: current, next: originalValue }], false);
    }
    clearEditState();
    setTimeout(() => focusCell(rowId, colKey), 0);
  }, [applyChanges, clearEditState, editingCell, focusCell, getValue]);

  const undo = useCallback(() => {
    const changes = historyRef.current.pop();
    if (!changes || changes.length === 0) return;
    if (setValuesBatch && changes.length > 1) {
      setValuesBatch(changes.map((c) => ({ rowId: c.rowId, colKey: c.colKey, value: c.prev })));
      return;
    }
    changes.forEach((c) => setValue(c.rowId, c.colKey, c.prev));
  }, [setValue, setValuesBatch]);

  const handleKeyDown = useCallback(
    (e: any) => {
      if (!(enabled && Platform.OS === "web")) return false;
      if (isEditorHandlingKeys?.()) return false;
      const key = String(e?.key ?? "");
      const shift = !!e?.shiftKey;
      const ctrlMeta = !!(e?.ctrlKey || e?.metaKey);
      const editorIsMultiline = !!(e as any)?.__gridEditorMultiline;
      const isPrintable = key.length === 1;
      const activeRowId = active ? rowIds[active.rowIndex] : rowIds[0] ?? null;
      const activeColKey = active ? colKeys[active.colIndex] : colKeys[0] ?? null;
      const exitEditAndMove = (dx: number, dy: number) => {
        stopEditing();
        setTimeout(() => {
          moveActiveBy(dx, dy);
        }, 0);
      };

      if (editingCell) {
        if (key === "Escape") {
          e.preventDefault?.();
          cancelEditing();
          return true;
        }

        if (key === "Tab") {
          e.preventDefault?.();
          exitEditAndMove(shift ? -1 : 1, 0);
          return true;
        }

        if (key === "Enter") {
          if (shift && editorIsMultiline) return false;
          e.preventDefault?.();
          exitEditAndMove(0, 1);
          return true;
        }

        if (key === "ArrowUp") {
          e.preventDefault?.();
          exitEditAndMove(0, -1);
          return true;
        }

        if (key === "ArrowDown") {
          e.preventDefault?.();
          exitEditAndMove(0, 1);
          return true;
        }

        if (key === "ArrowLeft" || key === "ArrowRight") {
          return false;
        }

        return false;
      }

      if (key === "Backspace" || key === "Delete") {
        if (!selection && !active) return false;
        e.preventDefault?.();
        clearSelectedCells();
        return true;
      }

      if (key === "F2" && activeRowId && activeColKey) {
        e.preventDefault?.();
        beginEdit(activeRowId, activeColKey, "preserve");
        return true;
      }

      if (key === " " && activeRowId && activeColKey && !ctrlMeta && !e?.altKey) {
        e.preventDefault?.();
        beginEdit(activeRowId, activeColKey, "append", " ");
        return true;
      }

      if (isPrintable && !ctrlMeta && !e?.altKey && !e?.metaKey && activeRowId && activeColKey) {
        e.preventDefault?.();
        beginEdit(activeRowId, activeColKey, "replace", key);
        return true;
      }

      if (key === "Tab") {
        e.preventDefault?.();
        if (shift) {
          moveActiveBy(-1, 0);
        } else {
          moveActiveBy(1, 0);
        }
        return true;
      }

      if (key === "Enter") {
        e.preventDefault?.();
        moveActiveBy(0, 1);
        return true;
      }

      if (key === "ArrowUp") {
        e.preventDefault?.();
        if (shift) extendSelectionBy(0, -1);
        else moveActiveBy(0, -1);
        return true;
      }

      if (key === "ArrowDown") {
        e.preventDefault?.();
        if (shift) extendSelectionBy(0, 1);
        else moveActiveBy(0, 1);
        return true;
      }

      if (key === "ArrowLeft") {
        e.preventDefault?.();
        if (shift) extendSelectionBy(-1, 0);
        else moveActiveBy(-1, 0);
        return true;
      }

      if (key === "ArrowRight") {
        e.preventDefault?.();
        if (shift) extendSelectionBy(1, 0);
        else moveActiveBy(1, 0);
        return true;
      }

      if (ctrlMeta && key.toLowerCase() === "d") {
        if (!active) return false;
        e.preventDefault?.();
        const rowId = rowIds[active.rowIndex];
        const colKey = colKeys[active.colIndex];
        if (!rowId || !colKey) return false;
        if (onFillDown) {
          onFillDown(rowId, colKey);
        } else {
          const rect = selectionRect;
          const changes: Array<GridChange<RowId, ColKey>> = [];
          if (rect && rect.r2 > rect.r1) {
            for (let r = rect.r1 + 1; r <= rect.r2; r += 1) {
              for (let c = rect.c1; c <= rect.c2; c += 1) {
                if (r < 0 || r >= rowIds.length) continue;
                if (c < 0 || c >= colKeys.length) continue;
                const targetRowId = rowIds[r];
                const targetColKey = colKeys[c];
                const sourceRowId = rowIds[rect.r1];
                const sourceColKey = colKeys[c];
                changes.push({
                  rowId: targetRowId,
                  colKey: targetColKey,
                  prev: getValue(targetRowId, targetColKey),
                  next: getValue(sourceRowId, sourceColKey),
                });
              }
            }
          } else {
            const value = getValue(rowId, colKey);
            for (let i = active.rowIndex + 1; i < rowIds.length; i += 1) {
              changes.push({
                rowId: rowIds[i],
                colKey,
                prev: getValue(rowIds[i], colKey),
                next: value,
              });
            }
          }
          applyChanges(changes);
        }
        return true;
      }

      if (ctrlMeta && key.toLowerCase() === "c") {
        e.preventDefault?.();
        void copySelectionToClipboard();
        return true;
      }

      if (ctrlMeta && key.toLowerCase() === "v") {
        e.preventDefault?.();
        void pasteFromClipboard();
        return true;
      }

      if (ctrlMeta && key.toLowerCase() === "z") {
        e.preventDefault?.();
        undo();
        return true;
      }

      return false;
    },
    [
      active,
      beginEdit,
      cancelEditing,
      clearSelectedCells,
      colKeys,
      copySelectionToClipboard,
      enabled,
      extendSelectionBy,
      isEditorHandlingKeys,
      editingCell,
      moveActiveBy,
      onFillDown,
      applyChanges,
      pasteFromClipboard,
      rowIds,
      selectionRect,
      selection,
      setValue,
      stopEditing,
      undo,
    ]
  );

  const bindingVersion = useMemo(
    () =>
      [
        enabled ? "1" : "0",
        active ? `${active.rowIndex}:${active.colIndex}` : "",
        anchor ? `${anchor.rowIndex}:${anchor.colIndex}` : "",
        selection ? `${selection.r1}:${selection.c1}:${selection.r2}:${selection.c2}` : "",
        editingCell ? `${editingCell.rowId}:${String(editingCell.colKey)}` : "",
        clipboardText,
      ].join("|"),
    [
      active,
      anchor,
      clipboardText,
      copySelectionToClipboard,
      editingCell,
      enabled,
      getValue,
      handleKeyDown,
      onActivate,
      pasteTextAtSelection,
      selection,
    ]
  );

  const bindCell = useCallback(
    (rowId: RowId, colKey: ColKey): GridCellBinding => {
      const cellId = makeCellId(rowId, colKey);
      const rowIndex = rowIndexById.get(rowId) ?? -1;
      const colIndex = colIndexByKey.get(colKey) ?? -1;

      const onKeyDown = (e: any) => {
        if (!(enabled && Platform.OS === "web")) return;
        const key = String(e?.key ?? "");
        const ctrlMeta = !!(e?.ctrlKey || e?.metaKey);
        const handled = handleKeyDown(e);
        if (handled) return;

        if (ctrlMeta && key.toLowerCase() === "c") {
          const value = getValue(rowId, colKey);
          setClipboardText(value);
          if (e?.clipboardData?.setData) {
            e.clipboardData.setData("text/plain", value);
            e.preventDefault?.();
          }
          return;
        }
      };

      const onPaste = (e: any) => {
        if (!(enabled && Platform.OS === "web")) return;
        if (isEditingCell(rowId, colKey)) return;
        const raw = String(e?.clipboardData?.getData?.("text/plain") ?? "").trimEnd() || String(clipboardText ?? "");
        if (!raw) return;
        e.preventDefault?.();
        pasteTextAtSelection(raw);
      };

      const onCopy = (e: any) => {
        if (!(enabled && Platform.OS === "web")) return;
        if (isEditingCell(rowId, colKey)) return;
        e.preventDefault?.();
        void copySelectionToClipboard();
      };

      const onMouseDown = (e: any) => {
        if (!(enabled && Platform.OS === "web")) return;
        const coord = { rowIndex, colIndex };
        if (isEditingCell(rowId, colKey)) {
          return;
        }
        clearEditState();
        onActivate?.();
        if (e?.detail >= 2) {
          beginEdit(rowId, colKey, "preserve");
          return;
        }
        if (e?.shiftKey && anchor) {
          setSelection(makeRect(anchor, coord));
          setActive(coord);
          dragSelectingRef.current = true;
          return;
        }
        dragSelectingRef.current = true;
        setAnchor(coord);
        setActive(coord);
        setSelection(null);
      };

      const onMouseEnter = (e: any) => {
        if (!(enabled && Platform.OS === "web")) return;
        if (!dragSelectingRef.current) return;
        if (isEditingCell(rowId, colKey)) return;
        if (e?.buttons === 0) {
          dragSelectingRef.current = false;
          return;
        }
        const coord = { rowIndex, colIndex };
        const fixed = anchor ?? active ?? coord;
        setActive(coord);
        setSelection(makeRect(fixed, coord));
      };

      const onFocus = () => {
        if (!(enabled && Platform.OS === "web")) return;
        const coord = { rowIndex, colIndex };
        onActivate?.();
        if (!isEditingCell(rowId, colKey)) {
          clearEditState();
        }
        setActive(coord);
        if (!anchor) setAnchor(coord);
      };

      const onBlur = () => {
        if (!(enabled && Platform.OS === "web")) return;
        if (!isEditingCell(rowId, colKey)) return;
        // Blur should always end edit mode so stale "editing" state does not persist.
        stopEditing();
      };

      return {
        cellId,
        version: bindingVersion,
        ref: (el: any) => {
          refs.current[cellId] = el;
        },
        handlers: { onKeyDown, onPaste, onCopy, onMouseDown, onMouseEnter, onFocus, onBlur },
      };
    },
    [
      anchor,
      clipboardText,
      clearEditState,
      beginEdit,
      colIndexByKey,
      copySelectionToClipboard,
      enabled,
      getValue,
      isEditingCell,
      handleKeyDown,
      makeCellId,
      makeRect,
      onActivate,
      pasteTextAtSelection,
      rowIndexById,
      selection,
      stopEditing,
      active,
      bindingVersion,
    ]
  );

  const isCellSelected = useCallback(
    (rowId: RowId, colKey: ColKey) => {
      const rowIndex = rowIndexById.get(rowId);
      const colIndex = colIndexByKey.get(colKey);
      if (rowIndex == null || colIndex == null) return false;
      if (selection) {
        return (
          rowIndex >= selection.r1 &&
          rowIndex <= selection.r2 &&
          colIndex >= selection.c1 &&
          colIndex <= selection.c2
        );
      }
      return active?.rowIndex === rowIndex && active?.colIndex === colIndex;
    },
    [active, colIndexByKey, rowIndexById, selection]
  );

  const isCellActive = useCallback(
    (rowId: RowId, colKey: ColKey) => {
      const rowIndex = rowIndexById.get(rowId);
      const colIndex = colIndexByKey.get(colKey);
      if (rowIndex == null || colIndex == null) return false;
      return active?.rowIndex === rowIndex && active?.colIndex === colIndex;
    },
    [active, colIndexByKey, rowIndexById]
  );

  const selectRow = useCallback(
    (rowId: RowId, shift = false) => {
      clearEditState();
      const rowIndex = rowIndexById.get(rowId);
      if (rowIndex == null) return;
      if (colKeys.length === 0) return;
      const startRow = shift && anchor ? anchor.rowIndex : rowIndex;
      const fixed = { rowIndex: startRow, colIndex: 0 };
      const edge = { rowIndex, colIndex: colKeys.length - 1 };
      const rect = makeRect(fixed, edge);
      setSelection(rect);
      setActive({ rowIndex, colIndex: 0 });
      if (!shift || !anchor) setAnchor({ rowIndex, colIndex: 0 });
    },
    [anchor, clearEditState, colKeys.length, makeRect, rowIndexById]
  );

  const isRowSelected = useCallback(
    (rowId: RowId) => {
      const rowIndex = rowIndexById.get(rowId);
      if (rowIndex == null) return false;
      if (!selection) return false;
      return rowIndex >= selection.r1 && rowIndex <= selection.r2;
    },
    [rowIndexById, selection]
  );

  useEffect(() => {
    if (!(enabled && Platform.OS === "web")) return;
    const onMouseUp = () => {
      dragSelectingRef.current = false;
    };
    window.addEventListener("mouseup", onMouseUp, { capture: true });
    return () => {
      window.removeEventListener("mouseup", onMouseUp, true);
    };
  }, [enabled]);

  useEffect(() => {
    onSelectionChange?.({ rowIds: selectedRowIds, colKeys: selectedColKeys });
  }, [onSelectionChange, selectedColKeys, selectedRowIds]);

  return {
    bindCell,
    copySelectionToClipboard,
    clearSelection,
    cancelEditing,
    extendSelectionBy,
    editIntentRef,
    editingCell,
    consumeEditIntent,
    beginEdit,
    focusCell,
    getSelectionRect: () => selectionRect,
    getSelectedColKeys: () => selectedColKeys,
    handleKeyDown,
    isEditingCell,
    isCellActive,
    isCellSelected,
    isRowSelected,
    stopEditing,
    makeCellId,
    moveActiveBy,
    pasteFromClipboard,
    pasteTextAtSelection,
    selectedRowIds,
    selectRow,
    setActiveCell: (rowId: RowId, colKey: ColKey) => focusCell(rowId, colKey),
    undo,
    applyCellValue,
    applyChanges,
  };
}
