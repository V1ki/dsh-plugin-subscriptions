# 图片账号调度

[English](./image-account-pool.md) · [文档目录](./README.zh.md)

`image_generate` 的生图与编辑请求都通过 `ImageAccountPool` 发送。它读取与对话相同的实时服务商账号列表，但维护独立的图片健康状态与会话亲和：对话目录和对话用量快照并不能证明图片权限或图片配额。

首次请求按默认账号优先的顺序尝试。请求成功后，会建立按会话、按服务商隔离的亲和关系，并在生图与编辑之间共享。明确的 HTTP 429、401/403、402/404 拒绝，以及 `ACCOUNT_SUSPENDED` 都可以触发切换到同一服务商的其他账号。遇到 401 时，会先刷新该账号令牌并重试一次再切换。若服务商返回了重置时间，则按该时间计算冷却；否则使用现有账号池冷却常量（`ACCOUNT_SUSPENDED` 与认证/凭据错误使用 24 小时 `AUTH_COOLDOWN_MS`，限流使用 5 分钟 `DEFAULT_QUOTA_COOLDOWN_MS`，402/404 使用 60 秒 `TRANSIENT_COOLDOWN_MS`）。登录或登出操作会清空图片健康状态与亲和记录；已移除的账号不会继续保留在候选列表中。

参数错误、传输层故障、超时、5xx 以及响应解码或存储失败不会自动重发图片请求，因为上游在这些情况下可能已经生成了图片。账号耗尽时不会跨服务商切换；当首选服务商未登录时回退到另一服务商的既有行为保持不变。

设置 `pool.enabled: false` 或 `pool.autoAccounts: false` 会禁用自动图片账号调度（`autoFamilies` 仍作为旧版兼容别名受支持）。对话侧的 `strategy`、`families` 与 `tiers` 不会控制图片请求。
