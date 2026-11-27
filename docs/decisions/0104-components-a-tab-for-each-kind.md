# 0104 · Components: a tab for each kind

**Status: built.** Changes how Settings › Components shows its kinds
([0095](0095-components-in-one-table.md)): one kind at a time, a tab for each, in place of one table of
every kind with a row of buttons at the top leading to each. What each switch does, who may change it
and where it is kept are as 0095 has them.

The owner's direction:

> "There's a display bug in the components buttons. Also, the sections need to be more prominent. Does
> it make sense to separate the sections completely as tabs so it's not one long scrolling list?"

## The bug

The table's column heads stayed in view by sticking to the top of the scrolling content, and covered
the content's top padding (20px) above them with their background, so that nothing scrolling past
showed there. Not scrolled, that background covered the bottom of the buttons above the table.

## A tab for each kind

The buttons are tabs now (**Document formats 3**, **Features 11**, **Languages 1**, …; a tab for each
kind the host has, with how many), one line, scrolled sideways where they do not fit. They stay at the
top as the kind scrolls, and the column heads (Host, Workspace, You) stay under them. The tabs cover
the padding above now. The arrow keys, Home and End move between them.

The kind shown has its name as a heading, how it stands (*3 of 3 on*, *Podman in use*), what it is,
and its owner's switches for the whole kind (**Run R code in documents** under Languages, **Where code
runs** under Environments), then its table: its components, a column for each level, as before. The
columns are the same for every kind, a dash where a kind is not switched at a level, so that each kind
shows where it is switched.

The first kind is shown first. The kind shown last is shown again when Settings is opened again in the
same window (not after a reload). A feature's subpanel, closed, comes back to Features.

## Not changed

Every `data-testid` 0095 lists. `components-formats`, `components-features`, `components-run`,
`components-environments`, `components-tools` and `components-syncs` are each on the panel while that
kind is shown (in the page only then). `kind:<kind>` is each tab; `component-kinds`, the tabs. The
browser tests open the tab they need (`openComponents(page, kind)`, Features unless said).
