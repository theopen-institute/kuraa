# 0024 · Outputs know what they were computed from

A chunk's output depends on the chunks above it as much as on its own code. Before this, an output
was marked out of date only when its own chunk changed: edit chunk 2 and the output of chunk 3,
computed from the old chunk 2, looked current. Now the host remembers what each session has run,
and every output records what had run before it.

**The session's history.** Each document's session with an engine keeps its steps: the chunks it
has run, in order, as `RunStep { label, index, codeHash, complete }`. A step is complete when the
whole chunk ran without an error or an interrupt. Running the same chunk and code again replaces its
earlier step; running a line or selection of a chunk that has already run in full leaves that step
standing (the session still has what the chunk defined). The history is part of the session's
`RunSessionInfo` (`id`, `steps`), so every client sees it. A restart, or a session that stops or
fails, has none. It lives only in memory, like the session.

**Each run's basis.** When a run starts, the host records on it the session's id and its steps so
far (`RunRecord.basis`), and the engine that ran it (`RunRecord.engine`). These are cached with the
outputs, so they survive a reload.

**Out of date.** Against the chunks above it that the same engine runs, a client asks of a set of
steps for the first chunk it does not have as it now reads (`behind`, in
`packages/client/src/upstream.ts`). A chunk's latest step is the one that counts; it is matched as
runs are matched to chunks (a labelled chunk by label, an unlabelled one by position or code). The
chunk is behind when it never ran ("ran without chunk 2"), ran in another version ("chunk 2
changed since") or did not run in full ("chunk 2 had not run in full"). The client asks this of:

- an output's basis: the output is dimmed and says why, as with "code changed since";
- the live session's steps, plus runs already queued: if a chunk above is behind, the chunk's
  header offers **Rebuild above** (**Run above** when nothing has run in the session yet), which
  runs the chunks above again from the first one that is behind. When the session has every chunk
  above as it reads, nothing is offered: there is nothing to run.

Rebuilding above does not run the chunk itself, and does not bring its output up to date: run it
when the chunks above are done.

**Not covered.** What a deleted chunk defined stays in the session without a sign, and so do
objects an earlier version of a chunk made that the current one does not (a renamed variable).
Restart, then Run all (or knitting, which always starts afresh) settles both. Nor does it work out
which chunks actually use what another defines (all chunks below a change are flagged, whether
they use it or not), or notice chunks run out of order. A document with chunks for two engines
gets out-of-date outputs for both, but Rebuild above only for the engine whose session the client
knows. Outputs from before this change have no basis and are not flagged.
