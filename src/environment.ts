/**
 * [INPUT]: 依赖 node:fs/path/os/child_process/crypto，读取 package.json 配置项
 * [OUTPUT]: 对外提供 ZcodeEnvironment 解析（CLI/配置路径/node 回退/内置 revision 指纹）
 * [POS]: 环境探测层（仅 macOS），被 extension.ts / account.ts / serverManager.ts / scripts/smoke.ts 消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';

export interface EnvironmentOverrides {
  appPath?: string;
  nodePath?: string;
}

export interface ZcodeEnvironment {
  appRoot: string;
  cliPath: string;
  builtinConfigPath: string;
  personalConfigPath: string;
  credentialsPath: string;
  settingPath: string;
  /** node 可执行文件与附加环境（ELECTRON_RUN_AS_NODE 回退时非空） */
  nodeCommand: string;
  nodeExtraEnv: Record<string, string>;
  /** zcode-builtin:<revision>:<sha256(realpath(builtin))>，账户推送的握手暗号 */
  builtinRevision: string | null;
  cliExists: boolean;
  builtinExists: boolean;
  personalConfigExists: boolean;
  credentialsExist: boolean;
  settingExists: boolean;
  platform: NodeJS.Platform;
}

/** 仅支持 macOS；其他平台需通过 zcode.appPath 显式指定 */
function detectAppRoot(override?: string): string {
  if (override && override.trim()) return path.resolve(override.trim());
  return '/Applications/ZCode.app';
}

/** 解析运行 CLI 的 node：配置 → PATH → VSCode 内置（ELECTRON_RUN_AS_NODE） */
function resolveNode(nodePath?: string): { command: string; extraEnv: Record<string, string> } {
  if (nodePath && nodePath.trim()) return { command: nodePath.trim(), extraEnv: {} };
  const probe = spawnSync('node', ['--version'], { timeout: 5000 });
  if (probe.status === 0) return { command: 'node', extraEnv: {} };
  // 扩展宿主进程即 Electron，以 node 模式运行自身
  return { command: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * 计算内置 provider 配置的 revision 指纹。
 * 与 CLI 内 NodeZCodeBuiltinProviderConfigSource 的算法保持一致：
 *   `zcode-builtin:<file.revision>:<sha256hex(realpath(activeFilePath))>`
 * 注意：桌面端以 activeFilePath（缓存副本）为准；本插件直接指向应用内置文件，
 * realpath 后哈希——与 CLI 加载同一文件时指纹一致，账户推送校验即可通过。
 */
export function computeBuiltinRevision(builtinPath: string): string | null {
  try {
    const raw = fs.readFileSync(builtinPath, 'utf8');
    const parsed = JSON.parse(raw) as { revision?: number | string };
    if (parsed.revision === undefined) return null;
    const real = fs.realpathSync(builtinPath);
    const hash = crypto.createHash('sha256').update(real).digest('hex');
    return `zcode-builtin:${parsed.revision}:${hash}`;
  } catch {
    return null;
  }
}

export function resolveEnvironment(overrides: EnvironmentOverrides = {}): ZcodeEnvironment {
  const appRoot = detectAppRoot(overrides.appPath);
  const home = process.env.HOME ?? '';
  const v2 = path.join(home, '.zcode', 'v2');

  const cliPath = path.join(appRoot, 'Contents', 'Resources', 'glm', 'zcode.cjs');
  const builtinConfigPath = path.join(appRoot, 'Contents', 'Resources', 'config', 'provider', 'zcode-builtin.json');
  const personalConfigPath = path.join(v2, 'provider_config.json');
  const credentialsPath = path.join(v2, 'credentials.json');
  const settingPath = path.join(v2, 'setting.json');

  const exists = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  const node = resolveNode(overrides.nodePath);

  return {
    appRoot,
    cliPath,
    builtinConfigPath,
    personalConfigPath,
    credentialsPath,
    settingPath,
    nodeCommand: node.command,
    nodeExtraEnv: node.extraEnv,
    builtinRevision: exists(builtinConfigPath) ? computeBuiltinRevision(builtinConfigPath) : null,
    cliExists: exists(cliPath),
    builtinExists: exists(builtinConfigPath),
    personalConfigExists: exists(personalConfigPath),
    credentialsExist: exists(credentialsPath),
    settingExists: exists(settingPath),
    platform: process.platform
  };
}
