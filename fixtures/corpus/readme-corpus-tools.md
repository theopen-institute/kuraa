corpus-tools
============

Small utilities for cleaning and tokenising the interview transcripts
used in the *Voices of the Valley* oral history project. Maintained by
the project's research software group; see the
[project page](https://example.org/valley "Voices of the Valley") for
background.

Source and issue tracker: <https://example.org/git/corpus-tools>

Questions: <mailto:rse-team@example.org>

* * *

Installation
------------

You need Python 3.10 or newer. Clone the repository and install in
editable mode:

```bash
git clone https://example.org/git/corpus-tools.git
cd corpus-tools
pip install -e .
```

On the shared cluster the module is already available:

    module load python/3.11
    module load corpus-tools/0.4

Usage
-----

The main entry point is `ct-clean`, which reads raw transcripts and
writes normalised text:

~~~ {.bash}
ct-clean --in raw/ --out clean/ --lang de --keep-fillers
~~~

The `--keep-fillers` flag preserves hesitation markers such as *ähm*
and *hmm*. Without it, they are dropped. A typical normalised line
looks like this:

```text
[INT] und dann sind wir nach Graz gezogen, das war neunzehnhundert
[INT] fünfundsechzig oder so
```

From Python, the same functionality is available through
`corpus_tools.clean`:

```python
from corpus_tools.clean import normalise_file

for path in raw_dir.glob("*.txt"):
    text = normalise_file(path, lang="de", keep_fillers=True)
    (out_dir / path.name).write_text(text, encoding="utf-8")
```

### Speaker codes

Speaker codes are given in square brackets at the start of each line.
The tool recognises `[INT]` (interviewee), `[IV]` (interviewer) and
`[X]` (unidentified). Literal square brackets in the transcript text
must be escaped as \[ and \] in the source files, otherwise they are
read as speaker codes.

Other characters that need escaping in the raw files: \*, \_, \# at
the start of a line, and the backslash itself (\\). For example, a
transcriber's note written as \*inaudible\* stays as literal asterisks.

### Configuration

Settings can be placed in `ct.toml` at the project root:

``` toml
[clean]
lang = "de"
keep_fillers = false
max_line_length = 72
```

* * *

Development
-----------

Run the tests with:

    pytest -q

Style is enforced with `ruff`. Please run `ruff check .` before opening
a merge request. The changelog is kept in `CHANGES.md`; add a line
under *Unreleased* for any user-visible change.

Releases follow [semantic versioning](https://semver.org "SemVer
specification"). Version 0.x releases may change the command-line
interface without notice.

---

Licence
-------

MIT. See `LICENSE` for the full text. Transcript data is **not**
included in this repository and is subject to the project's data
access agreement; contact the data steward at
<data-steward@example.org> for access.
