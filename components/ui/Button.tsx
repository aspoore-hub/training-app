import React from "react";
import { Pressable, ViewStyle } from "react-native";
import { AppText } from "./AppText";
import { useAppTheme } from "./useAppTheme";

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const { theme, colors } = useAppTheme();

  const bg =
    variant === "primary" ? colors.tint : variant === "danger" ? colors.danger : colors.card;
  const borderColor = variant === "secondary" ? colors.border : bg;
  const textColor = variant === "secondary" ? "text" : "card";

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          height: 44,
          paddingHorizontal: theme.space.lg,
          borderRadius: theme.radius.md,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: bg,
          borderWidth: theme.border.hairline,
          borderColor,
          opacity: disabled ? 0.5 : pressed ? 0.9 : 1,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
        style,
      ]}
    >
      <AppText variant="sub" color={textColor as any}>
        {title}
      </AppText>
    </Pressable>
  );
}
