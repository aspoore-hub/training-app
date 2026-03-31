import React from "react";
import { Text, View } from "react-native";

export type InlineSaveStatusValue = "idle" | "saving" | "saved" | "error";

type InlineSaveStatusProps = {
  status: InlineSaveStatusValue;
  message?: string | null;
  size?: "sm" | "md";
  align?: "left" | "right" | "center";
};

const STATUS_LABELS: Record<InlineSaveStatusValue, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Saved ✓",
  error: "Error",
};

const STATUS_COLORS: Record<InlineSaveStatusValue, string> = {
  idle: "#64748b",
  saving: "#1d4ed8",
  saved: "#166534",
  error: "#b91c1c",
};

export function InlineSaveStatus({
  status,
  message,
  size = "md",
  align = "left",
}: InlineSaveStatusProps) {
  const label = STATUS_LABELS[status];
  const textColor = STATUS_COLORS[status];
  const shouldShowMessage = status === "error" && String(message ?? "").trim().length > 0;
  if (!label && !shouldShowMessage) return null;

  const isSmall = size === "sm";
  const textAlign = align === "right" ? "right" : align === "center" ? "center" : "left";
  const alignItems = align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start";

  return (
    <View style={{ alignItems }}>
      {label ? (
        <Text
          style={{
            fontSize: isSmall ? 11 : 12,
            fontWeight: "800",
            color: textColor,
            textAlign,
          }}
        >
          {label}
        </Text>
      ) : null}
      {shouldShowMessage ? (
        <Text
          style={{
            marginTop: 2,
            fontSize: isSmall ? 10 : 11,
            fontWeight: isSmall ? "400" : "700",
            color: "#b91c1c",
            textAlign,
          }}
          numberOfLines={2}
        >
          {message}
        </Text>
      ) : null}
    </View>
  );
}
