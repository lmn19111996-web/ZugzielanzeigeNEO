# Rescheduling Prediction Model — Review Report

Nov 11, 2026 · @Julian

## Summary

The model predicts how the planner's user reschedules a disrupted day, and on unbiased test days it gets 74% of trains right versus 57% for simply pushing everything back. It is ready to roll out for time predictions; cancellation predictions should be shown softly or not at all.

The model is a learned cost model. For each disrupted day it builds the timetables the user could plausibly choose and picks the one that is cheapest by costs learned from the user's own past choices. It was trained and evaluated on 101 sandbox levels: realistic hypothetical days with disruptions drawn from the user's real logs, which the user resolved by hand.

| Measure (25 random test levels, 148 trains) | Model | Push baseline |
| --- | --- | --- |
| Trains predicted right (cancel decision matches, start within 10 min) | **74%** | 57% |
| Average start error on kept trains | **12 min** | 33 min |
| Error in when the day ends | **11 min** | 21 min |
| User's cancellations predicted | 9 of 23 | 0 |
| Cancellations predicted that the user did not make | 8 of 125 kept trains | 0 |

The most recent 40 levels were the best so far (83% and 78% of trains right per block of about 20). The main remaining limit is not data but expressiveness: in 38 of 101 levels the user resolved the day with a move the model cannot build, such as starting a train earlier than planned.

## How the model works

The model chooses among whole candidate timetables, not train by train: it predicts the day the user would pick, by the user's own learned priorities.

&#91;embedded content: how a prediction is made and learned · 6 steps, one loop\]

### 1. Candidate timetables

Everything from the first disruption on is a decision. For every such train the model considers keeping or cancelling it, plus at most one special move per timetable:

| Move | What it does |
| --- | --- |
| Push | A kept train starts once the trains planned before it are done, plus a break |
| Hold | A train stays at its planned time and overlaps (rarely chosen) |
| Shorten to fit | A train is shortened so it ends before the next one, leaving a full break or only a 5-minute transition ("trim") |
| Move behind | A train jumps behind a later train (e.g. a film moved after dinner); the train it jumps behind may shrink to make room |
| Full breaks | After a late task the whole day keeps full breaks instead of the planned gaps |

A typical level has 1,000–10,000 distinct candidate timetables.

### 2. Learned costs

Each candidate gets a cost; the prediction is the cheapest. Costs are learned from which timetable the user actually chose (multinomial logit, maximum likelihood with a pull toward starting values).

| Cost | Per |
| --- | --- |
| Delay | hour a train starts later than planned |
| Cancellation | cancelled train |
| Shortening | hour cut from a train |
| Missed minutes | hour of a fixed appointment missed by arriving late |
| Skipping | skipped fixed appointment |
| Relocation | train moved behind another |
| Missing break | hour of break missing between tasks |
| Overlap, day ending late | hour |

The per-train costs are layered: overall → line ranking tier → line → task family → template. A task family groups templates with the same role, such as the seven weekday Morning Rituals. A family with little data behaves like its line; with more data it develops its own costs. This is how the model forms its own tier list of anchors and sacrificial tasks instead of relying on a declared ranking.

### 3. Learned patterns

Re-learned every 5 levels from the user's choices:

- **Breaks:** break after a task grows with its length; currently 14 minutes per hour of task.
- **Linked pairs:** two tasks that move as one block, keeping their planned gap (Morning Rituals → Fitness Studio, 19 of 20 cases).
- **Slack:** how far a task may move later at most, and how short it may get (the shortest length the user has ever given it).

### 4. Two explicit rules

Day-start trains and fixed appointments are declared in the settings, not learned (see Explicit rules).

### 5. Live prediction and training

While the user edits a day, the model picks the cheapest candidate that agrees with every decision already made and shows its proposal for the remaining trains. After each finished level the server refits the costs in a background thread, so the next level is predicted with everything learned so far.

## Data and evaluation method

Every score in this report is prequential: each level is scored against the prediction the model made at the start of that level, trained only on levels played before it.

### Data

|  | Count |
| --- | --- |
| Levels played and kept | 101 (1 discarded, 7 skipped as unrealistic) |
| Random test levels | 25 (every 4th level) |
| Selected levels | 76, of which 22 practice levels for fixed appointments |
| Train decisions (trains after the first disruption) | 761 |
| Disruptions | 125 late starts, 30 late arrivals at fixed appointments |

The levels were played on 11 November 2026. An earlier study of 54 levels with a previous model is archived and not used here.

### How levels are made

