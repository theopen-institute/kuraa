// Today's writing (0094): the words written in each document since it was
// first open today, in this browser, and a target of your own for a day.
// Kept in this browser (localStorage); a new day starts afresh, keeping the
// target. A document's words when it was first seen today are its start, so
// what others write in it while it is open counts too: it is a day's change,
// not a keystroke count.
import { ref } from 'vue';

const KEY = 'kuraa:words:session';

interface Stored {
  day: string;
  target: number | null;
  /** By document: its words when first seen today, and now. */
  docs: { [path: string]: { start: number; now: number } };
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function read(): Stored {
  let v: Partial<Stored> = {};
  try {
    v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Stored>;
  } catch { /* none, or unreadable: afresh */ }
  const target = typeof v.target === 'number' && v.target > 0 ? v.target : null;
  return v.day === today() && v.docs && typeof v.docs === 'object' ? { day: v.day, target, docs: v.docs } : { day: today(), target, docs: {} };
}

let stored = read();
/** Goes up with every change, for what shows it. */
export const sessionTick = ref(0);

function save() {
  sessionTick.value++;
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch { /* storage unavailable: for this page only */ }
}

/** A document's words now: its start, the first time today. */
export function note(path: string, words: number): void {
  if (stored.day !== today()) stored = { day: today(), target: stored.target, docs: {} };
  const was = stored.docs[path];
  if (was?.now === words) return;
  stored.docs[path] = was ? { ...was, now: words } : { start: words, now: words };
  save();
}

/** The words written today, in every document (less where words were cut). */
export function written(): number {
  if (stored.day !== today()) return 0;
  return Object.values(stored.docs).reduce((n, d) => n + (d.now - d.start), 0);
}

export const sessionTarget = (): number | null => stored.target;

export function setSessionTarget(target: number | null): void {
  stored.target = target;
  save();
}

/** Start the day's count again from now. */
export function restart(): void {
  stored = { day: today(), target: stored.target, docs: Object.fromEntries(Object.entries(stored.docs).map(([p, d]) => [p, { start: d.now, now: d.now }])) };
  save();
}
