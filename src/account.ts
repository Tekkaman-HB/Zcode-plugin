/**
 * [INPUT]: 依赖 node:fs/path，读取 credentials.json / setting.json / zcode-builtin.json
 * [OUTPUT]: 对外提供 buildAccountSnapshot / watchCredentials / 探测登录态
 * [POS]: 账户层——把桌面端 OAuth 登录态翻译成 CLI 的 provider/updateAccountConfig 快照
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AccountSnapshot, AccountProviderEntry, AccountProviderState } from './protocol/types';

export interface AccountUserInfo {
  email?: string;
  name?: string;
}

export interface AccountStatus {
  loggedIn: boolean;
  user?: AccountUserInfo;
  /** 当前选中的 providerId（states.current=true 者） */
  currentProviderId?: string;
  providerIds: string[];
  providerLabels: Record<string, string>;
}

export interface BuiltAccount {
  snapshot: AccountSnapshot | null;
  status: AccountStatus;
}

interface BuiltinRule {
  providerId: string;
  providerName?: string;
  config?: {
    group?: string;
    builtinModelIds?: string[];
    access?: { type?: string; mode?: string; accountType?: string };
    [k: string]: unknown;
  };
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** credentials.json 里的键 → 拥有的 coding plan provider 集合 */
function extractEntitledProviders(credentials: Record<string, unknown>): Set<string> {
  const owned = new Set<string>();
  for (const key of Object.keys(credentials)) {
    // 形如 account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:<uid>:api-key
    const m = /^account-provider:coding-plan:account:([a-z0-9][a-z0-9-]*):account:\d+:api-key$/.exec(key);
    if (m) owned.add(`account:${m[1]}`);
  }
  return owned;
}

function parseUserInfo(credentials: Record<string, unknown>): AccountUserInfo | undefined {
  for (const key of Object.keys(credentials)) {
    const m = /^oauth:([a-z0-9-]+):user_info$/.exec(key);
    if (!m) continue;
    const raw = credentials[key];
    try {
      const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (info && typeof info === 'object') {
        const o = info as Record<string, unknown>;
        return {
          email: typeof o.email === 'string' ? o.email : undefined,
          name: typeof o.name === 'string' ? o.name : (typeof o.nickname === 'string' ? o.nickname : undefined)
        };
      }
    } catch {
      /* 忽略无法解析的 user_info */
    }
  }
  return undefined;
}

/**
 * 由桌面端文件构造账户快照。
 * - 拥有判定：credentials.json 中的 coding-plan api-key 键 × builtin 的 zhipu-account 规则取交集
 * - 当前选择：setting.json 的 providerFamilyDomain + providerFamilyConnectionSelections[domain].kind
 */
export function buildAccountSnapshot(
  builtinConfigPath: string,
  credentialsPath: string,
  settingPath: string,
  basedOnZCodeBuiltinRevision: string | null
): BuiltAccount {
  const emptyStatus: AccountStatus = { loggedIn: false, providerIds: [], providerLabels: {} };
  const builtin = readJson<{ revision?: number; config?: { providerConfigRules?: { providerRules?: BuiltinRule[] } } }>(builtinConfigPath);
  const credentials = readJson<Record<string, unknown>>(credentialsPath);
  const setting = readJson<{
    providerFamilyDomain?: string;
    providerFamilyConnectionSelections?: Record<string, { kind?: string }>;
  }>(settingPath);

  if (!builtin || !basedOnZCodeBuiltinRevision) {
    return { snapshot: null, status: emptyStatus };
  }

  const rules = builtin.config?.providerConfigRules?.providerRules ?? [];
  const accountRules = rules.filter((r) => r.config?.access?.type === 'zhipu-account');

  const owned = credentials ? extractEntitledProviders(credentials) : new Set<string>();
  const entitled = accountRules.filter((r) => owned.has(r.providerId));

  if (entitled.length === 0) {
    // 无任何 coding plan 凭据：是否至少有 OAuth 登录（可引导去登录/订阅）
    const oauth = credentials ? Object.keys(credentials).some((k) => /^oauth:[a-z0-9-]+:access_token$/.test(k)) : false;
    return {
      snapshot: null,
      status: {
        loggedIn: oauth,
        user: credentials ? parseUserInfo(credentials) : undefined,
        providerIds: [],
        providerLabels: {}
      }
    };
  }

  // 当前选择：桌面端 setting 优先，回退第一个
  const domain = setting?.providerFamilyDomain;
  const kind = domain ? setting?.providerFamilyConnectionSelections?.[domain]?.kind : undefined;
  let currentId: string | undefined;
  if (domain && kind) {
    const candidate = `account:${domain}-${kind}`;
    if (entitled.some((r) => r.providerId === candidate)) currentId = candidate;
  }
  if (!currentId) currentId = entitled[0].providerId;

  const providers: Record<string, AccountProviderEntry> = {};
  const states: Record<string, AccountProviderState> = {};
  const labels: Record<string, string> = {};
  const providerIds: string[] = [];
  for (const rule of entitled) {
    providers[rule.providerId] = {
      builtinModelIds: rule.config?.builtinModelIds ?? [],
      access: { type: 'zhipu-account', entitled: true }
    };
    states[rule.providerId] = {
      availability: 'available',
      entitled: true,
      current: rule.providerId === currentId
    };
    labels[rule.providerId] = rule.providerName ?? rule.providerId;
    providerIds.push(rule.providerId);
  }

  const snapshot: AccountSnapshot = {
    revision: `zcode-vscode:${Date.now()}`,
    basedOnZCodeBuiltinRevision,
    providers,
    states
  };

  return {
    snapshot,
    status: {
      loggedIn: true,
      user: credentials ? parseUserInfo(credentials) : undefined,
      currentProviderId: currentId,
      providerIds,
      providerLabels: labels
    }
  };
}

export interface CredentialsWatcher {
  stop(): void;
}

/** 监听凭据目录变化（登录/登出即时生效） */
export function watchCredentials(credentialsPath: string, onChange: () => void): CredentialsWatcher {
  const dir = path.dirname(credentialsPath);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, (_event, file) => {
      if (stopped) return;
      if (file && (file === 'credentials.json' || file.startsWith('credentials'))) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(onChange, 500); // 写入可能分多步，去抖
      }
    });
  } catch {
    // 目录不存在（未登录过）：忽略
  }
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    }
  };
}
