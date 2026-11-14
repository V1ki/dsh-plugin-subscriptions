# 国内订阅登录（Kimi Code / GLM / Qwen Code）

本 fork 在原有五家 OAuth 订阅之外，新增三个**用登录而不是粘贴 API Key** 接入的国内订阅路由：

| 路由 | 订阅产品 | 登录方式 | 推理端点 |
|---|---|---|---|
| `kimi` | Kimi Code（Moonshot 会员编程套餐） | 官方 CLI 公共客户端的 OAuth 设备码（RFC 8628） | `https://api.kimi.com/coding/v1/chat/completions` |
| `glm` | 智谱 GLM Coding Plan（国内 bigmodel / 国际 z.ai） | ZCode 官方客户端的浏览器授权 + 套餐 Key 自动签发 | `https://open.bigmodel.cn/api/coding/paas/v4`（国内）/ `https://api.z.ai/api/coding/paas/v4`（国际） |
| `qwen` | Qwen Code（chat.qwen.ai Plus/Pro 订阅） | Qwen Code 官方客户端 OAuth 设备码 | `https://api.qwen.ai/compatible-mode/v1` |

三者共用上游的账号存储、刷新、多账号和模型池：

- 凭据写入 `~/.dsh/plugins/subscriptions/auth.json`（0600），与原有订阅同一份文件、同一套刷新/失效逻辑。
- 设置 → 订阅 里每张卡都有登录、账号管理、设为默认、退出；登录中会显示设备码或等待浏览器完成。
- 登录成功前模型选择器不显示该路由；登录后立即出现。同一账号重新登录会原地更新，不产生重复账号。
- 本版本不提供这三家的额度查询（它们没有公开的、可供第三方调用的用量接口），用量区显示“不支持”，不会按 token 数虚构余量。

## Kimi Code

Kimi Code 的官方 CLI 注册了一个公开的 OAuth 设备码客户端。登录流程：

1. `POST https://auth.kimi.com/api/oauth/device_authorization`（表单，`client_id` 为 Kimi Code CLI 公共客户端 id，不带 scope）。
2. 浏览器打开返回的 `verification_uri_complete`，用 Kimi 账号确认设备码。
3. 插件轮询 `POST https://auth.kimi.com/api/oauth/token`，拿到 `access_token` + `refresh_token`。
4. 以后每次刷新用 `grant_type=refresh_token` 换一对新 token；**refresh token 会轮换**，插件每次刷新都立即落盘。
5. 推理请求把 access token 作为 `Authorization: Bearer` 发到 `https://api.kimi.com/coding/v1/chat/completions`，并带上官方客户端的 `X-Msh-*` 设备头。

模型目录优先读 `GET /coding/v1/models`（带账号 token），失败时回退到内置清单（`kimi-for-coding`、`k3`、`k3.1-pro` 等）。思考内容（`reasoning_content`）会在工具回合按原序回传，避免多轮工具调用时模型重新思考。

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

**重要边界**

- 这条链路来自官方客户端的实际行为，但**不是官方文档承诺的第三方接入方式**。端点或风控随时可能变化（例如未来的客户端签名开关）。
- 2026-10-16 之后，bigmodel 的套餐权益按 **Key 的产品类型**而不是端点区分。自动签发的 `zcode-api-key` 是否一定计入 Coding Plan 额度，需要在真实订阅账号上对照账单确认；本仓库没有做这项线上验收。
- 如果账号没有带项目的机构（没有生效中的 Coding Plan），登录会明确报“no organization with a coding-plan project”，不会写入假凭据。
- 套餐 Key 长期有效，插件按 30 天重新签发一次；如果被撤销，重新登录即可。

## Qwen Code（不是百炼 Coding Plan）

`qwen` 路由登录的是 **Qwen 账号订阅**（chat.qwen.ai Plus/Pro），端点是 `https://api.qwen.ai/compatible-mode/v1`。它**不是**阿里云百炼 Coding Plan：

- 百炼 Coding Plan 只接受套餐专属 `sk-sp-` Key，没有对第三方工具的 OAuth；Qwen 账号 token 打不通 `coding.dashscope.aliyuncs.com`。
- 所以本路由命名为 `Qwen Code`，不冒充百炼。需要百炼时请继续使用官方客户端或按量 API Key 的接入方式。

流程：`POST https://auth.qwen.ai/api/oauth/device/code`（表单，scope `model:invoke profile:read`）→ 浏览器确认 → 轮询 `POST /api/oauth/token` → `GET /api/oauth/userinfo` 读取邮箱与会员档位。刷新同样轮换 refresh token。模型目录读 `GET /compatible-mode/v1/models`，失败时使用 `qwen3.8-max`。请求必须带 `QwenCode/<version> (<platform>; <arch>)` User-Agent，否则网关会先拦成 WAF 页面。

## 安全与数据

- 所有凭据只进 `auth.json` 和 DSH 凭据存储；不写入插件配置、不写日志、不回显。
- Kimi 的设备 id 存在 `~/.dsh/plugins/subscriptions/kimi-device-id`（0600），只用于登录与推理的 `X-Msh-Device-Id`。
- 刷新失败按上游语义处理：401/403 或 `invalid_grant` 视为永久失效并移除该账号；网络/5xx 保留可用 token 重试。
- 这三条路由不跟随重定向，token 只发往固定端点。

## 验证清单

自动化测试覆盖：设备码请求形状、token 轮换与账户键、ZCode init/poll/ready、业务 Key 查找/创建/复制、错误信封、取消、30 天重签、设置页宿主注册。未执行真实账号登录与真实套餐调用——那需要你在本机用自己的订阅完成一次浏览器授权。

## 安装

本 fork 与上游同名，不能同时加载：

```sh
# 在 DSH 插件管理器中执行
remove_bundle   dsh-plugin-subscriptions
install_bundle  github:Jetiaime/dsh-plugin-subscriptions#feat/cn-subscription-login
```

Git 安装会现场执行仓库的 `prepare` 构建（tsdown 编译 Host 与 Client 入口）。pnpm 默认禁止依赖执行构建脚本，若被 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 拦下，按插件管理器提示确认来源并允许本包的构建脚本后重试；也可以本地 `pnpm build` 后用预构建目录安装。安装或更新后刷新页面一次，新的 Client bundle 才生效。

## 已知限制

- 三家都没有公开的订阅用量接口，卡片不显示额度百分比；也不按 token 估算余量。
- 不提供推理档位切换（GLM/Kimi/Qwen 各自的思考参数没有稳定的第三方文档），模型使用服务端默认思考行为。
- GLM 的授权链路、Kimi 的客户端身份都属于官方未承诺的第三方接入方式；服务端策略变化可能导致登录失败。失败时会明确报错，不会静默回退到按量计费端点。
- 未做真实账号的端到端验收：登录、套餐扣费和模型可用性需要你在自己的订阅上验证一次。
