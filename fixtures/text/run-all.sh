#!/usr/bin/env bash
# Rebuild everything from raw data.
set -euo pipefail

cd "$(dirname "$0")"
for script in R/*.R; do
  echo "== ${script}"
  Rscript --vanilla "$script" || { echo "failed: $script" >&2; exit 1; }
done
quarto render --to html
