import React from "react";
import { SafeAreaView, View, ViewStyle } from "react-native";
import { useAppTheme } from "./useAppTheme";

export function Screen({
  children,
  padded = true,
  style,
}: {
  children: React.ReactNode;
  padded?: boolean;
  style?: ViewStyle;
}) {
  const { theme, colors } = useAppTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={[
          { flex: 1, padding: padded ? theme.space.lg : 0, backgroundColor: colors.bg },
          style,
        ]}
      >
        {children}
      </View>
    </SafeAreaView>
  );
}
