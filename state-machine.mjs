/**
 * 双模型编排状态机 · 离线仿真（v3：按真实步序建模）
 *
 * 真实回合的时序（每一步 = 一次 LLM 调用 + 它发起的工具执行）：
 *
 *   turn/start ─→ [官方 system-prompt/assemble：把 selection.current 快照成 assembled]
 *      └→ pre-step   看得到「上一步产出」+「上一步 inject 的指令」
 *                    → 写 assembled（本步用谁）+ current（下一步用谁）+ 贴阶段指令
 *         └→ 模型产出 = 本步产出
 *            ├─ 有工具调用 → 工具执行 → tool/result 事件 → 同一回合自动进下一步
 *            │                （**不触发** turn-stopping）
 *            └─ 无工具调用 → turn-stopping 触发（本步产出就在 tail 里）
 *                            → 决定交棒 / 收尾；交棒靠 agent.inject 注入下一条指令
 *
 * 所以仿真里每一步要分别喂：
 *   prev = pre-step 看得见的「上一步产出」（口令已经写在这里了）
 *   now  = turn-stopping 看得见的「本步产出」（**口令必须写在这里**）
 *
 * v2 的错误正是把口令错放进了 prev，导致 turn-stopping 读不到口令。
 *
 * 用法：node /tmp/pem_simulate.mjs
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ---------- 把 Host 插件点起来（假 ctx） ---------- */
const home = join(tmpdir(), 'pem-sim-home');
process.env.DSH_HOME = home;
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const API = '/dsh-plan-exec-models/api';

const handlers = new Map();
let httpHandler = null;
const settingState = {
	enabled: false,
	// 与新版默认值保持一致：验收不通过的"重新规划→继续"循环可以跑很多轮，
	// 轮数只是防无限循环的安全阀（用例 10 会临时调小验证到顶行为）。
	maxRounds: 20,
	maxRetries: 2,
	planProvider: 'vendorA', planModel: 'Manager-1',
	execProvider: 'vendorB', execModel: 'Worker-1',
	planEffort: '', execEffort: ''
};
/** sessionId → 该会话当前的 agent（pre-step / turn-stopping 拿到的就是它）。 */
const agentsBySession = new Map();
/** 一个共享的官方 selection 对象：本插件就是要写它。 */
const fakeSelection = { current: undefined, assembled: undefined };
/** 官方 selection 的降落点（关闭时应回到这里）。 */
const OFFICIAL_ROUTE = { provider: 'vendorDefault', model: 'Official-Single' };

const fakeCtx = {
	settings: {
		register: () => ({
			get: () => settingState,
			update: async (patch) => { Object.assign(settingState, patch); }
		})
	},
	webServer: { register: (options) => { httpHandler = options.handler; } },
	agents: {
		list: () => [...agentsBySession.values()],
		get: (id) => agentsBySession.get(String(id))
	},
	reflect: {
		get: (name) => (name === 'sessionController'
			? { agents: { selectionFor: () => fakeSelection } }
			: undefined)
	},
	effect: (fn) => { fn(); },
	on: (name, fn) => { handlers.set(name, fn); return () => {}; }
};

const mod = await import('/Users/azhai/.dsh/local-plugins/dsh-plan-exec-models/lib/index.js');
mod.apply(fakeCtx);

/* ---------- 基础设施 ---------- */
/**
 * @param text  最后一条 assistant 消息的文本（pre-step / turn-stopping 看的 tail）
 * @param calls 它的工具调用签名（有工具调用 = 本步不会触发 turn-stopping）
 */
function makeAgent(sessionId, text, calls = []) {
	let nextStep = null;
	const agent = {
		session: {
			id: sessionId,
			deriveMessages: () => (text === '' && calls.length === 0 ? [] : [{
				role: 'assistant',
				content: [
					...(text ? [{ type: 'text', text }] : []),
					...calls.map((c) => ({ type: 'tool-call', name: c.name ?? 'bash', arguments: c.args ?? '' }))
				]
			}]),
			requestHeader: () => undefined
		},
		inject: (message) => { nextStep = message; },
		taken: () => nextStep
	};
	agentsBySession.set(sessionId, agent);
	return agent;
}

