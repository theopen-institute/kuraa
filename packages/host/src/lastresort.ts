// The last resort for an error nothing else caught (a promise no one waited on,
// an exception in a callback): say it, save what can be saved, and go on. A
// server holds many workspaces, and one workspace's error must not stop the
// others. Only errors coming thick and fast (something is badly wrong) stop it.

export interface LastResortOptions {
  log(message: string): void;
  /** Write and commit what can be (Hub.saveAll). */
  save(): Promise<void>;
  /** Stop, saving as usual: called once errors come too fast. */
  stop(): void;
  /** How many errors in a minute are too many. Default 20. */
  limit?: number;
  /** Where the errors are told of (default: this process). */
  on?: Pick<NodeJS.Process, 'on' | 'off'>;
}

/** Handle uncaught exceptions and unhandled rejections in this process, from now on. Returns a function that stops handling them. */
export function lastResort(o: LastResortOptions): () => void {
  let recent: number[] = [];
  let saving = false;
  const handle = (what: string) => (e: unknown) => {
    o.log(`${what}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    const now = Date.now();
    recent = [...recent.filter((t) => now - t < 60_000), now];
    if (recent.length > (o.limit ?? 20)) {
      o.log('too many unexpected errors: stopping');
      o.stop();
      return;
    }
    if (saving) return;
    saving = true;
    o.save().catch((err: unknown) => o.log(`saving after an unexpected error failed: ${String(err)}`)).finally(() => {
      saving = false;
    });
  };
  const rejection = handle('unexpected error (not waited for)');
  const exception = handle('unexpected error');
  const on = o.on ?? process;
  on.on('unhandledRejection', rejection);
  on.on('uncaughtException', exception);
  return () => {
    on.off('unhandledRejection', rejection);
    on.off('uncaughtException', exception);
  };
}
