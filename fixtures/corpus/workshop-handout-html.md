---
title: "Workshop Handout: Reproducible Figures"
date: 2024-09-12
---

<div class="handout-banner">
  <p>Graduate Methods Workshop &middot; Session 4</p>
</div>

# Before we start {#before}

Please make sure you can open the course folder and that you have a
working R or Python installation. If you are on a managed laptop, the
IT helpdesk can install software for you; allow a couple of days.

<details>
<summary>Checking your installation</summary>

Open a terminal and run `python --version` or `R --version`. Anything
from the last two or three years is fine.

</details>

# Why figures go wrong {#why}

Most figure problems in theses are not about aesthetics. They are about
figures that cannot be regenerated: the data has changed, the script
is lost, or the figure was edited by hand after export. Press
<kbd>Ctrl</kbd>+<kbd>S</kbd> on a figure in a slide editor and you have
already lost the link to the code.

Some common symptoms:

- axis labels that do not match the variable names in the data;
- a figure that looks different in the PDF and in the slides;
- a colour scale that silently changed between versions.

A useful rule: if a figure cannot be rebuilt by running one command,
it is <em>not finished</em>, however good it looks.

<!-- TODO: add the example from last year's cohort here -->

# The workflow {#workflow}

1. Keep raw data read-only.
2. Write one script per figure, named after the figure.
3. Export to a vector format (PDF or SVG) at the final size.
4. Include the figure in the thesis by file reference, never by
   copy-and-paste.

<table class="checklist">
  <thead>
    <tr><th>Check</th><th>Done?</th></tr>
  </thead>
  <tbody>
    <tr><td>Script runs from a clean session</td><td>&#9744;</td></tr>
    <tr><td>Output size matches the page</td><td>&#9744;</td></tr>
    <tr><td>Fonts embedded</td><td>&#9744;</td></tr>
  </tbody>
</table>

# Figures in LaTeX theses {#latex}

If you write your thesis in LaTeX, the figure should be included at the
width of the text block:

```latex
\begin{figure}
  \centering
  \includegraphics[width=\linewidth]{figures/fig3-trend.pdf}
  \caption{Trend in annual mean temperature.}
  \label{fig:trend}
\end{figure}
```

When writing in Markdown and converting with Pandoc, you can still
drop down to TeX where needed, for example to force a page break
before a large figure:

\newpage

or to use a citation command directly, as in \cite{wilke2019}, though
Pandoc's own citation syntax is usually the better choice. The
`\clearpage`{=latex} command flushes all pending floats.

```{=html}
<p class="aside">This paragraph appears only in the HTML version of the
handout.</p>
```

# Exercises {#exercises}

<span class="badge">20 min</span> Take one figure from your current
draft and try to regenerate it from scratch. Note every step where you
had to do something by hand.

<span class="badge">10 min</span> Swap notes with a neighbour and
suggest one change that would remove a manual step.

<hr class="section-break">

Further reading: Claus O. Wilke, *Fundamentals of Data Visualization*,
available online at <https://clauswilke.com/dataviz/>.
