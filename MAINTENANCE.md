# dsh-plan-exec-models —— 主管 / 员工双模型

在 DSH Web GUI 输入栏右下角（官方「模型位」左侧）增加一个 **「双模型」** 框；
开在这个框上的「双模型工作」菜单里指定 **主管** 和 **员工** 两个模型。
官方那一席同时被装扮成 **「单模型」** 框 —— 双模型关着时它就是唯一的选模型入口。

核心目标：**用一个强模型当主管，用一个便宜模型当员工** —— 拿到比单用小模型更好的结果，
同时比单用大模型更低的消耗。

> **v6 起：单/双模型是「每个对话各自独立」的设定。** 在 A 对话里开双模型，
> B 对话不受影响；**只有新开的对话**才继承"上一次最后用的设定"（全局那份只当种子）。
> 详见下面「每个对话各自独立（v6）」。

## 工作机制（v6.3：主管 × 员工，动态介入 + 验收循环 + 交付总结）

> **两条最重要的原则**
> 1. **阶段什么时候翻转，由模型自己说，不由宿主硬切。** 宿主只在三种"确实出事了"的情况下兜底插手。
> 2. **员工卡住不是失败，是流程的一部分。** 但员工必须**带着结构化报告**来求援，主管才能对症下药。

一轮用户消息 = 一个回合，全程在回合内完成（用户只看到一条消息）：

```
主管：拆目标 → 给【执行方法 SOP】+【验收标准】
   │                       说完「【规划完毕】」才交棒
   ↓
员工：按 SOP 落地
   │   ├─ 顺利      → 自己复核 → 说「【任务完成】」
   │   ├─ 走不通    → 先自己想办法（最多 maxRetries 次）
   │   └─ 还不行    → 说「【求援】」+ 结构化求助报告（问题类型/卡在哪/试过什么/缺什么/求什么）
   ↓
主管：下场救火 → 【诊断】根因 → 【帮助方式】8 选 1 → 【给员工的新任务书】（revised_task）
   │                       说完「【介入完毕】」把活交回员工（要用户拍板时用 ask_user 交还用户）
   ↓
员工：按主管给的新材料继续
   ↓
主管：验收（实际读文件 / 跑命令复核，过程保持安静）
        ├─ 通过    → 「【验收】通过」+ **给用户的交付总结**（结论 / 关键结果 / 详细报告）→ 编排完成
        └─ 不通过 / 没给明确结论 → 交回主管**重新规划**（给出新任务书）→ 员工继续执行
                                      ……循环直到通过，或达到「最大轮数」→ 暂停并明确通知用户
```

> **v6.3：验收通过的那次发言，就是用户看到的"最终答复"。** 用户明确要求：
> "复核依据那种 Agent 自校验说明给客户看没有意义；客户要的是『我问的问题，简练的总结』+ 详细的文档。"
> 所以 verify 指令规定：通过时**不许**写复核依据，直接写面向用户的交付文案 ——
> `**结论**`（1~2 句回答用户最初的问题）→ `**关键结果**`（3~6 条，带数字）→ `**详细报告**`（文档路径）；
> 且**不许出现内部术语**（复核依据/验收标准/员工/主管/编排…），总长 ≤ 20 行。

**主管不替员工干活。** 主管下场只做四件事：补上下文、降难度、给方法、给示例；
产出是一份 `revised_task`（`new_context / new_sop / example / constraints / acceptance_criteria`），
员工照着继续干。`manager_do_step`（主管亲自做一小步）是最后手段。

### 口令表（宿主只听这些）

| 口令 | 谁说的 | 含义 |
|---|---|---|
| `【规划完毕】` | 主管 | 初次任务书已交出，交棒给员工 |
| `【介入完毕】`（也认旧 `【重规划完毕】`） | 主管 | 救火方案已交出，把活交回员工 |
| `【求援】`（也认 `【求助主管】/【需要主管】/【无法完成】/【需要帮助】`） | 员工 | 我卡住了；**紧跟一份结构化报告** |
| `【任务完成】`（也认旧 `【执行完毕】`） | 员工 | 我干完了，请主管验收 |
| `【验收】通过` / `【验收】不通过` | 主管 | 验收结论 |

匹配前会剥掉所有空白，所以 `【 验收 】通过` 也能认。**验收口令读不到（没给明确结论）时按"不通过"处理**
—— fail-closed：宁可多循环一轮，也绝不把没验过的结果当成"通过"静默交付（那正是用户实测到的"任务突然停了"）。

### 三个动态触发条件（任一满足即把主管请下来）

