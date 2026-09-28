/**
 * [INPUT]: 依赖 ../../protocol/types 的 PermissionRequestParams，./render 的 h()/diffBlock()/jsonBlock()，./i18n
 * [OUTPUT]: 对外提供 resolveToolFamily()/toolPreview()/previewBody()/displayReason()/originBadge()（工具身份分流与权限预览）
 * [POS]: webview 交互层的预览子层——对标桌面端 toolIdentity + permission-request-preview，被 ./interaction 的权限卡消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { PermissionRequestParams } from '../../protocol/types';
import { h, diffBlock, isAskUserQuestion } from './render';
import type { Translate } from './i18n';

// ═══════════════ 来源徽章（对标桌面端 InteractionRequestOriginBadge） ═══════════════

/** origin 仅 subagent 一种有 UI（桌面端同款）；title 提示具体 agentType */
export function originBadge(origin: unknown, t: Translate): HTMLElement | null {
  const o = origin as { kind?: string; agentType?: string } | null | undefined;
  if (!o || o.kind !== 'subagent') return null;
  const badge = h('span', { class: 'origin-badge' }, t('originSubagent'));
  if (o.agentType) badge.title = t('originSubagentTitle', { agentType: o.agentType });
  return badge;
}

// ═══════════════ 展示文案与工具身份预览（对标桌面端 permission-request-preview + toolIdentity） ═══════════════

/** 协议诊断用 reason，不是给用户看的具体说明（桌面端同款过滤） */
const NON_USER_FACING_REASONS = new Set([
  'High risk tools require explicit approval',
  'Tool has side effects and requires approval'
]);

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 非用户可读的协议诊断文案 → null */
export function userFacingText(v: unknown): string | null {
  const s = nonEmpty(v);
  return s && !NON_USER_FACING_REASONS.has(s) ? s : null;
}

/** 展示用理由：优先工具入参里的 description/summary，其次请求 reason；滤掉泛用策略文案 */
export function displayReason(req: PermissionRequestParams): string {
  const raw = (req.input ?? {}) as Record<string, unknown>;
  return userFacingText(raw.description) ?? userFacingText(raw.summary) ?? userFacingText(raw.reason)
    ?? userFacingText(req.reason) ?? '';
}

/** 工具身份（桌面端 resolveToolCallFamily 的最小移植）：决定权限卡主体用什么语言展示 */
export type ToolFamily =
  | 'edit' | 'write' | 'execute' | 'search' | 'skill' | 'mcp'
  | 'switchMode' | 'askQuestion' | 'files' | 'fallback';

function normalizedToolToken(...names: (string | undefined)[]): string[] {
  return names
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .map((n) => n.trim().toLowerCase().replace(/[\s_]+/g, ''));
}

export function resolveToolFamily(toolName: string, input: unknown): ToolFamily {
  const rec = (input ?? {}) as Record<string, unknown>;
  const tokens = normalizedToolToken(toolName);
  const isRec = typeof rec === 'object' && rec !== null;

  // AskUserQuestion：questions 载荷或工具名（判定唯一事实源在 render.isAskUserQuestion）
  if (isAskUserQuestion(toolName, input)) {
    return 'askQuestion';
  }
  // 计划模式退出：占位动画而非参数预览（桌面端同款分流）
  if (tokens.some((x) => x.startsWith('exitplan') || x === 'switchmode')) return 'switchMode';
  // MCP：不是普通未知工具，单独展示名称与协议 reason，避免摊开 raw JSON
  if (tokens.some((x) => x.startsWith('mcp'))) return 'mcp';
  // Skill：title/kind === skill 或入参带 skill 字符串
  if (tokens.some((x) => x === 'skill') || (isRec && typeof rec.skill === 'string')) return 'skill';
  // 搜索族：WebFetch/WebSearch 只展示用户关心的 URL/query
  if (tokens.some((x) => x.startsWith('webfetch') || x.startsWith('websearch'))) return 'search';
  if (isRec && typeof rec.old_string === 'string' && typeof rec.new_string === 'string') return 'edit';
  if (isRec && typeof rec.content === 'string' && typeof rec.file_path === 'string') return 'write';
  if (isRec) {
    for (const [k, v] of Object.entries(rec)) {
      const key = k.toLowerCase();
      if ((key === 'command' || key === 'cmd' || key === 'script' || key === 'shellcommand') && typeof v === 'string' && v.trim()) {
        return 'execute';
      }
    }
  }
  const paths = extractPaths(rec);
  if (paths.length) return 'files';
  return 'fallback';
}

