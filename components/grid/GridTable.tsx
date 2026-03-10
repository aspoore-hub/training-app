import { ScrollView, View } from "react-native";
import type { ReactNode } from "react";
import { Platform } from "react-native";

export function GridTable({
  minWidth,
  children,
  webUseParentScroll = false,
}: {
  minWidth: number;
  children: ReactNode;
  webUseParentScroll?: boolean;
}) {
  if (Platform.OS === "web" && webUseParentScroll) {
    return (
      <View
        style={{
          minWidth,
          width: "100%",
          overflow: "visible" as any,
        }}
      >
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      style={Platform.OS === "web" ? ({ overflow: "visible" } as any) : undefined}
      contentContainerStyle={{
        minWidth,
        width: "100%",
        ...(Platform.OS === "web" ? ({ overflow: "visible" } as any) : null),
      }}
    >
      <View style={{ flex: 1 }}>{children}</View>
    </ScrollView>
  );
}