| # | 触发 | 判据 |
|---|---|---|
| ① | 员工主动求助 | 员工说了 `【求援】`（主路径） |
| ② | 员工反复撞同一堵墙 | **同一段报错**连续重复 `maxRetries` 次 |
| ③ | 验收打回 | **主管验收不通过 / 没给明确结论** —— 任何一次都交回主管重新规划（v6.2 起，不再"先让员工重做"） |

另有兜底：**同一个工具调用**连续重复 `stuckThreshold` 次（真卡死）；以及"员工一步都没动手就停住"。

注意②③都是「同一段/连续的**重复**」，不是「报错几次」—— **碰壁一两次不叫卡死，那正是员工该自己想办法的时候**。

### 关闭（默认就是关的，且**只看本对话**）

`enabled === false` → **本插件在这个对话里完全不接管**：不换模型、不注入指令、不写 selection、不统计信号，
行为与"没装这个插件"完全一致（官方单模型生成）。所有接管入口都过同一个闸门：

```js
function isActive(state) {
  return state.enabled === true && seatsComplete(state);   // 这里的 state 是「本对话的那一份」
}
```

关闭动作会**立刻**生效：`PUT /seats` 里发现（本对话的）开关从开翻到关（或两席被清空），
就把**本对话**活会话的 `selection.current` 写回 `undefined` —— 那是官方"我不管了"的语义，
选择权当场交还官方（否则正在跑的会话会停在上一次编排选的模型上，用户会以为"关了还生效"）。
**别的对话一概不动**（见下节）。

### 每个对话各自独立（v6）

**这一节是 v6 的核心。** 原本 `enabled` / 两席存在全局 `settings.yaml` 里，于是
"在一个对话里打开双模型，所有对话都被接管" —— 用户明确要求不要这样：

> 是否为单双模型工作方式，应该每个对话内容都是独立的；
> 只有在新开对话的时候，才继承上一次对话的最后设定。

现在改成**两层存储**：

| 层 | 文件 | 角色 |
|---|---|---|
| 全局种子 | `~/.dsh/settings.yaml` → `dsh-plan-exec-models` 段 | **只当种子**。新对话第一次出现时从这里拷一份 |
| 每对话那份 | `~/.dsh/dsh-plan-exec-models/sessions.json` | **读写的唯一真身**。每个 `sessionId` 一条独立记录 |

一个函数管住所有读：`stateFor(store, sessionId)`

```js
function stateFor(store, sessionId) {
  const key = normalizeSessionKey(sessionId);
  if (key === null) return store.get();          // 老接口没带 sessionId → 退回全局
  const rec = seatSessions.get(key);
  if (rec !== void 0) return { ...DEFAULTS, ...rec };   // 本对话有自己的记录 → 用它
  const pinned = { ...store.get() };              // 第一次见面 → 从全局种子拷一份钉住
  seatSessions.update(key, pinned);
  return pinned;
}
```

- **钉住（pin）只发生一次**，就在某对话首次出现时。此后这个对话改开关/改席位，
  只写它自己那条记录 + 顺带把全局种子更新成"最后一次的设定"（供下一个新对话继承）。
- **所有读取点都必须带上 sessionId**：`agent/pre-step`、`agent/request`、
  `agent/turn-stopping`、`turn/start`、`POST /seats`。漏一处就会出现"某个阶段偷看全局"。
- **关闭动作也按对话算**：`releaseSessions(reason, sessionId)` 只把**本对话**的
  `orchestration.phase` 置 `done`、只清本对话 agent 的 `selection.current`。
- **客户端**把 `?sessionId=` 挂在 `/api/seats`（GET+PUT）与 `/api/state`（GET）上；
  对齐优先级**反转为 Host 优先** —— 本对话在 Host 有记录就照做，Host 空、localStorage 有才反推上去。
  （原来 localStorage 优先，多开对话时会互相覆盖。）
- 调试点：客户端会把当前会话 id 写到 `document.body.dataset.pemSession`，
  live 脚本靠它确认"现在开着的是哪个对话"。

排障时 `/api/log` 会多出这些行，可据此确认隔离生效：

```
Host 侧已加载：存储=…，会话席位表=/Users/azhai/.dsh/dsh-plan-exec-models/sessions.json（已有 2 个对话的独立记录）；
               全局种子=官方单模型（新对话会继承它）；每个对话的单/双模型设定互相独立
会话 78305ba0 首次出现 → 从全局继承设定（官方单模型），此后与本会话独立
总开关（会话 78305ba0）：关 → 开
双模型编排开始接管（会话 78305ba0）：主管规划 → 员工执行 → 求援则主管救火 → 主管验收
已关闭本会话的双模型编排（总开关关闭，会话 78305ba0）：1 个会话交还给官方单模型生成，其它对话不受影响
```

### 换模型怎么生效

