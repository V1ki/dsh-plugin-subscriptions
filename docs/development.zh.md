# 开发指南

[English](./development.md) · [文档目录](./README.zh.md)

本文档介绍 `dsh-plugin-subscriptions` 的宿主兼容性策略、构建与单元测试命令、离线 Playwright UI 回归脚本、自动发布流程与仓库结构。

## DSH 宿主兼容性与 Peer 依赖范围策略

- **当前开发/测试基线**：`package.json` 将所有 `@deepseek-ai/dsh-*` 的 devDependencies 锁定在 `0.2.3-alpha.2`，`@deepseek-ai/cordis` 为 `4.2.0-alpha.1`，`@deepseek-ai/schemastery` 为 `3.20.0-alpha.1`（要求 Node 24 与 `pnpm@10.26.2`）。
- **仅设下限的 Peer 依赖策略**：全部 5 个 `@deepseek-ai/dsh-*` peerDependencies（`@deepseek-ai/dsh-attachment`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-web`）统一声明为：
  ```
  >=0.2.0-rc.2 || >=0.2.1-0 || >=0.2.2-0 || >=0.2.3-0
  ```
  `@deepseek-ai/cordis`（`^4.0.1 || 4.0.5-alpha.1 || 4.0.5-alpha.2 || ^4.2.0-0`）与 `@deepseek-ai/schemastery`（`^3.18.1 || 3.18.5-alpha.1 || 3.18.5-alpha.2 || ^3.20.0-0`）也为 `0.2.3` 版本线提供了对应的预发布锚点。且刻意不设置 `engines.dsh` 覆盖；所有兼容性不变量由 `test/dsh-compatibility.spec.ts` 自动化校验。
  - **为什么需要预发布锚点**：DSH 启动器在评估版本范围时使用 `includePrerelease: true`，而 npm/pnpm 默认使用 `includePrerelease: false`。添加 `0.2.1-0`、`0.2.2-0` 与 `0.2.3-0` 锚点后，无需为每个 RC 单独列出条目即可同时兼容两种求值模式，同时排除已退役的 `0.1.x` 分支以及低于 `0.2.0-rc.2` 的版本。未来支持新的预发布主线（如 `0.3.0-alpha.1`）时，只需追加对应的 `-0` 锚点并更新 `test/dsh-compatibility.spec.ts`。
- **宿主挂载元数据**：`package.json` 通过 `dsh.bundle.patch` 指向 `cordis.patch.yml`（实现 Node 端自激活），并通过 `dsh.client`（`platform: "web"`）声明注入 `@deepseek-ai/dsh-client-ui-renderer`、`@deepseek-ai/dsh-client-ui-settings` 与 `@deepseek-ai/dsh-client-locale`。

## 构建与单元测试

```sh
pnpm install        # 安装依赖（CI 中使用：pnpm install --frozen-lockfile）
pnpm build          # tsc && tsdown（类型检查 src/ 并打包 lib/index.js 与 lib/client.js）
pnpm test           # tsc -p tsconfig.test.json && node --test "lib-test/test/**/*.spec.js"
```

`package.json` 中的其他生命周期脚本：

- `pnpm prepare`：运行 `tsdown -c tsdown.prepare.config.ts`
- `pnpm prepublishOnly`：运行 `pnpm build && pnpm test`

类型检查已包含在 `pnpm build`（`tsc`）和 `pnpm test`（`tsc -p tsconfig.test.json`）中，无需单独执行 `typecheck` 脚本。

## 离线 Playwright UI 回归脚本

`test/*-browser.mjs` 下包含 8 个独立的浏览器回归脚本，直接通过已安装的 `rolldown` 实时打包 React 测试夹具并驱动无头 Chromium，全程离线运行（无需运行中的 DSH 服务，也不依赖真实账号或凭据）。

通过 `PLAYWRIGHT_PATH` 指向本地 Playwright 包目录（可选设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定自定义 Chromium 可执行文件）：

```sh
# 1. 账号管理弹窗（默认状态、严格模型白名单、保存失败重试、子代理速度、中英双语与窄屏适配）
PLAYWRIGHT_PATH=/path/to/playwright node test/account-manager-browser.mjs

# 2. 真实 SubscriptionsAuthController + PoolUsageTracker + RPC 路由（需先编译测试文件）
pnpm exec tsc -p tsconfig.test.json
PLAYWRIGHT_PATH=/path/to/playwright node test/freshness-browser.mjs

# 3. 服务商模型编辑器（显示顺序、上下文窗口、工具开关、子代理速度、自定义显示名与默认推理档）
PLAYWRIGHT_PATH=/path/to/playwright node test/model-editor-browser.mjs

# 4. 服务商标签栏、窄屏滚动可见性、登录状态流转与 Codex Credits 展示
PLAYWRIGHT_PATH=/path/to/playwright node test/provider-tabs-browser.mjs

# 5. 额度展示模式（已用/剩余）、过期与失败恢复、跨标签同步、中文与窄屏布局
PLAYWRIGHT_PATH=/path/to/playwright node test/quota-display-browser.mjs

# 6. 设置页帮助提示（悬停、键盘聚焦/Escape、点击外部与触屏交互）
PLAYWRIGHT_PATH=/path/to/playwright node test/settings-help-browser.mjs

# 7. 状态栏用量徽章显示模式、本地存储异常容错、中英双语设置与窄屏布局
PLAYWRIGHT_PATH=/path/to/playwright node test/subscription-usage-browser.mjs

# 8. 服务商自定义配额分组（如 Antigravity）、剩余指示器与可见性即时更新
PLAYWRIGHT_PATH=/path/to/playwright node test/usage-window-filter-browser.mjs
```

## 隔离宿主兼容性检查与手动探针

- **Antigravity 输出图片宿主检查（`scripts/verify-antigravity-images-host.mjs`）**：在临时 npm 前缀与临时 DSH 主目录中针对已发布的 `@deepseek-ai/dsh-attachment-local`、`@deepseek-ai/dsh-client-ui-attachment`、`@deepseek-ai/dsh-client-ui-chat` 与 `@deepseek-ai/dsh-llm`（`0.2.3-alpha.2`）运行端到端校验，不改动项目依赖。完整命令见[Antigravity 输出图片](./antigravity-output-images.zh.md)。
- **Copilot 回放探针（`scripts/manual/real-copilot-replay-probe.mjs`）**：用于针对真实端点手动验证 Copilot Responses 加密推理回放行为的诊断脚本。

## 发布流程

自动发布工作流位于 `.github/workflows/release.yml`，推送 `v*` Git 标签时触发：

1. 在 `package.json` 中更新 `"version"`，提交到 `main` 后推送匹配的 `vX.Y.Z` 标签：
   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
2. `Release` 工作流在 `ubuntu-latest` 上运行（Node 24、`packageManager` 指定的 `pnpm`、最新版 `npm` ≥ 11.5.1）：
   - 校验标签名与 `v${package.json.version}` 一致，且该版本尚未发布至 npm。
   - 若版本号包含 `-`，自动选择 `next` dist-tag 并标记 GitHub Release 为 `--prerelease`，否则使用 `latest`。
   - 依次执行 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm test` 与 `npm pack --dry-run`。
   - 通过 **npm Trusted Publishing（OIDC）** 附带构建溯源（provenance）发布（`npm publish --registry=https://registry.npmjs.org --provenance --access public --tag "$DIST_TAG"`，无需长期 npm Token）。
   - 执行 `gh release create "$TAG" --verify-tag --generate-notes` 创建对应的 GitHub Release。

## 仓库目录结构

```text
.
├── cordis.patch.yml                 # DSH 插件包自激活补丁
├── package.json                     # 包元数据、peer 版本范围与构建/测试脚本
├── screenshots.json                 # docs/images/ 下 README 截图清单
├── .github/workflows/release.yml    # 基于标签与 OIDC 的 npm / GitHub 自动发布工作流
├── docs/                            # 中英双语文档目录、技术参考与界面截图
├── scripts/
│   ├── verify-antigravity-images-host.mjs   # 隔离宿主附件与画廊兼容性检查
│   └── manual/real-copilot-replay-probe.mjs # 手动 Copilot Responses 推理回放探针
├── src/
│   ├── index.ts                     # Cordis 插件入口、Config Schema、RPC 与工具注册
│   ├── http.ts                      # 出站代理路由（proxy.json）与 Happy Eyeballs 超时下限
│   ├── provider-settings.ts         # 持久化服务商 UI 偏好（provider-settings.json）
│   ├── model-defaults.ts            # 按模型默认推理档位（model-defaults.json）
│   ├── model-speeds.ts              # Codex 输入框速度偏好持久化（model-speeds.json）
│   ├── codex-budget-defaults.ts     # Codex 默认上下文窗口与本地输出预留常量
│   ├── antigravity-model-id.ts      # Antigravity 模型分组 ID 与配额作用域辅助函数
│   ├── compat.ts / json-text.ts     # 跨宿主类型与 BOM 兼容辅助
│   ├── auth/                        # auth.json 存储、OAuth PKCE / 设备流、Claude 钥匙串同步与 RPC
│   ├── providers/                   # 各服务商适配器、令牌管理、账号池、健康度、用量与重置卡
│   ├── translate/                   # Anthropic、Responses、Chat Completions、Antigravity 与图片转换器
│   ├── tools/                       # image_generate、video_generate、x_search 与别名注册
│   ├── usage/                       # 本地用量窗口追踪、历史预折叠、看板聚合与 RPC
│   └── client/                      # Web 设置界面、额度徽章、模型/账号编辑器与用量看板
│                                    # （UsageDashboard.tsx、UsageCharts.tsx、UsageHeatmap.tsx、
│                                    #  ActiveWindowsPanel.tsx、usage-dashboard-state.ts、usage-dashboard-styles.ts）
└── test/                            # Node 单元测试（*.spec.ts）与离线 Playwright UI 回归（*-browser.mjs）
```
