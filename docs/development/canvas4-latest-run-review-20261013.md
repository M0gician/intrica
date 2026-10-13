# 2026 年 10 月 13 日画布 4 运行复核与改进方案

本轮已生成包含 GIF 在内的 8 份交付文件，但协作流程仍有阻塞。最先需要修复的是同一次读取反复产生审批，以及删除成员时同时停止管理员。恢复执行还会重放已经成功的删除。最终管理员完成了自己的检查，独立质检尚未给出结论，运行进入等待消息状态。

## 运行范围与结果

本文时间均为 UTC+8。复核对象为 10 月 13 日 15:07:22 新建的画布 4，ID 为 `canvas-daeb19aa60ae9245b6e83ecb`。10 月 12 日的同名画布已删除，本次统计与此前复核分开。

桌面启动构建元数据为 `07a4681`，构建时间 15:07:12；它属于 `ea3607f` 的直接后继提交链。运行数据库版本为 15，206 次工具调用的协议版本均为 4。采样时工作区的未提交变更集中在会话身份和气泡样式，服务端实现与本轮运行对应。下文问题描述针对该运行版本；本次修复和验证结果另列在文末。复核对应用数据库使用可重复读的只读事务；原始记录保存在仓库外的本地快照中。

| 项目 | 本轮记录 |
| --- | --- |
| 会话范围 | 15:07:45 至 15:48:23 |
| 团队 | 温言负责统筹，江澄负责美术，诸葛亮负责制作，梁溪负责质检；当前保留统筹和制作成员 |
| 数据量 | 4 个会话、1,735 条会话记录、206 次工具调用、125 次模型请求 |
| 工具结果 | 191 次成功、15 次失败；21 次 bash 中另有 4 次命令退出码非零 |
| 模型请求 | 118 次成功、7 次中断 |
| 审批 | 449 条，其中 442 条来自同一次源路径读取；最终 441 条 satisfied、6 条 approved、1 条 denied、1 条 cancelled |
| 运行最终状态 | 4 个 cancelled、2 个 waiting；两个等待原因均为 message |
| 产物 | 8 份快照的字节数和 SHA-256 均匹配，源文件也仍与快照一致 |
| GIF | 640×640、50 帧、每帧 80 ms、4 秒、无限循环，1,679,405 字节 |

16:09:45 再次查询时，图版本 23、事件序号 2,779、消息数、工具数、审批数和最后消息时间均与复核快照一致。

管理员在自己的工作区记录了 GIF 元数据检查和 12 秒 Chromium 实际播放检查。梁溪最后的协作消息仍指出“部分交接段被身体遮住，抛/接动作是否足够可读”，并准备继续查看关键帧；14 秒后其节点被移除。这个视觉问题仍需最终质检结论，不能仅由帧数、哈希和播放检查判断已通过。

## 问题与优先级

| 优先级 | 问题 | 运行影响 | 改进方向 |
| --- | --- | --- | --- |
| P1 | 快照授权和源路径授权判断不一致，审批反复重建 | 单次读取产生 442 条审批及 1,325 条关联通知，质检无法结束该调用 | 统一目标与权限类型；限制无进展的审批重试 |
| P1 | 删除成员同时停止管理员 | 两次团队调整后均需用户恢复管理员 | 区分成员移除、资源撤销与发起者本轮执行 |
| P1 | 恢复执行重放已成功的删除 | 两次出现 Agent 不存在，并使上下文对成员消失原因产生错误判断 | 按会话和原工具调用恢复持久回执 |
| P1 | 正常结束和等待的提示混在一起 | completion=ready 后仍等待消息，最终结果说明未提交 | 明确完成、等待、阻塞三条结束路径 |
| P2 | 附件发送和资源委派缺少完整操作流程 | 一次消息参数失败，随后需逐项处理 6 个读取申请 | 提供明确的批量资源委派与快照复制能力 |
| P2 | 错误返回的执行标志和修正信息不够一致 | 审查拒绝同时返回 executed=true；对象被传成字符串时需自行修正 | 区分操作提交和执行器调用，返回具体修正示例 |
| P2 | 长时间模型生成的进展难以判断 | 美术两次请求均中断，未形成方案；制作有一次 604 秒模型请求 | 返回模型阶段、进展和超时策略，改善加急决策 |

