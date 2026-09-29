#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "docs:check: $*" >&2
  exit 1
}

remind_stale() {
  echo "docs:reminder: $1 本地最后修改时间超过 7 天，请考虑收敛"
}

require_heading() {
  local file="$1"
  local heading="$2"
  grep -Fqx "$heading" "$file" || fail "$file 缺少标题：$heading"
}

require_key() {
  local file="$1"
  local key="$2"
  grep -Eq "^${key}:[[:space:]]*[^[:space:]].*$" "$file" || fail "$file 缺少 frontmatter 字段：$key"
}

require_single_h1() {
  local file="$1"
  local count
  count=$(grep -Ec '^# [^#]' "$file" || true)
  [ "$count" -eq 1 ] || fail "$file 必须且只能包含一个一级标题"
}

test -s AGENTS.md
test -s README.md
test -s docs/README.md

test -s docs/00-context/README.md
test -s docs/10-product/README.md
test -s docs/20-architecture/README.md
test -s docs/30-engineering/README.md
test -s docs/40-operations/README.md
test -s docs/50-planning/README.md
test -s docs/80-dev/README.md
test -s docs/90-ui-ux/README.md
test -f docs/60-marketing/README.md
test -f docs/70-research/README.md
test -f docs/99-archive/README.md

# 保护目录只检查路径，不读取文件内容。
for readme in \
  docs/00-context/README.md \
  docs/10-product/README.md \
  docs/20-architecture/README.md \
  docs/30-engineering/README.md \
  docs/40-operations/README.md \
  docs/50-planning/README.md \
  docs/80-dev/README.md \
  docs/90-ui-ux/README.md; do
  require_heading "$readme" "## 目标"
  require_heading "$readme" "## 放什么"
  require_heading "$readme" "## 不放什么"
  require_heading "$readme" "## 命名格式"
  require_heading "$readme" "## 内容格式"
  require_heading "$readme" "## 编写要求"
done

test -s docs/00-context/项目简介.md
test -s docs/00-context/需求清单.md
test -s docs/00-context/硬约束.md
test -s docs/10-product/业务流程.md
test -s docs/10-product/验收标准.md
test -s docs/20-architecture/架构概览.md
test -s docs/30-engineering/环境搭建.md
test -s docs/30-engineering/命令清单.md
test -s docs/30-engineering/AI编码指南.md
test -s docs/40-operations/环境说明.md
test -s docs/40-operations/运维手册.md
test -s docs/50-planning/路线图.md
test -s docs/50-planning/变更记录.md
test -f docs/60-marketing/产品定位.md
test -f docs/60-marketing/发布说明.md
test -f docs/70-research/参考资料.md
test -f docs/70-research/备选方案.md
test -s docs/90-ui-ux/页面清单.md
test -s docs/90-ui-ux/交互模式.md

for file in \
  docs/00-context/项目简介.md \
  docs/00-context/需求清单.md \
  docs/00-context/硬约束.md \
  docs/10-product/业务流程.md \
  docs/10-product/验收标准.md \
  docs/20-architecture/架构概览.md \
  docs/30-engineering/环境搭建.md \
  docs/30-engineering/命令清单.md \
  docs/30-engineering/AI编码指南.md \
  docs/40-operations/环境说明.md \
  docs/40-operations/运维手册.md \
  docs/50-planning/路线图.md \
  docs/50-planning/变更记录.md \
  docs/90-ui-ux/页面清单.md \
  docs/90-ui-ux/交互模式.md; do
  require_key "$file" "status"
  require_key "$file" "owner"
  require_key "$file" "last-reviewed"
  require_single_h1 "$file"
done

