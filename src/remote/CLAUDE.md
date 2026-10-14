# src/remote/
> L2 | 父级: /CLAUDE.md

## 成员清单
relayTypes.ts: 协议事实层——relay 线消息/应用载荷类型与手写校验器、心跳 jitter 常量与函数、RPC 帧上限、crc32/canonical-base64 二进制工具（对齐官方 shared/web-remote-control*，去 zod）
relayAuth.ts: 配对凭据层——password/passHash/proof 三算法（node:crypto）与 RelayDeviceAuth 两态、deviceMid/bridgeSessionId 生成；passHash 严禁日志
relayTransport.ts: 设备角色传输状态机——注册→挑战应答→配对→心跳→重连（移植桌面 webRemoteControlTransport，去埋点）；发送门=paired 且非怀疑态，超 1MiB oversize 拒绝
rpcFrameCodec.ts: rpc-frame 编解码——消息字节→分帧批次（二分解码预算）、装配状态机（重复指纹/间隙/元数据一致性/crc32 终验）、最坏信封计量
ackRelayProtocol.ts: ACK 可靠字节通道——出向批队列（8MiB 重放缓冲 admission）、入向装配→消息→合并 ACK、deadline 45s、高低水位流控；暴露 ByteProtocol 供上下对接
localServer.ts: 本地服务宿主——spawn zcode-server.cjs、zcode-hello 行握手、13 字节帧头解封/封装；stderr 仅转发不进状态机
pairingManager.ts: 配对编排——payload 路由（bootstrap/workspace-list/bridge-open/platform 降级）、单 bridge 生命周期（ready 后开闸 raw 帧）、出向缓冲 50 条/5s、workspace-list 推送去重、二维码 URL 组装
qrUrl.ts: 二维码入口——sid/hash/t/mid/name/app_version → zcode.z.ai/remote/v4 URL
index.ts: 门面——extension/pairingController/scripts 只经此消费

## 协议事实（勿重新推导，全量见根 CLAUDE.md「手机远控」节）

- 本目录全部文件 vscode 无关（纯 Node），scripts/smoke-relay.ts 经 esbuild 独立 bundle 直跑验证 relay 通道
- 桥接拓扑：手机 ChannelClient ⇄ relay(ack 协议) ⇄ [本目录] ⇄ 13 字节帧 ⇄ zcode-server stdio（ChannelServer）

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
