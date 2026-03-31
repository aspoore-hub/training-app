export type WeekLabelTone = "competition" | "break" | "camp" | "custom";

export function getWeekLabelTone(label: string): WeekLabelTone {
  const normalized = String(label ?? "").trim().toLowerCase();
  if (!normalized) return "custom";

  const competition = [
    "meet",
    "relays",
    "open",
    "challenge",
    "champs",
    "district",
    "sectional",
    "regional",
    "state",
    "invite",
    "competition",
    "conference",
    "section",
    "qualifier",
    "ncaa",
    "race",
    "championship",
    "invitational",
  ];
  const breakKeywords = ["break", "off", "rest", "recovery", "holiday"];
  const campKeywords = ["camp"];

  if (competition.some((key) => normalized.includes(key))) return "competition";
  if (breakKeywords.some((key) => normalized.includes(key))) return "break";
  if (campKeywords.some((key) => normalized.includes(key))) return "camp";
  return "custom";
}

export function getWeekLabelToneText(tone: WeekLabelTone): string {
  if (tone === "competition") return "Competition";
  if (tone === "break") return "Break";
  if (tone === "camp") return "Camp";
  return "Custom";
}
