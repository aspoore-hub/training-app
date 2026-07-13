import React, { useEffect, useMemo, useState } from "react";
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
  const normalizedValue = normalizeDateValue(value);
  const [webDraftValue, setWebDraftValue] = useState(normalizedValue);
  const dateValue = Platform.OS === "web" ? webDraftValue : String(value ?? "");
  const canClear = editable && allowClear && !!String(value ?? "").trim();
  const webInputStyle = useMemo<React.CSSProperties>(
    () => ({
      flex: 1,
      height: 44,
      minWidth: 0,
      boxSizing: "border-box",
      paddingLeft: theme.space.md,
      paddingRight: theme.space.md,
      borderRadius: theme.radius.md,
      borderWidth: theme.border.hairline,
      borderStyle: "solid",
      borderColor: colors.border,
      backgroundColor: colors.card,
      color: colors.text,
      fontSize: 16,
      ...((inputStyle as React.CSSProperties | undefined) ?? {}),
    }),
    [colors.border, colors.card, colors.text, inputStyle, theme.border.hairline, theme.radius.md, theme.space.md]
  );

  useEffect(() => {
    setWebDraftValue(normalizedValue);
  }, [normalizedValue]);

  function commitDateValue(next: string) {
    const clean = normalizeDateValue(next);
    if (clean) {
      setWebDraftValue(clean);
      onChangeText(clean);
      return;
    }
    setWebDraftValue("");
    onChangeText("");
  }

  return (
    <View style={[{ gap: theme.space.sm }, style]}>
      {label ? <AppText variant="caption" color="mutedText">{label}</AppText> : null}
      <View style={{ flexDirection: "row", gap: theme.space.sm, alignItems: "center" }}>
        {Platform.OS === "web" ? (
          <input
            type="date"
            value={dateValue}
            disabled={!editable}
            onChange={(event) => {
              const next = String((event.target as HTMLInputElement)?.value ?? "").trim();
              if (next === "" && normalizedValue) {
                setWebDraftValue(normalizedValue);
                return;
              }
              commitDateValue(next);
            }}
            style={webInputStyle}
          />
        ) : (
          <TextInput
            value={dateValue}
            onChangeText={(next) => onChangeText(String(next ?? "").slice(0, 10))}
            editable={editable}
            placeholder="YYYY-MM-DD"
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
          />
        )}
        {canClear ? (
          <Pressable
            onPress={() => commitDateValue("")}
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
