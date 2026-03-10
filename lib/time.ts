type Meridiem = "AM" | "PM";

function to12Hour(hour24: number): { hour12: number; meridiem: Meridiem } {
  if (hour24 === 0) return { hour12: 12, meridiem: "AM" };
  if (hour24 === 12) return { hour12: 12, meridiem: "PM" };
  if (hour24 > 12) return { hour12: hour24 - 12, meridiem: "PM" };
  return { hour12: hour24, meridiem: "AM" };
}

function formatCanonical(hour12: number, minute: number, meridiem: Meridiem) {
  const mm = String(minute).padStart(2, "0");
  return `${hour12}:${mm} ${meridiem}`;
}

function parseMeridiemTime(raw: string): string | null {
  // accepts: 8a, 8am, 8:00a, 8:00am, 800a, 12p, 12:05pm
  const m = raw.match(/^(\d{1,2})(?::?([0-5]\d))?(a|am|p|pm)$/);
  if (!m) return null;

  const h = Number(m[1]);
  const min = m[2] != null ? Number(m[2]) : 0;
  const mer = m[3].startsWith("a") ? "AM" : "PM";

  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 1 || h > 12) return null;

  return formatCanonical(h, min, mer);
}

function parse24HourTime(raw: string): string | null {
  // accepts: 20:00, 2000, 08:30, 830
  const compact = raw.replace(":", "");
  if (!/^\d{3,4}$/.test(compact)) return null;

  const hourPart = compact.length === 3 ? compact.slice(0, 1) : compact.slice(0, 2);
  const minPart = compact.slice(-2);

  const h = Number(hourPart);
  const min = Number(minPart);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;

  const t12 = to12Hour(h);
  return formatCanonical(t12.hour12, min, t12.meridiem);
}

export function normalizeWorkoutTimeInput(text: string): string | null {
  const raw = String(text ?? "").trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "");
  if (!raw) return null;

  // direct meridiem forms first
  const meridiem = parseMeridiemTime(raw);
  if (meridiem) return meridiem;

  // hh:mm with no suffix (treat as 24h if possible)
  const withColon = raw.match(/^(\d{1,2}):([0-5]\d)$/);
  if (withColon) {
    const h = Number(withColon[1]);
    const min = Number(withColon[2]);
    if (h >= 0 && h <= 23) {
      const t12 = to12Hour(h);
      return formatCanonical(t12.hour12, min, t12.meridiem);
    }
  }

  // compact 24h
  const from24 = parse24HourTime(raw);
  if (from24) return from24;

  return null;
}

export function formatWorkoutTime(value?: string): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const normalized = normalizeWorkoutTimeInput(raw);
  return normalized ?? raw;
}
