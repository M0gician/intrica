# 当前画布 4 的运行复核与改进建议

2026 年 10 月 12 日新运行的画布 4 最终完成了 GIF 交付，但仍暴露出信箱复核、
文件版本交接、工具参数提示和运行环境方面的问题。消息超时提醒、加急、定向回复
和结果提交已正常工作。最优先需要处理的是信箱请求 ID 的混用，以及复核提交
字段缺失时返回成功查询结果的行为。

2026 年 10 月 13 日再次从当前应用数据库以只读事务取样，确认最新的未删除
画布 4 为 `canvas-f28b1b22208f44e2a3b08235`。最后一条会话记录仍为
10 月 12 日 21:09:44；本次快照的全部数据表内容与 10 月 12 日 21:15 的快照
一致，没有后续新增运行。下述问题在当前源码和应用已加载的构建中仍然存在。

本次复查重新验证了三份附件的原始字节、大小和 SHA-256，均与快照记录一致；
旧候选的工作区路径已经指向新版字节。离线结构检查未发现陈旧工具回执或孤立
审批。使用当前构建的实际校验函数和信箱服务，在内存中再次复现了 `read`
联合类型错误混入其他分支，以及缺少一个复核数组时退回查询的行为。未修改
应用实现或运行数据。

## 运行范围和版本

- 画布在 20:25:05 创建，Agent 运行范围为 20:25:21 至 21:09:44。
  本文时间均为 UTC+8。
- 工作区 HEAD 为 `ea3607fe5a049162cd1bbccd784b9b8623a11a40`，现有改进仍未提交。
  应用加载的构建时间为 20:24:13，数据库版本为 14，本轮工具调用的协议版本均为 3。
- 4 个 Agent、351 条会话记录、178 次工具调用、138 次模型请求；全部 4 个运行
  已结束。工具记录有 10 次失败；另有 4 次 bash 调用返回非零退出码。bash 的工具
  执行状态与命令退出码分别保存，界面已有退出码提示，不能将两种统计混为一谈。
- 这 10 次失败不等于 10 个实现缺陷：拒绝读取整个画布目录、拒绝过期的复核凭据
  均符合预期保护。另一次 bash 非零退出来自模型调用不存在的
  `PIL.ImageChops.getbbox`，属于生成脚本的 API 使用错误，随后已修正。
- 数据库查询使用只读事务；现有画布、授权、会话和附件保持原状。代码只做审查，
  没有应用本文的改进建议。

## 优先处理的问题

### 信箱复核混用了两种 requestId

21:01:42 的 `review_inbox({})` 返回了两条用户输入的 `requestId`。这两个值来自
HTTP 请求追踪，而非 `message_requests` 中的回复请求；此时 `incoming` 和
`outgoing` 都为空。模型随后将它们放入 `trackRequestIds`，21:02:59 被拒绝，
错误为 `INBOX_REVIEW_INPUT`，两个值均列为 `unknownRequestIds`。

代码原因是用户输入保存了 HTTP `req.id`，信箱查询又直接将所有消息中的
`content.requestId` 作为同名字段输出，没有区分它是否为回复请求。

代码位置：
[HTTP 输入来源](/Users/m0gician/git/intrica-public/apps/server/src/http/conversations.ts:140)、
[会话记录保存](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/conversations.ts:206)、
[信箱字段投影](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/message-hooks.ts:111)。

优先改进：信箱仅为真实回复请求输出可跟踪 ID，并通过消息与请求表的关联确认
身份；HTTP 追踪信息使用独立字段或保留在诊断数据中。提交错误同时返回当前
允许跟踪的 ID，并明确用户输入应使用 `handledMessageIds` 确认。保留新来信使
复核凭据失效的检查：21:02:04 的凭据过期拒绝属于正确保护。

### 缺少复核字段的提交被当作再次查看

21:03:11 和 21:03:30，模型携带 `reviewKey` 与 `handledMessageIds`，省略
`trackRequestIds`；21:07:29 则省略 `handledMessageIds`。三次调用都记为
`succeeded`，但只返回 `reviewRequired:true`，没有确认凭据。

两个数组在工具 schema 中均为可选，服务端只要发现任意一个数组缺失，就进入
查看分支，忽略本次提交的确认内容。本轮共调用 `review_inbox` 11 次，其中只有
2 次真正完成确认，3 次属于上述不完整提交。最终两次 `wait_for_message` 都有
有效凭据，等待检查没有被绕过。

代码位置：
[可选字段定义](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/tools/conversations.ts:17)、
[查看与提交的分支判断](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/message-hooks.ts:153)。

优先改进：显式区分查看和确认，例如 `action:"inspect"` 与 `action:"confirm"`；
确认时要求 `reviewKey` 和两个数组，空集合明确传 `[]`。不完整确认应返回字段
错误及可直接修正的参数示例，不能默默转换成查询。继续要求全部待处理项覆盖
和凭据新鲜度。

### 质检使用的快照与工作区文件发生版本分离

