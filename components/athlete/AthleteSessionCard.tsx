import { Pressable, Text, View } from "react-native";
import type { WorkoutCategory } from "../../lib/types";
import { categoryColorByName } from "../../lib/categories";

export type AthleteSessionCardStatus = "submitted" | "missing" | "planned" | "none" | "multiple";

type Props = {
  session: "AM" | "PM";
  title: string;
  summary?: string;
  planSummary?: string;
  prescribed?: string;
  time?: string | null;
  location?: string | null;
  categories?: string[];
  categoriesSource?: WorkoutCategory[];
  status: AthleteSessionCardStatus;
  actionLabel?: string;
  disabled?: boolean;
  onOpen?: () => void;
  onLog?: () => void;
};

function statusColors(status: AthleteSessionCardStatus) {
  if (status === "submitted") return { border: "#bbf7d0", bg: "#f0fdf4", text: "#166534", label: "Logged" };
  if (status === "missing") return { border: "#fecaca", bg: "#fff1f2", text: "#991b1b", label: "Missing" };
  if (status === "multiple") return { border: "#fed7aa", bg: "#fff7ed", text: "#9a3412", label: "Multiple" };
  if (status === "planned") return { border: "#bfdbfe", bg: "#eff6ff", text: "#1e40af", label: "Planned" };
  return { border: "#e2e8f0", bg: "#f8fafc", text: "#64748b", label: "No planned session" };
}

export function AthleteSessionCard({
  session,
  title,
  summary,
  planSummary,
  prescribed,
  time,
  location,
  categories,
  categoriesSource = [],
  status,
  actionLabel,
  disabled,
  onOpen,
  onLog,
}: Props) {
  const colors = statusColors(status);
  const cleanCategories = Array.from(new Set((categories ?? []).map((name) => String(name ?? "").trim()).filter(Boolean)));
  const canOpen = Boolean(onOpen) && !disabled;
  const canLog = Boolean(onLog) && !disabled && status !== "none";

  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: "#ffffff",
        padding: 12,
      }}
    >
      <Pressable disabled={!canOpen} onPress={onOpen} style={{ opacity: canOpen ? 1 : 0.96 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: "900", color: "#0f172a" }}>{session}</Text>
            <Text style={{ marginTop: 5, fontSize: 17, fontWeight: "900", color: "#0f172a" }}>{title}</Text>
          </View>
          <View
            style={{
              borderRadius: 999,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.bg,
              paddingHorizontal: 9,
              paddingVertical: 3,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: "900", color: colors.text }}>{colors.label}</Text>
          </View>
        </View>

        <View style={{ marginTop: 8, gap: 4 }}>
          {time ? <Text style={{ color: "#334155", fontWeight: "800" }}>{time}</Text> : null}
          {location ? <Text style={{ color: "#475569", fontWeight: "700" }}>{location}</Text> : null}
          {prescribed ? <Text style={{ color: "#1e40af", fontWeight: "900" }}>Mileage: {prescribed}</Text> : null}
        </View>

        {cleanCategories.length > 0 ? (
          <View style={{ marginTop: 8, flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
            {cleanCategories.slice(0, 4).map((name) => {
              const color = categoryColorByName(categoriesSource, name);
              return (
                <View
                  key={`${session}-${title}-${name}`}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: color,
                    backgroundColor: "white",
                  }}
                >
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>{name}</Text>
                </View>
              );
            })}
          </View>
        ) : null}

        {summary ? <Text style={{ marginTop: 8, color: "#475569", lineHeight: 20 }}>{summary}</Text> : null}
        {planSummary ? <Text style={{ marginTop: 7, color: "#334155", fontWeight: "700", lineHeight: 19 }}>{planSummary}</Text> : null}
      </Pressable>

      {actionLabel && onLog ? (
        <Pressable
          disabled={!canLog}
          onPress={onLog}
          style={{
            marginTop: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: canLog ? "#bfdbfe" : "#e2e8f0",
            backgroundColor: canLog ? "#eff6ff" : "#f8fafc",
            paddingVertical: 11,
            alignItems: "center",
            opacity: canLog ? 1 : 0.65,
          }}
        >
          <Text style={{ fontWeight: "900", color: canLog ? "#1e40af" : "#94a3b8" }}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
