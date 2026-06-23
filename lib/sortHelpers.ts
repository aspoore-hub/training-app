type NamedLike = {
  id?: string | null;
  name?: string | null;
  title?: string | null;
};

type FolderedNamedLike = NamedLike & {
  folderId?: string | null;
};

type SeasonLike = NamedLike & {
  start_date?: string | null;
  end_date?: string | null;
  sort_order?: number | null;
};

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function displayNameOf(value: NamedLike): string {
  return cleanText(value.name) || cleanText(value.title);
}

export function compareText(a: unknown, b: unknown): number {
  return cleanText(a).localeCompare(cleanText(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function compareNames(a: NamedLike, b: NamedLike): number {
  return compareText(displayNameOf(a), displayNameOf(b)) || compareText(a.id, b.id);
}

export function compareCategoryNames(a: NamedLike | string, b: NamedLike | string): number {
  const aName = typeof a === "string" ? a : displayNameOf(a);
  const bName = typeof b === "string" ? b : displayNameOf(b);
  const aOther = aName.trim().toLowerCase() === "other";
  const bOther = bName.trim().toLowerCase() === "other";
  if (aOther !== bOther) return aOther ? 1 : -1;
  return compareText(aName, bName);
}

export function sortCategoriesForDisplay<T extends NamedLike>(categories: T[]): T[] {
  return [...(Array.isArray(categories) ? categories : [])].sort(compareCategoryNames);
}

export function sortFoldersForDisplay<T extends NamedLike>(folders: T[]): T[] {
  return [...(Array.isArray(folders) ? folders : [])].sort(compareNames);
}

function folderLabel(folderId: unknown, folderNameById: Map<string, string>): string {
  const id = cleanText(folderId);
  return id ? cleanText(folderNameById.get(id)) : "";
}

export function compareFolderThenName<T extends FolderedNamedLike>(
  a: T,
  b: T,
  folders: NamedLike[] | Map<string, string>
): number {
  const folderNameById = folders instanceof Map
    ? folders
    : new Map((Array.isArray(folders) ? folders : []).map((folder) => [cleanText(folder.id), displayNameOf(folder)]));
  const aFolder = folderLabel(a.folderId, folderNameById);
  const bFolder = folderLabel(b.folderId, folderNameById);
  const aUncategorized = !aFolder;
  const bUncategorized = !bFolder;
  if (aUncategorized !== bUncategorized) return aUncategorized ? 1 : -1;
  return compareText(aFolder, bFolder) || compareNames(a, b);
}

export function sortByFolderThenName<T extends FolderedNamedLike>(
  items: T[],
  folders: NamedLike[] | Map<string, string>
): T[] {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => compareFolderThenName(a, b, folders));
}

export function sortSeasonsForDisplay<T extends SeasonLike>(seasons: T[]): T[] {
  return [...(Array.isArray(seasons) ? seasons : [])].sort((a, b) => {
    const byStart = compareText(a.start_date, b.start_date);
    if (byStart !== 0) return byStart;
    const byEnd = compareText(a.end_date, b.end_date);
    if (byEnd !== 0) return byEnd;
    return compareNames(a, b);
  });
}
