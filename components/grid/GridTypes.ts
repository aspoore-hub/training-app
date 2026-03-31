export type GridCellId = string;

export type GridBindHandlers = {
  onKeyDown?: (e: any) => void;
  onPaste?: (e: any) => void;
  onCopy?: (e: any) => void;
  onMouseDown?: (e: any) => void;
  onMouseEnter?: (e: any) => void;
  onFocus?: (e: any) => void;
  onBlur?: (e: any) => void;
};

export type GridCellBinding = {
  cellId: GridCellId;
  ref: (el: any) => void;
  handlers: GridBindHandlers;
};

export type GridEngineOptions<RowId extends string, ColKey extends string> = {
  enabled: boolean;
  rowIds: RowId[];
  colKeys: ColKey[];
  getValue: (rowId: RowId, colKey: ColKey) => string;
  setValue: (rowId: RowId, colKey: ColKey, value: string) => void;
  setValuesBatch?: (changes: Array<{ rowId: RowId; colKey: ColKey; value: string }>) => void;
  isEditorHandlingKeys?: () => boolean;
  onFillDown?: (rowId: RowId, colKey: ColKey) => void;
  onSelectionChange?: (selection: { rowIds: RowId[]; colKeys: ColKey[] }) => void;
  onActivate?: () => void;
};

export type GridCoord = {
  rowIndex: number;
  colIndex: number;
};

export type GridSelectionRect = {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
};
