# 账号与模型管理 / Account and model management

在 **设置 → 订阅 → 对应服务商 → 管理** 中配置账号。保存前的修改只属于本地草稿；取消不会写入配置。

## 配置含义

- **别名**：例如“个人”“工作”。独立模型条目显示别名，内部绑定使用稳定账号 key；改别名不会改变绑定。
- **加入自动 Pool**：允许这个账号参与普通对话模型入口的自动调度。默认开启。
- **Pool 模型列表**：限制该账号允许参与 Pool 的模型。“跟随全部模型”包含将来发现的新模型；显式全选只选择当前列表；全不选不允许任何模型参与。
- **独立模型入口**：为账号增加单独的模型选择条目。默认关闭，开启后直接绑定该账号，不随 Pool 切换。

Antigravity 的账号池白名单按模型分组管理，推理档位由模型选择器单独控制。旧版保存的 `-low`、`-medium`、`-high`、`-xhigh` 条目，只有在该账号的当前目录已用对应分组替代具体条目时才按分组匹配；仍存在的手动具体模型和未知 ID 保持原样，`-tiered` 不作猜测映射。读取不会改写配置，编辑器会显示对应分组，取消勾选并保存后不会被旧条目重新启用。该兼容处理不保留旧条目的推理档位限制，也不会修改默认推理档位。

## 工作与个人账号示例

| 账号 | 别名 | 加入自动 Pool | 独立模型入口 |
|---|---|---|---|
| 个人账号 | 个人 | 开启 | 可选 |
| 工作账号 | 工作 | 关闭 | 开启 |

普通模型条目只使用允许参与 Pool 的账号。选择带“工作”别名的独立模型条目后，该模型调用只使用工作账号；账号被删除、独立入口被关闭、凭据失效或额度不足时，不会静默改用个人账号。

## 范围与限制

这些配置约束插件的 **LLM 对话模型路由**，不是整个会话的隐私隔离开关。图片生成、视频生成和 X 搜索等工具仍使用各自的账号策略；指定其他模型的子代理也不因此自动绑定账号。需要严格的工作/个人数据隔离时，不能只依赖此设置。

服务商级“编辑模型列表”继续管理模型显示、上下文和工具偏好；账号管理不重置这些设置。默认账号星标与 Pool 参与开关是两个不同配置。

---

Open **Settings → Subscriptions → provider → Manage** to edit account aliases, automatic-pool participation, per-account pool model allowlists, and independent model entries.

Existing accounts default to participating in the pool, with independent entries disabled. An absent model allowlist follows all discovered models, including future additions; an empty allowlist permits none. Independent entries bind a stable account key, not its editable alias, and do not fall back to another account when unavailable.

Antigravity allowlists select model families; reasoning effort is controlled separately in the model picker. Legacy `-low`, `-medium`, `-high`, and `-xhigh` selections match their family only when that account's current catalog replaces the concrete entry with the family. Still-listed manual concrete models and unknown IDs stay exact; `-tiered` aliases are not guessed. Reads do not rewrite saved settings. The editor shows the corresponding family, and unchecking it removes the legacy selections on save. This compatibility mapping does not preserve an old effort restriction or change the default reasoning effort.

These controls govern LLM model routing only. Image/video generation, X search, and agents explicitly selecting other models retain their own routing policies. This feature is not a session-wide privacy-isolation guarantee.
