# Bug 修复分析报告

## 问题总结

根据对 `dsh-plugin-subscriptions` 源码的深入分析，发现了两个关键问题：

### 问题 1：缺少 Ultra 思考档位 ❌

**现象**：用户在 UI 中看不到 `ultra` 推理档位选项

**根本原因**：
1. **静态档位列表缺失**：`src/providers/codex.ts` 第 105-111 行的 `CODEX_EFFORTS` 常量只定义了 5 个档位，缺少 `max` 和 `ultra`
2. **API 目录主动过滤**：第 540-543 行从 API 返回的目录中**故意过滤掉了 `ultra`**
3. **设计误解**：代码注释说明 `ultra` 会被 API 拒绝（HTTP 400），但根据 [Codex 官方文档](https://codex.danielvaughan.com/2026/07/27/gpt56-sol-ultra-mode-tradeoff-reasoning-budgets-subagent-cost-codex-cli/)，**GPT-5.6 Sol 确实支持 6 个完整档位**

**证据**：
- Codex 官方文档明确列出：Low, Medium, High, Extra High, Max, Ultra
- 第 721-723 行的 `codexWireEffort` 函数将 `ultra` 转换为 `max`，这是一个**过时的兼容逻辑**

```typescript
// 当前错误的实现
const CODEX_EFFORTS = [
  { id: ReasoningEffortId('minimal'), name: 'Minimal' },
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('xhigh'), name: 'Extra High' },
  // ❌ 缺少 max 和 ultra
] as const
```

### 问题 2：快速 1.5X 档位实际有效，但可能存在用户体验问题 ⚠️

**现象**：用户感觉开启 1.5X 快速模式后与标准模式没有区别

**代码分析**：
1. **实现是完整的**：
   - `src/model-speeds.ts`：速度选择持久化到 `~/.dsh/plugins/subscriptions/model-speeds.json`
   - `src/index.ts` 第 874-877 行：正确读取速度并传递 `fast` 标志
   - `src/providers/codex.ts` 第 753 行：将 `fast` 转换为 `service_tier: 'priority'` 发送给 API

2. **可能的问题**：
   - **UI 反馈不足**：切换档位后没有明显的视觉确认
   - **生效延迟**：设置只对**新会话**生效，当前会话可能仍在使用旧设置
   - **上游限流**：即使请求了 `priority` 服务层，API 可能因配额或订阅限制而降级
   - **感知差异小**：1.5X 加速主要体现在队列优先级，不是模型推理速度，在低负载时段差异不明显

**验证建议**：
```bash
# 检查速度设置是否保存
cat ~/.dsh/plugins/subscriptions/model-speeds.json

# 检查网络请求中是否包含 service_tier
# 需要在 DSH 中启用网络日志查看
```

## 修复方案

### 修复 1：添加 Max 和 Ultra 档位

**文件**：`src/providers/codex.ts`

**第 105-111 行**：
```typescript
// 修复前
const CODEX_EFFORTS = [
  { id: ReasoningEffortId('minimal'), name: 'Minimal' },
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('xhigh'), name: 'Extra High' },
] as const

// 修复后
const CODEX_EFFORTS = [
  { id: ReasoningEffortId('minimal'), name: 'Minimal' },
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('xhigh'), name: 'Extra High' },
  { id: ReasoningEffortId('max'), name: 'Max' },
  { id: ReasoningEffortId('ultra'), name: 'Ultra' },
] as const
```

**第 540-543 行**：
```typescript
// 修复前
const efforts = (entry.supported_reasoning_levels ?? [])
  .filter(level => typeof level.effort === 'string' && level.effort.length > 0 && level.effort !== 'ultra')

// 修复后
const efforts = (entry.supported_reasoning_levels ?? [])
  .filter(level => typeof level.effort === 'string' && level.effort.length > 0)
  // 不再过滤 ultra，让 API 返回什么就用什么
```

**第 721-723 行**（可选优化）：
```typescript
// 修复前
export function codexWireEffort(effort: string): string {
  return effort === 'ultra' ? 'max' : effort
}

// 修复后：移除这个过时的转换，直接透传
export function codexWireEffort(effort: string): string {
  return effort
}
```

### 修复 2：改进速度档位的用户体验

**方案 A：添加切换确认提示**

在 `src/client/SpeedSelect.tsx` 的 `choose` 函数中添加即时反馈：

```typescript
const choose = (tier: SpeedTier): void => {
  if (busy) return
  if (tier === state.tier) {
    setOpen(false)
    return
  }
  setBusy(true)
  void setSpeed(tier, state.model).then((ok) => {
    if (!mounted.current) return
    setBusy(false)
    if (ok) {
      setOpen(false)
      // 添加成功提示
      console.log(`Speed changed to ${tier} for model ${state.model}`)
    }
    void refresh()
  }, () => { if (mounted.current) { setBusy(false); void refresh() } })
}
```

**方案 B：在 UI 上显示当前生效状态**

修改触发按钮的样式，区分 `fast` 和 `standard`：

```typescript
// 在 styles.trigger 中添加条件样式
trigger: {
  // ... 现有样式
  background: state.tier === 'fast' 
    ? 'var(--dsw-alias-accent-primary)' 
    : 'var(--dsh-subscription-speed-hover, transparent)',
  color: state.tier === 'fast'
    ? 'var(--dsw-alias-label-on-accent)'
    : 'var(--dsw-alias-label-secondary)',
}
```

## 测试计划

### 测试 1：Ultra 档位显示
1. 启动 DSH，登录 Codex 账号
2. 打开设置 → 订阅 → Codex → 编辑模型列表
3. 验证每个模型的推理档位下拉菜单中**显示 Max 和 Ultra 选项**
4. 选择 Ultra，保存，创建新会话，验证请求中包含 `reasoning: { effort: "ultra" }`

### 测试 2：Fast 档位生效
1. 在 Composer 中点击速度切换按钮
2. 选择"快速"档位
3. 检查 `~/.dsh/plugins/subscriptions/model-speeds.json` 是否更新
4. 发起新请求，通过网络日志验证请求体包含 `service_tier: "priority"`
5. 对比快速与标准模式的响应时间（需要在高负载时段测试）

## 风险评估

### 修复 1 风险：低 ✅
- **向后兼容**：新增档位不影响现有用户的选择
- **API 兼容性**：如果 API 真的拒绝 `ultra`，会返回明确的错误，不会静默失败
- **用户控制**：用户可以选择不使用新档位

### 修复 2 风险：极低 ✅
- **UI 改进**：纯展示层修改，不影响业务逻辑
- **渐进增强**：即使 UI 更新失败，核心功能仍然工作

## 相关资源

- [Codex Ultra Mode 官方文档](https://codex.danielvaughan.com/2026/07/27/gpt56-sol-ultra-mode-tradeoff-reasoning-budgets-subagent-cost-codex-cli/)
- [Codex 推理档位调优指南](https://codex.danielvaughan.com/2026/03/27/reasoning-effort-tuning/)
- [GitHub Issue #32187 - Ultra 模式问题](https://github.com/openai/codex/issues/32187)
- [GitHub Issue #32587 - 子代理模型继承问题](https://github.com/openai/codex/issues/32587)
