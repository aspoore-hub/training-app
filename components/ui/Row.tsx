import React from "react";
import { Pressable, View, ViewStyle } from "react-native";
import { useAppTheme } from "./useAppTheme";
import { AppText } from "./AppText";

export function Row({
  title,
  subtitle,
  right,
  onPress,
  style,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  const { theme } = useAppTheme();

  const content = (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: subtitle ? "flex-start" : "center",
          justifyContent: "space-between",
          paddingVertical: theme.space.md,
          paddingHorizontal: theme.space.lg,
          gap: theme.space.md,
        },
        style,
      ]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="body" numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" color="mutedText" numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {right ? <View style={{ justifyContent: "center" }}>{right}</View> : null}
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}>
      {content}
    </Pressable>
  );
}