- **The day:** the recurring trains of a real date in the next four weeks, made conflict-free, plus one-off trains from the logs.
- **The disruptions:** drawn from the user's real logs. How many per day follows real days (1–3); which train follows how often it really starts late; the size comes from that train's own real late starts, capped at the 90th percentile and 3 hours. Fixed appointments are only ever disrupted by a late arrival. Real logs contain no overruns, so none are generated.
- **The selection:** selected levels are the candidate days where the model learns most (high uncertainty, rarely seen trains, new combinations). Every 4th level is a random realistic day instead: the unbiased test.
- **The user's job:** resolve the day as they really would. A disruption is a fact and is never undone; cancelling, moving later, shortening or relocating the disrupted train is allowed.

### Scoring

A train counts as right when the cancel decision matches and, if kept, its start is within 10 minutes. The baseline is push: every train kept and moved later only as far as the trains before it force.

### Caveats for reviewers

- **Anchoring:** on selected levels the model's proposal is visible while the user solves, which can pull the user toward it. Test levels hide it until the end, so they are the headline figure.
- **Changing engine:** the model was extended during the 101 levels (task families, fixed appointments, new moves). Stored scores therefore mix model versions; replays with the current engine agree within a few percentage points.
- **One user, one day of play:** all levels were played by the planner's single user in one session; behaviour on other days of the year is not covered.

## Overall accuracy

The model beats push on every measure in every group of levels, and the gap holds across the whole run.

| Group | Levels | Trains right (model / push) | Avg. start error, min (model / push) | Day-end error, min (model / push) | Cancellations caught | False cancellations |
| --- | --- | --- | --- | --- | --- | --- |
| Random test levels | 25 | 74% / 57% | 12.2 / 32.8 | 10.7 / 20.8 | 9 of 23 | 8 of 125 |
| Selected levels | 76 | 73% / 62% | 11.6 / 20.4 | 14.2 / 18.4 | 27 of 96 | 19 of 517 |
| All levels | 101 | 73% / 61% | 11.7 / 23.3 | 13.4 / 19.0 | 36 of 119 | 27 of 642 |

&#91;embedded content: sandbox\_data/episodes.jsonl · 101 levels, 11 Nov 2026 · start-of-level predictions\]

The dip at levels 41–63 coincides with a period of engine changes and four levels that were briefly saved twice (since removed). Part of push's improvement over the run comes from the generator becoming more realistic, which made levels easier; the gap to push is the fairer measure.

## Effectiveness by case

The model is reliable for the bulk of the day — trains left as planned, routine knock-on and fixed appointments — and weak where the user makes a special move: shortening, moving a train behind another or earlier, and cancelling the evening pair.

&#91;embedded content: sandbox\_data/episodes.jsonl · 761 train decisions in 101 levels · start-of-level predictions; right = cancel decision matches and start within 10 min (shortened: duration too)\]

Right column = second half of the levels, which reflects the current model best. Across all levels the model wrongly cancelled 27 of 642 trains the user kept (4%).

### Routine knock-on and untouched trains — strong

Trains the user leaves alone are predicted right 94% of the time; trains pushed later by an earlier delay went from 39% to 72% as the model learned breaks and per-family costs.

- **L1 (hit):** Selbststudium HM3 starts 5 min late. The model moves Abend to 18:35; the user chose 18:40.
- **L3 (hit):** after a long afternoon the model puts Abend at 19:50; the user chose 20:00.
- **L2 (miss):** the model squeezes Halbwocheneinkauf to 50 min at 10:40; the user kept it whole and pushed it to 11:45.

### Waking up late (day-start rule) — good after two fixes

Morning Rituals is predicted right 67–71% of the time; the misses were the model shortening the ritual, which the user never does below about 45 min.

- **L1 (before the rule):** the user overslept 3 h. The untrained model proposed skipping the ritual and keeping Tennis at 08:00. With the day-start rule it proposes ritual at 08:00 and Tennis cancelled, as the user did.
- **L60 (miss, since fixed):** the model cut the 60-min ritual to 30 min and put Fitness at 10:00; the user kept 60 min and started Fitness at 10:30. Since level 62 the shortest allowed length is learned (45 min); replayed, L60 now matches the user exactly.

### Fixed appointments — strong

The user's rule is sharp and the model has learned it: attend up to about 20 min late, skip beyond.

| Minutes late | Attended | Skipped |
| --- | --- | --- |
| 10 or less | 9 | 1 |
| 11–20 | 13 | 5 |
| 21–30 | 0 | 8 |
| More than 30 | 0 | 6 |