### P1 审批判断与沙箱检查不一致

15:42:59，梁溪调用 `read` 读取诸葛亮工作区中的 GIF 源路径。原调用为 `tool-3f28188a-827f-4954-ac9b-314dd45046a7`。15:43:13 开始，审批不断变为 satisfied，工具恢复后又申请相同路径，直到 15:46:57 删除质检成员才结束。

这一次调用产生 442 条审批，441 条变为 satisfied，最后一条 cancelled。与它关联的通知包括 442 条 permission_notice、442 条 access 和 441 条 tool_update，共 1,325 条，占本轮会话记录约 76.4%。后台恢复持续重试同一个模型调用，产生了这些申请。

被复核版本的判断链为：

1. `coveringGrant` 根据资源路径判断覆盖范围，快照节点也被当作源路径授权。
2. `intentCovered` 因此判定权限已经满足，`reconcileApprovals` 将审批置为 satisfied，并将原工具恢复为 prepared。
3. `HostExecutor.scope` 为保持快照隔离，明确跳过带 snapshot 的资源，实际执行范围仍不包含源路径。
4. 工具重新执行准备检查，产生新的审批。`AccessService.gate` 仅复用 pending 或有效 approved 的原申请，未将相同 satisfied 后仍不满足执行条件的状态作为错误停止。
5. 后台监视器每 500 ms 检查一次，持续恢复原调用。原工具的整体执行超时尚未开始，模型回合限制也无法阻止这类后台循环。

使用被复核构建的实际 `coveringGrant` 函数，对本轮 GIF 节点进行只读检查，确认快照授权仍返回“覆盖源路径”。同一问题还表现为管理员的 `request_permission` 返回 granted 后，两次隔离 `cp` 仍返回 Operation not permitted；管理员最后使用 fullHost 才完成复制。

改进方案：

- 将发布快照、可变路径和命令执行范围作为不同权限目标。节点快照只授权固定字节；源路径的访问必须由路径授权单独决定。
- 让权限说明、审批是否满足、操作准备检查和沙箱构建共用同一授权判断。批准路径时创建独立的路径资源，避免复用同路径的快照节点。
- 同一工具调用、同一目标和同一权限版本保留一个审批记录。已判定 satisfied 而执行检查仍失败时，返回授权不一致的具体错误，停止自动重建。
- 对后台恢复设置无进展次数限制及退避。停止时保留原调用、目标、权限依据和未执行状态，以便处理原因。
- 按原调用合并审批通知与工具更新，历史变化按需展开。审批状态的变化只在需要处理时触发信箱通知。

代码依据：[路径覆盖](/Users/m0gician/git/intrica-public/apps/server/src/modules/access/resources.ts)、[快照排除](/Users/m0gician/git/intrica-public/apps/server/src/adapters/host/executor.ts)、[审批恢复](/Users/m0gician/git/intrica-public/apps/server/src/modules/access/lifecycle.ts)、[申请复用](/Users/m0gician/git/intrica-public/apps/server/src/modules/access/service.ts)、[后台轮询](/Users/m0gician/git/intrica-public/apps/server/src/modules/execution/background-tools.ts)。

### P1 删除成员导致管理员运行中断

15:18:55，温言成功删除江澄。相同事务随即将温言和江澄的运行标记为 cancelRequested，温言约 27 ms 后结束为 cancelled。诸葛亮后来完成了产物，管理员仍需用户在 15:40:49 恢复，才继续质检流程。

15:46:57，温言成功删除梁溪，温言又约 30 ms 后结束为 cancelled。用户于 15:47:19 再次恢复管理员。两次取消时间都与 `dismiss_agent` 的成功事务一致，删除由模型发起。

