// Export… asked for (the ⋯ menu): the Preview panel, as it is asked, shows its
// formats to export as instead of rendering for the page. One page, one flag.
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
