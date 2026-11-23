# 国内订阅登录（Kimi Code / GLM / Qwen Code）

本 fork 在原有五家 OAuth 订阅之外，新增三个国内订阅路由：

| 路由 | 订阅产品 | 接入方式 | 推理端点 |
|---|---|---|---|
| `kimi` | Kimi Code（Moonshot 会员编程套餐） | 官方 CLI 公共客户端的 OAuth 设备码（RFC 8628） | `https://api.kimi.com/coding/v1/chat/completions` |
| `glm` | 智谱 GLM Coding Plan（国内 bigmodel / 国际 z.ai） | ZCode 官方客户端的浏览器授权 + 套餐 Key 自动签发 | `https://open.bigmodel.cn/api/coding/paas/v4`（国内）/ `https://api.z.ai/api/coding/paas/v4`（国际） |
| `qwen` | Qwen 千问AI平台（Token Plan / 按量计费） | 平台 API Key（该平台没有 OAuth，Key 只粘贴一次） | `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1`（`sk-sp-`）/ `https://maas.qianwenaiapi.com/compatible-mode/v1`（`sk-ws-`/`sk-`） |

三者共用上游的账号存储、刷新、多账号和模型池：

- 凭据写入 `~/.dsh/plugins/subscriptions/auth.json`（0600），与原有订阅同一份文件、同一套刷新/失效逻辑。
- 设置 → 订阅 里每张卡都有登录、账号管理、设为默认、退出；登录中会显示设备码或等待浏览器完成。
- 登录成功前模型选择器不显示该路由；登录后立即出现。同一账号重新登录会原地更新，不产生重复账号。
- Kimi 和 GLM 的额度、重置时间与余额已经接入设置页（见下文“用量与余额”）；Qwen 千问AI平台的推理 Key 读不到额度，卡片会明确说明原因。

## Kimi Code

Kimi Code 的官方 CLI 注册了一个公开的 OAuth 设备码客户端。登录流程：

1. `POST https://auth.kimi.com/api/oauth/device_authorization`（表单，`client_id` 为 Kimi Code CLI 公共客户端 id，不带 scope）。
2. 浏览器打开返回的 `verification_uri_complete`，用 Kimi 账号确认设备码。
3. 插件轮询 `POST https://auth.kimi.com/api/oauth/token`，拿到 `access_token` + `refresh_token`。
4. 以后每次刷新用 `grant_type=refresh_token` 换一对新 token；**refresh token 会轮换**，插件每次刷新都立即落盘。
5. 推理请求把 access token 作为 `Authorization: Bearer` 发到 `https://api.kimi.com/coding/v1/chat/completions`，并带上官方客户端的 `X-Msh-*` 设备头。

模型目录优先读 `GET /coding/v1/models`（带账号 token），失败时回退到内置清单（`kimi-for-coding`、`k3`、`k3.1-pro` 等）。思考内容（`reasoning_content`）会在工具回合按原序回传，避免多轮工具调用时模型重新思考。

**思考等级**：K3.1 Pro、K3、K2.8 Preview 都支持 `reasoning_effort: low | high | max`，插件按模型给出默认值（K3.1/K3 默认 high，Kimi for Coding 默认 max）；`kimi-for-coding-highspeed` 固定开启思考、没有等级可选。K3.1 Pro 关闭思考会被 HTTP 400 拒绝，所以不提供“关闭”档。

**边界**：Kimi 官方文档建议第三方工具使用控制台 Key，并禁止伪造客户端身份。这里使用的是官方 CLI 已注册的公共客户端与设备信息头，不伪造 User-Agent；是否放行仍由服务端策略决定。若你的账号被限制，请改用官方客户端或控制台 Key。

## GLM Coding Plan（ZCode）

GLM 的 Coding Plan 没有对第三方开放的 OAuth 应用，但官方 ZCode 客户端本身有一条账号授权链路，登录后会为账号**签发标准套餐 Key**（`<apiKey>.<secretKey>`，名称固定为 `zcode-api-key`，重复登录复用同一把）。插件实现的就是这条链路：

