#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
  echo "Usage: $0 \"decision title\"" >&2
  exit 1
fi

ADR_DIR="docs/20-architecture/decisions"
mkdir -p "$ADR_DIR"
LAST=$(ls "$ADR_DIR"/*.md 2>/dev/null | sed -E 's#.*/([0-9]+)-.*#\1#' | sort -n | tail -1 || true)
NEXT=$((10#${LAST:-0} + 1))
NUM=$(printf "%04d" "$NEXT")
TITLE_PART=$(printf '%s' "$1" | sed 's#[/\\]#-#g; s/[[:space:]][[:space:]]*/-/g; s/-\{2,\}/-/g; s/^-*//; s/-*$//')
if [ -z "$TITLE_PART" ]; then
  echo "标题转换后的文件名为空" >&2
  exit 1
fi
TARGET="$ADR_DIR/$NUM-$TITLE_PART.md"
cp docs/templates/ADR模板.md "$TARGET"
sed -i.bak "s/^adr: .*/adr: $NUM/" "$TARGET" && rm -f "$TARGET.bak"
sed -i.bak "s/^date: .*/date: $(date +%F)/" "$TARGET" && rm -f "$TARGET.bak"
sed -i.bak "s/^# ADR-NNNN：.*/# ADR-$NUM：$1/" "$TARGET" && rm -f "$TARGET.bak"
echo "Created $TARGET"
