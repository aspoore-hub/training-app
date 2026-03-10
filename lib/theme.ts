import { Platform } from "react-native";

export const theme = {
  space: {
    xs: 6,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
  },
  radius: {
    sm: 10,
    md: 12,
    lg: 16,
    xl: 20,
  },
  border: {
    hairline: Platform.OS === "web" ? 1 : 0.5,
  },
  text: {
    title: { fontSize: 20, fontWeight: "700" as const },
    headline: { fontSize: 17, fontWeight: "700" as const },
    body: { fontSize: 16, fontWeight: "500" as const },
    sub: { fontSize: 14, fontWeight: "600" as const },
    caption: { fontSize: 12, fontWeight: "600" as const },
  },
};

// Simple, iOS-like palettes. Tweak later.
export const colors = {
  light: {
    bg: "#F2F2F7",
    card: "#FFFFFF",
    text: "#111111",
    mutedText: "#6B7280",
    border: "#E5E7EB",
    tint: "#0A84FF",
    danger: "#FF3B30",
    success: "#34C759",
    warning: "#FF9500",
  },
  dark: {
    bg: "#000000",
    card: "#1C1C1E",
    text: "#FFFFFF",
    mutedText: "#9CA3AF",
    border: "#2C2C2E",
    tint: "#0A84FF",
    danger: "#FF453A",
    success: "#30D158",
    warning: "#FF9F0A",
  },
};

export type ColorSchemeName = keyof typeof colors;