# 条件检查：存在智能体边界规范或决策清单时，两者必须同时存在且结构完整。
AGENT_POLICY="docs/00-context/智能体边界规范.md"
AGENT_DECISIONS="docs/20-architecture/智能体决策清单.md"
AGENT_REVIEW="docs/30-engineering/AI变更评审清单.md"
if [ -e "$AGENT_POLICY" ] || [ -e "$AGENT_DECISIONS" ] || [ -e "$AGENT_REVIEW" ]; then
  test -s "$AGENT_POLICY" || fail "$AGENT_POLICY 缺失或为空（智能体边界唯一规范源）"
  test -s "$AGENT_DECISIONS" || fail "$AGENT_DECISIONS 缺失或为空（项目决策映射）"
  test -s "$AGENT_REVIEW" || fail "$AGENT_REVIEW 缺失或为空（AI 变更评审入口）"
  require_key "$AGENT_POLICY" "status"
  require_key "$AGENT_POLICY" "owner"
  require_key "$AGENT_POLICY" "last-reviewed"
  require_key "$AGENT_POLICY" "policy-id"
  require_key "$AGENT_POLICY" "policy-version"
  require_single_h1 "$AGENT_POLICY"
  require_heading "$AGENT_POLICY" "## 3. 总原则"
  require_heading "$AGENT_POLICY" "## 4. 运行模式"
  require_heading "$AGENT_POLICY" "## 12. 新增确定性逻辑的六问门禁"
  require_heading "$AGENT_POLICY" "## 17. 评测和测试"
  require_key "$AGENT_DECISIONS" "status"
  require_key "$AGENT_DECISIONS" "owner"
  require_key "$AGENT_DECISIONS" "last-reviewed"
  require_key "$AGENT_DECISIONS" "policy-source"
  require_key "$AGENT_DECISIONS" "policy-version"
  require_single_h1 "$AGENT_DECISIONS"
  require_heading "$AGENT_DECISIONS" "## 路径清单"
  require_heading "$AGENT_DECISIONS" "## 决策命题"
  require_heading "$AGENT_DECISIONS" "## 正式副作用"
  require_heading "$AGENT_DECISIONS" "## 已批准例外与 ADR"
  require_heading "$AGENT_DECISIONS" "## 待确认"
  require_key "$AGENT_REVIEW" "status"
  require_key "$AGENT_REVIEW" "owner"
  require_key "$AGENT_REVIEW" "last-reviewed"
  require_key "$AGENT_REVIEW" "policy-source"
  require_single_h1 "$AGENT_REVIEW"
  require_heading "$AGENT_REVIEW" "## 变更记录"
  require_heading "$AGENT_REVIEW" "## 评审结论"
fi

while IFS= read -r file; do
  name=${file##*/}
  case "$name" in
    README.md|路线图.md|变更记录.md) continue ;;
  esac
  [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[^[:space:]-][^[:space:]]*\.md$ ]] || \
    fail "$file 临时计划必须使用无空格的 YYYY-MM-DD-中文主题.md"
  require_key "$file" "status"
  require_key "$file" "owner"
  require_key "$file" "last-reviewed"
  require_single_h1 "$file"
  require_heading "$file" "## 目标与范围"
  require_heading "$file" "## 里程碑与依赖"
  require_heading "$file" "## 状态与验收"
  [ -z "$(find "$file" -prune -mtime +7 -print)" ] || remind_stale "$file"
done < <(find docs/50-planning -maxdepth 1 -type f -name '*.md' -print)

while IFS= read -r file; do
  name=${file##*/}
  [ "$name" = "README.md" ] && continue
  [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[^[:space:]-][^[:space:]]*\.md$ ]] || \
    fail "$file 必须使用无空格的 YYYY-MM-DD-中文主题.md"
  require_key "$file" "status"
  require_key "$file" "owner"
  require_single_h1 "$file"
  require_heading "$file" "## 问题与目标"
  require_heading "$file" "## 当前实际情况"
  require_heading "$file" "## 优化方案"
  [ -z "$(find "$file" -prune -mtime +7 -print)" ] || remind_stale "$file"
done < <(find docs/80-dev -maxdepth 1 -type f -name '*.md' -print)

# 条件检查：项目根存在 .trae/design/ 原型目录时，docs 必须登记原型关联。
if [ -d ".trae/design" ]; then
  PROTO_INDEX="docs/90-ui-ux/原型索引.md"
  test -s "$PROTO_INDEX" || fail "检测到 .trae/design/，但 $PROTO_INDEX 缺失或为空（原型登记表）"
  require_key "$PROTO_INDEX" "status"
  require_key "$PROTO_INDEX" "owner"
  require_key "$PROTO_INDEX" "last-reviewed"
  require_single_h1 "$PROTO_INDEX"
  require_heading "$PROTO_INDEX" "## 原型登记"
  PROTO_COUNT=$(find .trae/design -maxdepth 1 -mindepth 1 -not -name '.*' | wc -l | tr -d ' ')
  if [ "$PROTO_COUNT" -gt 0 ]; then
    grep -E '^\|' "$PROTO_INDEX" | grep -qF "](../../.trae/design/" || fail "$PROTO_INDEX 未登记任何 .trae/design/ 原型链接"
  fi
  while IFS= read -r rel; do
    target=${rel#../../}
    target=${target%%#*}
    [ -e "$target" ] || fail "$PROTO_INDEX 原型链接失效：$rel"
  done < <(grep -E '^\|' "$PROTO_INDEX" | grep -oE '\]\(\.\./\.\./\.trae/design/[^)]+\)' | sed -e 's/^](//' -e 's/)$//')
fi

echo "docs:check passed"
