# dsh-plugin-subscriptions

[English](README.md) | 中文

把你的 **ChatGPT(Codex)**、**Claude**、**Grok(X Premium)** 订阅当作 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 LLM provider 使用 —— 不需要 API key。Codex 和 Grok 通过 dsh web 界面 OAuth 登录(设置 → 订阅);Claude 在存在 Claude Code 会话时直接导入凭据(macOS Keychain 或 `~/.claude/.credentials.json`),否则回退到同样的浏览器 OAuth 流程,因此不要求安装 Claude Code CLI。Token 保存在 `~/.dsh/plugins/subscriptions/auth.json`(权限 0600),过期自动刷新。

## 演示

设置 → **订阅**:每个 provider 的登录/退出,无需 API key。Claude 有 Claude Code 会话时导入凭据,否则和 Codex、Grok 一样走 OAuth(截图中账号已打码):

![订阅设置页](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/subscriptions.png)

已登录的 provider 会带着实时模型目录进入会话模型选择器:

![模型选择器中的订阅模型](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-picker.png)

声明了推理等级的模型会在同一菜单里多出**推理等级**选择 —— Codex 系列模型,以及 Grok 4.6 / 4.5(档位和默认值来自各 provider 的实时目录,不是硬编码列表):

![推理等级选择器](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-effort.png)

目录声明了 fast tier(即 codex CLI 的 fast 模式)的 Codex 模型,会在输入框工具行(模型选择器旁)多出一个**速度**开关 —— 标准 / 快速(`service_tier: priority`),按会话生效。`/fast` 斜杠命令提供同样的弹窗选择;当前模型不支持快速档时会提示原因。

![速度开关及其标准/快速菜单](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/speed-toggle.png)

`image_generate` 工具生成的图片直接内联显示在对话里:

![image_generate 内联显示生成的图片](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-inline.png)

`provider` 参数可选择生图后端——同一条提示词分别走 GPT(`gpt-image-2`,上)和 Grok(`grok-imagine-image-2.0`,下):

![image_generate 的 provider 参数对比 gpt 与 grok](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-providers.png)

`video_generate` 工具生成的视频直接内联播放:

![video_generate 内联播放生成的视频](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/video-generate-inline.png)

## Provider 一览

| 路由     | 订阅             | 模型 |
|----------|------------------|------|
| `codex`  | ChatGPT Plus/Pro | 从 `chatgpt.com/backend-api/codex/models` 实时获取 |
| `claude` | Claude Pro/Max   | 订阅内所有可用模型(Opus、Sonnet、Haiku、Fable —— 静态目录,随插件更新) |
| `grok`   | X Premium (xAI)  | 从 `api.x.ai/v1/models` 实时获取(仅对话模型);推理等级来自 Grok CLI 目录(`cli-chat-proxy.grok.com/v1/models`) |

只有已登录的 provider 才会出现在会话模型选择器里;登录/退出后列表自动刷新。支持视觉的模型会声明 `['text', 'image']` 输入模态,图片内容会被翻译成各 provider 的 wire 格式。

已登录的卡片还会显示**订阅用量**——按限额窗口(5 小时会话窗、每周窗,以及计划包含的按模型每周窗)展示已用百分比、进度条和重置时间,并带刷新按钮。Codex 用量来自 `chatgpt.com/backend-api/wham/usage`(同时报告计划类型),Claude 用量来自 `api.anthropic.com/api/oauth/usage`,Grok 用量来自 Grok Build CLI 代理的 `cli-chat-proxy.grok.com/v1/billing`(即 CLI `/usage` 面板的数据源,报告共享每周额度和订阅档位)。

随 provider 启用自动注册的工具:

- **`x_search`**(Grok)—— xAI 托管的 X 搜索,返回 `{ answer, citations }`。
- **`image_generate`**(ChatGPT 或 Grok)—— 经 Codex 后端调用 `gpt-image-2`,或经 `api.x.ai/v1/images/generations` 调用 `grok-imagine-image-2.0`。`provider` 参数指定首选提供方(`gpt` 为默认值,可选 `grok`);首选方未登录时自动回退到另一方。图片保存到 `~/.dsh/plugins/subscriptions/images/` 并返回路径。Grok 路径上 `size`/`quality` 参数会映射为 Grok 的 `aspect_ratio`/`quality`。
- **`video_generate`**(Grok)—— 经 `api.x.ai/v1/videos` 调用 `grok-imagine-video-1.5`(异步提交 + 轮询);MP4 保存到 `~/.dsh/plugins/subscriptions/videos/` 并返回路径,视频直接在对话里内联播放。支持时长(1–15 秒)、宽高比、分辨率,以及通过 `image_url` 做图生视频。

## 安装

本机已有 `dsh` CLI 时,从 npm 安装(预构建产物,无需构建授权):

```sh
dsh plugin --profile web add dsh-plugin-subscriptions
```

也可以从 GitHub 安装源码:

```sh
dsh plugin --profile web add github:V1ki/dsh-plugin-subscriptions
```

首次安装 pnpm 会要求允许该包的构建脚本(git 安装拉取的是源码而非构建产物);把打印出的包名加进 profile 的 `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-plugin-subscriptions: true
```

然后重新执行 `add`。该授权会在安装时执行包的代码,只授给你信任的来源。

本地检出安装:

```sh
git clone https://github.com/V1ki/dsh-plugin-subscriptions.git
cd dsh-plugin-subscriptions && pnpm install && pnpm build
dsh plugin --profile web add ./dsh-plugin-subscriptions
```

不装进 profile 的 headless 用法(先在 web 界面登录过 —— token 文件是共享的):

```sh
cp overlay.example.yml overlay.yml   # 然后把 name: 改成本检出的 lib/index.js 绝对路径
dsh --profile headless --patch <检出目录>/overlay.yml "你的任务"
```

