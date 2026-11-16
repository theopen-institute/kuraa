---
title: Methods — Survey Design and Weighting
author: Research Team, Wave 3
date: March 2024
---

# Sampling {#sampling}

The target population was adults aged 18 and over living in private
households in the four study regions. We drew a stratified two-stage
sample: postal districts were selected with probability proportional to
size, and households were then selected by simple random sampling
within each district.

Let $N_h$ be the number of households in stratum $h$ and $n_h$ the
number sampled. The first-stage inclusion probability for district $i$
in stratum $h$ is

$$
\pi_{hi} = \frac{m_h \, M_{hi}}{\sum_{j} M_{hj}}
$$

where $m_h$ is the number of districts drawn and $M_{hi}$ is the
measure of size. Household-level inclusion probabilities follow as
$\pi_{hik} = \pi_{hi} \cdot n_{hi} / N_{hi}$.

Fieldwork costs were budgeted per completed interview. Face-to-face
interviews cost $42 on average and telephone follow-ups about $15, so
the mixed-mode design saved roughly $9,000 against the original plan.
Respondents were offered a $10 voucher on completion.

# Fieldwork {#fieldwork}

Fieldwork proceeded in three phases:

1) Advance letter, with a link to the web questionnaire
2) Up to four face-to-face contact attempts for non-responding
   households
3) A final telephone reminder where a number was available

Interviewers were trained over two days. Training covered the consent
procedure, the show cards, and how to record partial interviews. The
fieldwork manager can be reached at fieldwork@example.org for queries
about specific cases.

# Response {#response}

| Region     | Issued | Achieved | Response rate |
|:-----------|-------:|---------:|:-------------:|
| North      |  1,200 |      702 |     58.5%     |
| South      |  1,150 |      621 |     54.0%     |
| East       |    980 |      590 |     60.2%     |
| West       |  1,070 |      546 |     51.0%     |
| **Total**  |  4,400 |    2,459 |   **55.9%**   |

: Issued and achieved sample by region {#tbl-response}

Response rates were calculated using AAPOR definition RR3, with the
eligibility rate among unknown-eligibility cases estimated from the
resolved cases in the same district.

# Weighting {#weighting}

Weights were constructed in four steps.

1. **Design weights.** The base weight for each respondent is the
   inverse of the household inclusion probability, multiplied by the
   number of eligible adults in the household:
   $d_k = a_k / \pi_{hik}$.
2. **Non-response adjustment.** We fitted a logistic model of response
   on district-level covariates and divided the design weight by the
   predicted response propensity $\hat{p}_k$.
3. **Calibration.** Weights were raked to population margins for age
   group, sex, region and tenure, using the 2021 census estimates.
4. **Trimming.** Weights above the 99th percentile were trimmed and the
   excess redistributed proportionally.

The calibration step solves

$$
\min_{w} \sum_{k \in s} \frac{(w_k - d_k)^2}{d_k}
\quad \text{subject to} \quad
\sum_{k \in s} w_k \mathbf{x}_k = \mathbf{t}_x
$$

for the vector of known totals $\mathbf{t}_x$.

## Design effect {#deff}

The design effect due to weighting was approximated with Kish's
formula, $\text{deff}_w = 1 + \text{CV}^2(w)$, giving a value of 1.38
for the full sample. Combined with the clustering effect, the overall
design effect for a typical proportion is around 1.9, and the effective
sample size is therefore roughly 1,290.

| Variable           | deff | Effective *n* |
|--------------------|-----:|--------------:|
| Trust in council   | 1.84 |         1,336 |
| Satisfied with GP  | 2.07 |         1,188 |
| Volunteered (12 m) | 1.71 |         1,438 |

# Variance estimation {#variance}

Standard errors were estimated by Taylor linearisation, treating
strata and primary sampling units as given in the variables `stratum`
and `psu_id`. Where a stratum contained only one PSU after fieldwork,
it was collapsed with its nearest neighbour as listed in
`stratum_collapse_map.csv`.

The final analysis weight is called final_wt in the released file.
Analysts who only need the design weights should use design_wt, and
those replicating the non-response model will find the fitted
propensities in nr_propensity_hat.
