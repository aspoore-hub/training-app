import React from "react";
import { Text, TextStyle } from "react-native";
import { useAppTheme } from "./useAppTheme";

export function AppText({
  children,
  variant = "body",
  color = "text",
  style,
  numberOfLines,
}: {
  children: React.ReactNode;
  variant?: "title" | "headline" | "body" | "sub" | "caption";
  color?: "text" | "mutedText" | "tint" | "danger" | "success";
  style?: TextStyle;
  numberOfLines?: number;
}) {
  const { theme, colors } = useAppTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        theme.text[variant] as TextStyle,
        { color: (colors as any)[color] ?? colors.text },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