20:50:37 发布的候选附件为 `77136035…`，1,875,433 字节。管理员随后修改配色
并重写同一工作区路径，21:01:24 发布了 `6543ac18…`，2,214,087 字节的新附件。
质检员仍持有旧候选节点及对照样片的资源授权，未获得新节点授权；其逐帧读取
和 Python 解码使用了工作区路径。

21:01:38，质检员发现旧节点的快照元数据和当前路径字节不一致，发信请求确认。
21:02:19，管理员指定新 hash，质检员重新抽样与解码，最后按新 hash 提交结论。
最终交付的附件也使用新 hash。

三份不可变附件的字节数和 SHA-256 均与各自节点记录一致。发生变化的是工作区
文件；旧快照仍完整保存。这是此前提出的版本交接风险在本轮的实际出现，没有
证据表明不可变附件被覆盖。

代码位置：
[节点读取保留资源路径](/Users/m0gician/git/intrica-public/apps/server/src/adapters/host/agent-context.ts:93)、
[节点图像读取不可变附件](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/tools/node-read.ts:116)、
[文件授权用于工作区路径读取](/Users/m0gician/git/intrica-public/apps/server/src/adapters/host/executor.ts:81)。

优先改进：质检任务绑定发布节点和 hash；新版本发布后重新授予该版本的读取权限，
再发出更新通知。支持直接对节点快照读取 GIF 帧、帧时长和循环信息，或将获准
快照复制到受限的临时目录，避免质检必须转向可变路径。旧候选显示被后续版本
取代的状态；发送文件与授予资源权限继续分别处理。

## 工具与运行环境问题

### read 错误混入不相关的 schema 分支

20:44:28，三次 GIF 读取将 `frame` 放进 `target`，实际正确位置是工具参数顶层。
错误同时要求补充 `nodeId`、`skillId`，并提示移除当前 path 分支所需的 `path`。
这会将一次字段位置错误解释成互相冲突的修正要求。模型在 6 秒后自行将 `frame`
移至顶层，三次重试都成功。

当前错误格式化器收集联合 schema 的所有分支错误，没有按 `target.kind=path`
筛选。这一返回已使用当前构建的真实工具定义和校验函数在本地复现。

代码位置：
[read 参数定义](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/tools/read.ts:35)、
[错误合并逻辑](/Users/m0gician/git/intrica-public/apps/server/src/modules/execution/tool-validation.ts:26)。

改进：优先选择 discriminator 匹配的分支，只报告 `/target/frame` 的位置问题，
返回将该字段移至顶层的明确操作和正确示例。保留已有的失败审计和 `executed:false`。

### 权限申请说明允许模型构造无效字段组合

质检员先申请整个画布目录的隔离读取能力，被管理员以范围过大拒绝；这次拒绝
符合现有权限边界。随后 20:53:45 的两个申请缩小到单个 GIF，却继续使用
`access:"file", execution:"isolated"`，均在预检阶段失败。

工具说明和 schema 将 `file/directory` 与 `none/isolated/host` 一并提供，而实现
禁止单文件授权包含命令能力。错误只有“文件授权不包含命令执行能力”，没有字段
位置或修正方案。稍后质检员从自己的工作区成功执行 bash，读取了已授权 GIF，
实际无需额外申请在该文件位置执行命令。

代码位置：
[申请说明和 schema](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/tools/permissions.ts:19)、
[单文件组合拒绝](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/tools/permissions.ts:77)、
[自有工作区执行依据](/Users/m0gician/git/intrica-public/apps/server/src/adapters/host/executor.ts:185)。

改进：schema 和说明明确 `access=file` 仅接受 `execution=none`；错误标出
`scope.execution`，说明可以在自有工作区运行隔离命令读取已授权文件。发现能力
应分别说明“命令在哪里运行”和“命令可读取哪些资源”，避免让模型申请整个画布。
本轮仅有 1 个审批实例，已由管理员拒绝，无遗留 pending 或重复审批实例。

### Python 入口和依赖发现仍不完整

54 次 bash 中，46 次输出 `xcrun_db` 缓存写入被拒绝的警告。多数命令仍返回 0，
该警告并不表示 Python 未执行。发现工具选择了 `/usr/bin/python3`；macOS 的
这个入口会经过开发工具定位程序，在宿主临时目录尝试写缓存。

使用当前沙箱构建函数、独立临时工作区和相同环境进行了验证：系统入口会输出
两条缓存拒绝警告；直接调用 `/Library/Developer/CommandLineTools/usr/bin/python3`
返回同一 Python 3.9.6，stderr 为空。

此外，动画工程师在自己的工作区安装了 Pillow，但独立质检员的工作区没有该
依赖。20:54:39 的解码命令因 `No module named 'PIL'` 退出。质检员随后用
标准库自行编写 GIF 解码程序，完成了任务，增加了处理步骤。

代码位置：
[解释器发现](/Users/m0gician/git/intrica-public/apps/server/src/adapters/host/capabilities.ts:29)、
[受限环境和 PATH](/Users/m0gician/git/intrica-public/apps/server/src/adapters/host/sandbox.ts:39)。

