import React from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";

type SectionLabelProps = {
  children: React.ReactNode;
  compact?: boolean;
  style?: StyleProp<TextStyle>;
};

type SectionEmptyTextProps = {
  children: React.ReactNode;
  compact?: boolean;
  style?: StyleProp<TextStyle>;
};

export function SectionLabel({ children, compact = false, style }: SectionLabelProps) {
  return (
    <Text
      style={[
        compact
          ? { marginTop: 4, fontSize: 9, fontWeight: "900", color: "#64748b", letterSpacing: 0.2 }
          : { marginTop: 10, fontSize: 11, fontWeight: "900", color: "#334155", letterSpacing: 0.2 },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function SectionEmptyText({ children, compact = false, style }: SectionEmptyTextProps) {
  return (
    <Text
      style={[
        compact
          ? { marginTop: 4, fontSize: 9, fontWeight: "700", color: "#64748b" }
          : { marginTop: 8, color: "#777", fontWeight: "800" },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
