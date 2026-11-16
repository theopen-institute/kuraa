# Lab meeting — 14 May

Present: Akira, Bea, Chidi, Dana, Søren (chair)\
Apologies: Fatima

Notes taken by Bea. Corrections to bea.lindqvist@example.org by Friday.


## 1. Actions from last meeting

- [x] Chidi to re-run the pilot with the corrected stimulus timings
- [x] Dana to book the eye tracker for June
- [ ] Akira to draft the preregistration ~~by 10 May~~ now by 21 May
- [ ] Søren to chase the ethics amendment

The ethics amendment is still with the committee. Søren spoke to the
secretary, who said it should be considered at the meeting on 28 May
2024. The committee has a backlog, so a decision before June is
unlikely.


## 2. Pilot results

Chidi summarised the re-run. With the corrected timings the
manipulation check now works: participants in the high-load condition
reported more effort (mean 5.8 vs 4.1 on the 7-point scale). The
reaction time effect is in the expected direction but small.

Discussion points:

- Is the sample (n = 24) big enough to say anything about the RT
  effect? General view: no, treat it as a feasibility check only.
- Bea pointed out that the `trial_onset_ms` column is off by one frame
  in the first block. Chidi will check whether this is the logging
  script or the monitor refresh.
- Dana asked whether we should drop the practice block from the
  analysis. Agreed: yes, and say so in the prereg.


## 3. Preregistration

Akira has a skeleton draft on the shared drive under
`prereg/draft_v2.docx`. Main open questions:

1. Exclusion criteria — do we exclude on accuracy below 70% or below
   chance?
2. Primary outcome — median RT per participant, or a mixed model on
   trial-level RTs?
3. Stopping rule — fixed *N* or sequential Bayes factor?

Brief discussion, no decisions. Akira will circulate options before
the next meeting. Søren suggested looking at how the Hendricks lab
handled the same question in their 2022 paper; Bea thinks they used a
sequential design with a maximum *N* of 120.



## 4. Equipment

The eye tracker is booked for 3–28 June. Dana noted that the head rest
is cracked; it still works but should be replaced. Quote from the
supplier is £180. Søren will check whether this can come out of the
consumables budget.

The new response boxes arrived. Two of the five have a sticky left
button. Returned to the supplier on Monday.


## 5. AOB

- Fatima's viva is on 30 May, everyone welcome to the celebration
  afterwards
- Departmental seminar next week is cancelled
- Reminder that the shared drive will be migrated over the weekend of
  25 May; do not leave files open


## Actions

- [ ] Akira — circulate prereg options (by 21 May)
- [ ] Chidi — check the off-by-one in `trial_onset_ms`
- [ ] Dana — get a second quote for the head rest
- [ ] Søren — budget check for the head rest; chase ethics

Next meeting: 28 May, same room.
