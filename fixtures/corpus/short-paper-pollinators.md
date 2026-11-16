---
title: "Urban Green Roofs as Pollinator Habitat: A Two-Season Survey"
author:
  - Jonas Ekström
  - Priya Raghunathan
  - Zoë Abernethy
date: 2023-11-02
abstract: |
  Green roofs are often promoted as habitat for wild bees, but surveys
  of their actual use remain scarce. We recorded bee visits on twelve
  extensive green roofs and twelve paired ground-level sites over two
  summers. Roofs supported fewer species than ground sites, but the
  difference narrowed on roofs with deeper substrate and more varied
  planting.
bibliography: pollinators.bib
header-includes:
  - \usepackage{booktabs}
---

# Introduction {#sec:intro}

Urban areas can host surprisingly diverse bee communities
[@hall2017; @baldock2019]. Green roofs add flowering area without
taking up ground space, and several cities now subsidise them partly on
biodiversity grounds [@williams2014, pp. 1648--1650]. Whether bees use
them as much as ground-level habitat is less clear. @macivor2015 found
that roof height was a strong negative predictor of bee abundance,
while @tonietto2011 found roofs comparable to parks for some genera.

We address three questions. First, how does species richness on roofs
compare with nearby ground-level sites? Second, does substrate depth
matter? Third, which genera are under-represented on
roofs?[^funding]

[^funding]: This work was funded by the city environment office under
    grant UE-2021-114. The funder had no role in the design or the
    analysis.

# Methods {#sec:methods}

## Sites

Twelve extensive green roofs between 4 and 22 m above ground were
paired with the nearest public green space of similar area. Substrate
depth on the roofs ranged from 6 to 20 cm. Planting was dominated by
*Sedum* on seven roofs; the remaining five had mixed wildflower
plantings.

![Location of the twelve roof--ground site pairs.](figures/site-map.png){#fig:map width=80%}

## Sampling

Each site was visited six times per season. On each visit, two
observers walked a fixed 20-minute transect and recorded every bee seen
foraging, identifying to species where possible in the field and
otherwise netting for later identification [as in @westphal2008].

## Analysis

Species richness was estimated with rarefaction to the smallest sample
size across sites. Paired differences $\Delta_i = S_{\text{roof},i} -
S_{\text{ground},i}$ were analysed with a linear model

$$\Delta_i = \beta_0 + \beta_1 \, \text{depth}_i + \beta_2 \, \text{height}_i + \varepsilon_i$$

with $\varepsilon_i \sim \mathcal{N}(0, \sigma^2)$. All analyses were
run in R 4.3.1.^[Code and data are available from the authors on
request.]

\newpage

# Results {#sec:results}

We recorded 2,814 bee visits belonging to 61 species. Ground sites
yielded 58 species and roofs 37. Mean rarefied richness was lower on
roofs (paired difference $-6.4$, 95% CI $[-9.1, -3.7]$).

The difference narrowed with substrate depth
($\hat\beta_1 = 0.42$ species per cm, $p = 0.013$) but was not
detectably related to roof height ($p = 0.31$), in contrast to
@macivor2015 [p. 6]. Ground-nesting *Andrena* and *Lasioglossum* were
the most strongly under-represented genera on roofs, while
cavity-nesting *Hylaeus* were, if anything, more frequent there.

![Rarefied species richness by site type and substrate depth.](figures/richness.png){#fig:richness width=60%}

# Discussion {#sec:discussion}

Our results agree with earlier work showing that roofs are poorer bee
habitat than the ground [@macivor2015; @tonietto2011], but suggest the
gap depends on design. Deeper substrate supports a wider range of
plants and may allow some ground-nesting species to establish, as has
been suggested elsewhere \cite{kratschmer2018}.

Two limitations should be noted. Our roofs were not randomly selected:
owners had to agree to access, and roofs with more ambitious planting
may be over-represented. And two seasons is short; bee populations
fluctuate a great deal from year to year [-@williams2014].

# Conclusion {#sec:conclusion}

Green roofs are not a substitute for ground-level habitat, but deeper,
more varied roofs come closer. Planning guidance that specifies a
minimum substrate depth of around 15 cm would likely improve their
value for bees.

# References
