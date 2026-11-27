# 文档目录

[English](./README.md) · [中文说明](../README.zh.md)

`dsh-plugin-subscriptions` 的功能参考与架构文档（快速上手与总览请见[中文说明](../README.zh.md)）。

- [账号与模型管理](./account-management.zh.md) — 显示名称、账号别名、自动账号池参与、模型白名单、独立账号模型入口、Claude 提示缓存有效期及 Antigravity 手动启用说明。
- [配置与本地存储](./configuration-and-storage.zh.md) — 完整 YAML 配置项、环境变量以及 `~/.dsh/plugins/subscriptions/` 本地目录布局。
- [服务商参考](./providers.zh.md) — Codex、Claude、Grok、GitHub Copilot 与 Google Antigravity 的认证流程、上游端点、协议细节与高级选项。
- [账号池与限流机制](./pool-and-rate-limits.zh.md) — 账号池调度策略、故障分类、冷却时间、429 重试策略及 Codex 重置卡防误触机制。
- [用量追踪](./usage-tracking.zh.md) — 用量看板存储结构、配额窗口生命周期、多进程并发持久化以及状态栏额度徽章缓存。
- [图片账号调度](./image-account-pool.zh.md) — `image_generate` 的 `ImageAccountPool` 故障切换、会话亲和、冷却与重试边界。
- [Antigravity 输出图片](./antigravity-output-images.zh.md) — Antigravity `inlineData` 图片响应的持久化附件契约、准入/失败边界及隔离宿主兼容性检查。
- [开发指南](./development.zh.md) — DSH 宿主兼容性策略、构建与单元测试命令、离线 Playwright UI 回归脚本、发布流程与仓库结构。
- [`images/`](./images/) — README 与 [`screenshots.json`](../screenshots.json) 引用的界面截图。
