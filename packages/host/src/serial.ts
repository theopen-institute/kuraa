// Work done one step at a time, in the order asked for. A step that fails fails
// only its own caller; the next step runs all the same.
export function serialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
}
