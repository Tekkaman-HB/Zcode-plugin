/**
 * [INPUT]: 依赖 node:fs 的凭据读取（经 ./credentials 间接）、全局 fetch/AbortSignal.timeout（Node 18+）
 * [OUTPUT]: 对外提供 QuotaWindowUsage/QuotaUsagePayload 类型、parseQuotaLimits（纯解析）、fetchCodingPlanQuota（单次拉取）、QuotaMonitor（轮询器）
 * [POS]: 根级套餐额度层——智谱 Coding Plan 5 小时/每周用量查询，extension.ts 装配轮询并经 chatProvider 推 webview 圆环
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 接口契约（桌面端 app.asar + cc-switch 源码双向实证，2026-10）：
 *   GET {open.bigmodel.cn|api.z.ai}/api/monitor/usage/quota/limit
 *   Authorization: <coding-plan api-key>（裸 key，无 Bearer 前缀——智谱特有，与 OAuth Bearer 通道并存）
 *   data.limits[]: { type:'TOKENS_LIMIT'|'CREDIT_LIMIT', unit:3=5小时|6=每周, percentage(已用%), nextResetTime(ms) }
 *   data.level: 套餐等级（如 max/pro）
 * 注意：这是账户后端直连通道，与已移除的 usage/stats（CLI 协议 token 统计）无关，勿混淆。
 * 安全约束：api-key 只进请求头，严禁日志/遥测/错误消息。
 */
import { decryptCredentials } from './credentials';

/** 单窗口用量：percent=已用百分比（0-100），resetAt=窗口重置毫秒时间戳 */
export interface QuotaWindowUsage {
  percent: number;
  resetAt: number | null;
}

export interface QuotaUsagePayload {
  fiveHour: QuotaWindowUsage | null;
  weekly: QuotaWindowUsage | null;
  /** 套餐等级（max/pro/...），服务端不给为 null */
  level: string | null;
}

/** 凭据表 → { 主机, api-key }。主机跟随桌面端 active provider；key 多把时 individual 优先、team 最后 */
function resolveTarget(values: Map<string, string | null>): { host: string; apiKey: string } | null {
  const active = (values.get('oauth:active_provider') ?? '').trim();
  const host = active === 'zai' ? 'https://api.z.ai' : 'https://open.bigmodel.cn';
  let best: { rank: number; key: string } | null = null;
  for (const [name, value] of values) {
    if (!value || !name.startsWith('account-provider:coding-plan:account:') || !name.endsWith(':api-key')) continue;
    const rank = name.includes('-individual-') ? 0 : name.includes('-team-') ? 2 : 1;
    if (!best || rank < best.rank) best = { rank, key: value };
  }
  return best ? { host, apiKey: best.key } : null;
}

/**
 * 解析 quota/limit 响应 data 为双窗口用量（宽容解析，多余字段容忍）。
 * 窗口锚定 unit 字段（3=5 小时 / 6=每周）——勿按重置时间排序代替：周期末尾每周窗口
 * 会早于 5 小时窗口重置，时间排序必然把两桶标反（cc-switch issue #3036 实证）。
 * 兜底（unit 缺失/不识别）：无重置时间者优先归 5 小时（0% 态可能无 reset），其余按重置升序补空槽；
 * 老套餐只回一条 TOKENS_LIMIT，自然降级为仅 5 小时环。
 */
export function parseQuotaLimits(data: unknown): QuotaUsagePayload {
  const level = (data as { level?: unknown } | null | undefined)?.level;
  const lvl = typeof level === 'string' ? level.trim() || null : null;
  const limits = (data as { limits?: unknown } | null | undefined)?.limits;
  if (!Array.isArray(limits)) return { fiveHour: null, weekly: null, level: lvl };
  type Entry = { percent: number; resetAt: number | null };
  let fiveHour: Entry | null = null;
  let weekly: Entry | null = null;
  const unclassified: Entry[] = [];
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const type = typeof it.type === 'string' ? it.type : '';
    if (!/^(tokens_limit|credit_limit)$/i.test(type)) continue;
    const percent = typeof it.percentage === 'number' && Number.isFinite(it.percentage) ? it.percentage : 0;
    const resetAt = typeof it.nextResetTime === 'number' && Number.isFinite(it.nextResetTime) ? it.nextResetTime : null;
    const entry: Entry = { percent, resetAt };
    if (it.unit === 3) fiveHour ??= entry;
    else if (it.unit === 6) weekly ??= entry;
    else unclassified.push(entry);
  }
  unclassified.sort((a, b) =>
    (a.resetAt === null ? 0 : 1) - (b.resetAt === null ? 0 : 1) || (a.resetAt ?? 0) - (b.resetAt ?? 0));
  for (const e of unclassified) {
    if (!fiveHour) fiveHour = e;
    else if (!weekly) weekly = e;
  }
  return { fiveHour, weekly, level: lvl };
}

/**
 * 单次拉取套餐用量。null = 无凭据/非 coding-plan（webview 据此隐藏圆环）；
 * throw = 网络/服务失败（调用方保留旧值静默处理）。
 */
export async function fetchCodingPlanQuota(credentialsPath: string): Promise<QuotaUsagePayload | null> {
  const creds = decryptCredentials(credentialsPath);
  if (!creds) return null;
  const target = resolveTarget(creds.values);
  if (!target) return null;
  const res = await fetch(`${target.host}/api/monitor/usage/quota/limit`, {
    headers: {
      // 裸 key：智谱额度接口特有约定（cc-switch 实证），加 Bearer 前缀反而 401
      Authorization: target.apiKey,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`quota HTTP ${res.status}`);
  const body = await res.json() as { success?: boolean; msg?: string; data?: unknown };
  if (body.success === false) throw new Error(`quota: ${body.msg ?? 'refused'}`);
  return parseQuotaLimits(body.data);
}

// ═══════════════ 轮询器 ═══════════════

const REFRESH_MS = 5 * 60_000;
/** 两次真实网络拉取的最小间隔（refreshNow 高频触发时防打爆） */
const MIN_GAP_MS = 30_000;

export class QuotaMonitor {
  private timer: NodeJS.Timeout | undefined;
  private last: QuotaUsagePayload | null = null;
  private inFlight = false;
  private lastFetchedAt = 0;

  constructor(
    private readonly credentialsPath: () => string,
    private readonly push: (p: QuotaUsagePayload | null) => void
  ) {}

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** webview（重）挂载：缓存秒显，后台立即刷新校准 */
  refreshNow(): void {
    if (this.last) this.push(this.last);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.inFlight || Date.now() - this.lastFetchedAt < MIN_GAP_MS) return;
    this.inFlight = true;
    try {
      const snap = await fetchCodingPlanQuota(this.credentialsPath());
      this.lastFetchedAt = Date.now();
      this.last = snap;
      this.push(snap);
    } catch {
      /* 失败静默：圆环保留最后一次已知值，辅助信息绝不打断主流程 */
    } finally {
      this.inFlight = false;
    }
  }
}