const FILE_KEYS = new Set([
  'path', 'paths', 'file', 'file_path', 'filepath', 'files',
  'filename', 'filenames', 'target', 'targets', 'location', 'locations'
]);

function extractPaths(rec: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const [k, v] of Object.entries(rec ?? {})) {
    if (!FILE_KEYS.has(k.toLowerCase())) continue;
    if (typeof v === 'string' && v) paths.push(v);
    else if (Array.isArray(v)) for (const p of v) if (typeof p === 'string' && p) paths.push(p);
  }
  return paths;
}

interface ToolPreview {
  family: ToolFamily;
  file?: string;
  oldStr?: string;
  newStr?: string;
  command?: string;
  url?: string;
  skillName?: string;
  mcpName?: string;
  paths: string[];
}

export function toolPreview(req: PermissionRequestParams): ToolPreview {
  const rec = (req.input ?? {}) as Record<string, unknown>;
  const family = resolveToolFamily(req.toolName, req.input);
  const paths = extractPaths(rec);
  const file = paths[0]?.split('/').pop();
  const base: ToolPreview = { family, paths };
  switch (family) {
    case 'edit':
      return { ...base, file, oldStr: String(rec.old_string), newStr: String(rec.new_string) };
    case 'write':
      return { ...base, file, newStr: String(rec.content) };
    case 'execute': {
      let command = '';
      for (const [k, v] of Object.entries(rec)) {
        const key = k.toLowerCase();
        if ((key === 'command' || key === 'cmd' || key === 'script' || key === 'shellcommand') && typeof v === 'string') {
          command = v;
          break;
        }
      }
      const args = rec.args ?? rec.argv;
      if (Array.isArray(args)) command += ' ' + args.filter((a) => typeof a === 'string').join(' ');
      return { ...base, command };
    }
    case 'search':
      return { ...base, url: nonEmpty(rec.url) ?? nonEmpty(rec.query) ?? nonEmpty(rec.prompt) ?? '' };
    case 'skill':
      return { ...base, skillName: nonEmpty(rec.skill) ?? nonEmpty(rec.name) ?? nonEmpty(rec.command) ?? '' };
    case 'mcp':
      return { ...base, mcpName: req.toolName };
    default:
      return base;
  }
}

export function previewBody(preview: ToolPreview, t: Translate): HTMLElement | null {
  switch (preview.family) {
    case 'edit':
      return h('div', { class: 'perm-preview' },
        h('div', { class: 'tool-card-label' }, `${t('permPreviewDiff')} · ${preview.file ?? ''}`),
        diffBlock(preview.oldStr!, preview.newStr!));
    case 'write':
      return h('div', { class: 'perm-preview' },
        h('div', { class: 'tool-card-label' }, `${t('permPreviewNewFile')} · ${preview.file ?? ''}`),
        h('pre', { class: 'json-block diff-add' }, preview.newStr!));
    case 'execute':
      return h('div', { class: 'perm-preview' },
        h('div', { class: 'tool-card-label' }, t('permPreviewCommand')),
        h('pre', { class: 'json-block' }, preview.command!));
    case 'search':
      return h('div', { class: 'perm-preview' },
        h('div', { class: 'tool-card-label' }, t('permPreviewSearch')),
        h('pre', { class: 'json-block' }, preview.url || ''));
    case 'skill':
      return h('div', { class: 'perm-preview' },
        h('div', { class: 'tool-card-label' }, t('permPreviewSkill')),
        h('pre', { class: 'json-block' }, preview.skillName || ''));
    case 'mcp':
      return h('div', { class: 'perm-preview' },
        h('div', { class: 'tool-card-label' }, 'MCP'),
        h('pre', { class: 'json-block' }, preview.mcpName ?? ''));
    case 'files':
      return h('div', { class: 'perm-preview perm-file-chips' },
        ...preview.paths.slice(0, 6).map((p) => h('span', { class: 'perm-file-chip' }, p)));
    default:
      return null;
  }
}