let failures = 0;
let total = 0;
function check(label, actual, expected) {
	total += 1;
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures += 1;
	console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `\n      期望=${JSON.stringify(expected)}\n      实际=${JSON.stringify(actual)}`}`);
}

const emit = (sessionId, event) => handlers.get('session/event')({ id: sessionId }, event);
const turnStart = (sessionId, turn) => emit(sessionId, { type: 'turn/start', data: { turn } });
const toolOk = () => emit('__', {
	type: 'tool/result',
	data: { message: { content: [{ type: 'tool-result', isError: false, content: 'ok' }] } }
});

/** 上一步 inject 的指令，会在下一步真的送达模型。 */
const carried = new Map();
/** 每个会话走到的步数（给提示词用，仅用于打印）。 */
const stepNo = new Map();

/**
 * 跑「一个真实步」。
 * @param prev  pre-step 看得见的"上一步产出" { text, calls }
 * @param now   turn-stopping 看得见的"本步产出"  { text, calls }
 * @param tools 本步落地的工具结果（写进 session/event，用于累计 execToolCalls / 报错信号）
 */
async function realStep(sessionId, turn, prev, now, tools = []) {
	const n = (stepNo.get(sessionId) ?? 0) + 1;
	stepNo.set(sessionId, n);

	// 本步模型能看到的"上一步交棒注入的指令"——必须在步首取，不能被本步的注入覆盖。
	const carriedNow = carried.get(sessionId) ?? '';
	carried.delete(sessionId);

	// ── ① pre-step：拿到「上一步产出」，决定本步归谁
	const before = makeAgent(sessionId, prev.text ?? '', prev.calls ?? []);
	const decision = await handlers.get('agent/pre-step')(
		{ agent: before, turn, step: n },
		async () => ({ kind: 'ok', messages: [] })
	);
	const instruction = (decision?.messages ?? []).length > 0 ? decision.messages[0].content[0].text : '';

	// ── ② 本步的工具结果落地（session/event 是唯一能看到工具结果的时机）
	for (const t of tools) {
		if (t.error) {
			emit(sessionId, {
				type: 'tool/result',
				data: { message: { content: [{ type: 'tool-result', isError: true, content: t.error }] } }
			});
		} else {
			emit(sessionId, {
				type: 'tool/result',
				data: { message: { content: [{ type: 'tool-result', isError: false, content: 'ok' }] } }
			});
		}
	}

	// ── ③ turn-stopping：只有本步"没有工具调用"时官方才会触发它
	const after = makeAgent(sessionId, now.text ?? '', now.calls ?? []);
	let injected = '';
	if ((now.calls ?? []).length === 0) {
		handlers.get('agent/turn-stopping')({ agent: after, turn });
		const message = after.taken();
		injected = message === null ? '' : message.content[0].text;
	}
	if (injected !== '') carried.set(sessionId, injected);

	return {
		step: n,
		/** 本步 pre-step 贴的指令（换人时才非空） */
		instruction,
		/** 本步 turn-stopping 注入给下一步的指令 */
		injected,
		/** 本步模型真正收到的编排指令 = 上一步交棒注入的 ?? 本步 pre-step 贴的 */
		effective: carriedNow !== '' ? carriedNow : instruction,
		route: { current: fakeSelection.current, assembled: fakeSelection.assembled }
	};
}
const title = (text) => (text === '' ? '(无交棒)' : text.split('\n')[0]);

/* ---------- HTTP 直通（验证 PUT /seats 的全局关闭） ---------- */
function api(method, url, body) {
	const request = new EventEmitter();
	request.method = method;
	request.url = url;
	request.destroy = () => {};
	setImmediate(() => {
		if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)));
		request.emit('end');
	});
	const response = { status: 0, payload: null };
	response.writeHead = (status) => { response.status = status; };
	response.end = (text) => { response.payload = JSON.parse(text); };
	return httpHandler(request, response).then(() => response);
}

/* ================================================================
 * 用例 0：总开关关闭 → 一律不接管（行为 = 没装这个插件）
 * ================================================================ */
console.log('\n【用例 0】总开关关闭 → 一律不接管');
settingState.enabled = false;
{
	makeAgent('s0', '');
	turnStart('s0', 1);
	check('turn/start 不抢话语权', fakeSelection.current, undefined);
	const r = await realStep('s0', 1, { text: '' }, { text: '【求援】' }, [{ error: 'boom' }]);
	check('pre-step 不贴任何指令', r.instruction, '');
	check('turn-stopping 不做任何交棒', r.injected, '');
	check('selection 全程没被写过', r.route.current, undefined);
}

/* ================================================================
 * 用例 1：开启 → 主管规划 → 交棒员工 → 员工接着干
 * ================================================================ */
console.log('\n【用例 1】开启后：主管规划 → 交棒员工');
settingState.enabled = true;
{
	makeAgent('s1', '');
	turnStart('s1', 1);
	check('turn/start 就把话语权给了主管', fakeSelection.current.model, 'Manager-1');

	// 第 1 步：主管写规划（无工具调用 → 收尾时交棒）
	const r1 = await realStep('s1', 1, { text: '' }, { text: '【目标与需求】…\n【执行方法 SOP】…\n【规划完毕】' });
	check('第 1 步贴「主管规划」指令', title(r1.instruction), '【双模型编排 · 主管规划】');
	check('第 1 步由主管执行', r1.route.assembled.model, 'Manager-1');
	check('第 1 步预写的"下一步"仍是主管（它还没说规划完毕）', r1.route.current.model, 'Manager-1');
	check('第 1 步收尾时把执行权交给员工', title(r1.injected), '【双模型编排 · 员工执行】');

	// 第 2 步：员工按 SOP 动手（有工具调用 → 本步不触发 turn-stopping）
	const r2 = await realStep('s1', 1, { text: '【规划完毕】' }, { text: '收到，我开始做。', calls: [{ name: 'bash' }] }, [{ ok: true }]);
	check('第 2 步换员工模型', r2.route.assembled.model, 'Worker-1');
	check('第 2 步收到的正是上一步交棒注入的执行指令', title(r2.effective), '【双模型编排 · 员工执行】');
	check('第 2 步不重复贴指令', r2.instruction, '');
	check('第 2 步有工具调用 → 不交棒', r2.injected, '');
}

/* ================================================================
 * 用例 2：触发条件① 员工【求援】→ 主管介入（带结构化求助报告）
 * ================================================================ */
console.log('\n【用例 2】触发条件①：员工【求援】→ 主管介入');
{
	makeAgent('s2', '');
	turnStart('s2', 1);
	await realStep('s2', 1, { text: '' }, { text: '【规划完毕】' });
	const report = '{"problem_type":"信息不足","description":"只知道产品是智能客服系统","tried_methods":["按常识猜了一版"],"missing_info":["核心功能","目标客户"],"request_to_manager":"请补充产品背景资料"}';
	const r = await realStep('s2', 1, { text: '【规划完毕】' }, { text: `【求援】\n${report}` });
	check('贴「主管介入（重新规划）」指令', title(r.injected), '【双模型编排 · 主管介入（重新规划）】');
	check('指令里带上结构化求助报告', r.injected.includes('【员工结构化求助报告】'), true);
	check('问题类型被翻成人话', r.injected.includes('问题类型：信息不足'), true);
	check('"卡在哪"被渲染', r.injected.includes('只知道产品是智能客服系统'), true);
	check('"已试过"被渲染成列表', r.injected.includes('- 按常识猜了一版'), true);
	check('"缺少的信息"被渲染成列表', r.injected.includes('- 目标客户'), true);
	check('给主管的请求被带上', r.injected.includes('请补充产品背景资料'), true);
	check('没有把原始 JSON 直接倒给主管', r.injected.includes('"problem_type"'), false);

	// 下一步：主管拿到话语权
	const r3 = await realStep('s2', 1, { text: `【求援】\n${report}` }, { text: '（主管在处理）' });
	check('救火这一步由主管执行', r3.route.assembled.model, 'Manager-1');
}

/* ================================================================
 * 用例 3：主管【介入完毕】→ 交回员工（带诊断 + 新任务书）
 * ================================================================ */
console.log('\n【用例 3】主管【介入完毕】→ 交回员工并带上新任务书');
{
	makeAgent('s3', '');
	turnStart('s3', 1);
	await realStep('s3', 1, { text: '' }, { text: '【规划完毕】' });
	await realStep('s3', 1, { text: '【规划完毕】' }, { text: '【求援】{"problem_type":"信息不足"}' });
	const managerReply = [
		'【诊断】员工失败原因是缺少产品功能、目标客户和应用场景，导致只能生成空泛文案。',
		'【帮助方式】provide_context',
		'{"diagnosis":"员工缺产品功能与目标客户，只能写空泛卖点。","help_action":"provide_context","revised_task":{"task_name":"撰写产品卖点","new_context":"面向电商客服团队的智能客服系统，核心功能含自动回复、夜间值守。","new_sop":["先从电商客服常见痛点出发","每个痛点匹配一个产品功能"],"example":"示例：夜间咨询无人回复，智能客服自动承接。","constraints":["输出5个卖点"],"acceptance_criteria":["必须能直接用于官网"]},"message_to_worker":"先读补充背景再动手，不要再写空泛口号。"}',
		'【介入完毕】'
	].join('\n');
	const r = await realStep('s3', 1, { text: '【求援】{"problem_type":"信息不足"}' }, { text: managerReply });
	check('交回员工（带材料版指令）', title(r.injected), '【双模型编排 · 员工执行（带着主管给的补充材料）】');
	check('材料里有主管诊断', r.injected.includes('【主管诊断】员工缺产品功能与目标客户'), true);
	check('帮助方式是"中文（键名）"', r.injected.includes('补充上下文（provide_context）'), true);
	check('材料里有新任务书标题', r.injected.includes('【主管给的新任务书】'), true);
	check('材料里有补充背景', r.injected.includes('面向电商客服团队的智能客服系统'), true);
	check('材料里有新 SOP', r.injected.includes('先从电商客服常见痛点出发'), true);
	check('材料里有示例', r.injected.includes('夜间咨询无人回复'), true);
	check('材料里有验收标准', r.injected.includes('必须能直接用于官网'), true);
	check('材料里有主管叮嘱', r.injected.includes('不要再写空泛口号'), true);

	// 下一步：员工拿着材料继续
	const r4 = await realStep('s3', 1, { text: managerReply }, { text: '好的，我按新方法做。', calls: [{ name: 'bash' }] }, [{ ok: true }]);
	check('交回后模型换回员工', r4.route.assembled.model, 'Worker-1');
	check('员工收到的正是带材料的指令', title(r4.effective), '【双模型编排 · 员工执行（带着主管给的补充材料）】');
}

/* ================================================================
 * 用例 4：触发条件③ 验收不通过 → 主管重新规划 → 员工继续 → 直到通过
 *
 * v6.2 起语义变化：验收不通过不再"直接把意见甩回给员工重做"，而是每次都交回
 * **主管重新规划**（给出新任务书）→ 员工按新任务书继续 → 再验收……循环到通过为止。
 * v6.3：通过时的发言 = 面向用户的交付总结（结论 / 关键结果 / 详细报告）。
 * ================================================================ */
console.log('\n【用例 4】触发条件③：验收不通过 → 主管重新规划 → 员工继续 → 直到通过');
{
	makeAgent('s4', '');
	turnStart('s4', 1);
	await realStep('s4', 1, { text: '' }, { text: '【规划完毕】' });
	await realStep('s4', 1, { text: '【规划完毕】' }, { text: '我在做了。', calls: [{ name: 'bash' }] }, [{ ok: true }]);
	const doneStep = await realStep('s4', 1, { text: '我在做了。', calls: [{ name: 'bash' }] }, { text: '产出如下…【任务完成】' });
	check('员工【任务完成】→ 交主管验收', title(doneStep.injected), '【双模型编排 · 主管验收】');

	// ── 第 1 次验收不通过 → 交回主管重新规划（不是把意见甩给员工）
	const v1 = await realStep('s4', 1, { text: '产出如下…【任务完成】' }, { text: '【验收】不通过：卖点过于空泛，没有具体功能支撑。' });
	check('第 1 次不通过 → 交回主管重新规划', title(v1.injected), '【双模型编排 · 主管介入（重新规划）】');
	check('证据写明这是第几次不通过', v1.injected.includes('主管第 1 次验收**不通过**'), true);
	check('证据带上了验收意见原文', v1.injected.includes('卖点过于空泛'), true);

	// ── 主管重新规划出「新任务书」→ 交回员工继续
	const fix1 = [
		'【诊断】卖点空泛是因为没有把功能翻译成用户收益。',
		'【帮助方式】provide_context',
		'{"diagnosis":"需要把产品功能逐条对应到用户场景。","help_action":"provide_context","revised_task":{"task_name":"重写卖点","new_context":"智能客服，核心功能：自动回复、夜间值守。","new_sop":["先列功能","再逐条翻译成场景收益"],"acceptance_criteria":["每条卖点都必须引用一个具体功能"]},"message_to_worker":"围绕功能与场景的对应关系写，不要再写口号。"}',
		'【介入完毕】'
	].join('\n');
	const m1 = await realStep('s4', 1, { text: '【验收】不通过：卖点过于空泛，没有具体功能支撑。' }, { text: fix1 });
	check('重新规划这一步由主管执行', m1.route.assembled.model, 'Manager-1');
	check('规划完把员工叫回来（带新任务书）', title(m1.injected), '【双模型编排 · 员工执行（带着主管给的补充材料）】');
	check('新材料里带上了主管叮嘱', m1.injected.includes('不要再写口号'), true);

	const w1 = await realStep('s4', 1, { text: fix1 }, { text: '好，我按新方法做。', calls: [{ name: 'bash' }] }, [{ ok: true }]);
	check('员工带着新任务书继续执行', w1.route.assembled.model, 'Worker-1');
	check('员工收到的正是带材料的指令', title(w1.effective), '【双模型编排 · 员工执行（带着主管给的补充材料）】');
	await realStep('s4', 1, { text: '好，我按新方法做。', calls: [{ name: 'bash' }] }, { text: '这次改好了。【任务完成】' });

	// ── 第 2 次不通过 → 依然交回主管重新规划（循环不中断，计数在累加）
	const v2 = await realStep('s4', 1, { text: '这次改好了。【任务完成】' }, { text: '【验收】不通过：还是不行，问题不在改文案。' });
	check('第 2 次不通过 → 依然交回主管重新规划（循环不中断）', title(v2.injected), '【双模型编排 · 主管介入（重新规划）】');
	check('证据写明"第 2 次不通过"（计数累加）', v2.injected.includes('主管第 2 次验收**不通过**'), true);
	check('证据带上了最后一次验收意见原文', v2.injected.includes('问题不在改文案'), true);

	// ── 主管再规划 → 员工再执行 → 这次验收通过 → 循环收敛
	const fix2 = [
		'【诊断】问题不在文案本身，先把任务拆小重做。',
		'【帮助方式】decompose_task',
		'{"diagnosis":"直接改写收效有限，先拆成两步验证。","help_action":"decompose_task","revised_task":{"task_name":"拆分重做","new_sop":["先只写 2 条最强卖点","复核通过再补全"],"acceptance_criteria":["2 条卖点先行过关"]},"message_to_worker":"先小步交付，别一次写完。"}',
		'【介入完毕】'
	].join('\n');
	await realStep('s4', 1, { text: '【验收】不通过：还是不行，问题不在改文案。' }, { text: fix2 });
	await realStep('s4', 1, { text: fix2 }, { text: '收到，我拆开做。', calls: [{ name: 'bash' }] }, [{ ok: true }]);
	const w3 = await realStep('s4', 1, { text: '收到，我拆开做。', calls: [{ name: 'bash' }] }, { text: '这回真的完成了。【任务完成】' });
	check('第 3 次验收的指令里提醒了历史次数', w3.injected.includes('第 3 次验收'), true);

	const pass = await realStep('s4', 1, { text: '这回真的完成了。【任务完成】' }, { text: '【验收】通过：复核过，这次符合要求。' });
	check('循环最后：这次由主管验收', pass.route.assembled.model, 'Manager-1');
	check('验收通过 → 不再交棒（循环收敛）', pass.injected, '');
	const end = await realStep('s4', 1, { text: '【验收】通过：复核过，这次符合要求。' }, { text: '已交付给用户。' });
	check('收尾后不再贴指令', end.instruction, '');
	check('收尾后不再交棒', end.injected, '');
}

/* ================================================================
 * 用例 5：触发条件② 员工重试 2 次仍失败（同一段报错）→ 主管介入（重新规划）
 * ================================================================ */
console.log('\n【用例 5】触发条件②：员工重试 2 次仍失败 → 主管介入（重新规划）');
{
	makeAgent('s5', '');
	turnStart('s5', 1);
	await realStep('s5', 1, { text: '' }, { text: '【规划完毕】' });
	const boom = 'EACCES: permission denied, open /etc/hosts';
	const r2 = await realStep('s5', 1, { text: '【规划完毕】' }, { text: '这个工具好像一直报错…', calls: [{ name: 'bash' }] }, [{ error: boom }, { error: boom }]);
	check('员工重试期间不交棒（还有工具调用）', r2.injected, '');
	const r3 = await realStep('s5', 1, { text: '这个工具好像一直报错…', calls: [{ name: 'bash' }] }, { text: '（等主管）' });
	check('重试 2 次仍失败 → 主管重新规划', title(r3.instruction), '【双模型编排 · 主管介入（重新规划）】');
	check('证据里带了报错原文', r3.instruction.includes(boom), true);
	check('证据写明是宿主判定', r3.instruction.includes('同一段报错连续出现 2 次'), true);
	check('模型切回主管', r3.route.assembled.model, 'Manager-1');
}

/* ================================================================
 * 用例 6：员工一步没动手 → 交回主管
 * ================================================================ */
console.log('\n【用例 6】员工没有任何动作 → 交回主管');
{
	makeAgent('s6', '');
	turnStart('s6', 1);
	await realStep('s6', 1, { text: '' }, { text: '【规划完毕】' });
	const r = await realStep('s6', 1, { text: '【规划完毕】' }, { text: '好，我明白了。' });
	check('没动手 → 主管介入（重新规划）', title(r.injected), '【双模型编排 · 主管介入（重新规划）】');
	check('证据里写清"一步都没动手"', r.injected.includes('一步都没动手'), true);
}

/* ================================================================
 * 用例 7：员工完成 → 主管验收通过 → 收尾不再干预
 *
 * v6.3：验收通过的那次发言 = **给用户的交付总结**（结论 / 关键结果 / 详细报告）。
 * 用户明确要求：不要"复核依据"那种 Agent 自校验说明（给客户看没有意义），
 * 要的是"我问的问题，简练的总结" + 详细文档。这些断言把格式要求钉在指令里。
 * ================================================================ */
console.log('\n【用例 7】员工完成 → 主管验收通过 → 收尾不再干预');
{
	makeAgent('s7', '');
	turnStart('s7', 1);
	await realStep('s7', 1, { text: '' }, { text: '【规划完毕】' });
	await realStep('s7', 1, { text: '【规划完毕】' }, { text: '做完了。', calls: [{ name: 'bash' }] }, [{ ok: true }]);
	const v = await realStep('s7', 1, { text: '做完了。', calls: [{ name: 'bash' }] }, { text: '全部完成【任务完成】' });
	check('员工完成 → 交主管验收', title(v.injected), '【双模型编排 · 主管验收】');
	check('验收指令要求：通过时直接写"给用户的最终答复"', v.injected.includes('给用户的最终答复'), true);
	check('交付总结三件套：结论 / 关键结果 / 详细报告',
		v.injected.includes('**结论**') && v.injected.includes('**关键结果**') && v.injected.includes('**详细报告**'), true);
	check('交付文案明令禁止内部术语', v.injected.includes('不许出现内部术语'), true);
	check('交付文案限长（20 行内）', v.injected.includes('20 行以内'), true);
	check('旧的"写复核依据"要求已移除', v.injected.includes('说明你的复核依据'), false);

	const pass = await realStep('s7', 1, { text: '全部完成【任务完成】' }, { text: '【验收】通过：读了产出，符合要求。' });
	check('验收这一步由主管执行', pass.route.assembled.model, 'Manager-1');
	check('通过后不再交棒', pass.injected, '');

	const end = await realStep('s7', 1, { text: '【验收】通过：读了产出，符合要求。' }, { text: '已经交付给用户了。' });
	check('收尾后不再贴指令', end.instruction, '');
	check('收尾后不再交棒', end.injected, '');
}

/* ================================================================
 * 用例 8：运行中全局关闭 → 立刻把会话交还官方单模型
 * ================================================================ */
console.log('\n【用例 8】运行中全局关闭 → 会话立刻交还官方单模型');
{
	makeAgent('s8', '');
	turnStart('s8', 1);
	await realStep('s8', 1, { text: '' }, { text: '【规划完毕】' });
	await realStep('s8', 1, { text: '【规划完毕】' }, { text: '我动手了。', calls: [{ name: 'bash' }] }, [{ ok: true }]);
	check('关闭前 selection 由本插件掌管（员工）', fakeSelection.current.model, 'Worker-1');

	// 走真正的 HTTP 接口把总开关关掉
	const res = await api('PUT', `${API}/seats`, { enabled: false });
	check('PUT /seats 返回 200', res.status, 200);
	check('快照 mode=off', res.payload.mode, 'off');
	check('关闭瞬间 selection.current 被交还官方（undefined）', fakeSelection.current, undefined);

	const after = await realStep('s8', 1, { text: '【规划完毕】' }, { text: '继续。' });
	check('关闭后 pre-step 不再贴指令', after.instruction, '');
	check('关闭后不再交棒', after.injected, '');
	check('关闭后 selection 不被改写', after.route.current, undefined);

	// 另一条关闭路径：两席被清空（enabled 还是 true）
	settingState.enabled = true;
	await api('PUT', `${API}/seats`, { execModel: '' });
	check('两席未选全 → 同样交还官方', fakeSelection.current, undefined);
}

/* ================================================================
 * 用例 9：两席未选全 → 待命不接管
 * ================================================================ */
console.log('\n【用例 9】只选了一席（待命）→ 不接管');
{
	settingState.enabled = true;
	settingState.execModel = '';
	settingState.planModel = 'Manager-1';
	makeAgent('s9', '');
	turnStart('s9', 1);
	check('turn/start 不抢话语权', fakeSelection.current, undefined);
	const r = await realStep('s9', 1, { text: '' }, { text: '【规划完毕】' });
	check('pre-step 不贴指令', r.instruction, '');
	check('turn-stopping 不交棒', r.injected, '');
	settingState.planModel = 'Manager-1';
	settingState.execModel = 'Worker-1';
}

/* ================================================================
 * 用例 10：验收一直不通过直到「最大轮数」→ 明确暂停并通知用户（绝不静默停止）
 * ================================================================ */
console.log('\n【用例 10】达到「最大轮数」→ 暂停并明确通知用户');
{
	settingState.maxRounds = 2;
	makeAgent('s10', '');
	turnStart('s10', 1);
	await realStep('s10', 1, { text: '' }, { text: '【规划完毕】' });
	await realStep('s10', 1, { text: '【规划完毕】' }, { text: '做了。【任务完成】' });

	// 第 1 次不通过 → 还有轮数 → 照常交回主管重新规划
	const f1 = await realStep('s10', 1, { text: '做了。【任务完成】' }, { text: '【验收】不通过：不行。' });
	check('第 1 次不通过照常交回主管', title(f1.injected), '【双模型编排 · 主管介入（重新规划）】');

	// 主管重新规划 → 员工再干 → 再次验收又不过 → 已达上限
	const midFix = '【诊断】换个做法重来。\n【帮助方式】change_method\n{"diagnosis":"换个做法","help_action":"change_method","revised_task":{"task_name":"重做"},"message_to_worker":"照新方案做"}\n【介入完毕】';
	await realStep('s10', 1, { text: '【验收】不通过：不行。' }, { text: midFix });
	await realStep('s10', 1, { text: midFix }, { text: '照新方案做完了。【任务完成】' });
	const f2 = await realStep('s10', 1, { text: '照新方案做完了。【任务完成】' }, { text: '【验收】不通过：还是不行。' });
	check('已达上限 → 暂停并明确通知用户', title(f2.injected), '【双模型编排 · 已暂停】');
	check('通知里带上轮数数字', f2.injected.includes('上限（2 轮）'), true);
	check('通知里给出下一步选项', f2.injected.includes('直接回复你的指示'), true);

	settingState.maxRounds = 20;
}

/* ================================================================
 * 用例 11：主管声明 ask_user → 话筒交还用户（循环的收敛出口；没写 JSON 也要认）
 * ================================================================ */
console.log('\n【用例 11】主管声明 ask_user → 话筒交还用户');
{
	makeAgent('s11', '');
	turnStart('s11', 1);
	await realStep('s11', 1, { text: '' }, { text: '【规划完毕】' });
	const sos = '需要用户提供 API 密钥。【求援】{"problem_type":"信息不足","description":"缺少密钥","tried_methods":["试了公开接口"],"missing_info":["API 密钥"],"request_to_manager":"请帮我要密钥"}';
	await realStep('s11', 1, { text: '【规划完毕】' }, { text: sos });
	const askText = '【诊断】缺少 API 密钥，只能由用户提供，自动循环解决不了。\n【帮助方式】ask_user\n【介入完毕】';
	const ask = await realStep('s11', 1, { text: sos }, { text: askText });
	check('主管声明 ask_user（没写 JSON 也认得）→ 话筒交还用户', title(ask.injected), '【双模型编排 · 等你拍板】');
	check('通知里说清了下一步', ask.injected.includes('直接回复你的决定或补充信息'), true);

	const after = await realStep('s11', 1, { text: askText }, { text: '好的，我去找密钥。' });
	check('交还用户后不再贴指令', after.instruction, '');
	check('交还用户后不再交棒', after.injected, '');
}

console.log(`\n=== 结果：${failures === 0 ? `全部通过 ✓（${total} 项）` : `${failures}/${total} 项失败 ✗`} ===`);
process.exit(failures === 0 ? 0 : 1);
