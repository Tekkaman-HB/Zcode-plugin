/**
 * [INPUT]: 无外部依赖（类型契约 + 纯函数事件守卫）
 * [OUTPUT]: 对外提供 ZCode app-server 协议的全部 TS 类型（方法参数/结果/事件/权限契约）与 asSessionEvent/asStateUpdated 通知守卫
 * [POS]: protocol 的类型面，被 rpc.ts / serverManager.ts / sessionController.ts / webview 消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 类型来源：对 zcode.cjs 0.16.9 bundle 的逆向分析 + 实测验证。
 * 原则：宽进严出——服务端未知字段一律容忍（不标记 excess），已知字段精确标注。
 */

// ═══════════════ 传输层 ═══════════════

/** 服务端 → 客户端反向请求（带 id 的 method 消息，必须应答） */
export interface RpcServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

/** 通知（无 id 的 method 消息） */
export interface RpcNotification {
  method: string;
  params?: unknown;
}

// ═══════════════ 通用结构 ═══════════════

export interface WorkspaceRef {
  workspacePath: string;
  workspaceKey: string;
}

export type SessionMode = 'plan' | 'build' | 'edit' | 'yolo' | 'auto';

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'paused' | 'completed' | 'error';

export interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}

export interface SessionInfo {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  mode: SessionMode;
  status: SessionStatus;
  title: string;
  sessionKind: string;
  workspace: WorkspaceRef;
  traceId?: string;
  target?: string | null;
}

export interface ReasoningOptions {
  levels: { value: string; label: string }[];
  defaultLevel: string;
}

export interface AvailableModel {
  ref: ModelSelection;
  label: string;
  providerLabel: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning?: ReasoningOptions;
  properties?: unknown;
}

export interface SessionSettings {
  mode: { current: SessionMode };
  model: {
    available: AvailableModel[];
    current?: ModelSelection;
    lastUsed?: ModelSelection;
  };
  permission: { mode: string };
  thoughtLevel?: {
    available?: { value: string; label: string }[];
    current?: string;
    enabled: boolean;
  };
}

export interface SlashCommand {
  name: string;
  description: string;
  inputHint: string;
  source: string;
}

/** 会话状态投影（state.updated 的 patch 基准 / create 响应的 projection） */
export interface SessionProjection {
  sessionId: string;
  status: SessionStatus;
  mode: SessionMode;
  turnCount: number;
  totalTokenCount: number;
  contextUsed: number;
  contextWindow: number;
  currentTurnId?: string;
  pendingPermissions: PendingPermission[];
  activeToolCalls: {
    toolCallId: string;
    toolName?: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'denied';
    startedAt?: string;
  }[];
  backgroundJobs: unknown[];
  target?: string | null;
}

export interface SessionCreateResult {
  protocol: { name: string; version: number };
  session: SessionInfo;
  settings: SessionSettings;
  projection: SessionProjection;
  runtime: {
    eventSeq: number;
    pendingRequestIds: unknown[];
    stateRevision: number;
    [k: string]: unknown;
  };
  messages: SessionMessage[];
  todos?: unknown[];
  todoGroups?: unknown[];
  slashCommands?: SlashCommand[];
}

export interface SessionListItem {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  mode: SessionMode;
  status: SessionStatus;
  title: string;
  titleSource?: string;
  sessionKind: string;
  workspace: WorkspaceRef;
}

export interface SessionListResult {
  sessions: SessionListItem[];
}

/** session/subscribe 结果：backlog 事件 + 当前 eventSeq */
export interface SessionSubscribeResult {
  sessionId: string;
  eventSeq: number;
  events: SessionEvent[];
  snapshot?: unknown;
}

// ═══════════════ 消息与部件 ═══════════════

export interface MessageInfo {
  role: 'user' | 'assistant' | 'system' | string;
  messageId?: string;
  [k: string]: unknown;
}

export interface PartBase {
  partId: string;
  sessionId: string;
  messageId: string;
}

export interface TextPart extends PartBase {
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
}

export interface ReasoningPart extends PartBase {
  type: 'reasoning';
  text: string;
}