招募时，管理员会取得成员节点的管理授权。删除节点时，`deleteNodes` 把删除的成员和所有被移除授权的 subject 一并交给 `cancelAgents`，其中包括发起删除的管理员；随后权限减少检查再次取消它。这个过程还会改变协作暂停状态。权限变化分支将 consumed_message_seq 直接推进到 message_seq，也会使尚未实际消费的来信失去正常待处理状态。

改进方案：将成员移除和资源权限撤销分别处理。删除成员时停止该成员及其需要停止的工作，管理员在工具回执持久化后更新名录和权限，再继续协调。对于正在使用被撤销资源的调用，保留必要的取消检查，依据具体执行目标判断影响范围。权限变化应保留尚未消费的协作来信，不直接推进消费序号。

代码依据：[招募后的管理授权](/Users/m0gician/git/intrica-public/apps/server/src/modules/access/service.ts)、[删除时取消相关主体](/Users/m0gician/git/intrica-public/apps/server/src/modules/graph/mutation.ts)、[权限减少检查](/Users/m0gician/git/intrica-public/apps/server/src/modules/graph/mutation.ts)、[取消与消费序号](/Users/m0gician/git/intrica-public/apps/server/src/modules/execution/cancellation.ts)。

### P1 恢复时重放已成功的删除

15:40:49 和 15:47:19，管理员恢复后分别再次执行先前已经成功的删除，均返回 NOT_FOUND。原调用和重放调用使用相同的 logical_call_id，但属于不同 run_id，因此生成了新的工具记录。

删除的副作用与工具回执已经持久化，管理员取消使其后续 checkpoint 未能加入 toolResult。下一轮从 checkpoint 中找到未闭合调用；`invokeTool` 只按当前 run_id 和 logical_call_id 查询原回执，未取得上一轮的成功结果，于是再次执行。随后模型将成员缺失解释为可能的自动移除或服务恢复，影响了后续交接判断。

改进方案：恢复会话时，先按 conversation、原回合标识、工具名称和参数哈希匹配持久回执。已成功调用只补齐上下文中的 toolResult。合法的新调用使用新的回合标识。具有副作用的图操作，应在完成后保留可供会话恢复使用的原调用关联，避免取消发生在副作用提交与上下文保存之间时丢失确认结果。

代码依据：[按当前运行查询工具回执](/Users/m0gician/git/intrica-public/apps/server/src/modules/execution/tool-calls.ts)、[未闭合调用恢复与后续 checkpoint](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/conversation-runtime/execute.ts)、[已有回执匹配机制](/Users/m0gician/git/intrica-public/apps/server/src/modules/execution/checkpoint-tools.ts)。

### P1 完成后仍进入等待消息

15:48:18，管理员的 `review_inbox` 确认返回 reviewed=true、completion=ready。15:48:23 又调用 `wait_for_message`，运行变为 waiting/message。截至复核结束，管理员没有提交 `to=user, kind=result` 的消息；用户可以访问已发布文件，但最终交付说明和独立质检结论仍未完成。

被复核版本的系统提示先说明正常结束也执行信箱检查，紧接着要求将确认凭据用于 wait_for_message。英文提示中的 “Then call wait_for_message” 同样没有限定为仍需等待的情况。本轮保存的上下文显示，模型将检查后等待理解为流程要求。

质检请求也没有得到结果回复。该成员移除后，跟踪停止，信箱不再把它列为待处理投递。管理员随后报告“没有待审批或待回复请求”，仅说明当前跟踪状态，不能表示独立质检已完成。15:46:30 的一次 reviewId 失效拒绝符合新消息保护，需处理的是背景通知及未完成任务的表达。

改进方案：

- 提示与返回值明确分支：仍依赖回复时调用 wait_for_message；可以结束时先提交结果，再自然结束；存在权限或执行问题时说明阻塞原因。
- 为仍然打开的任务关联交付节点、版本和验收结果。发送者明确接受取消、转交或结果后，才把工作标记为完成。
- 保留收件人移除、发送者停止跟踪等关闭原因，供结束检查判断是否需要重新分配任务。
- 信箱确认以需要处理的项目及其版本为依据，稳定复用检查结果。恢复审批通知的合并后，继续保留实际新消息使确认失效的检查。

