# dsh-plan-exec-models —— 主管 / 员工双模型编排

DeepSeek Harness(DSH)Web GUI 插件:**用一个强模型当主管,用一个便宜模型当员工**。拿到比单用小模型更好的结果,同时比单用大模型更低的消耗。

> 输入栏右下角出现「双模型」框(官方「模型位」自动装扮成「单模型」框让位);开关按对话独立,关掉即完全退回官方单模型生成。

## 功能特性

**双模型编排(一个回合内完成,用户只看到一条消息):**

```
主管(强模型):拆目标 → 下发【执行方法 SOP】+【验收标准】
   ↓ 【规划完毕】
员工(便宜模型):按 SOP 落地
   ├─ 顺利   → 自复核 → 【任务完成】
   ├─ 走不通 → 先自己想办法(最多 maxRetries 次)
   └─ 还不行 → 【求援】+ 结构化求助报告(卡在哪/试过什么/缺什么/求什么)
   ↓
主管下场救火:【诊断】根因 →【帮助方式】8 选 1 →【给员工的新任务书】revised_task
   ↓ 【介入完毕】
主管验收:实际读文件 / 跑命令复核 → 通过则输出面向用户的交付总结(结论/关键结果/详细报告)
   └─ 不通过 → 交回主管重新规划 → 循环,直到通过或达到 maxRounds 上限(明确暂停并通知用户)
```

- **口令协议驱动**:【规划完毕】【介入完毕】【求援】【任务完成】【验收】通过/不通过;匹配前剥除空白。**fail-closed**:验收口令读不到(没给明确结论)一律按不通过处理,绝不把未验过的结果静默交付。
- **三种动态介入触发**:① 员工主动求援;② 同一段报错连续重复 maxRetries 次;③ 验收打回。另有兜底:同一工具调用连续重复 stuckThreshold 次(真卡死)。碰壁一两次不触发——那正是员工该自己想办法的时候。
- **主管不替员工干活**:下场只做补上下文、降难度、给方法、给示例,产出结构化 `revised_task` 交回员工继续。
- **每个对话各自独立(v6)**:A 对话开双模型不影响 B;只有新开的对话继承"上一次最后用的设定"(全局 `settings.yaml` 只当种子,每对话真身存 `sessions.json`)。
- **关闭即彻底还原(v6.6)**:关掉开关立刻把本对话模型选择还原为接管前的单模型(显式落 `model/selection` 事件 + 写内存双写,规避官方 selection getter 的回落语义)。
- **存量脏会话自愈(v6.6/v6.7)**:老版本留下的"关了却还挂在编排模型上"的会话,靠三道网自动修复(启动全量扫 / 打开对话时 / 用户再发言前),判据严格卡时间域,幂等、不误伤。
- **状态可视化**:双模型框实时显示当前相位与模型(主管规划 / 主管介入 / 主管验收 / 员工执行,紫/绿色呼吸点),对话里每步有阶段徽标(`阶段 · 模型名`)。

**可调参数(界面仅暴露两项 + 三席选择):**

| 参数 | 默认 | 说明 |
|---|---|---|
| `enabled` | false | 总开关,**按对话独立**;关 = 本对话完全退回官方单模型 |
| `maxRounds` | 20 | 防无限循环安全阀(clamp 1~100):验收不通过的"重规划→继续"轮数上限 |
| `maxRetries` | 2 | 员工在同一段报错上重试几次后主管下场 |
| 主管/员工席位 | 空 | provider / model / 推理等级,两席可跨 provider;开关打开时用当前官方模型自动播种 |

## 适用范围

- **宿主**:DeepSeek Harness(DSH)Web GUI,基于 vendored Cordis 插件体系的 host + client 双端插件(依赖官方 model selection 服务与 `conversation.input.right` 输入位插槽)。
- **任务类型**:多步工程任务(写代码、批量数据处理、调研交付)——规划/救火/验收交给强模型,落地执行交给便宜模型;轻量闲聊没必要开。
- **模型**:DSH 已配置的任意 provider/model 组合(火山方舟 glm、DeepSeek、豆包等;开发时主力组合为 kimi-k3 × glm-5.3-flash 级别搭配)。
- **人群**:希望在 DSH 里降 token 成本、又不接受小模型单独干活质量的用户。

## 兼容性说明(使用前必读)

1. **平台**:开发与全部测试在 **macOS(Apple Silicon)+ DSH App** 完成;Windows/Linux 未验证。
2. **DSH 内部契约依赖**:挂接 `agent/pre-step`、`agent/turn-stopping`、`turn/start`、`agent/request` 等官方 agent 事件,并依赖官方 model selection 的 `selection.assembled/current` 语义。**DSH 大版本升级若变动这些契约,插件可能失效**(仓库 `docs/MAINTENANCE.md` 记录了全部契约与排查方法)。
3. **客户端注入契约**:`dsh.client.immediately: true` 必须保留(叶子插件缺它 = bundle 下载但永不执行、零报错);`exports.inject` 只允许 `["slots", "sessions", "remote", "remote.session"]`;`dsh.client.inject` 必须含 `@deepseek-ai/dsh-client-ui-conversation` 与 `@deepseek-ai/dsh-client-ui-model-selection`。
4. **安装必须是符号链接**:`file:` 依赖在 npm 9+/pnpm 下是**拷贝**而非链接,改源码不生效(且可能被某次 `npm install` 静默还原)——用 `ln -s` 接入并定期核对 inode(详见维护文档)。
5. **模型指令跟随能力**:主管/员工需能稳定输出口令协议;模型不说口令时宿主有内部兜底常量(`planSteps/replanSteps/verifySteps/stuckThreshold`),但不保证所有模型可用。员工太弱会频繁求援(消耗上升),主管太弱会验收失真。
6. **改代码后必须整进程重启** DSH(App 不监督 dsh 子进程);首页 HTML 无 Cache-Control,硬刷新(Cmd+Shift+R)才能拿到新启动图。
7. **纯 JavaScript,无构建步骤**;测试脚本用 Node 直接跑(建议 ≥ 18)。

## 安装(profile 接入三处)

1. `~/.dsh/profiles/web/package.json` → `dependencies` 增加:
   ```json
   "dsh-plan-exec-models": "file:/path/to/dsh-plan-exec-models"
   ```
2. `~/.dsh/profiles/web/cordis.patch.yml` → 追加:
   ```yaml
   - insert:
       - id: dsh-plan-exec-models
         name: 'dsh-plan-exec-models'
   ```
3. 安装并重启:
   ```sh
   dsh plugin --profile web install
   # 然后重启 DSH App
   ```

## 自检(离线,不需要烧 token)

```bash
node test/state-machine.mjs      # 状态机:11 用例 / 86 断言(开关/交棒/触发条件/验收循环/边界)
node test/client-render.mjs      # 客户端真渲染三遍(抓 TDZ 一类"框直接消失")
node test/session-isolation.mjs  # 对话隔离:31 断言(A 开 B 不受影响/新对话继承/按对话存)
node --check lib/index.js && node --check lib/client.js
```

`test/live-*.mjs` 为真机验证脚本,**凭据已脱敏**——运行前需自行设置 `DSH_AUTH_NAME` / `DSH_AUTH_VALUE` 环境变量(本机 DSH App 的会话 cookie)。

## 文档

- [docs/MAINTENANCE.md](docs/MAINTENANCE.md) —— 完整维护手册:工作机制逐层拆解、口令表、三个触发条件判据、v3→v7 内部契约清单(15 条踩坑实录)、排障 API(`/api/state` `/api/log` `/api/probe`)。

## License

[MIT](LICENSE)
