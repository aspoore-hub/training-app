import React from "react";
import { TextInput, View, ViewStyle } from "react-native";
import { useAppTheme } from "./useAppTheme";
import { AppText } from "./AppText";

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize = "none",
  style,
  editable = true,
}: {
  label?: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "email-address" | "numeric";
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  style?: ViewStyle;
  editable?: boolean;
}) {
  const { theme, colors } = useAppTheme();

  return (
    <View style={[{ gap: theme.space.sm }, style]}>
      {label ? <AppText variant="caption" color="mutedText">{label}</AppText> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        editable={editable}
        placeholderTextColor={colors.mutedText}
        style={{
          height: 44,
          paddingHorizontal: theme.space.md,
          borderRadius: theme.radius.md,
          borderWidth: theme.border.hairline,
          borderColor: colors.border,
          backgroundColor: colors.card,
          color: colors.text,
          fontSize: 16,
        }}
      />
    </View>
  );
}