代码依据：[等待与结束提示](/Users/m0gician/git/intrica-public/apps/server/src/adapters/model/conversation-prompt.ts)、[信箱状态与确认](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/messaging/review.ts)、[投递关闭投影](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/messaging/deliveries.ts)、[结束检查](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/messaging/completion.ts)。

### P2 资源委派和快照复制缺少完整流程

15:41:54，管理员发送质检任务时同时传入 fileIds 和 resourceIds，被拒绝：“仅管理者的 result 可交付已接管工作的资源”。移除 resourceIds 后消息成功，但梁溪读取 6 个节点仍需分别申请权限。附件发送不授予读取权限的规则本身符合当前设计；字段含义和后续委派步骤还不够明确。

节点 GIF 帧与元数据读取已可用。独立播放器、Pillow 或哈希检查还需要固定原始字节；当前工具不能直接将获准快照复制到自己的工作区。梁溪因此转向源路径，进入审批循环；随后申请整个工程目录，被管理员拒绝。最后管理员凭 host 能力完成实际播放，梁溪只能引用该检查并说明自己未在隔离环境实播。

改进方案：提供明确的批量资源委派操作，检查管理关系、已有权限及每个固定版本，再发送任务通知。将用于交付文件、授权读取、接管工作结果的字段分别命名并给出完整示例。提供将获准快照复制到自身工作区的工具，返回节点 ID、哈希和目标路径，使成员能够保持隔离并运行独立检查。

代码依据：[消息字段限制](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/tools/collaboration.ts)、[发送时的文件检查](/Users/m0gician/git/intrica-public/apps/server/src/modules/access/service.ts)、[路径申请的已有授权判断](/Users/m0gician/git/intrica-public/apps/server/src/adapters/host/executor.ts)。

### P2 错误执行状态和修正提示

三次过期审批审查准确说明“此审查未执行”，返回的顶层 executed 却为 true。当前字段表达执行器是否进入 execute，和目标操作是否提交存在差异。两次 update_message 版本冲突仅返回新版本号，缺少当前回执及可用动作。

诸葛亮还曾将 read.target 传成 JSON 字符串，四次预检均仅指出 `/target` 应为 object、实际为 string。这些属于模型参数误用，错误分支筛选已比前次复核准确；修正后继续执行。可补充直接可用的结构化对象示例，并明确 target 无需再次 JSON 编码。

改进方案：让执行状态分别说明目标操作是否提交、是否仍在后台、结果是否未知。状态冲突返回当前状态、版本、允许的动作和下一步；保持拒绝过期决定的检查。结构错误提供针对当前字段的最小修正示例，不自动扩大参数解释范围。

代码依据：[审批拒绝返回](/Users/m0gician/git/intrica-public/apps/server/src/modules/access/service.ts)、[统一错误格式](/Users/m0gician/git/intrica-public/apps/server/src/modules/execution/tool-validation.ts)、[消息版本冲突](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/messaging/actions.ts)。

### P2 长时间模型生成的状态信息不足

江澄的两次请求分别持续 325.880 秒和 278.088 秒，均在产生持久方案前被中断。第一次中断与加急输入时间一致，第二次发生在成员删除时。诸葛亮另有一次 604.377 秒的模型请求，最终成功。它们均较早收到模型流式响应，记录不能将这些请求判断为网络无响应。

管理员多次看到的状态只有 running、无活动工具和待处理消息数量，难以判断对方仍在生成、缺少依赖还是执行停滞。加急会打断当前推理，持续时间较长时需要让发送者知道这一影响。

改进方案：状态接口返回模型生成阶段、请求持续时间、首次响应、最近流式响应和当前工具阶段。为不同任务设置合理的生成预算和等待期限；长任务及时提交阶段结果或请求调整计划。加急前显示对当前推理的影响，并按任务依赖决定继续等待、调整范围或重新分配。

代码依据：[成员状态工具](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/tools/conversations.ts)、[消息加急](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/messaging/actions.ts)、[运行中的输入检查](/Users/m0gician/git/intrica-public/apps/server/src/modules/work/conversation-runtime/execute.ts)。