export interface FilePart extends PartBase {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
}

export type ToolStatus =
  | { status: 'pending'; input: unknown; raw?: string }
  | { status: 'running'; input: unknown; title?: string; startedAt?: string }
  | { status: 'completed'; input: unknown; output: string; title: string; startedAt?: string; completedAt?: string }
  | { status: 'error'; input: unknown; error: string; startedAt?: string; completedAt?: string }
  | { status: string; input?: unknown; [k: string]: unknown };

export interface ToolPart extends PartBase {
  type: 'tool';
  callId: string;
  tool: string;
  state: ToolStatus;
}

export interface StepStartPart extends PartBase { type: 'step-start'; snapshot?: string }
export interface StepFinishPart extends PartBase { type: 'step-finish'; reason: string; cost?: number }
export interface SnapshotPart extends PartBase { type: 'snapshot'; snapshot: string }
export interface PatchPart extends PartBase { type: 'patch'; hash: string; files: string[] }
export interface CompactionPart extends PartBase { type: 'compaction'; auto: boolean; reason?: string }
export interface TimelinePart extends PartBase { type: 'timeline'; timelineType: string; display: string; [k: string]: unknown }
export interface UnknownPart extends PartBase { type: string & {}; [k: string]: unknown }

export type MessagePart =
  | TextPart | ReasoningPart | FilePart | ToolPart
  | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | CompactionPart | TimelinePart | UnknownPart;

export interface SessionMessage {
  info: MessageInfo;
  parts: MessagePart[];
}

// ═══════════════ 事件（session/event 通知） ═══════════════

export type SessionEventType =
  | 'session.created' | 'session.resumed' | 'session.updated' | 'session.titleUpdated' | 'session.closed'
  | 'turn.started' | 'turn.steerQueued' | 'turn.steerDrained' | 'turn.completed' | 'turn.failed'
  | 'message.upserted' | 'message.removed'
  | 'part.started' | 'part.delta' | 'part.upserted' | 'part.removed'
  | 'model.streaming'
  | 'tool.updated'
  | 'permission.requested' | 'permission.resolved'
  | 'userInput.requested' | 'userInput.resolved'
  | 'checkpoint.created' | 'rewind.triggered' | 'streamRecovery.updated'
  | string; // 未知事件容忍

/** session/event 事件信封（宽松） */
export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  messageId?: string;
  partId?: string;
  turnId?: string;
  seq?: number;
  timestamp?: number;
  [k: string]: unknown;
}

/** part.delta 事件负载 */
export interface PartDeltaEvent extends SessionEvent {
  type: 'part.delta';
  messageId: string;
  partId: string;
  field?: 'text' | 'reasoning' | 'input' | 'output';
  delta: string;
}

/** turn.completed payload.usage：本回合 token 账目（contextUsed 的协议原生来源） */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  [k: string]: unknown;
}

/** model.streaming 事件负载 */
export interface ModelStreamingEvent extends SessionEvent {
  type: 'model.streaming';
  assistantMessageId?: string;
  delta?: string;
  done?: boolean;
  kind?: string;
  partId?: string;
  toolCallId?: string;
  toolName?: string;
}

/** state.updated 通知负载 */
export interface StateUpdatedEvent {
  type: 'state.updated';
  scope: 'server' | 'workspace' | 'session';
  sessionId?: string;
  workspace?: WorkspaceRef;
  revision: number;
  reason?: string;
  patch?: Partial<SessionProjection> & Record<string, unknown>;
}

// ═══════════════ 权限契约 ═══════════════

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type PermissionDecision = 'allow' | 'deny' | 'escalate' | 'modify';

export interface PermissionRuleUpdate {
  type: 'addRules';
  behavior: 'allow' | 'deny' | 'ask';
  rules: { toolName: string; ruleContent?: string }[];
}

export interface PermissionResponse {
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
  permissionUpdates?: PermissionRuleUpdate[];
}

export interface PermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: PermissionResponse;
}

