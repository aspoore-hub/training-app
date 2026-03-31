import React from "react";
import { Pressable, Text, View } from "react-native";

type PrevNextNavButtonsProps = {
  onPrev: () => void;
  onNext: () => void;
  size?: number;
  spread?: boolean;
};

export function PrevNextNavButtons({
  onPrev,
  onNext,
  size = 40,
  spread = false,
}: PrevNextNavButtonsProps) {
  const radius = size / 2;

  return (
    <View style={{ flexDirection: "row", gap: 10, justifyContent: spread ? "space-between" : "flex-start", width: spread ? "100%" : undefined }}>
      <Pressable
        onPress={onPrev}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          borderWidth: 1,
          borderColor: "#ddd",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#fafafa",
        }}
      >
        <Text style={{ fontWeight: "900", color: "#111" }}>◀</Text>
      </Pressable>
      <Pressable
        onPress={onNext}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          borderWidth: 1,
          borderColor: "#ddd",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#fafafa",
        }}
      >
        <Text style={{ fontWeight: "900", color: "#111" }}>▶</Text>
      </Pressable>
    </View>
  );
}