走官方 model selection（`agent/pre-step` 里写 `selection.assembled` / `selection.current`），
由官方 `system-prompt/assemble` + `agent/request` 应用，并自然产生 `[model changed: …]` 通知。
拿不到 selection 时退回自己改写 `agent/request` 的 config（降级通道，阶段指令会失效）。

> 顺序很关键：官方的 `system-prompt/assemble` 在 `agent/pre-step` **之前**执行，把 `selection.current`
> 快照成 `assembled`。所以钩子里写 `current` 影响的是**下一步**：`assembled` 对齐"本步"，
> `current` 写"下一步"（用 `peekNextSeat()` 预测）。

### 关掉双模型时怎么"还原"（v6.6 修）

**不能只清 `selection.current`。** 官方 `selectionFor` 的 getter 在内部 `picked === undefined`
时会**回落到 `session.requestHeader()`**（本会话上一次**实际发出**的模型）。编排期间每个回合
都在发主管/员工的请求，于是回落值恰好就是编排模型 —— 用户看到的就是"切成单模型了，
可它还在走双模型那一席"（实测：某会话 11:52:53 关闭后，11:53:20 的请求头仍是 `arkcn/glm-5.3-flash`）。

所以关闭时**显式写回**：

```js
const target = pickSoloFallback(ctx, agent, key);   // 还原目标
agent.session.append('model/selection', target);    // ① 落一条 durable 事件（官方"单模型"框读的就是它）
selection.current = target;                         // ② 写内存（下一刻的 assemble/request 就用它）
```

还原目标的优先级：**接管时记内存的那份 → 接管时落盘的那份 → 用户在关闭之后亲手选的 → 官方默认**。
第 2 项（`soloProvider/soloModel/soloEffort` 写进 `sessions.json`）是必需的 —— 内存记忆活不过
进程重启，而"开着双模型 → 重启 App → 关掉"是极常见路径。

**顺手钉一条关闭时刻**：`PUT /seats` 收到 `enabled: false` 时写 `offAt`。它是自愈判据的时间基线
（见下），必须钉死不被后续写入顶掉。

### 存量脏会话的自愈（v6.6 新增）

老版本留下的"关了却还挂在编排模型上"的会话，靠自愈修。**判据必须卡时间域，四条同时成立**：

1. 开关没开（`enabled !== true`）；
2. 会话表里有这条记录（没有 = 从没见过它）；
3. 当前选中恰好落在本会话某席；
4. 用户在**关闭之后**没有再亲手选过它。

> 为什么必须卡时间：`model/selection` 事件**不只是用户点模型会写** —— 界面上配置两席
> （`commit()`）时会调官方 `select()`，于是**成对**落下该事件（实测 `18:44:47 glm` +
> `18:44:50 deepseek`，正是本会话的两席）。只看"事件流最后一条"，在"current 卡在员工席"时
> 会永远判成"用户想要"，自愈彻底失效。

时间基线取 `offAt`（显式关闭时刻）→ `at`（最后一次配置写入）→ `0`（只被"首次继承全局种子"
写过的记录，没有可用基线，此时最保守：宁可少修不误伤）。

**三道网**（覆盖三种场景，都走同一个判据）：

| 触发点 | 覆盖 |
|---|---|
| 启动后 1.5s / 8s 全量扫活 agent | 重启后就活着的会话 |
| `GET /seats?sessionId=…` | 用户一打开那个对话（**v6.7 起自带迟到补扫**，见下） |
| **`agent/pre-step`（非编排分支）** | 用户再发言时、**请求发出前** —— 最可靠的一道 |

**唤醒竞态与迟到补扫（v6.7）**：点开大会话（实测 4.7MB 事件流）后 agent 要 ~30 秒才活，
而 `GET /seats` 在点开那一瞬间就发出 —— 单发一枪会落空。所以 `GET /seats` 里**没有活 agent 时**
会自动排 10/30/60/120s 四枪迟到补扫（`scheduleHealRetry`，同会话 150s 内去重）；
有活 agent 则直打一枪，不排（醒着的会话没必要）。每枪仍走上面的从严判据 → 幂等、不误伤。

**实测四关**（改判据后必须过）：19865c1f（关后用户选了 → **不修**）、f2e59341（零事件存量污染
→ 修）、78305ba0（关后请求头仍是席位模型 → 修）、d48396c4（关后用户主动选了 doubao → **不修**）。
另两例端到端自愈实证：78305ba0 由 `GET /seats` 直打命中、f2e59341 由补扫 +10s 命中。

### 阶段指令怎么下发

在 `agent/pre-step` 里**追加**一条消息到本步的 `messages`（`{kind:'plugin', form:'notice'}`），
把角色、工作方式、口令写清楚。官方会把它正常 append 成 `user/message`，模型看得见、用户也看得见。