Learned skip threshold: about 20 min for most classes (Höhere Mathematik III 21, Thermodynamik 20, Deutsch 20), lower for the ones the user drops easily (Vortragsübung 15, Technische Mechanik III 14). Attending late is predicted right 94% of the time and skipping 63% in the second half (0% in the first half, before appointments had their own costs).

- **L24 (hit):** HM3 Gruppenübungen, joined 20 min late at 11:50.
- **L63 (hit):** Höhere Mathematik III skipped.
- **L19 (miss, early):** TM3 Tutorium 80 min late; the model would have joined for the last 10 min, the user skipped.

### Linked pair: Morning Rituals → Fitness Studio — pattern learned, prediction weak

The 30-min gap is learned (kept in 19 of 20 cases), but Fitness lands right only 38% of the time: the model shortened the ritual or Fitness itself before level 62.

- **L18 (miss):** the user started Fitness at 09:30, the model at 10:00.
- **L60 (replayed with the current model):** ritual 09:00–10:00, Fitness 10:30, as the user did.

### Cancellations — weak, by design acceptable

The model predicts 30% of the user's cancellations overall and wrongly cancels 4% of kept trains.

| Group | Caught, levels 52–102 |
| --- | --- |
| Fixed appointments (skipped) | 12 of 19 |
| One-off trains | 3 of 8 |
| Other recurring trains | 4 of 13 |
| Evening pair (Circe, Journaling) | 3 of 15 |

- **L8 (miss):** the user dropped Circe and Journaling to end the day; the model kept both at 21:30 and 22:00. Its learned cost of the day ending late is small, so lateness alone rarely justifies a cancellation.
- **L14 (hit):** Scheinklausur 2 (one-off) cancelled, as predicted.

### Shortening — weak

The user shortened 75 trains (Abend 20×, Fitness 11×, Samstagkoch 11×); the model matched the length only 23–25% of the time.

- **L26 (hit):** the over-planned afternoon — Selbststudium Thermodynamik trimmed to 115 min before the tutorial, TM3 cancelled.
- **L2 (miss):** the user cut Fitness to 60 min; the model kept 90.

### Moving behind another train — weak

In 22 levels the user's solution is closest to a relocation; the model predicted it 3 times.

- **L7 (hit):** Fitness moved behind the morning block to 14:05.
- **L3 (miss):** Fitness at 11:35; the model had 11:15.

### Moving a train earlier — not expressible

The user started 15 trains earlier than planned (in 6 levels); the model cannot build that move.

- **L12:** Abend moved from 19:00 to 18:30; the model kept 19:00.
- **L45:** Scheinklausur 9 moved from 17:35 to 15:45 into a freed slot.

### One-off trains — weak, expected

One-offs are known only through their line, so their knock-on (29%) and cancellations (38%) are educated guesses. A one-off S7 behaves like a typical S7 task.

## Explicit rules

Everything else is learned; only two facts about the world are declared, because costs cannot express them and early levels would otherwise produce impossible proposals.

| Rule | Set in | What the model does | Why it is not learned |
| --- | --- | --- | --- |
| Day start | Settings → Prognosemodell → Tagesbeginn, per task family (here: Morning Rituals) | Never cancels or moves the train behind another; nothing planned after it can start before it does; it may still be shortened | Oversleeping is a constraint on the whole day. Without the rule the model learned "skipping the ritual" as a way to keep Tennis at 08:00 (L1) |
| Fixed appointment | Settings → Prognosemodell → Feste Termine, per task family (lectures, tutorials, Tennis, dance) | Its end is fixed: arriving late means attending less; free only after its end means it can only be skipped; never relocated, held or extended; no hard lateness limit | A class does not start late or end late; the generator produced "class starts 3 h late" until the rule existed (L10, skipped as unrealistic) |

Both rules apply to the prediction model and the level generator only. The editor never adjusts what the user enters, by design: an automatic change would be data manipulation.

Task families are configurable in the same settings page (merge or split templates); they are grouping, not a behavioural rule.

## Known limitations

The largest limit is expressiveness: the model's candidate timetables reproduce the user's solution exactly in only 32 of 101 levels (roughly in 31 more, not at all in 38).

### Model

- **Moves it cannot build:** starting a train earlier than planned (15 cases) and combining two special moves in one day (for example shortening one train and moving another behind Abend). The share of each among the 38 unreproduced levels has not been counted yet.
- **The evening:** the learned cost of the day ending late is small, so cancelling Circe or Journaling to protect bedtime is rarely predicted (3 of 15 in the second half).
- **Lengths:** when the user shortens a train, the predicted length is right only about a quarter of the time.
- **One-off trains:** known only through their line.
- **Minimum lengths:** learned from the single shortest case (Morning Rituals: one 45-min case sets the floor).
- **Rounding:** the user often moves starts to the quarter hour; this is deliberately not modelled (predictions are estimates).

