# Antigravity 输出图片

[English](./antigravity-output-images.md) · [文档目录](./README.zh.md)

Antigravity 的 `inlineData` 响应在 `stream()`（SSE）与 `generate()`（JSON）两种传输模式下都会转为持久化的 DSH 图片块。成功保存的图片即视为有效内容，即使它构成整条回复的全部内容也是如此。此能力不涉及任何账号池策略变更。

## 契约与实现

宿主输出块格式为 `{ type: 'image', attachment: ImageAttachmentRef }`。`{ type: 'image', mediaType, dataBase64 }` 仅是本插件已解析的**请求**表示形式，并非合法的持久化助手消息块。

转换器在发出图片块的 `block-start` 与 `block-end` 之前会先等待 `AttachmentStore.saveImage()` 完成，并先关闭之前的文本或推理块，防止后续文本跨越图片合并。每次图片出现都会分配新的块索引，即使不同帧中重复出现完全相同的图片也是如此。块级 `thoughtSignature` 会随存储与回放一并保留。助手侧图片解析保持输入块与输出块一一对应；用户/工具侧的图片编辑提示保持不变。

宿主的 `BlockAssembler` 消费这些流式分片，`AssistantStreamAccumulator` / `expandAssistantStream` 在 JSON 序列化前后完整保留这些结构。持久化助手消息只保存附件引用而不包含 base64 数据。后续请求回放时，先通过 `resolveImages()` 读回字节，再由 `toAntigravityContents()` 为源路由恢复 `inlineData` 与 `thoughtSignature`。宿主归一化可能会改变编码后的字节，回放始终使用已存储且经过校验的图片。

官方 `dsh-client-ui-chat` 助手渲染器会在回复的对应位置将连续图片块分组，并调用 `conversation.chat.message.images` 插槽；`dsh-client-ui-attachment` 实现该插槽，对话图片加载器读取具备会话授权的附件并创建浏览器 URL。完整的交互链路需要同时挂载宿主附件后端与图片 UI 插件。

用量事件在 `finish` 之前发出；如果终止帧不含用量信息，则保留最近一次用量快照。既有的 `STOP`、工具调用、`MAX_TOKENS` 与内容过滤完成语义保持不变。未收到结束原因就遇到 EOF / `[DONE]` 会被视为截断流，缺少结束原因的 JSON 响应同样会失败。

## 准入与失败边界

- 仅接受规范补齐的 base64 以及宿主支持的光栅 MIME 类型：PNG、JPEG、WebP 与 GIF。拒绝空数据、data URL、畸形 base64 与不支持的 MIME 类型，且不会将原始载荷复制到诊断信息中。
- 过滤掉标记为 `thought: true` 的 Gemini 内联中间草图，不写入可见历史也不参与请求回放。仅保存并回放最终图片字节及其对应签名；若只有草图而无最终输出，则返回 `EMPTY_RESPONSE`。参见 [Google 图片生成思考签名规则](https://ai.google.dev/gemini-api/docs/generate-content/image-generation?hl=en)。
- 在分配内存前即按宿主的单图字节上限与总字节上限校验解码后的图片大小；单次响应跨多帧累计数目与总字节数。这些属于输出准入限制，与请求侧的图片卸载或 base64 预算相互独立。
- MIME 与实际字节一致性校验、完整光栅解码、像素与尺寸限制、归一化及持久化写入均委托给附件存储服务完成。
- 缺少附件存储、非法图片、超出输出限制或本地存储失败会显式报错（`UNSUPPORTED`、`INVALID_IMAGE_RESPONSE`、`IMAGE_OUTPUT_LIMIT`、`IMAGE_OUTPUT_STORAGE`）。这些错误码不会触发账号池切换或冷却；真正的空响应则保持既有账号池行为。
- 现有 HTTP/SSE 解析器仍会在图片准入前先缓冲单个 JSON 帧，不引入传输层单帧大小上限。若前面帧已保存图片而后续帧失败，磁盘上可能遗留未引用对象，且该次尝试不会发出成功的 `finish` 事件。附件保留与清理策略仍归宿主管理。

## 宿主兼容性检查

仓库提供一个可选的隔离检查脚本，用于在临时目录中针对已发布的宿主真实本地附件后端与图片画廊做端到端验证，不会改动项目依赖或现有 DSH 主目录。先编译测试代码（`pnpm exec tsc -p tsconfig.test.json`），再将宿主包安装到临时前缀目录并运行脚本：

```sh
HOST_CHECK_DIR=$(mktemp -d)
npm install --prefix "$HOST_CHECK_DIR" --save-exact --no-audit --no-fund \
  @deepseek-ai/dsh-attachment-local@0.2.3-alpha.2 \
  @deepseek-ai/dsh-client-ui-attachment@0.2.3-alpha.2 \
  @deepseek-ai/dsh-client-ui-chat@0.2.3-alpha.2 \
  @deepseek-ai/dsh-llm@0.2.3-alpha.2
node scripts/verify-antigravity-images-host.mjs "$HOST_CHECK_DIR"
```
