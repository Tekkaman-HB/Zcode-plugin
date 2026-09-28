/**
 * [INPUT]: 消费 ./chat（ChatApp）与 ../bridge 的契约类型
 * [OUTPUT]: webview 聊天入口——装配 vscode webview API 并挂载 ChatApp
 * [POS]: webview 的入口文件（esbuild browser target），被 chatProvider 的 HTML 引用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { ChatApp } from './chat';
import type { FromWebviewMessage, ToWebviewMessage } from '../bridge';

declare function acquireVsCodeApi(): {
  postMessage(msg: FromWebviewMessage): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const api = acquireVsCodeApi();
const app = new ChatApp();
const root = document.getElementById('app');
if (root) {
  app.mount(root);
  app.setApi(api);
  api.postMessage({ kind: 'ready' });
}

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as ToWebviewMessage;
  app.onMessage(msg);
});
