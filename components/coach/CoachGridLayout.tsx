import { Platform, ScrollView, Text, View } from "react-native";
import type { ReactNode } from "react";

export type CoachGridColumn = {
  key: string;
  label: string;
  width: number;
};

type CoachGridLayoutProps = {
  columns: CoachGridColumn[];
  minWidth?: number;
  children: ReactNode;
};

export function CoachGridLayout({ columns, minWidth = 1200, children }: CoachGridLayoutProps) {
  return (
    <ScrollView horizontal contentContainerStyle={{ minWidth }}>
      <View style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: "row",
            borderWidth: 1,
            borderColor: "#dfe3ea",
            borderBottomWidth: 0,
            backgroundColor: "#f7f9fc",
            ...(Platform.OS === "web" ? ({ position: "sticky", top: 0, zIndex: 20 } as any) : null),
          }}
        >
          {columns.map((c) => (
            <View
              key={`grid-h-${c.key}`}
              style={{
                width: c.width,
                borderRightWidth: 1,
                borderRightColor: "#e3e8ef",
                paddingHorizontal: 8,
                paddingVertical: 6,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: "900", color: "#53627a" }}>{c.label}</Text>
            </View>
          ))}
        </View>
        {children}
      </View>
    </ScrollView>
  );
}
