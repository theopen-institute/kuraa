// Export… asked for (the ⋯ menu): the panel, as it is asked, renders for the
// page as ⇧⌘R does and also puts the focus on its formats to export as (0114).
// One page, one flag.
let asked = false;

/** Export… was chosen: the panel's next ask is for exporting. */
export function askExport(): void {
  asked = true;
}

/** Whether the ask now is for exporting (once: the flag is taken). */
export function exportAsked(): boolean {
  const was = asked;
  asked = false;
  return was;
}