## 与前次复核的差异

| 前次问题 | 本轮证据 |
| --- | --- |
| HTTP requestId 混入回复请求 | 用户输入使用 traceId，回复通过 deliveryId 和 replyTo；未出现同类混用 |
| 不完整确认退回查询 | review_inbox 有 13 次 inspect、12 次 confirm；11 次确认成功，1 次因信箱变化被明确拒绝 |
| 等待前未复核 | 11 次 wait_for_message 都携带 confirmed=true 和 reviewToken，均成功 |
| 未读及回复超时提醒 | 跟进、停止跟踪和加急已有实际调用，等待中的管理员被提醒唤醒；新问题主要在后续完成流程 |
| 旧工具 report_result | 本轮未调用；send_message 共 19 次，18 次成功，1 次因 resourceIds 的使用条件失败 |
| 同管理者通信 | 本轮成员和管理员之间发送成功，协作操作没有产生审批申请；未发生兄弟成员直接发信的运行案例 |
| 固定 GIF 帧读取 | 本轮可以通过节点读取 GIF 元数据和指定帧；源路径与快照的权限判断仍有上述不一致 |
| Python 系统入口缓存警告 | 21 次 bash 输出中没有前次的 xcrun_db 警告；一次中文脚本编码错误在添加编码声明后恢复，具体原因未查明 |
| 浏览器启动与实际播放 | 工程师和管理员均保存了持续 CDP 会话与实际时间采样的检查结果 |
| 文件版本交接 | 8 份快照和当前源文件的字节均一致，本轮没有再次出现旧节点与新源路径字节分离 |

发布的 GIF 原始字节经独立元数据读取确认：50 帧、每帧 80 ms、总计 4,000 ms、loop=0。交付 ZIP 中的 23 个条目通过 CRC 检查，其中 GIF 哈希与发布节点一致。复制、执行和界面下载仍是分别需要验证的行为。本轮记录未包含下载按钮、节点拖动和内置浏览器预览 HTML 的用户操作，不能据此新增这些交互的通过或失败结论。

## 实施顺序和回归范围

1. **先处理审批循环。** 统一快照和路径的权限判断，限制重复恢复，合并通知；覆盖“已获快照权限后读源路径”和“返回 granted 后实际隔离读取”的一致性。
2. **修复团队调整与恢复。** 管理员删除成员后继续运行；工具副作用提交与 checkpoint 保存之间发生取消时，恢复只补齐原回执；权限变化保留未读协作消息。
3. **完善结束流程。** 验证 completion=ready 后提交结果并结束；仍需回复时等待；成员退出后保留未完成任务原因及可重新分配状态。
4. **完善资源交接。** 批量委派固定版本、复制获准快照到成员工作区，再验证哈希、逐帧读取和隔离浏览器播放。审批和实际执行统一检查同一份权限。
5. **改善工具说明与状态反馈。** 覆盖结构化 read.target、消息版本冲突、过期审批的执行标志，以及长时间模型生成和加急中断的状态信息。

实现按权限目标、审批状态、会话恢复、结束检查和快照复制拆分模块，复用现有 messaging、conversation-runtime 和 execution 边界。回归应在独立 PostgreSQL 和临时工作目录执行，加入持续运行一段时间仍只有一个审批的断言；单次工具成功不足以覆盖后台恢复循环。

## 本次校验和修复

再次核对仓库外的只读快照，206 次工具调用、125 次模型请求、449 条审批和单次调用造成的 1,325 条通知均与报告一致。主要原因通过实际权限、审批、会话恢复和消息生命周期实现交叉检查。长时间请求已收到早期响应；旧数据没有最近响应时间，不能据此断言全过程持续输出或判断网络挂起。

修复基于 `07a4681` 所在的 `ea3607f` 后继分支，保留现有 UI 改动。未切换到 `e20701c`，未修改运行中的数据库、授权、消息或产物，也未重启应用。数据库定义升级至 16，工具接口升级至 5；没有为旧 `send_message.resourceIds` 增加兼容别名。

