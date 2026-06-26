import React from "react";
import { Platform, Pressable, TextInput, View, type TextStyle, type ViewStyle } from "react-native";
import { AppText } from "./AppText";
import { useAppTheme } from "./useAppTheme";

function normalizeDateValue(value: string): string {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

export function DateField({
  label,
  value,
  onChangeText,
  editable = true,
  allowClear = false,
  style,
  inputStyle,
}: {
  label?: string;
  value: string;
  onChangeText: (value: string) => void;
  editable?: boolean;
  allowClear?: boolean;
  style?: ViewStyle;
  inputStyle?: TextStyle;
}) {
  const { theme, colors } = useAppTheme();
  const dateValue = Platform.OS === "web" ? normalizeDateValue(value) : String(value ?? "");
  const canClear = editable && allowClear && !!String(value ?? "").trim();

  return (
    <View style={[{ gap: theme.space.sm }, style]}>
      {label ? <AppText variant="caption" color="mutedText">{label}</AppText> : null}
      <View style={{ flexDirection: "row", gap: theme.space.sm, alignItems: "center" }}>
        <TextInput
          value={dateValue}
          onChangeText={(next) => onChangeText(String(next ?? "").slice(0, 10))}
          editable={editable}
          placeholder={Platform.OS === "web" ? undefined : "YYYY-MM-DD"}
          placeholderTextColor={colors.mutedText}
          autoCapitalize="none"
          style={[
            {
              flex: 1,
              height: 44,
              paddingHorizontal: theme.space.md,
              borderRadius: theme.radius.md,
              borderWidth: theme.border.hairline,
              borderColor: colors.border,
              backgroundColor: colors.card,
              color: colors.text,
              fontSize: 16,
            },
            inputStyle,
          ]}
          {...(Platform.OS === "web" ? ({ type: "date" } as any) : {})}
        />
        {canClear ? (
          <Pressable
            onPress={() => onChangeText("")}
            style={{
              height: 44,
              paddingHorizontal: theme.space.md,
              borderRadius: theme.radius.md,
              borderWidth: theme.border.hairline,
              borderColor: colors.border,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.card,
            }}
          >
            <AppText variant="caption" color="mutedText" style={{ fontWeight: "900" }}>
              Clear
            </AppText>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