改进：提供经验证的真实 Python 入口或工作区包装命令；运行能力返回依赖状态及
局部安装方式。优先让内置媒体读取返回必要的 GIF 元数据，减少质检对外部库的
依赖。保持不同 Agent 的工作区隔离，无需放开宿主临时目录的写入权限。

### 浏览器启动与动画验证仍需模型试错

20:41:57 和 20:53:29，两名 Agent 使用已发现的 Chromium headless shell，
首次启动均出现 `Trace/BPT trap`。加入 `--no-sandbox` 后，在 Intrica 的系统
隔离内启动成功。当前能力说明已提示嵌套沙箱失败时使用这一参数，但缺少可直接
执行、已验证的启动方式。

随后使用 `--virtual-time-budget` 截取不同时间的 GIF，输出图像全部相同，无法
据此证明动画在播放。两名 Agent 最终改用持续的 CDP 会话和实际等待，得到变化
的中间帧及循环回到起点的证据，最终播放验证有效。

代码位置：
[浏览器能力说明](/Users/m0gician/git/intrica-public/apps/server/src/adapters/host/capabilities.ts:44)、
[当前实际浏览器回归使用的启动参数](/Users/m0gician/git/intrica-public/apps/server/src/adapters/host/sandbox-browser.test.ts:75)。

改进：能力发现返回经过验证的可执行路径、隔离条件、必要参数和临时 profile
设置；提供持续 CDP 会话的动画检查示例。只有确认外层系统隔离有效时，才采用
关闭 Chromium 内层沙箱的方式。浏览器日志中的 DNS 警告不作为网络故障结论：
本次外网对照探测在隔离内、隔离外及宿主 Node 均超时，不能归因于沙箱。

### send_message 的目标组合仍有一次可恢复误用

21:01:38，质检员传入 `to:"manager"` 同时附带管理员 `id`，被准确拒绝；
约 12 秒后改成 `to:"agent"` 与 `id`，成功投递。其余 9 次发送全部成功，
根 Agent 最终使用 `to:"user", kind:"result"` 提交成果。

代码位置：
[目标字段检查](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/tools/collaboration.ts:65)。

改进：对不同目标提供独立字段说明和示例；此类错误直接返回“移除 id 继续使用
manager”及“保留 id 改为 agent”两种正确修正。当前扁平消息语法总体可用，本轮
没有再次调用已停用的 `report_result`。

## 此前延迟问题的再次出现

20:27:45 发给管理员的确认消息，直到 20:36:06 才进入模型上下文，延迟
500.495 秒。管理员正在进行一次约 524.561 秒的模型请求；普通消息等待该次
推理结束。美术方案也延迟 93.329 秒才被管理员消费。它们是此前普通追加输入
延迟问题的再次出现。

相比之下，新的跟踪流程已生效：

| 动作 | 时间与结果 |
| --- | --- |
| 请求新版最终质检结论 | 21:04:51，设置预期回复 120 秒 |
| 质检员消费请求 | 21:06:15 |
| 自动超时提醒 | 21:06:52，仅在截止后约 0.512 秒产生一条通知，唤醒等待中的发送者 |
| 管理员加急 | 21:07:11，期限延长并触发加急输入 |
| 定向结果回复 | 21:09:07，使用原请求地址，跟踪状态变为 replied |

两条回复请求最终都已关闭。普通消息也应显示投递、消费、推理阶段和等待时长；
超过阈值提供加急入口。是否自动打断推理，需要按消息类型和任务依赖制定策略。
已派发工具的回执和结果未知保护应继续保留。

## 改进顺序和回归范围

1. 修复信箱中的请求 ID 投影和不完整确认分支。增加用户输入、空请求集合、
   省略单个数组及新来信使凭据失效的回归场景。
2. 将质检对象绑定到不可变附件版本，补充节点 GIF 帧和元数据读取，以及版本
   更新后的资源授权与通知流程。覆盖审查期间源路径被重写的场景。
3. 按联合 schema 的目标分支生成错误；收紧权限字段组合，并补充 `read` 和
   `send_message` 的正确调用示例。
4. 提供真实 Python 入口、按工作区准备依赖，以及经过验证的受限浏览器启动和
   动画检查方式。增加系统 Python、缺少 Pillow、嵌套 Chromium 沙箱和静态截图
   无法证明动画播放的验证。
5. 改善普通消息等待的可见性和响应策略，分别衡量推理时间、排队时间和输入
   消费时间。

结构检查未发现陈旧工具回执、孤立 pending 审批或结果未知的工具；三份附件均
通过原始字节哈希和 GIF 解码校验。最终交付是 640×640、48 帧、80 ms 每帧、
总时长 3840 ms、无限循环的新版本，与质检员明确验收的 hash 一致。

本轮任务生成 GIF，没有新的 HTML 产物；会话记录不能确认下载按钮和节点拖拽
的界面回归情况。因此不能据本轮成功交付推断这三项交互始终正常。
