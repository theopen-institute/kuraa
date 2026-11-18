// Which format editor modules (markdown cues, footnote ordering, chunk fences)
// are off for this person: a choice kept in this browser, affecting no one else.

const KEY = 'kuraa:editors-off';

/** Type ids whose editor module this person has turned off. */
export function loadEditorsOff(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveEditorsOff(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}
