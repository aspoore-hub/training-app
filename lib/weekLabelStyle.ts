export type WeekLabelType = "competition" | "training" | "break";
export type WeekLabelTone = WeekLabelType;

export function normalizeWeekLabelType(raw: unknown): WeekLabelType {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "competition") return "competition";
  if (value === "break") return "break";
  return "training";
}

export function getWeekLabelTone(type: unknown): WeekLabelTone {
  return normalizeWeekLabelType(type);
}

export function getWeekLabelToneText(tone: WeekLabelTone): string {
  if (tone === "competition") return "Competition";
  if (tone === "break") return "Break";
  return "Training";
}

export function getWeekLabelToneColors(tone: WeekLabelTone) {
  if (tone === "competition") {
    return { border: "rgba(220,38,38,0.34)", bg: "rgba(220,38,38,0.1)", text: "#991b1b" };
  }
  if (tone === "break") {
    return { border: "rgba(37,99,235,0.32)", bg: "rgba(37,99,235,0.1)", text: "#1d4ed8" };
  }
  return { border: "rgba(100,116,139,0.28)", bg: "rgba(100,116,139,0.1)", text: "#334155" };
}
