import React from "react";
import { View, ViewStyle } from "react-native";
import { useAppTheme } from "./useAppTheme";

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const { theme, colors } = useAppTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.card,
          borderRadius: theme.radius.lg,
          borderWidth: theme.border.hairline,
          borderColor: colors.border,
          padding: theme.space.lg,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
