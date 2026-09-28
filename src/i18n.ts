/**
 * [INPUT]: 依赖 vscode（vscode.env.language）
 * [OUTPUT]: 对外提供 t()（扩展宿主侧文案）
 * [POS]: i18n 扩展侧，extension.ts / providers 消费；webview 侧文案见 ui/webview/i18n.ts
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as vscode from 'vscode';

export type Locale = 'zh-CN' | 'en-US';

export function detectLocale(): Locale {
  const lang = vscode.env.language.toLowerCase();
  return lang.startsWith('zh') ? 'zh-CN' : 'en-US';
}

const strings = {
  'zh-CN': {
    loginTerminalTitle: 'ZCode 登录',
    loginStarted: '正在集成终端中启动 ZCode 登录…完成 OAuth 后回来即可。',
    logoutDone: '已退出 ZCode 登录。',
    logoutFailed: '登出失败：{msg}',
    appMissing: '未找到 ZCode 桌面端（{path}）。请在设置 zcode.appPath 中指定安装路径。',
    serverFailed: 'ZCode 服务启动失败：{msg}',
    noWorkspace: '请先打开一个文件夹再使用 ZCode。',
    openDesktopFailed: '无法打开 ZCode 桌面端：{msg}'
  },
  'en-US': {
    loginTerminalTitle: 'ZCode Login',
    loginStarted: 'Starting ZCode login in the integrated terminal… come back after OAuth.',
    logoutDone: 'Logged out of ZCode.',
    logoutFailed: 'Logout failed: {msg}',
    appMissing: 'ZCode desktop app not found ({path}). Set zcode.appPath to its install location.',
    serverFailed: 'ZCode server failed to start: {msg}',
    noWorkspace: 'Open a folder first to use ZCode.',
    openDesktopFailed: 'Cannot open ZCode desktop app: {msg}'
  }
} as const;

export type StringKey = keyof typeof strings['zh-CN'];

export function makeT(locale: Locale): (key: StringKey, vars?: Record<string, string>) => string {
  const table = strings[locale];
  return (key, vars) => {
    let s: string = table[key] ?? strings['en-US'][key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    }
    return s;
  };
}
