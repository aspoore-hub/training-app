import React from "react";
import { View, ViewStyle } from "react-native";
import { useAppTheme } from "./useAppTheme";

export function Divider({ style }: { style?: ViewStyle }) {
  const { theme, colors } = useAppTheme();
  return (
    <View
      style={[
        { height: theme.border.hairline, backgroundColor: colors.border, width: "100%" },
        style,
      ]}
    />
  );
}
