import { Platform, TextInput } from "react-native";
import type { GridCellBinding } from "../GridTypes";

type Props = {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  style?: any;
  numberOfLines?: number;
  inputRef?: any;
  binding?: GridCellBinding;
  webProps?: any;
  editable?: boolean;
};

export function TextCellEditor({
  value,
  onChangeText,
  placeholder,
  style,
  numberOfLines = 1,
  inputRef,
  binding,
  webProps,
  editable = true,
}: Props) {
  const singleLineEditor = numberOfLines <= 1;
  const webInputHandlers =
    Platform.OS === "web"
      ? {
          ...(webProps ?? {}),
          onKeyDown: (e: any) => {
            const key = String(e?.key ?? e?.nativeEvent?.key ?? "");
            const shift = !!(e?.shiftKey ?? e?.nativeEvent?.shiftKey);
            if (key === "Enter") {
              if (shift && !singleLineEditor) return;
              e?.preventDefault?.();
              (e as any).__gridEditorMultiline = !singleLineEditor;
              if (binding?.handlers?.onKeyDown) binding.handlers.onKeyDown(e);
              else webProps?.onKeyDown?.(e);
              return;
            }
            if (key === "Tab" || key === "Escape") {
              e?.preventDefault?.();
              if (binding?.handlers?.onKeyDown) binding.handlers.onKeyDown(e);
              else webProps?.onKeyDown?.(e);
              return;
            }
            webProps?.onKeyDown?.(e);
          },
          onFocus: (e: any) => {
            webProps?.onFocus?.(e);
            binding?.handlers?.onFocus?.(e);
          },
          onBlur: (e: any) => {
            webProps?.onBlur?.(e);
            binding?.handlers?.onBlur?.(e);
          },
        }
      : null;

  return (
    <TextInput
      ref={(el) => {
        if (typeof inputRef === "function") inputRef(el);
        else if (inputRef && typeof inputRef === "object") inputRef.current = el;
        binding?.ref?.(el);
      }}
      value={value}
      onChangeText={onChangeText}
      style={style}
      placeholder={placeholder}
      placeholderTextColor="#94a3b8"
      numberOfLines={numberOfLines}
      editable={editable}
      multiline={!singleLineEditor}
      blurOnSubmit={singleLineEditor}
      {...(Platform.OS === "web" ? (webInputHandlers as any) : null)}
    />
  );
}
