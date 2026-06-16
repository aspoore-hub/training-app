import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { memo, useEffect, useRef } from "react";
import type { GridCellBinding } from "./GridTypes";

type GridCellProps = {
  binding?: GridCellBinding;
  value?: string;
  onChangeText?: (v: string) => void;
  placeholder?: string;
  style?: any;
  numberOfLines?: number;
  editable?: boolean;
  gridEditing?: boolean;
  editIntent?: { mode: "replace" | "append" | "preserve"; text?: string } | null;
  onEnterEditMode?: () => void;
  consumeEditIntent?: () => void;
  [key: string]: any;
};

function shallowEqualObject(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

function sameEditIntent(
  a?: GridCellProps["editIntent"],
  b?: GridCellProps["editIntent"]
): boolean {
  if (a === b) return true;
  return a?.mode === b?.mode && String(a?.text ?? "") === String(b?.text ?? "");
}

function areGridCellPropsEqual(prev: GridCellProps, next: GridCellProps): boolean {
  const { binding: prevBinding, style: prevStyle, editIntent: prevEditIntent, ...prevRest } = prev;
  const { binding: nextBinding, style: nextStyle, editIntent: nextEditIntent, ...nextRest } = next;
  return (
    String(prevBinding?.cellId ?? "") === String(nextBinding?.cellId ?? "") &&
    String(prevBinding?.version ?? "") === String(nextBinding?.version ?? "") &&
    shallowEqualObject(prevStyle, nextStyle) &&
    sameEditIntent(prevEditIntent, nextEditIntent) &&
    shallowEqualObject(prevRest, nextRest)
  );
}

function GridCellComponent({
  binding,
  value,
  onChangeText,
  placeholder,
  style,
  numberOfLines = 1,
  editable = true,
  gridEditing,
  editIntent,
  onEnterEditMode,
  consumeEditIntent,
  ...rest
}: GridCellProps) {
  const inputRef = useRef<any>(null);
  const appliedEditIntentRef = useRef<string>("");
  const isWeb = (Platform as any).OS === "web";

  useEffect(() => {
    if (!gridEditing) {
      appliedEditIntentRef.current = "";
      return;
    }
    const ref = inputRef.current;
    if (!ref) return;
    if (!editIntent?.mode) return;

    const cellId = String(binding?.cellId ?? "");
    const signature = `${cellId}|${editIntent.mode}|${String(editIntent.text ?? "")}|${gridEditing ? "1" : "0"}`;
    if (appliedEditIntentRef.current === signature) return;

    const currentValue = String(value ?? "");

    let nextValue = currentValue;
    if (editIntent.mode === "replace") {
      nextValue = String(editIntent.text ?? "");
      onChangeText?.(nextValue);
    } else if (editIntent.mode === "append") {
      nextValue = `${currentValue}${String(editIntent.text ?? "")}`;
      onChangeText?.(nextValue);
    }

    consumeEditIntent?.();
    appliedEditIntentRef.current = signature;

    const node = ref as any;
    const nextPos = nextValue.length;

    requestAnimationFrame(() => {
      if (typeof node?.focus === "function") {
        node.focus();
      }
      if (typeof node?.setSelectionRange === "function") {
        try {
          node.setSelectionRange(nextPos, nextPos);
        } catch {}
      }
    });
  }, [binding?.cellId, consumeEditIntent, editIntent, gridEditing, onChangeText, value]);

  const displayValue = String(value ?? "");
  const resolvedStyle = style ?? {};
  const singleLineEditor = numberOfLines <= 1;
  const webInputHandlers = isWeb
    ? {
        onKeyDown: (e: any) => {
          const key = String(e?.key ?? e?.nativeEvent?.key ?? "");
          const shift = !!(e?.shiftKey ?? e?.nativeEvent?.shiftKey);
          if (key === "Enter") {
            if (shift && !singleLineEditor) return;
            e?.preventDefault?.();
            (e as any).__gridEditorMultiline = !singleLineEditor;
            (binding?.handlers as any)?.onKeyDown?.(e);
            return;
          }
          if (key === "Tab" || key === "Escape") {
            e?.preventDefault?.();
            (binding?.handlers as any)?.onKeyDown?.(e);
          }
        },
        onFocus: (binding?.handlers as any)?.onFocus,
        onBlur: (binding?.handlers as any)?.onBlur,
      }
    : null;
  if (!gridEditing) {
    return (
      <Pressable
        ref={(el) => {
          inputRef.current = el;
          if (typeof binding?.ref === "function") {
            binding.ref(el);
          }
        }}
        {...(isWeb
          ? {
              tabIndex: 0,
            }
          : null)}
        {...(binding?.handlers as any)}
        onPress={() => {
          if (!isWeb && editable) {
            onEnterEditMode?.();
          }
        }}
        style={{ width: "100%" }}
      >
        <View style={[{ minWidth: 0 }, style]}>
          {displayValue ? (
            <Text
              numberOfLines={Math.max(1, numberOfLines)}
              style={{ color: resolvedStyle?.color || "#334155", ...(style ?? {}) }}
            >
              {displayValue}
            </Text>
          ) : placeholder ? (
            <Text
              numberOfLines={Math.max(1, numberOfLines)}
              style={{ color: "#94a3b8", ...(style ?? {}) }}
            >
              {placeholder}
            </Text>
          ) : null}
        </View>
      </Pressable>
    );
  }

  return (
    <TextInput
      ref={(el) => {
        inputRef.current = el;
        if (typeof binding?.ref === "function") {
          binding.ref(el);
        }
      }}
      value={displayValue}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="#94a3b8"
      style={style}
      editable={editable}
      selectTextOnFocus={false}
      multiline={!singleLineEditor}
      numberOfLines={numberOfLines}
      blurOnSubmit={singleLineEditor}
      onKeyPress={(e: any) => {
        if (!isWeb) return;
        const key = String(e?.nativeEvent?.key ?? "");
        if (key !== "Enter") return;
        if (!singleLineEditor && (e?.nativeEvent?.shiftKey || e?.shiftKey)) return;
        // Spreadsheet cells are strict single-line inputs on web.
        e?.preventDefault?.();
      }}
      {...rest}
      {...(Platform.OS === "web" ? (webInputHandlers as any) : null)}
    />
  );
}

export const GridCell = memo(GridCellComponent, areGridCellPropsEqual);
