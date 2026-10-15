# 实现与测试清理复核（2026-10-15）

第一批修复为 #41–#44，已合入 `main`。本轮以 `a7cb09c` 为基线，完成
#38、#39、#40 中剩余候选的修改或保留判断。保留判断表示已经复核，不表示
尚待执行的删除计划。历史迁移文件保持不变。

## 工具契约与查询成本（#38）

| 原条目 | 处理与依据 |
| --- | --- |
| 16 | 请求类型从 TypeBox schema 派生。对 9 个公开类型进行了双向可赋值检查；保留 `MoveEntry.expectedLayoutVersion` 可显式传入 `undefined` 的既有语义。将 thinkingLevel 的动态 schema 数组改为显式元组，修正 `Static` 推断为 `never` 的问题。 |
| 18 | 定义已经设置 `additionalProperties: false` 时，不再复制 schema。注册入口仍强制严格对象；直接执行入口仅补齐缺省值，保留显式规则与历史收据优先读取。这两个入口的检查承担不同职责。 |
| 19 | 同一画布内比较两个协作成员时，共用一次局部权限视图：原路径 10 次查询降到最多 6 次。函数返回即丢弃视图；后续授权变更重新查询。其他授权入口保持独立检查，未增加跨事务缓存。 |
| 22 | 一页最多 40 条 mailbox reference 从逐项 upsert 改为一次批量 upsert，保留顺序、重复 ID 和稳定引用。progress evidence 的候选调用/节点合并查询，节点授权仍逐项执行。 |
| 23 | 先逐条完成 archive 权限检查，再为允许访问的归档批量检索匹配来源。20 条目录匹配的数据库往返从 20 次降到 1 次，排序、摘要回退和分页不变。 |
| 24 | 保留两次工具刷新：前一次参与工具执行和上下文预算/压缩，后一次在输入处理与压缩结束后、模型请求之前重新读取权限。直接删除前一次会使用旧工具集估算预算。 |
| 25 | 保留 checkpoint 中的 read observation 扫描及用量估算。观察记录依靠事务内 SQL 去重；内存游标需要额外处理事务回滚、历史替换和压缩。当前测量未支持引入该状态复杂度。 |

CPU 测量使用 Node.js 24.18.0，50 次采样前预热 10 次，每条工具结果含
128 字符正文。read observation 的数据库调用替换为空结果，只测提取调用 ID
的 CPU 成本；下表不代表数据库或模型请求延迟。

| 消息数 | ID 扫描 P95（ms） | contextUsage P95（ms） |
| ---: | ---: | ---: |
| 100 | 0.005 | 0.121 |
| 1,000 | 0.038 | 0.756 |
| 5,000 | 0.274 | 3.716 |

查询数量由真实 PostgreSQL 测试约束。测试还检查后续 grant 变更可见、分页引用
重读稳定，以及被撤销权限的归档正文不可读取。

## 前端与测试结构（#39）

| 原条目 | 处理与依据 |
| --- | --- |
| 26 | 快照恢复、运行订阅、初始响应共用 assistant 消息和时间线更新函数。工具状态合并与用户回执仍按各自事件语义处理。 |
| 27 | reset 与断裂 delta 共用恢复流程，关闭旧流、清空旧消息、合并重复恢复请求；卸载后不再重连或上报恢复错误。新增回归覆盖同一消息 ID 的 revision 回退。 |
| 28 | 删除模块加载时创建的默认 connection/store。生产 App 显式提供两者；单元测试 render helper 与独立浏览器组件夹具共用 provider 工厂，创建独立实例并清理连接。 |
| 33 | 删除只校验手写快照的 contract 测试包，改用真实数据库的图快照及 generation preview 校验公开 schema。由此发现并修正 metadata SQL 将缺失 text/summary 投影为 null 的契约偏差。 |
| 34 | 抽取完全相同的 Agent 创建、工具会话、输入消费、进度检查与通知读取 helper。保留各文件数据库生命周期、视觉能力、清理规则及工具查找失败语义的差异。 |
| 36 | 相同的 E2E 侧栏缩放与画布创建共用 helper；其他 setup/open 保留场景特定参数与交互步骤。 |
| 37 | 升级测试使用冻结的 v8/v9/v12 schema，不再按当前 schema 删除列和表模拟旧版本。v12 来自 `3e9f1f5`；v9 来自最早保存的 v10 schema `3d3621f`（0010 仅转换数据和版本）；v8 再撤销 0009 的三项 DDL。测试构造的收据按历史表真实存在的列复制，再执行生产迁移。 |
| 38 | 历史 CSS、头像和 DOM 增量消融移到独立 visual 入口。普通浏览器测试继续验证生产布局、分页与行为。 |
| 39 | 普通图测试使用 250 节点/250 runs 检查等价性、对象复用、增量负载；10,000 节点/100,000 runs 和耗时记录移到 benchmark 入口，不再用机器相关时间阈值判定功能正确性。 |
| 40 | 80 项安全消融共用一次隔离 PostgreSQL 启动，各测试仍使用自己的数据库。保留精确文本锚点及唯一匹配预检：变体同时涉及 SQL 字符串、权限条件与 JavaScript，统一 AST 改写会增加多种解析规则，并不能覆盖所有目标。每次仍验证生成文件按字节恢复。 |

删除了静态与运行时类名检查均无引用的 14 类 CSS，合计 29 个 selector 分支。
保留动态 `state-*`、`agent-event-*` 和 Markdown 生成的类名。

## 历史兼容与恢复（#40）

| 原条目 | 处理与依据 |
| --- | --- |
| 44 | 保留 full-records 对旧 truncated/recordVersion 的回退。连接兼容判断仍是 API v2 与 graphProtocol，未单独要求记录版本字段；删除回退会缩小现有连接兼容范围。 |
| 45 | 共用空 AssistantMessage 初始化，保留两层事件循环：meteredStream 为每次 provider attempt 写计量并提交错误；scheduledStream 负责排队、重试、校验、lease fencing 和缓存后投递。合并循环会混合不同的完成与失败语义。 |
| 46 | 只有 ENOENT 表示首次运行。身份文件和升级记录损坏、结构不支持或 I/O 失败时明确失败并保留原文件；身份初始化使用独占创建，避免覆盖并发创建的身份。 |
| 47 | 新库不再创建无业务读写的 inbox_reviews。现有数据库及历史迁移中的表和数据继续保留，不作删除迁移。 |
| 30（剩余） | 新库 schema 直接声明最终字段和工具版本默认值。与冻结 v18 对比列顺序、类型、默认值、约束和索引；唯一预期差异为不再新建 inbox_reviews。 |

恢复时应从该安装的备份恢复 `server.json` 或 `updates/operation.json`，然后重启。
不能通过删除损坏文件把已有安装伪装成首次运行；新的服务端身份会影响连接绑定，
丢失升级记录会影响迁移后的恢复判断。

## 验证入口

先运行 `pnpm build`，测试读取 dist 期间不得重新构建。

```sh
pnpm typecheck
pnpm lint
node scripts/ci-tests.mjs functional
node scripts/ci-tests.mjs browser
pnpm test:browser-fixtures
pnpm --filter @intrica/desktop test
node --test tests/integration/public-releases.test.mjs
node scripts/ci-tests.mjs benchmark
node scripts/ci-tests.mjs visual
node scripts/ci-tests.mjs ablation
```

最后一项单独运行，不与其他读取生成模块的测试并行。
原入口 `node tests/integration/ablate-interactions.mjs` 会委托给隔离 wrapper。
