type AthleteNameLike = {
  id?: string | null;
  display_name?: string | null;
  displayName?: string | null;
  first_name?: string | null;
  firstName?: string | null;
  last_name?: string | null;
  lastName?: string | null;
};

function cleanName(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function splitDisplayNameForEdit(displayName: unknown): { firstName: string; lastName: string } {
  const clean = cleanName(displayName);
  if (!clean) return { firstName: "", lastName: "" };
  const parts = clean.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

export function getAthleteFirstName(athlete: AthleteNameLike | null | undefined): string {
  const explicit = cleanName(athlete?.first_name ?? athlete?.firstName);
  if (explicit) return explicit;
  return splitDisplayNameForEdit(athlete?.display_name ?? athlete?.displayName).firstName;
}

export function getAthleteLastName(athlete: AthleteNameLike | null | undefined): string {
  const explicit = cleanName(athlete?.last_name ?? athlete?.lastName);
  if (explicit) return explicit;
  return splitDisplayNameForEdit(athlete?.display_name ?? athlete?.displayName).lastName;
}

export function getAthleteDisplayName(athlete: AthleteNameLike | null | undefined): string {
  const first = getAthleteFirstName(athlete);
  const last = getAthleteLastName(athlete);
  const joined = `${first} ${last}`.trim();
  if (joined) return joined;
  const display = cleanName(athlete?.display_name ?? athlete?.displayName);
  if (display) return display;
  const id = cleanName(athlete?.id);
  return id ? `Athlete (${id.slice(-6)})` : "Athlete";
}

export function getAthleteShortName(athlete: AthleteNameLike | null | undefined): string {
  return getAthleteLastName(athlete) || getAthleteDisplayName(athlete);
}

export function compareAthletesByLastFirst(
  a: AthleteNameLike | null | undefined,
  b: AthleteNameLike | null | undefined
): number {
  const aLast = getAthleteLastName(a).toLowerCase();
  const bLast = getAthleteLastName(b).toLowerCase();
  const byLast = aLast.localeCompare(bLast);
  if (byLast !== 0) return byLast;

  const aFirst = getAthleteFirstName(a).toLowerCase();
  const bFirst = getAthleteFirstName(b).toLowerCase();
  const byFirst = aFirst.localeCompare(bFirst);
  if (byFirst !== 0) return byFirst;

  return getAthleteDisplayName(a).toLowerCase().localeCompare(getAthleteDisplayName(b).toLowerCase());
}

export function compareAthleteDisplayNamesByLastFirst(aName: string, bName: string): number {
  return compareAthletesByLastFirst(
    { display_name: aName },
    { display_name: bName }
  );
}
