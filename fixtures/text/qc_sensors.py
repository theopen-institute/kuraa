#!/usr/bin/env python3
"""Flag sensor readings outside plausible ranges."""
from __future__ import annotations

import csv
import sys
from dataclasses import dataclass

LIMITS = {"temp_c": (-40.0, 60.0), "rh_pct": (0.0, 100.0)}


@dataclass
class Reading:
    station: str
    field: str
    value: float

    def plausible(self) -> bool:
        lo, hi = LIMITS.get(self.field, (float("-inf"), float("inf")))
        return lo <= self.value <= hi


def main(path: str) -> int:
    bad = 0
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            r = Reading(row["station"], row["field"], float(row["value"]))
            if not r.plausible():
                print(f"{r.station}\t{r.field}\t{r.value!r}", file=sys.stderr)
                bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