## 更新

npm 安装的:

```sh
dsh plugin --profile web update --latest dsh-plugin-subscriptions
```

GitHub 安装的:重新执行一遍 `add github:V1ki/dsh-plugin-subscriptions` —— 会重新拉取源码并构建。link 的本地检出只需在检出目录里 `git pull && pnpm build`。

无论哪种方式,更新后都要重启 `dsh web` 才会加载新版本。

## 使用

1. `dsh web`,打开打印的 URL。
2. **设置 → 订阅**:点对应 provider 的「连接」。若先运行过 `claude` 并登录,Claude 会即时导入凭据;没有凭据时,Claude 也和其他 provider 一样在浏览器里授权。Codex 和 Grok 在打开的标签页里授权;无浏览器环境下可展开手动兜底,粘贴回调 URL 或授权码。
3. 在任意会话里打开模型选择器(`/model`),选择 **ChatGPT (Codex)** / **Claude (Subscription)** / **Grok (Subscription)** 下的模型。

未登录时:该 provider 不出现在选择器里;直接请求会报 `MISSING_CREDENTIAL` 并提示去设置页登录,不影响其他功能。

## 配置

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [codex, claude]        # 子集;默认三个全启用
    streamIdleTimeoutMs: 300000
    rateLimit:
      wait: true                       # 等待限流窗口重开(默认开启)
      maxWaitMs: 21600000              # 单次等待上限;6 小时,足够覆盖 5 小时会话窗口
    models:                            # 覆盖实时发现/内置目录
      codex:
        - { id: gpt-5.6-sol, name: GPT-5.6 Sol, contextWindow: 272000, inputModalities: [text, image] }
```

### 等待限流窗口

订阅套餐天然是按限流窗口计费的 —— 5 小时会话窗口、周窗口,部分套餐还有按模型的周窗口 —— 所以 429 并不是终点:窗口会在 provider 自己告知的时刻重开。每条路由从自己的 429 里读出这个时刻,并把它作为应等待的时长上报。

只有能指明「是哪个窗口拒绝了这次请求」的信号才会被等待:Anthropic 的 `anthropic-ratelimit-unified-reset`、Codex 在 `usage_limit_reached` 上给出的秒数、xAI 在错误体里给出的延迟,或通用的 `retry-after`。各分桶的滚动快照(`anthropic-ratelimit-{requests,tokens,…}-reset`、`x-codex-*-reset-after-seconds`、`x-ratelimit-reset-*`)每个响应上都有,说不出是哪个桶拒绝的 —— 其中最早的那个往往正是还有余量的桶 —— 所以只带这些的 429 会通过插件的告警回调打印出相关 header 与响应体开头,而不是照着猜测把本轮挂起。

读取只发生在 429 上。其他失败仍走各自的短本地退避:同样这些 header 也会出现在瞬时 500 上,在那里照办等于为一次一秒就恢复的过载把本轮挂满整个窗口。

真正执行等待的是 [`@deepseek-ai/dsh-llm-retry`](https://www.npmjs.com/package/@deepseek-ai/dsh-llm-retry),三条路由的重试策略都是为它写的:把它加进编排,否则不会有任何等待,关闭的窗口仍旧直接让本轮失败。

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
```

重开时刻超过 `maxWaitMs`(比如几天后才重置的周窗口)会立即失败,而不是把会话挂在那里。`wait: false` 则只保留本地退避。

三条路由共用 Claude Code 自己的重试形状:首次尝试之后重试 10 次,从 1 秒开始退避,带 20% 抖动,上限 60 秒。这些都是面向消费者的订阅端点,过载时按突发丢流量,而 dsh-llm 默认值(5 次重试,500 毫秒到 10 秒)约 15 秒就放弃,对这种场景偏短。没有给出重开时刻的 429 现在会本地重试约 17 分钟才让本轮失败 —— `wait: false` 下约 5 分钟,那时 60 秒上限才真正生效。

一个需要知道的取舍:延迟上限与这份本地退避共用,调高 `maxWaitMs` 同时也抬高了无关瞬时失败(`TRANSPORT`、`SERVER`、`TIMEOUT`)在有限重试预算耗尽前的退避时长 —— 第 10 次重试最长会从 60 秒上限变成 512 秒。

## 开发

```sh
pnpm install   # devDependencies 用 link: 指向本地 deepseek-harness 检出 —— 先改成你的路径
pnpm build     # tsc(lib/)+ tsdown(lib/client.js 浏览器 bundle)
pnpm test      # 编译后跑 node --test 单测
```

`prepare`(git 安装时触发)执行 `tsdown.prepare.config.ts`:自包含打包两个面,所有 `@deepseek-ai/*` 依赖外部化 —— 运行时从 dsh 安装解析,保证不会引入第二份 cordis。

改了代码后 `pnpm build` 并重启 `dsh web` 生效。

## 目录结构

- `src/index.ts` —— 插件入口:配置 schema、adapter 注册、登录态变更通告、RPC 接线
- `src/auth/` —— PKCE/JWT 工具、token 存储、OAuth 流程引擎(临时本地回调服务)、Claude Code 凭据读取器(Keychain/文件)、`/subscriptions-auth` RPC 通道
- `src/providers/` —— 各 provider 的 OAuth 常量/换发/刷新 + `LlmAdapter` 实现,以及 `rate-limit.ts`(限流重开时刻解析 + 重试策略)
- `src/translate/` —— dsh `Message[]` 与 OpenAI Responses / Anthropic Messages 格式互转,SSE → `StreamChunk`
- `src/tools/` —— `x_search`、`image_generate` 与 `video_generate`
- `src/client/` —— 设置 → 订阅页面(浏览器面,中英文,跟随明暗主题)