四条指令（`INSTRUCTIONS`）+ 一条带材料的执行指令（`EXEC_WITH_BRIEFING`）：

| 阶段 | 关键内容 |
|---|---|
| `plan` | 主管：复述目标 → 【执行方法 SOP】`步骤N:` → 【验收标准】`标准N:` → 【风险与备选】；别自己动手 |
| `exec` | 员工：按 SOP 做；不通先自己想办法最多 maxRetries 次；不行就 `【求援】` + 结构化报告；完成说 `【任务完成】` |
| `replan` | 主管：内嵌**员工结构化报告** + 现场报错原文；【诊断】→【帮助方式】8 选 1 →【给员工的新任务】revised_task JSON →【给员工的提醒】 |
| `verify` | 主管：实际读文件/跑命令复核（过程保持安静）；**通过 → `【验收】通过` + 给用户的交付总结**（结论 / 关键结果 / 详细报告；禁内部术语；≤20 行）；不通过 → 写清"下一版怎么做"；标准是用户需求，不是员工的自述 |
| exec（带材料） | 员工被救火后：内嵌主管的诊断 + 新任务书（revised_task），要求"不要再重复之前失败的做法" |

### 信号从哪来

| 信号 | 来源 | 为什么不能用别的 |
|---|---|---|
| 上一句发言里的口令 | `agent.session.deriveMessages()` 的尾巴 | — |
| 工具报错 / 员工动作数 | `session/event` 的 `tool/result` | **工具结果不走 inbox**（`payload.messages` 里只有 `additionalContexts`），扫 `pre-step` 的 messages 永远扫不到，属于静默失效 |
| tool-call 签名（判原地打转） | 同 `deriveMessages()` | — |

> 口令识别有个坑：**交回主管后，「上一句发言」还是员工那句【求援】**。
> 所以求援口令**只在 `phase === 'exec'` 时才读**，否则主管每写一步都会被误判成"又求援一次"。

> 第二个坑：**`replan` 必须是独立的 `phase` 值，不能只用 `reason` 记。**
> 早先 `escalate()` 把 phase 停在 `'plan'`、只在 reason 里写 `'replan'`，于是
> `routeStep` / `turn-stopping` / `peekNextSeat` 里所有 `phase === 'replan'` 分支全成死代码：
> 主管的【介入完毕】被当成普通的【规划完毕】，`revised_task` 没人解析 ——
> 交回员工的是一条**没有材料的裸指令**。离线仿真抓到的（见用例 3）。

### 阶段之间怎么"交棒"

`agent/turn-stopping` 是官方在"本步没有工具调用、回合即将结束"时触发的钩子，
它的 dispatch 是 `fused(payload) = {...payload, agent}`，**载荷里带 agent**。于是：

```js
agent.inject(message);   // = inbox.splice("next-step", Infinity, 0, [message])，不唤醒驱动
```

官方主循环的判据因此从 `break` 变成继续：

```js
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial("agent/turn-stopping", { turn, signal });
}
if (turnEnds && this.inbox.nextStep.length === 0) break;   // ← 我们 inject 过，不 break
target = "next-step";
```

`followup` / `steer` / `inject` 三选一，我们用 `inject`（写 next-step 且**不唤醒**）。

> 两条路都要能送出材料：交棒既可能发生在 `turn-stopping`（主管说完就停，常态），
> 也可能发生在 `pre-step`（主管边说边调了工具，本步不触发 turn-stopping）。
> 两者都走同一个 `evidenceOf()` / `captureManagerBrief()`，否则会出现
> "主管救火完毕、交回员工的却是裸指令"。

## 可调参数（界面上只剩两个）

| 参数 | 默认 | 含义 |
|---|---|---|
| `enabled` | **false** | 总开关（**按对话独立**；全局那份只是新对话的种子）。关掉 = 本对话完全退回官方单模型生成 |
| `maxRounds` | 20 | **防无限循环的安全阀**（clamp 1~100）：验收不通过就"重新规划 → 继续"是一轮，跑到这个上限仍未通过 → 暂停并明确通知用户。它不是"跑几轮就收工" |
| `maxRetries` | 2 | 员工在同一段报错上重试几次后主管下场（触发②） |
| `planProvider/planModel/planEffort` | 空 | 主管席位（同样按对话独立） |
| `execProvider/execModel/execEffort` | 空 | 员工席位（同样按对话独立） |

**安全阀不再暴露给用户**（收进宿主内部常量 `TUNING`）：`planSteps=4` / `replanSteps=3` /
`verifySteps=2` / `stuckThreshold=3` / `autoReplan=true` / `verifyOnFinish=true`。
它们只在"模型一直不说口令"时才会用到，用户调它们只有副作用没有收益。

