---
title: Lab Notebook — Protein Crystallisation Trials
author: K. Oyelaran-Hoffmann
project: LYS-2024
---

# Week 12 {#week-12}

## Monday {#mon}

Set up a new 96-well screen for the [His-tagged lysozyme]{.construct}
variant, using the sitting-drop plates from the new batch. Protein
concentration after the last spin was 18 mg/mL by A~280~.

::: {.note}
The new plates have a slightly shallower reservoir. Use 70 µL rather
than 80 µL or the drop well floods when the seal is pressed down.
:::

Drop ratio 1:1, 200 nL + 200 nL, dispensed with the robot. Plates
moved to the 20 °C incubator at 14:10.

## Tuesday {#tue}

First inspection at 24 h. Nothing in most wells; light precipitate in
the high-PEG corner (rows G–H, columns 9–12). Wells B4 and C4 show
small needles, maybe 10 µm long.

::: {.warning}
The incubator door was found ajar at 08:30. Logger shows the
temperature reached 23.4 °C at some point overnight. Note this against
the whole batch.
:::

Called [Dr. Lindgren]{.smallcaps} about the needles. Her advice: don't
get excited yet, they could be salt. Check with UV.

## Wednesday {#wed}

UV imaging: the needles in B4 and C4 fluoresce, so they are protein.
Conditions for B4:

- 0.1 M sodium acetate, pH 4.6
- 1.0 M NaCl
- 25% (v/v) glycerol

::::: {.result #res-b4}
Protein crystals confirmed in B4 and C4.

:::: {.details}
Both wells share the acetate buffer and high salt. C4 has slightly less
NaCl (0.8 M). The crystals are thin needles, unsuitable for
diffraction as they are.

::: {.todo}
Set up an optimisation screen around B4: vary NaCl from 0.6 to 1.4 M in
0.2 M steps and pH from 4.2 to 5.0 in 0.2 steps.
:::
::::
:::::

The optimisation grid is $5 \times 5 = 25$ conditions, set up in
duplicate on one plate.

## Thursday {#thu}

Set up the optimisation plate as planned. Also tried a few drops with
[seeding]{.technique data-source="B4"}: crushed needles from B4,
diluted 1:100 and 1:1000 in reservoir solution, streaked through fresh
drops with a cat whisker.

::: {.note title="On seeding"}
Seed stock is in the 4 °C fridge, tube labelled **SS-B4-01**. It is
good for about a week. After that, make fresh seeds from whatever
crystals are biggest.
:::

## Friday {#fri}

Quick look at the optimisation plate. Too early to tell, but several
drops at 1.0–1.2 M NaCl and pH 4.6–4.8 already have more needles than
the original hits, and the seeded drops at 1:100 dilution are
[noticeably cloudy]{.underline}, which might be a shower of tiny
crystals.

Plan for next week:

1. Inspect daily.
2. If anything bigger than 50 µm appears, harvest one with a loop and
   test on the home source.
3. Book synchrotron time for the end of the month regardless.

::: {.signoff}
[K. O.-H.]{.initials}, 16:45
:::
