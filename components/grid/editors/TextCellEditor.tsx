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
}: Props) {
  return (
    <TextInput
      ref={inputRef}
      value={value}
      onChangeText={onChangeText}
      style={style}
      placeholder={placeholder}
      placeholderTextColor="#94a3b8"
      numberOfLines={numberOfLines}
      {...(binding ?? null)}
      {...(Platform.OS === "web" ? (webProps as any) : null)}
    />
  );
}