界面：点开唯一的「双模型工作」菜单 → 顶部是总开关 + 两个步进器（`− 值 +`）。
**总开关打开时会用当前官方模型自动播种两席**，避免出现"开关开了、单模型框让位了、两席却还空着"的死角。

## UI 约定（v5：双模型 / 单模型，两个框）

输入栏右下角（左 → 右）**只有两个框**：

| 框 | 内容 | 行为 |
|---|---|---|
| **双模型** | 关闭：`未启用`（压暗）<br>开着没配全：`待设置`（琥珀警示）<br>已接管：`kimi-k3 × glm-5.3-flash`<br>运行中：`主管规划 · kimi-k3` + 呼吸点 | 点开唯一的「双模型工作」菜单 |
| **单模型** | 官方那一席，`::before` 加「单模型」标签，仍显示真实模型名 | 双模型关着 → 完全可用（唯一的选模型入口）<br>双模型开着 → 压暗 + `单模型 · 已让位` + 禁点 |

> **为什么不给主管、员工各留一个框**：那样看起来像两个独立开关，但"总开关"其实只有一个，
> 于是"先关主管、再关员工"的第二次点击会把开关**又打开**（用户实测反馈）。
> 现在两席收进同一个菜单，输入栏上只有**一个**双模型框。

「双模型工作」菜单三个面板（同一容器里换）：

```
① 首页    双模型工作              [已接管 | 开]
          主管模型          kimi-k3        ›
          员工模型          glm-5.3-flash  ›
          最大轮数              − 3 +
          重试次数              − 2 +
② 挑模型  ‹ 返回双模型工作 / 选择主管模型 · 当前 kimi-k3 / 按提供方分组的模型列表
③ 挑等级  ‹ 返回模型列表   / 推理等级 · 主管 · kimi-k3
```

- 关闭态菜单里给明确指引："已关闭：现在完全走官方单模型 —— 用右边「单模型」框选模型即可。"
- **框上显示的是「当前这个对话」的设定**（v6）。换个对话，框的文案会跟着变 —— 那不是 bug，是设计。
- 选完模型**菜单保持打开**并回到首页，方便接着配另一席。
- 官方那席**只装扮不卸载**（仍挂载、仍提供 `modelDirectories`、仍 `load()`），让位靠
  `body[data-pem-dual="on"]` 上的几条 CSS；前缀 `_7KE1Ra` 是运行时从样式表现查的。

- **谁在跑，谁的状态就体现在双模型框上**（紫色=主管相位 / 绿色=员工相位，带呼吸点），**不再单独渲染第三个模型框**。
- 运行时框标签随子阶段变化：**主管规划 / 主管介入 / 主管验收 / 员工执行**；`第N轮` 只在 N>1 时出现。
- 主管席负责 `plan` / `replan` / `verify` 三种相位；员工席只负责 `exec`；收尾（`done`）或未接管时**不亮任何一席**。
- 对话里每一步助手输出上方有阶段徽标（`.pem-stepbadge`），颜色对应四种阶段。
  **文案格式是 `阶段 · 模型名`，例如 `主管规划 · kimi-k3`**（没有"双模型编排"之类前缀）。
  徽标数据来自宿主 `/state` 的 `phases` 映射（键 `turn:step`）—— 阶段是模型说出来的，
  客户端算不出来，必须由宿主汇报；没有记录时只敢断言"每回合第 1 步一定是主管"（`turn/start` 的保证）。
- **徽标是"实时"指标，不是历史记录**：`stepBadgeFor()` 第一道门就是 `orchestrating !== true → null`，
  所以总开关一关（或两席没配全），全部徽标会被摘掉。写自动化断言时必须在**回合进行中轮询**
  `document.querySelectorAll('.pem-stepbadge')` 回采文本，等回合结束再扫 `body.innerText` 会一无所获。

## 安装方式（profile 接入三处）

1. `~/.dsh/profiles/web/package.json` → `dependencies` 增加：
   ```json
   "dsh-plan-exec-models": "file:/Users/azhai/.dsh/local-plugins/dsh-plan-exec-models",
   ```
2. `~/.dsh/profiles/web/cordis.patch.yml` → 追加：
   ```yaml
   - insert:
       - id: dsh-plan-exec-models
         name: 'dsh-plan-exec-models'
   ```
3. 安装并重启：
   ```sh
   dsh plugin --profile web install
   # 然后：设置 → 通用 → 一键重启（由 dsh-setting-restart 提供）
   ```

## 自检（改完先跑离线三支，再重启；要验真机再跑 live 四支）