### Data and evaluation

- **One user, one session:** all 101 levels were played on 11 November 2026; no real days are used yet.
- **Anchoring:** proposals were visible on selected levels; only the 25 test levels are free of that.
- **Model changed during the run:** scores mix engine versions.
- **Untested situations:** overruns (none in the real logs, so none generated) and days with more than three disruptions.

### Engineering

- **Refit time grows with the number of levels:** a full refit took about 10 s at 57 levels. It now runs in a background thread, so the server stays responsive, but the next level may be predicted with a model one level behind.
- **Candidate sets:** up to about 10,000 timetables per day; adding moves (earlier, two specials) multiplies this and needs a search instead of full enumeration.

## Recommendations before rollout

Roll out the time predictions; show cancellation predictions softly or not at all.

### Rollout

1. **Show predicted times** for trains after a disruption in the live app, using the model as trained in the sandbox. This is where it is strong: 72–94% right on routine shifts, appointments and untouched trains.
2. **Show cancellations softly** ("könnte entfallen") or not at all. Keep them inside the prediction, so later times still account for them. A planner should not nudge its user to cancel.
3. **Keep the explicit rules and task families** as configured: day start = Morning Rituals; fixed appointments = lectures, tutorials, Tennis, dance.
4. **Do not train on real days yet.** Compare live predictions with what actually happens for a few weeks first, as an independent check of the sandbox results.

### Before or soon after

- [ ] Analyse the 38 levels the model cannot reproduce, to rank the missing moves (earlier, two special moves).
- [ ] Add "move earlier" if that analysis confirms it; replay all levels and keep it only if accuracy does not drop.
- [ ] Decide on a bedtime limit for the evening pair (learned or a third explicit rule).
- [ ] Speed up refits before the level count roughly doubles.

### Open questions for reviewers

- Is "start within 10 minutes and the right cancel decision" the right definition of a correct prediction for a planner?
- Should live cancellation predictions be hidden entirely, or shown with a probability?
- Is the sandbox-only evaluation enough for a first rollout, or should real-day validation come first?
- Should the learned minimum length use the shortest case or a more robust value (e.g. the second shortest)?

## Appendix

### Glossary

- **Train:** a task in the planner (line, name, planned start and length).
- **Level:** one hypothetical disrupted day in the sandbox, resolved by the user.
- **Push:** the baseline; every train kept, moved later only as far as the trains before it force.
- **Task family:** recurring templates with the same role (line + name, configurable).
- **Prequential:** each level predicted only from levels played before it.

### Learned shared costs (101 levels, fitted 11 Nov 2026)

Unit: 1 = the starting cost of 10 minutes of delay. Per-hour costs apply per hour of delay, shortening, missed time, missing break, overlap or lateness of the day's end.

| Cost | Starting value | Learned |
| --- | --- | --- |
| Delay, per hour | 6 | 1.62 |
| Cancellation | 6 | 3.34 |
| Fixed appointment: missed, per hour | 18 | 14.14 |
| Fixed appointment: skipped | 6 | 4.17 |
| Shortening, per hour | 6 | 2.46 |
| Moving behind another train | 6 | 0.83 |
| Missing break, per hour | 3 | 3.68 |
| Overlap, per hour | 18 | 11.73 |
| Day ending late, per hour | 3 | 1.74 |

Per-family values are added on top (layers: tier, line, family, template). Learned patterns: break 14 min per hour of task; one linked pair (Morning Rituals → Fitness Studio); slack limits for 21 families and minimum lengths for 22.

### Files and scripts

| Path | Purpose |
| --- | --- |
| `public/sandbox/engine/candidates.js` | Candidate timetables and the explicit rules |
| `public/sandbox/engine/patterns.js` | Breaks, linked pairs, slack, task families |
| `public/sandbox/engine/cost-model.js` | Costs, fitting, scoring, live prediction |
| `public/sandbox/sandbox-levels.js` | Level generator, practice mode |
| `sandbox-trainer.js`, `sandbox-trainer-worker.js` | Background refit after each level |
| `sandbox_data/episodes.jsonl` | The 102 recorded levels (data for this report) |
| `scripts/sandbox-eval.js` | Summary of stored scores (`node scripts/sandbox-eval.js --block 20`) |