| 问题 | 已实现的行为 | 主要模块 |
| --- | --- | --- |
| 快照与路径权限混用 | 快照仅按节点身份授权；源路径单独检查和授权；审批结束后仍不能执行时返回 `AUTHORIZATION_CHANGED`，不再新建审批 | access/resources、access/service、host/executor |
| 删除成员中断管理员 | 只直接取消被移除成员；真正的资源撤权继续中断相关执行，未读输入保留 | graph/mutation、execution/cancellation |
| 跨运行重放副作用 | 按会话、原 turn、provider call、工具名和参数哈希恢复持久回执；未确认副作用阻止自动重放 | conversation-runtime/recovery |
| 完成与等待混淆 | 双语提示和工具说明明确 `completion=ready` 后核查交付、提交结果并结束；无依赖等待必须说明明确的值守任务 | conversation-prompt、messaging/review |
| 移除成员丢失未完成事项 | 保留历史姓名、未完成投递和 `member_removed` 通知；复核需说明重新分配或取消原因；允许按正常协作额度唤醒发送者 | execution/member-removal、messaging/removal-notices |
| 缺少资源交接工具 | 新增 `grant_resources`，按管理关系、资源版本和已有权限原子委派；新增 `copy_artifact`，复制获准快照到自身工作区并校验哈希，不跟随目标符号链接或覆盖不同文件 | tools/resource-handoff、storage/artifact-copy |
| 工具错误含糊 | 已知未执行的拒绝统一返回 `executed:false`；消息版本冲突带当前回执及允许操作；字符串 target 返回正确对象示例 | execution/tool-validation、messaging/actions |
| 长时间生成难以判断 | 记录节流后的最近流式响应和阶段；状态接口返回请求时长、首末响应；明确加急中断生成的影响 | model/progress、model/usage、work/activity |

系统提示检查覆盖 owner/admin/write/read 角色、中文和英文、工具可见性、发送及接管字段、资源授权与复制步骤、信箱复核、等待、正常结束，以及加急影响。`report_result` 保持停用。文件发送不隐式授权；批量授权不新增命令执行权限。服务端检查负责状态与权限，结果是否满足任务要求仍需实际验收。

协作 UI 同步处理已关闭但尚未完成跟踪的请求：保留回执和核查提示，隐藏继续等待、提醒时间和加急操作，仍允许停止跟踪。成员退出通知的自动唤醒遵循协作次数上限；超过上限只保留待处理通知，停止重复唤醒。

新增逻辑分别放入会话恢复、成员退出通知、资源交接、快照复制和模型进展模块；未向现有单文件集中追加大段流程。

验证结果：

- `pnpm build`、`pnpm typecheck`、`pnpm lint` 和 `git diff --check` 通过。
- `node scripts/ci-tests.mjs functional`：99 个测试文件、793 项测试全部通过，其中集成测试 376 项。PostgreSQL、测试数据目录和服务端口均独立于运行中的应用。
- 新增 `tests/integration/runtime-reliability.test.ts` 的 11 项回归覆盖快照与路径隔离、重复审批恢复、批量委派、固定字节复制与目标保护、成员退出、撤权保留输入、跨运行回执恢复、未知结果阻止重放、完成与等待、状态诊断和协作额度。
- 浏览器回归：身份栏、双语协作布局，以及合成 HTML/WebGL 预览、正文区域拖拽和下载共 3 项通过。另 1 项依赖历史画布 3/4 原始文件路径，未配置夹具而跳过。
- 新增前端回归确认：已关闭但仍需跟踪的消息保留核查与停止跟踪操作，不再提供等待或加急按钮。

仍需区分软件修复验证与原任务验收：本次没有重启正在运行的 Intrica，也没有在真实画布 4 重新触发 Agent。原 GIF 中交接动作的可读性仍需独立视觉质检。下一次真实运行应重点观察审批是否只产生一份原申请、管理员删除成员后是否持续执行、质检能否仅凭快照权限完成独立检查，以及最终结果是否在交付后正常结束。