脚本都在本目录 `test/` 下（**不再放 `/tmp`** —— 重启就没了，README 的指令会失效）。
离线三支**不需要 App**，用 Node 直接跑：

```bash
# ① 状态机：11 个用例 / 86 项断言 —— 开关、交棒、三个触发条件、验收循环（含"通过→交付总结"
#    指令断言与"到上限明确暂停"、"ask_user 交还用户"两个边界用例）
#    （自研 React/fetch 桩，复刻主循环，不碰真实实例、不烧 token）
node test/state-machine.mjs

# ② 客户端：真渲染三遍（默认态 / 菜单 / 已接管）——
#    抓 TDZ 一类的"框直接消失"，以及 v5 的"输入栏只剩一个框、菜单只有一屏、两席齐才显示 ×"
node test/client-render.mjs

# ③ 对话隔离：31 项断言 —— A 开不影响 B、新对话 C 继承全局种子、pre-step 只认本对话、
#    席位按对话存、关 A 不杀 B、老接口（无 sessionId）退回全局、sessions.json 真落盘
node test/session-isolation.mjs

# ④ 纯语法
node --check lib/index.js && node --check lib/client.js
```

要验**正在跑的真实实例**（复用 §9 的 cookie，**全程不发消息、结束自动还原 Host 配置**）：

```bash
# ⑤ 界面端到端：44 项断言（两个框、让位、三面板菜单、2 秒轮询回归、配置还原）
node test/live-ui-verify.mjs

# ⑥ 对话隔离（真机）：26 项断言 —— 在真 App 里切两个对话，
#    B 开双模型 → A 不受影响；刷新后各自恢复；关 B → A 仍关着、全局种子回 false
node test/live-session-isolation.mjs

# ⑦ 只出成品截图（关闭态 / 打开态各一张，写到 /tmp）
node test/live-ui-shots.mjs

# ⑧ 菜单滚到底后继续滚不应退出菜单（含临时开→测→还原）
node test/live-menu-scroll.mjs
```

> live 四支都硬编码了本机 App 的 `dsh-auth-*` cookie；**cookie 过期就照 §9.1 重新取一个**。
> 它们只点 UI、读 DOM，**不发任何消息**，所以不会污染用户的会话、也不会烧 token。
>
> `live-session-isolation.mjs` 会**切换侧栏里的对话**（点未选中那一行，靠坐标点而非索引 ——
> dsh 侧栏按最近使用重排，索引会漂）。跑之前建议把两个测试用对话并排放在列表顶部。

## 维护要点

> **三个致命的坑（2026-09-10 实测踩过，改动前务必先读）**
>
> 1. **`dsh.client.immediately: true` 必须保留。** 本插件是"叶子"（没有任何插件 inject 它）。
>    客户端 `parseBootManifest` 会把启动图拆成 modules（模块加载）与 plugins（插件激活）两个视图，
>    plugins 视图只在 `immediately` 为真时才主动激活条目——**去掉它，bundle 照样被下载，
>    但插件永不执行**（页面 console 里连一条日志都不会有，且没有任何报错）。
>    佐证：`@liustack/modsearch` 同为叶子插件，也设了 `immediately: true`。
> 2. **`~/.dsh/profiles/web/node_modules/dsh-plan-exec-models` 必须是指向本目录的符号链接。**
>    npm 9+ / pnpm 对 `file:` 依赖是**拷贝**而非链接，改本目录不生效（症状：bundle 字节数一直不变）。
>    **⚠️ 会复发**：实测 2026-09-11 23:25，本机四个 `file:` 型本地插件被某次安装/更新带的
>    `npm install` **一次性全部还原成真实拷贝**（零报错、完全静默）。
>    所以**每次改完发现 UI 没反应，第一件事就是复查 inode**：
>    ```sh
>    ls -i ~/.dsh/profiles/web/node_modules/dsh-plan-exec-models/lib/index.js \
>          ~/.dsh/local-plugins/dsh-plan-exec-models/lib/index.js   # 两个数字必须相同
>    ```
>    被还原成目录后重建 —— **用 `mv` 不要用 `rm`**（副本可能含未同步的改动，移走可回滚）：
>    ```sh
>    BK=/tmp/dsh-nm-copies-backup-$(date +%H%M); mkdir -p "$BK"
>    cd ~/.dsh/profiles/web/node_modules
>    mv dsh-plan-exec-models "$BK/" && ln -s /Users/azhai/.dsh/local-plugins/dsh-plan-exec-models dsh-plan-exec-models
>    ```
> 3. **`exports.inject` 只放 `["slots", "sessions", "remote", "remote.session"]`。** `modelDirectories` 由官方
>    model-selection 晚一步提供，放进激活门控会让插件被永久挂起；它必须写在 `apply` 内部的
>    `ctx.inject(["modelDirectories"], …)` 里（官方 model-selection 同一模式）。
> 4. **改了 `lib/*.js` 或 `cordis.patch.yml` 必须整进程重启**：`kill $(pgrep -f "Contents/MacOS/DeepSeekHarness")`
>    然后 `open -a "DeepSeek Harness"`。App 不监督 dsh 子进程，只 kill 子进程不会自动复活。
>
> 附带一条：DSH 首页 HTML **不带 `Cache-Control`**，浏览器/WKWebView 会做启发式缓存，
> 改完插件后普通刷新可能仍拿旧启动图 —— 用 **Cmd+Shift+R 硬刷新**，或清掉
> `~/Library/Caches/<App 的 bundle id>/` 再刷新。