/** interaction/requestPermission 反向请求参数 */
export interface PermissionRequestParams {
  requestId: string;
  sessionId: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  reason: string;
  riskLevel: RiskLevel;
  input: unknown;
  origin?: unknown;
  options: PermissionOption[];
}

/** projection.pendingPermissions 元素 */
export interface PendingPermission {
  requestId: string;
  toolCallId: string;
  toolName: string;
  reason: string;
  riskLevel: RiskLevel;
  input?: unknown;
  options: PermissionOption[];
  requestedAt?: string;
}

// ═══════════════ 用户输入契约（AskUserQuestion） ═══════════════

/** requestUserInput 的问题元素（probe 实证 zcodePromptAttachmentSchema 家族） */
export interface UserInputQuestion {
  question: string;
  header: string;
  options: { value: string; label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
}

/** interaction/requestUserInput 反向请求参数（bundle 逆向 pUi schema） */
export interface UserInputRequestParams {
  requestId: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  prompt?: string;
  questions?: UserInputQuestion[];
  input?: unknown;
  [k: string]: unknown;
}

/** 应答：accept 时 content.answers 以 question.header 为键 */
export interface UserInputResponse {
  action: 'accept' | 'decline' | 'cancel';
  content?: { answers?: Record<string, unknown>; answer?: unknown };
  reason?: string;
}

// ═══════════════ 运行时偏好反向请求 ═══════════════

export interface RuntimePrefsParams {
  sessionId: string;
  scope: 'runtime-materialization' | 'user-execution';
}

export interface RuntimePrefsResult {
  nativeSearchEnhancementsEnabled: boolean;
  memoryEnabled: boolean;
  askUserQuestionAutoResolutionEnabled: boolean;
  modelContextBudgetStrategy: 'legacy' | 'preflight-v1';
  /** 判别联合：auto | {mode:'shell', dialect...}（后者仅 Windows）——不是纯字符串 */
  integratedTerminalShell?: string | { mode: string; dialect?: string };
}

// ═══════════════ 账户推送 ═══════════════

export interface AccountProviderEntry {
  builtinModelIds: string[];
  access: { type: 'zhipu-account'; entitled: boolean };
}

export interface AccountProviderState {
  availability: 'available' | 'pending' | 'unavailable' | 'unknown';
  entitled: boolean;
  current?: boolean;
  connectionKey?: string;
  effectiveAt?: number;
}

export interface AccountSnapshot {
  revision: string;
  basedOnZCodeBuiltinRevision: string;
  providers: Record<string, AccountProviderEntry>;
  states: Record<string, AccountProviderState>;
}

// ═══════════════ 使用量 ═══════════════

export type UsageRange = 'all' | '7d' | '30d';

/** usage/stats 结果（仅标注 UI 消费的字段，其余容忍） */
export interface UsageStatsResult {
  range: UsageRange;
  totals: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    modelRequestCount: number;
    modelErrorCount: number;
  };
  turnTotals?: {
    totalSessions: number;
    totalTurns: number;
    avgTurnDurationMs: number | null;
    longestSessionMs: number;
  };
  models?: { ref?: ModelSelection; label?: string; totalTokens?: number }[];
  [k: string]: unknown;
}

// ═══════════════ MCP 遥测（process/mcpTelemetry 通知） ═══════════════

export interface McpTelemetryEvent {
  kind: 'process_start' | 'process_crash' | 'session_startup' | 'memory' | string;
  mcpId?: string;
  /** session_startup 汇总 */
  configuredCount?: number;
  connectedCount?: number;
  failedCount?: number;
  processCount?: number;
  sessionId?: string;
  [k: string]: unknown;
}

// ═══════════════ 运行时守卫（通知参数 → 事件类型） ═══════════════

/** session/event 通知参数守卫 */
export function asSessionEvent(params: unknown): SessionEvent | null {
  if (params && typeof params === 'object' && 'type' in params) return params as SessionEvent;
  return null;
}

/** state.updated 通知参数守卫 */
export function asStateUpdated(params: unknown): StateUpdatedEvent | null {
  if (params && typeof params === 'object' && (params as { type?: string }).type === 'state.updated') {
    return params as StateUpdatedEvent;
  }
  return null;
}
