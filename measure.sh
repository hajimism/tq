#!/usr/bin/env bash
# Compare what an agent reads the usual way (grep, then Read whole files) with `tq context`.
# Run inside the target project:  ../tq/measure.sh lintVisualDeck renderSlideHtml asResolvedDeck
# Baseline is a lower bound: it leaves out Read's line-number prefixes, type files, and test files.
set -euo pipefail
TQ="$(cd "$(dirname "$0")" && pwd)/tq.ts"
tok() { echo $(( ($1 + 3) / 4 )); }
printf "%-20s %9s %9s %7s %7s %6s\n" symbol grep+def +callers tq_ctx tq_ms files
for s in "$@"; do
  g=$(grep -rnw "$s" src tests 2>/dev/null | wc -c | tr -d ' ')
  def=$(bun "$TQ" find "$s" | awk -v s="$s" -F'[# ]' '$2==s{print $1; exit}')
  d=$(wc -c < "$def" | tr -d ' ')
  c=0; n=0
  while read -r f; do
    [ -n "$f" ] || continue
    c=$((c + $(wc -c < "$f"))); n=$((n + 1))
  done < <(bun "$TQ" callers "$s" --all | grep -E '^  src/' | sed -E 's/^  ([^:]+):.*/\1/' | sort -u | grep -vx "$def" || true)
  t0=$(perl -MTime::HiRes=time -e 'print int(time*1000)')
  q=$(bun "$TQ" context "$s" | wc -c | tr -d ' ')
  t1=$(perl -MTime::HiRes=time -e 'print int(time*1000)')
  printf "%-20s %9s %9s %7s %7s %6s\n" "$s" "$(tok $((g + d)))" "$(tok $((g + d + c)))" "$(tok "$q")" $((t1 - t0)) $((n + 1))
done