> **v3/v4 补充的内部契约（宿主侧改动前必读）**
>
> 5. **`agent/turn-stopping` 的载荷里有 `agent`。** 来自 `dsh-agent/lib/types/dispatch.js` 的
>    `fused = (payload) => ({ ...payload, agent })` —— 所有 agent 事件都这样注入主体。
>    不要因为看到官方调用点写的是 `serial("agent/turn-stopping", {turn, signal})` 就以为拿不到 agent。
> 6. **`agent.inject` 是官方 API，不是内部字段。** `followup`（写 next-turn、唤醒）、
>    `steer`（写 next-step、唤醒）、`inject`（写 next-step、**不唤醒**）三者选一。
>    我们用 `inject`：当前回合正在跑，不需要也不能唤醒驱动。
>    副作用是它会往会话里落一条 `agent/inbox/spliced` 事件，并最终 append 成 `user/message` —— 这正是我们要的可见性。
> 7. **"关掉开关还在生效"的根因是闸门分散。** 旧版在 4 处各自判断 `enabled`，
>    `turn/start`、`turn-stopping`、`agent/request` 三处漏了检查。现在只有 `isActive()` 一个闸门。
> 8. **⭐ `mode` 这个字段名被 `snapshot()` 占了，别在响应里再写一个 `mode`。**
>    v5 之前 `/api/state` 是 `{ ...snapshot(store, sessionId), mode }`，后者（实现通道
>    `'selection'|'request'|'idle'`）**静默覆盖**前者（编排状态 `'off'|'waiting'|'active'`）。
>    宿主判定一直是对的，坏的是回程 —— 前端每 2 秒轮询一次就把编排状态冲掉，
>    界面于是"一边说已让位、一边说已关闭"，用户看到的就是**"明明关了却还像开着"**。
>    实现通道那个已改名 `implMode`（`/state` `/log` `/probe` 三处）。
>    **自查**：`grep -n -A 12 "\.\.\.snapshot(" lib/index.js`，逐个看展开后面跟了哪些键。
> 9. **一个总开关只能有一个入口。** 旧版两个框、每个框的菜单里各放同一个 `enabled`，
>    用户"先关主管、再关员工"的第二次点击把开关**又打开了** —— 用户以为在关两个东西。
>    现在两席收进同一个菜单，输入栏只留一个「双模型」框。
> 10. **状态翻转要双向留痕。** 原来只 log "关闭"、不 log "打开"，导致"关了又生效"
>     在日志里查不到中间那次打开。现在两个方向都记：`总开关：开 → 关（mode=off）`。
>
> **v6 补充的内部契约（改宿主/客户端前必读）**
>
> 11. **⭐ 任何读设定的地方都必须带上 `sessionId`，一律过 `stateFor(store, sessionId)`。**
>     直接从 `store.get()` 读就是"偷看全局"，会让本对话的判定被别人的设定污染。
>     五个入口一个都不能漏：`agent/pre-step`、`agent/request`、`agent/turn-stopping`、
>     `turn/start`、`POST /seats`（前后各读一次）。
>     **自查**：`grep -n "store\.get()" lib/index.js` —— 除了 `stateFor` / `snapshot` /
>     `createStore` 内部，别处出现就是漏了。
> 12. **`PUT /seats` 一次写两层，顺序不能反。** 先 `seatSessions.update(key, patch)`（本对话真身），
>     再 `await store.update(patch)`（全局种子，给下一个新对话继承）。
>     只写前者 → 新对话继承不到；只写后者 → 又变回全局设置（就是我们要修的 bug）。
> 13. **关闭要按对话释放。** `releaseSessions(reason, sessionId)` 只动本对话：
>     置本对话 `phase='done'`、只清本对话 agent 的 `selection.current`。
>     写日志时要说清是哪个会话，否则排障时会把"A 关掉了"误读成"全局关了"。
> 14. **客户端对齐优先级是 Host 优先。** 本对话在 Host 有记录就照 Host 的来；
>     只有 Host 空、localStorage 有才把 localStorage 推上去。
>     **不能反**（v6 之前是 localStorage 优先，多开对话会互相覆盖设定）。
> 15. **debug 钩子 `document.body.dataset.pemSession` 别删。**
>     live 脚本靠它确认"当前开着的是哪个对话"，也是排查"前端到底有没有把 sessionId 传上来"的唯一手段。
>     传不上来时 `/api/state` 的 `session` 字段会是 `null`、`pinned` 一直是 `false`。