1. `POST https://zcode.z.ai/api/v1/oauth/cli/init`，`{"provider":"bigmodel"}` 或 `{"provider":"zai"}`，返回 `flow_id`、`poll_token`、`authorize_url`（300 秒有效）。
2. 打开 `authorize_url`：国内走 `bigmodel.cn` 登录，国际走 `chat.z.ai` 登录；浏览器完成后由 ZCode 的回调页收尾。
3. 插件轮询 `GET /api/v1/oauth/cli/poll/{flow_id}`，`status` 变为 `ready` 后取得账号 token 与用户信息。
4. 国际站先把账号 token 换成业务 JWT（`POST https://api.z.ai/api/auth/z/login`）；国内站直接使用账号 token。
5. 通过业务接口选默认机构/项目，查找或创建 `zcode-api-key`，再取 `secretKey`，拼成 `apiKey.secretKey`。
6. 该 Key 作为 `Authorization: Bearer` 发到对应站点的 OpenAI 兼容 Coding Plan 端点；`glm-5.3` / `glm-5.3-flash` 为默认模型。

选择站点：

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [kimi, glm, qwen]
    glm:
      station: bigmodel   # 国内站（默认）；国际站填 zai
```

**模型目录**：登录后用套餐 Key 调用 `GET {站点}/api/paas/v4/models` 读取账号当前模型；只保留 `glm-5*` 这一代（过滤掉 4.x 和 `-legal` 专用变体），所以 GLM-5.4 这类新模型不需要等插件发版。端点失败时回退到内置清单（`glm-5.4`、`glm-5.3`、`glm-5.3-flash`）。

**思考等级**：GLM-5.* 强制思考，支持 `reasoning_effort: low | high | max`（默认 max）；请求同时带 `thinking: {type:"enabled"}`，插件会把选中的等级写进 `reasoning_effort`。

**重要边界**

- 这条链路来自官方客户端的实际行为，但**不是官方文档承诺的第三方接入方式**。端点或风控随时可能变化（例如未来的客户端签名开关）。
- 2026-10-16 之后，bigmodel 的套餐权益按 **Key 的产品类型**而不是端点区分。自动签发的 `zcode-api-key` 是否一定计入 Coding Plan 额度，需要在真实订阅账号上对照账单确认；本仓库没有做这项线上验收。
- 如果账号没有带项目的机构（没有生效中的 Coding Plan），登录会明确报“no organization with a coding-plan project”，不会写入假凭据。
- 套餐 Key 长期有效，插件按 30 天重新签发一次；如果被撤销，重新登录即可。

## Qwen 千问AI平台（Token Plan / 按量计费）

`qwen` 路由接的是 **千问AI平台**（`platform.qianwenai.com`）的 API Key，不是 chat.qwen.ai 的 Qwen 账号订阅，也不是百炼 Coding Plan：

- 该平台**没有对模型调用开放的 OAuth**，第三方工具只能用 API Key；插件因此把 Key 保存为不过期的凭据，登录按钮换成卡片里的 Key 输入框。
- Key 产品类型决定端点：`sk-sp-` = Token Plan（月度 credits，专用端点），`sk-ws-` / `sk-` = 按量计费（通用端点）。粘贴后插件自动识别，不需要手选。
- OpenAI 兼容端点**没有 `GET /models`**。保存 Key 后先用内置兜底清单（`qwen4-max-preview`、`qwen4-max`、`qwen3.8-max`、`qwen3.8-flash`、`qwen3.7-plus`、`deepseek-v4-pro`）；完成“登录查询额度”后，插件通过控制台的 `ListModelSeries` 读取账号真实模型列表（包括平台上能看到、但文档还没写的预览模型），并替换静态清单。也可以在配置 `models.qwen` 里手工覆盖。
- 思考等级：Qwen3.8 系列和 DeepSeek V4 Pro 支持 `reasoning_effort: low | medium | xhigh`（默认 xhigh），插件直接写顶层 `reasoning_effort`；Qwen3.7 Plus 没有声明档位，因此不提供选择。
- 注意 `sk-sp-` 前缀同样用于阿里云百炼/ModelStudio 的套餐 Key；本路由只按千问AI平台的端点发送，百炼 Key 在这里会鉴权失败。百炼 Coding Plan 仍只有 `sk-sp-` Key，没有 OAuth。
- **额度需要额外一次控制台登录**：推理 Key 读不到额度，所以保存 Key 后，卡片上会出现“登录查询额度”按钮。它走官方 CLI 同款的 PKCE 设备码（`t.qianwenai.com`），把控制台凭据存进同一个 qwen 会话，只用于读额度；推理仍然只用 API Key。没有登录时卡片会明确提示，不再显示笼统的“此服务商不支持额度查询”。

## 用量与余额

设置页的用量区对 Kimi 和 GLM 显示与 Codex/Antigravity 相同的窗口条：已用百分比、窗口长度、重置时间；有余额的显示余额，有重置卡的显示可用次数。

| 提供方 | 数据源 | 显示内容 |
|---|---|---|
| Kimi | `GET https://api.kimi.com/coding/v1/usages`（Bearer access token） | 5 小时窗口、旧套餐的每周窗口、共享月度池与其 Code 份额、`/me` 的套餐名；Extra Usage 钱包余额按固定点 ÷1e6 换算成货币 |
| GLM | `GET {站点}/api/monitor/usage/quota/limit` + `GET {站点}/api/biz/customer-package-reset/list`（铸造的套餐 Key） | 5 小时 credits、每周 credits、MCP 月度窗口、套餐档位；可用重置卡数量与到期时间 |
| Qwen | `usage` / `subscription` / `quota-config` 控制台网关（需要先点“登录查询额度”） | 月度（旧套餐为每周）已用比例、重置时间、套餐 specCode；用该档位的月度 credits × (1 − 已用比例) 算出剩余 credits；按量计费账号显示现金余额 |

