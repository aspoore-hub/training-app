import React from "react";
import { Pressable, Text, View } from "react-native";

type SegmentedViewToggleItem = {
  key: string;
  label: string;
  onPress: () => void;
};

type SegmentedViewToggleProps = {
  items: Array<SegmentedViewToggleItem>;
  activeKey: string;
};

export function SegmentedViewToggle({ items, activeKey }: SegmentedViewToggleProps) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", gap: 8, marginBottom: 10 }}>
      {items.map((item) => {
        const isActive = item.key === activeKey;
        return (
          <Pressable
            key={item.key}
            onPress={item.onPress}
            style={[
              {
                borderWidth: 1,
                borderColor: "#d7d7d7",
                borderRadius: 999,
                paddingHorizontal: 12,
                paddingVertical: 7,
                backgroundColor: "#fff",
              },
              isActive && { backgroundColor: "#111", borderColor: "#111" },
            ]}
          >
            <Text style={[{ fontWeight: "800", color: "#222" }, isActive && { color: "#fff" }]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