- `dsh.client.inject` 必须保留 `@deepseek-ai/dsh-client-ui-conversation`（slot 宿主）与
  `@deepseek-ai/dsh-client-ui-model-selection`（`modelDirectories` 服务提供方），否则插件不会激活或被加载。
- `exports.inject` 是**客户端服务名**（不是包名）。
- `conversation.input.right` 是 list 型位，允许多个插件叠加贡献；**不要**改用
  `conversation.input.model`（那是 `kind: "single"`，与官方模型位冲突）。
- 菜单用 `position: fixed` 向上弹出（`bottom = 视口高 − 触发器顶边 + 8px`），避免被 composer 容器裁剪。
- 纯手写 JS，无需构建步骤；改动 `lib/client.js` 后重启 `dsh web` 生效。

## 排障

```bash
# 编排现场（阶段状态机 + 每步阶段映射 + 参数）—— 注意 sessionId，不带它看的是全局种子
curl -s 'http://127.0.0.1:47615/dsh-plan-exec-models/api/state?sessionId=<会话id>' | python3 -m json.tool
# 决策日志：换手、下达阶段指令、求援/卡死判定、交棒、验收结论
#   关注这几行：`下达阶段指令：主管规划/主管介入/主管验收/员工执行`、`交回主管（…）`、`交棒 → …`、`验收结论：…`
#   隔离相关：`会话 <短号> 首次出现 → 从全局继承设定`、`总开关（会话 <短号>）`、`已关闭本会话的双模型编排`
#   关闭还原（v6.6）：`记下会话 <短号> 接管前的单模型`、`已把会话 <短号> 的模型还原为单模型：<provider>/<model>`
#   存量自愈（v6.6）：`自愈（<触发点>）：会话 <短号> 的单模型选择还挂在编排模型 <p>/<m> 上，已还原为 <p>/<m>`
#     触发点形如 `GET /seats` / `启动扫描` / `agent/pre-step`；v6.7 起多一种 `打开后补扫 +10s`（唤醒竞态兜底）
curl -s http://127.0.0.1:47615/dsh-plan-exec-models/api/log | python3 -m json.tool
# 通道自检（不用跑回合）
curl -s http://127.0.0.1:47615/dsh-plan-exec-models/api/probe | python3 -m json.tool
# 看每个对话各自记了什么（本文件由 Host 自己维护，别手改，改完要重启）
cat ~/.dsh/dsh-plan-exec-models/sessions.json | python3 -m json.tool
```

判读速查：

| 字段 | 正常值 | 含义 |
|---|---|---|
| `orchestrating` | `true` | 开关开着且两席都选了具体模型，编排已接管 |
| `mode` | `off` / `waiting` / `active` | 关闭 / 开着但两席没配全 / 已接管 |
| `implMode` | `idle` / `selection` / `request` | **实现通道**（不是编排状态！别和 `mode` 混） |
| `pinned` | `true` / `false` | **本对话是否已钉住自己那份设定**（false = 这次才从全局种子拷过来） |
| `session` | 会话 id | Host 收到并生效的会话 id（用来确认前端有没有把 `?sessionId=` 带上） |
| `active.phase` / `active.reason` | `plan`·`replan`·`exec`·`verify` / `initial`·`replan`·`verify`·`exec` | 此刻谁在跑、处于哪个子阶段 |
| `turn.round` | `1..maxRounds` | 当前是第几轮（主管下场后 +1） |
| `turn.escalated` | `true` | 员工已明确求援（模型自己喊的） |
| `turn.workerReport` | 文本 | 员工的结构化求助报告（已转人话），会被原样交给主管 |
| `turn.sameErrorStreak` | `0..` | **同一段报错**连续重复次数，达到 `maxRetries` 触发② |
| `turn.reviewFailStreak` | `0..` | **累计**验收不通过次数（跨轮累加；"没给结论"也计数），达到 `maxRounds` 时暂停并通知用户 |
| `turn.sigStreak` | `0..` | 同一工具调用连续重复次数，达到 `stuckThreshold` 触发兜底 |
| `phases["turn:step"]` | `{phase,reason,model}` | 对话里那一步的真实阶段（徽标数据源） |