**GLM 重置卡**：官方文档说 API-KEY 用户通常不会收到重置卡，所以“可用 0 次”是正常状态；插件只读取并展示，不在 DSH 内执行“使用重置卡”的写操作。

**Qwen 余额/额度**：千问AI平台只把账户额度暴露给控制台登录会话，推理 Key 本身没有公开的额度接口。插件已经接上官方 CLI 使用的 PKCE 设备码 + console 网关：保存 Key 后点“登录查询额度”，之后就能看到月度/每周已用比例、重置时间和剩余 credits；按量计费账号则显示现金余额。控制台 token 只用于额度读取，不会发往推理请求。

## 安全与数据

- 所有凭据只进 `auth.json` 和 DSH 凭据存储；不写入插件配置、不写日志、不回显。Qwen 的控制台 token 与推理 Key 存在同一个会话里，只用于额度查询。
- Kimi 的设备 id 存在 `~/.dsh/plugins/subscriptions/kimi-device-id`（0600），只用于登录与推理的 `X-Msh-Device-Id`。
- 刷新失败按上游语义处理：401/403 或 `invalid_grant` 视为永久失效并移除该账号；网络/5xx 保留可用 token 重试。
- 这三条路由不跟随重定向，token 只发往固定端点。

## 验证清单

自动化测试覆盖：设备码请求形状、token 轮换与账户键、ZCode init/poll/ready、业务 Key 查找/创建/复制、错误信封、取消、30 天重签、Kimi/GLM 用量窗口与重置卡解析、设置页宿主注册。未执行真实账号登录与真实套餐调用——那需要你在本机用自己的订阅完成一次浏览器授权。

## 安装

本 fork 与上游同名，不能同时加载：

```sh
# 在 DSH 插件管理器中执行
remove_bundle   dsh-plugin-subscriptions
install_bundle  github:Jetiaime/dsh-plugin-subscriptions#feat/cn-subscription-login
```

Git 安装会现场执行仓库的 `prepare` 构建（tsdown 编译 Host 与 Client 入口）。pnpm 默认禁止依赖执行构建脚本，若被 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 拦下，按插件管理器提示确认来源并允许本包的构建脚本后重试；也可以本地 `pnpm build` 后用预构建目录安装。安装或更新后刷新页面一次，新的 Client bundle 才生效。

## 已知限制

- Qwen 千问AI平台的额度需要额外一次“登录查询额度”（官方 CLI 同款控制台登录）；只保存 Key 时只能显示提示，不能显示额度。模型列表同理：登录后才会完全对齐平台（包括预览模型）。

- Kimi 没有“重置卡”概念，只有按时间重置的窗口；GLM 有重置卡但通常不会发给 API-KEY 用户。
- 各模型的可选思考档位以目录声明为准；`kimi-for-coding-highspeed`、`qwen3.7-plus` 等没有档位的模型不会显示选择器，使用服务端默认行为。
- GLM 的授权链路、Kimi 的客户端身份都属于官方未承诺的第三方接入方式；服务端策略变化可能导致登录失败。失败时会明确报错，不会静默回退到按量计费端点。
- 未做真实账号的端到端验收：登录、套餐扣费和模型可用性需要你在自己的订阅上验证一次。
