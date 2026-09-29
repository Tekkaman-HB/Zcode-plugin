#!/usr/bin/env bash
set -euo pipefail

test -f AGENTS.md
test -f CLAUDE.md
test -f GEMINI.md
grep -q "AGENTS.md" CLAUDE.md
grep -q "AGENTS.md" GEMINI.md
grep -q "docs/README.md" AGENTS.md
grep -q "60-marketing" AGENTS.md
grep -q "70-research" AGENTS.md
grep -q "99-archive" AGENTS.md

# AI 编码行为准则：AGENTS.md 四律摘要段 + AI 编码指南详细章；缺失时用 docs-scaffold 补齐缺失段。
grep -q "## Behavior" AGENTS.md
grep -qF "先想后写" AGENTS.md
grep -qF "简单优先" AGENTS.md
grep -qF "外科手术式修改" AGENTS.md
grep -qF "目标驱动验证" AGENTS.md
grep -q "## 行为准则" docs/30-engineering/AI编码指南.md

# 条件检查：项目根存在 .trae/design/ 原型目录时，AGENTS.md 必须声明原型边界。
if [ -d ".trae/design" ]; then
  grep -q ".trae/design" AGENTS.md
fi

# 条件检查：智能体规范启用后，所有 AI 入口必须引用唯一规范源，且 policy-id 只能出现一次。
AGENT_POLICY="docs/00-context/智能体边界规范.md"
AGENT_DECISIONS="docs/20-architecture/智能体决策清单.md"
AGENT_REVIEW="docs/30-engineering/AI变更评审清单.md"
if [ -e "$AGENT_POLICY" ] || [ -e "$AGENT_DECISIONS" ] || [ -e "$AGENT_REVIEW" ]; then
  test -s "$AGENT_POLICY"
  test -s "$AGENT_DECISIONS"
  test -s "$AGENT_REVIEW"
  grep -qF "$AGENT_POLICY" AGENTS.md
  grep -qF "$AGENT_POLICY" docs/README.md
  grep -qF "智能体边界规范.md" docs/00-context/硬约束.md
  grep -qF "$AGENT_POLICY" docs/30-engineering/AI编码指南.md
  grep -qF "$AGENT_DECISIONS" AGENTS.md
  grep -qF "$AGENT_DECISIONS" docs/30-engineering/AI编码指南.md
  grep -qF "$AGENT_REVIEW" docs/30-engineering/AI编码指南.md
  grep -qF "$AGENT_POLICY" "$AGENT_REVIEW"
  POLICY_VERSION=$(sed -n 's/^policy-version:[[:space:]]*//p' "$AGENT_POLICY" | head -1)
  test -n "$POLICY_VERSION"
  grep -qF "generated-from: $AGENT_POLICY policy-version=$POLICY_VERSION" AGENTS.md
  grep -qF "generated-from: $AGENT_POLICY policy-version=$POLICY_VERSION" docs/00-context/硬约束.md
  grep -qF "generated-from: $AGENT_POLICY policy-version=$POLICY_VERSION" docs/30-engineering/AI编码指南.md
  grep -qF "agentic" "$AGENT_POLICY"
  grep -qF "workflow" "$AGENT_POLICY"
  grep -qF "hybrid" "$AGENT_POLICY"
  POLICY_ID_COUNT=$(
    grep -Il '^policy-id: agent-deterministic-boundary$' \
      AGENTS.md \
      docs/README.md \
      docs/00-context/*.md \
      docs/10-product/*.md \
      docs/20-architecture/*.md \
      docs/30-engineering/*.md \
      docs/40-operations/*.md \
      docs/50-planning/*.md \
      docs/80-dev/*.md \
      docs/90-ui-ux/*.md 2>/dev/null | wc -l | tr -d ' '
  )
  [ "$POLICY_ID_COUNT" -eq 1 ] || {
    echo "ai:check: agent-deterministic-boundary 必须且只能有一个可编辑规范源，当前为 $POLICY_ID_COUNT" >&2
    exit 1
  }
fi

echo "ai:check passed"
