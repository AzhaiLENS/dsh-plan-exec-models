/**
 * dsh-plan-exec-models —— 主管 × 员工 双模型编排（Host 侧）
 *
 * 客户端（./client.js）只负责 UI：在 conversation.input.right 具名位渲染「主管 / 员工」两席，
 * 并把选中结果 PUT 到 /dsh-plan-exec-models/api/seats。真正的**编排**在这一侧发生。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 编排模型（v4：主管 × 员工，动态介入）
 *
 * 角色：**主管**（强模型，负责拆解 / 兜底诊断 / 验收）× **员工**（便宜模型，负责落地执行）。
 *
 *     主管：拆目标 → 给出【执行方法 SOP】+【验收标准】
 *        │                     （说 `【规划完毕】` 交棒）
 *        ↓
 *     员工：按 SOP 落地
 *        │   ├─ 顺利      → 复核后说 `【任务完成】` → 主管验收
 *        │   └─ 卡住      → 自己试（最多 2 次）→ 仍不通 → `【求援】` + 结构化求助报告
 *        ↓
 *     主管：下场救火 → 诊断根因 + 帮助方式 + 新任务书（revised_task）
 *        │                     （说 `【介入完毕】` 把活交回员工；需要用户拍板时用 ask_user 交还用户）
 *        ↓
 *     员工：按主管给的新方法继续
 *        ↓
 *     主管：验收（实际读文件 / 跑命令复核，过程保持安静）→ 下结论
 *            ├─ 通过   → `【验收】通过` + **给用户的交付总结**（简练结论 · 关键结果 · 详细文档）→ 编排完成
 *            └─ 不通过 → 交回主管**重新规划** → 员工继续执行（循环直到通过或达到 maxRounds）
 *
 * ── v6.3 要点：验收通过的那次发言 = 用户视角的交付总结 ──
 * 用户明确要求（2026-09-13）："对话里的结果太繁杂了……那只是 Agent 自己校验用的，
 * 给客户看没有意义；客户要的是「我问的问题，简练的总结」+ 详细的文档。"
 * 所以 verify 指令规定：**通过时不许写"复核依据"，直接写面向用户的交付文案**；
 * 内部术语（员工/主管/编排/验收标准…）一律不得出现在给用户的答复里。
 *
 * ── 关键设计（对齐设计稿）──
 *
 * 1. **员工不能说"我失败了"就完事**：求援必须带结构化报告
 *    `{problem_type, description, tried_methods, missing_info, request_to_manager}`，
 *    宿主解析后原样转给主管，主管才能"对症下药"。
 *
 * 2. **主管不替员工干活**：主管下场只做四件事——补上下文、降难度、给方法、给示例，
 *    产出是一份 revised_task（new_context / new_sop / example / constraints / acceptance_criteria），
 *    员工照着继续干。`manager_do_step` 是最后手段。
 *
 * 3. **三个动态触发条件**（任一满足即交回主管）：
 *    ① 员工主动求助（`【求援】`）
 *    ② 员工重试超过 maxRetries 次仍失败（同一段报错反复出现）
 *    ③ **主管验收不通过（或验收没给出明确结论）** —— 交回主管重新规划，直到通过或达到 maxRounds
 *    另有兜底：同一个工具调用连续重复 stuckThreshold 次（真卡死）。
 *
 * 4. **全局关闭**：enabled 关掉 = 本插件完全不接管 —— 不换模型、不注入指令、
 *    不写 selection、不统计信号，行为与"没装这个插件"完全一致（官方单模型生成）。
 *    所有接管入口都过同一个 `isActive()` 闸门，不存在"关了还生效"的旁路。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 实现要点（都是实测过的官方契约，细节见 README）
 *
 * 1. 换模型：走官方 model selection（agent/pre-step 里写 assembled / current），
 *    由官方 system-prompt/assemble + agent/request 应用，并自然产生
 *    "[model changed: …]" 通知。拿不到 selection 时退回自己改写 agent/request。
 *
 * 2. 阶段指令：在 agent/pre-step 里**追加**一条消息到本步的 messages，
 *    告诉当前一方「你现在是主管/员工，该做什么、口令是什么」。这条消息会被官方
 *    正常 append 成 user/message，模型看得见、用户也看得见。
 *
 * 3. 信号采集：**工具结果不走 inbox**（agent/pre-step 的 payload.messages 里只有
 *    additionalContexts），所以工具报错/动作数一律从 session/event 的 tool/result 累计；
 *    "上一句发言里的口令"和 tool-call 签名则从 agent.session.deriveMessages() 的尾巴读。
 *
 * 4. 交棒时机：agent/turn-stopping 在「本步没有工具调用、回合即将结束」时触发，
 *    且 dispatch 是 fused(payload) = {...payload, agent}，所以能直接拿到 agent。
 *    在里面用官方 API agent.inject(message)（写 next-step、不唤醒驱动）就可以
 *    让**同一个回合**再多跑一步 —— 这一步就是换到另一方的时机。
 *
 * 5. 口令容错：匹配前先剥掉所有空白，所以 `【 验收 】通过` 也能认；
 *    验收口令读不到时按"通过"处理（宁可不循环，也不卡死）。
 *
 * 与「自动续跑」插件（@weibaohui/dsh-continue）的分工：
 * 那个插件只在它自己的续跑回合里覆写 config.model/provider。我们的做法是：
 * 先看"上一份请求头里的模型"是不是既不属于本会话的选中模型、也不属于两席中的任何一个。
 * 是 → 说明别的插件在做主，本步立刻让路，绝不抢方向盘。
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 插件名：cordis 用它做服务命名空间与日志前缀。 */
export const name = 'dsh-plan-exec-models';

/** 依赖的服务；任一缺失插件会挂起等待，所以只声明宿主与 web 侧都确实存在的。 */
export const inject = ['settings', 'webServer', 'agents'];

/** 设置命名空间（必须匹配 /^[a-z][a-z0-9-]*$/）。 */
const SETTINGS_NS = 'dsh-plan-exec-models';

/** 自定义 HTTP 前缀：客户端拉/推席位配置，以及取"当前哪一步在用哪个模型"。 */
const API_PREFIX = '/dsh-plan-exec-models/api';

/** 席位取值：表示"跟随官方默认模型"，此时本插件对该阶段不做任何干预。 */
const FOLLOW_DEFAULT = '__default__';

/**
 * 默认配置。
 *
 * **enabled 默认为 false** —— 装了插件不等于打开编排：默认就是官方单模型生成，
 * 用户在输入栏右侧把两席选好、并打开总开关之后才接管。这是"默认单模型"要求的落点。
 */
const DEFAULTS = {
	enabled: false,
	/**
	 * 「主管→员工→验收」最多来回几轮。
	 *
	 * 语义（v6.2 起）：验收不通过会**重新规划并继续**，直到通过或达到这个上限；
	 * 它不是"跑几轮就收工"，而是防无限循环的安全阀 —— 所以默认给得宽（20 轮）。
	 */
	maxRounds: 20,
	/** 员工自己重试几次就判定"该喊主管了"（设计稿建议 2，不要更多，省小模型调用）。 */
	maxRetries: 2,
	planProvider: '',
	planModel: '',
	planEffort: '',
	execProvider: '',
	execModel: '',
	execEffort: ''
};

/**
 * 内部调优常量（不对外开放，避免设置项膨胀）。
 * 这些值没有"每次都要调"的理由，全是安全阀。
 */
const TUNING = {
	/** 主管规划阶段的安全阀步数（正常由它自己说「规划完毕」交棒）。 */
	planSteps: 4,
	/** 主管救火阶段的安全阀步数。 */
	replanSteps: 3,
	/** 验收阶段的安全阀步数（留 2 步够"先复核再下结论"）。 */
	verifySteps: 2,
	/** 同一个工具调用连续重复几次判定真卡死。 */
	stuckThreshold: 3,
	/** 是否允许员工求援后自动交回主管。 */
	autoReplan: true,
	/** 员工收尾后是否让主管做最终验收。 */
	verifyOnFinish: true
};

/** 每个会话最近一次编排决策，供客户端显示"当前哪一步、用哪个模型"。 */
const lastRoute = new Map();

/** 会话 id → "turn:step" → {phase, reason, model}。客户端靠它给每一步贴准确的阶段徽标。 */
const phaseLog = new Map();

/** 会话 id → agent。`turn/start` 早于本回合第 1 步，只能用会话 id 反查 agent。 */
const agentBySession = new Map();

/** 会话 id → 当前回合的编排状态机。 */
const orchestration = new Map();

/**
 * 会话 id → **开启双模型之前那一份单模型选择**。
 *
 * 关闭双模型时要用它把模型"还原"回去 —— 这是"关掉了却还在走主管模型"的正解。
 *
 * 为什么必须有这份记忆：官方 selection 的 `current` 在内部 `picked === undefined`
 * 时会**回落到 `session.requestHeader()`**（本会话上一次实际发出的模型）。编排期间
 * 每个回合都在发主管/员工的请求，于是 requestHeader 被写成编排模型；关闭时若只是
 * 把 picked 清成 undefined，回落值恰好就是编排模型 —— 用户看到的就是
 * "切成单模型了，可它还在走双模型那一席"。
 *
 * 这份记忆是**两层**的：内存里的 `soloSelections`（最快）+ 会话表里的
 * `soloProvider/soloModel/soloEffort`（落盘，活过进程重启）。内存没了就用落盘那份，
 * 两份都没有才退到 `pickSoloFallback()` 的后备（用户在关闭之后亲手选的 → 官方默认）。
 */
const soloSelections = new Map();

/** 排障用：最近若干条日志。套壳 App 里看不到子进程 stdout，所以留一份在内存 + 文件里。 */
const RECENT_LOG_LIMIT = 400;
const recentLog = [];

/** 单个会话保留的阶段记录条数上限。 */
const PHASE_LOG_LIMIT = 200;

/** 日志落盘路径（和席位配置同一个目录）。 */
function logFilePath() {
	try {
		return join(dirname(fallbackFile()), 'plan-exec-models.log');
	} catch (error) {
		return null;
	}
}

/** 简单日志：控制台 + 内存环形缓冲 + 追加到文件（失败一律忽略，绝不影响对话）。 */
function log(...args) {
	const line = `${new Date().toISOString()} ${args.map((item) => (typeof item === 'string' ? item : safeStringify(item))).join(' ')}`;
	try {
		recentLog.push(line);
		if (recentLog.length > RECENT_LOG_LIMIT) recentLog.splice(0, recentLog.length - RECENT_LOG_LIMIT);
	} catch (error) {
		/* 忽略 */
	}
	try {
		const file = logFilePath();
		if (file !== null) {
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, `${line}\n`);
		}
	} catch (error) {
		/* 落盘失败不影响功能 */
	}
	console.log('[dsh-plan-exec-models]', ...args);
}

/** JSON.stringify 的安全版本，循环引用不炸。 */
function safeStringify(value) {
	try {
		return JSON.stringify(value);
	} catch (error) {
		return String(value);
	}
}

/** 归一化步数到 1~20 的整数。 */
function clampSteps(value, fallback) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(20, Math.max(1, Math.trunc(number)));
}

/** 归一化轮数上限到 1~100 的整数（验收循环可能要跑很多轮，上限给宽）。 */
function clampRounds(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return DEFAULTS.maxRounds;
	return Math.min(100, Math.max(1, Math.trunc(number)));
}

/** 归一化重试次数到 1~5 的整数。 */
function clampRetries(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return DEFAULTS.maxRetries;
	return Math.min(5, Math.max(1, Math.trunc(number)));
}

/** 两段路由是否是同一个 provider + model。 */
function sameRoute(left, right) {
	return left !== null && right !== null && left.provider === right.provider && left.model === right.model;
}

/** 从路由里抽出 {provider, model} 便于比较。 */
function routeOf(config) {
	if (config === null || typeof config !== 'object') return null;
	const provider = String(config.provider ?? '');
	const model = String(config.model ?? '');
	if (provider === '' || model === '') return null;
	return { provider, model };
}

/**
 * 档位的规范序（与内核 `dsh-llm-pi-ai` 的 THINKING_LEVELS 一致）。
 * 用来把席位请求的档位「吸附」到目标模型真正声明的档位上。
 */
export const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 运行时注入的「读某模型声明了哪些档位」函数，由 `apply(ctx)` 接线。
 *
 * 为什么要注入而不是直接读：`seatOf()` 是纯函数、拿不到 ctx，而它的调用点有十几处。
 * 用模块级函数注入，就能在不改动任何调用点的前提下让档位解析变成动态的。
 * @type {null | ((provider: string, model: string) => string[] | null)}
 */
let readDeclaredLevels = null;

/** 只有测试/排障用：手动替换档位读取器。 */
export function setDeclaredLevelsReader(fn) {
	readDeclaredLevels = fn;
}

/**
 * 把席位请求的档位吸附到目标模型真正声明的档位上。
 *
 * **这是「换模型不失效」的关键**：主管席位永远请求最高思考档、员工席位永远请求中间档，
 * 但不同模型的档位词表并不相同（有的只有 low/high，有的有 off..max）。若把请求值原样
 * 发给模型没声明的档位，内核会解析成 `null` = **不发参数** = 退化成厂商默认，
 * 既不是最高也不是中间。所以这里按语义重新落位：
 *   · `max`             → 该模型声明档位中的最高档
 *   · `medium` / `mid`  → 该模型声明档位中的正中间档
 *   · 其它              → 规范序上最接近的一档
 *
 * 「思考档位」不含 `off`（off 的语义是"不思考"，不是"最低思考"）。
 * 模型未声明档位 / 读不到 / 请求值本身就合法时，原样返回，绝不改变既有行为。
 *
 * @param provider - 提供方路由名。
 * @param model - 模型 id。
 * @param requested - 席位配置里请求的档位。
 * @returns 目标模型真正接受的档位。
 */
export function snapEffort(provider, model, requested) {
	if (readDeclaredLevels === null) return requested;
	let declared;
	try {
		declared = readDeclaredLevels(provider, model);
	} catch {
		return requested;
	}
	if (!Array.isArray(declared) || declared.length === 0) return requested;
	if (declared.includes(requested)) return requested;
	/** 只把"要花思考"的档位算进语义落位，off 排除在外。 */
	const thinking = declared
		.filter((level) => level !== 'off' && EFFORT_ORDER.includes(level))
		.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
	if (thinking.length === 0) return requested;
	if (requested === 'max') return thinking[thinking.length - 1];
	if (requested === 'medium' || requested === 'mid') {
		return thinking[Math.floor((thinking.length - 1) / 2)];
	}
	const want = EFFORT_ORDER.indexOf(requested);
	if (want < 0) return requested;
	let best = thinking[0];
	let bestDistance = Infinity;
	for (const level of thinking) {
		const distance = Math.abs(EFFORT_ORDER.indexOf(level) - want);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = level;
		}
	}
	return best;
}

/**
 * 把一格 seats 字段解析成一席的意图。
 * @returns {{mode:'model',provider:string,model:string,reasoningEffort?:string}|{mode:'default'}|{mode:'unset'}}
 */
function seatOf(state, prefix) {
	const provider = String(state[`${prefix}Provider`] ?? '').trim();
	const model = String(state[`${prefix}Model`] ?? '').trim();
	if (model === FOLLOW_DEFAULT) return { mode: 'default' };
	if (provider === '' || model === '') return { mode: 'unset' };
	const effort = String(state[`${prefix}Effort`] ?? '').trim();
	return effort === ''
		? { mode: 'model', provider, model }
		: { mode: 'model', provider, model, reasoningEffort: snapEffort(provider, model, effort) };
}

/** 把一席的解析结果转成官方 selection 认的 {provider, model, reasoningEffort?}；不是具体模型就 null。 */
function toSelectionRoute(seat) {
	if (seat === null || seat === void 0 || seat.mode !== 'model') return null;
	return seat.reasoningEffort === void 0
		? { provider: seat.provider, model: seat.model }
		: { provider: seat.provider, model: seat.model, reasoningEffort: seat.reasoningEffort };
}

/** 两席是否都是具体模型（= 编排可以接管）。 */
function seatsComplete(state) {
	return seatOf(state, 'plan').mode === 'model' && seatOf(state, 'exec').mode === 'model';
}

/**
 * **唯一的接管闸门**。
 *
 * 只有它返回 true 时，本插件才允许碰会话：换模型、贴指令、听口令、数信号。
 * 之前"把开关关掉却依旧生效"的根因就是这里分散成了 4 处判断，
 * 而 turn/start、turn-stopping、agent/request 三处漏了 enabled 检查 ——
 * 于是关掉开关后模型照样被换、指令照样被注入。现在全部走这一个函数。
 */
function isActive(state) {
	if (state === null || state === void 0) return false;
	if (state.enabled !== true) return false;
	return seatsComplete(state);
}

/** 给客户端/日志用的状态短名。 */
function modeOf(state) {
	if (state === null || state === void 0) return 'off';
	if (state.enabled !== true) return 'off';
	return seatsComplete(state) ? 'active' : 'waiting';
}

/** 上面那个短名的"人话版"，只给日志/提示用。 */
function describeMode(state) {
	const mode = modeOf(state);
	if (mode === 'active') return '双模型开启';
	if (mode === 'waiting') return '双模型待命（两席未选全）';
	return '官方单模型';
}

/** 可选依赖 schemastery：宿主没带就退回 JSON 文件存储。 */
function loadSchema() {
	const candidates = [
		join(homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'),
		'/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.cjs',
		'/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.cjs'
	];
	for (const candidate of candidates) {
		try {
			const require = createRequire(candidate);
			const loaded = require(candidate);
			const Schema = loaded?.Schema ?? loaded?.default?.Schema ?? loaded;
			if (Schema !== null && typeof Schema?.object === 'function') return Schema;
		} catch (error) {
			/* 换下一个候选路径 */
		}
	}
	return null;
}

/** 席位配置的落盘位置（settings 不可用时的兜底）。 */
function fallbackFile() {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	return join(home, 'dsh-plan-exec-models', 'seats.json');
}

/**
 * 建一个 {get, update, kind} 的存储。
 * 首选 ctx.settings（可被 dsh 的设置界面看见、跟着 profile 走），拿不到就落 JSON 文件。
 *
 * 字段刻意收得很窄：只有"要不要接管"和两席是谁。原先把步数、阈值、开关一共 15 个
 * 字段全摊在设置里，用户反馈"太复杂"—— 那些安全阀现在都在 TUNING 里定死。
 */
function createStore(ctx) {
	const Schema = loadSchema();
	if (Schema !== null) {
		try {
			const schema = Schema.object({
				enabled: Schema.boolean().default(DEFAULTS.enabled),
				maxRounds: Schema.number().default(DEFAULTS.maxRounds),
				maxRetries: Schema.number().default(DEFAULTS.maxRetries),
				planProvider: Schema.string().default(DEFAULTS.planProvider),
				planModel: Schema.string().default(DEFAULTS.planModel),
				planEffort: Schema.string().default(DEFAULTS.planEffort),
				execProvider: Schema.string().default(DEFAULTS.execProvider),
				execModel: Schema.string().default(DEFAULTS.execModel),
				execEffort: Schema.string().default(DEFAULTS.execEffort)
			});
			const scope = ctx.settings.register(SETTINGS_NS, schema, { base: DEFAULTS });
			return {
				kind: 'settings',
				get: () => ({ ...DEFAULTS, ...(scope.get() ?? {}) }),
				update: async (patch) => {
					await scope.update(patch);
				}
			};
		} catch (error) {
			log('settings 命名空间注册失败，改用文件存储', error);
		}
	}
	const file = fallbackFile();
	let cache = { ...DEFAULTS };
	try {
		cache = { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) };
	} catch (error) {
		/* 首次运行：保持默认值 */
	}
	return {
		kind: 'file',
		get: () => ({ ...cache }),
		update: async (patch) => {
			cache = { ...cache, ...patch };
			try {
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, `${JSON.stringify(cache, null, '\t')}\n`);
			} catch (error) {
				log('席位配置落盘失败', error);
			}
		}
	};
}

/**
 * 会话级席位表：`sessionId → 席位配置`。
 *
 * **为什么要分两层存储**
 *
 * `ctx.settings`（= `~/.dsh/settings.yaml`）是**全局**的：在一个对话里开了双模型，
 * 所有对话都会跟着开。但"这个对话用单模型还是双模型"显然是**每个对话各自**的事 ——
 * 用户明确要求：
 *   > 是否为单双模型工作方式，应该每个对话内容都是独立的；
 *   > 只有在新开对话的时候，才继承上一次对话的最后设定。
 *
 * 所以：
 *   - `settings.yaml`  = **上一次的设定**，只当"新对话的种子"用；
 *   - `sessions.json`  = 每个对话**自己**的那份。会话第一次出现时从全局继承一次，
 *                        之后这个会话怎么改都不会波及其它会话。
 *
 * 拿不到 sessionId 时（插件刚启动、或非会话上下文）一律回落到全局。
 */
function sessionsFile() {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	return join(home, 'dsh-plan-exec-models', 'sessions.json');
}

/** 会话表上限：这是个"每个对话一条"的长期增长映射，超了按最后写入时间淘汰。 */
const SESSION_LIMIT = 500;

function createSessionStore() {
	const file = sessionsFile();
	let cache = {};
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'));
		const rows = parsed?.sessions;
		if (rows !== null && typeof rows === 'object') cache = rows;
	} catch (error) {
		/* 首次运行：空表 */
	}
	const flush = () => {
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify({ version: 1, sessions: cache }, null, '\t')}\n`);
		} catch (error) {
			log('会话席位表落盘失败', error);
		}
	};
	return {
		kind: 'file',
		file,
		has: (sessionId) => cache[sessionId] !== null && typeof cache[sessionId] === 'object',
		get: (sessionId) => (cache[sessionId] !== null && typeof cache[sessionId] === 'object' ? cache[sessionId] : void 0),
		/** 合并写入（只覆盖 patch 里出现的键），并记下写入时间用于淘汰。 */
		update: (sessionId, patch) => {
			cache[sessionId] = { ...(cache[sessionId] ?? {}), ...patch, at: Date.now() };
			const keys = Object.keys(cache);
			if (keys.length > SESSION_LIMIT) {
				keys.sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0));
				for (const key of keys.slice(0, keys.length - SESSION_LIMIT)) delete cache[key];
			}
			flush();
		},
		count: () => Object.keys(cache).length
	};
}

/**
 * 会话表实例。模块级是为了让 `snapshot()` 与各事件处理器都能读到
 * （它们拿不到 `apply()` 的闭包）。`apply()` 里替换成真实实现。
 */
let seatSessions = {
	kind: 'none',
	file: '',
	has: () => false,
	get: () => void 0,
	update: () => {},
	count: () => 0
};

/** dsh 里拿不到会话 id 时可能传进来的占位字符串，都当成"没有会话"。 */
function normalizeSessionKey(sessionId) {
	if (typeof sessionId !== 'string') return null;
	const key = sessionId.trim();
	if (key === '' || key === 'undefined' || key === 'null') return null;
	return key;
}

/**
 * 日志里给会话起个短号。dsh 的会话 id 形如 `session-a6d2390e-d913-…`，
 * 直接 `slice(0, 8)` 只会得到一水儿的 `session-`，什么也认不出来。
 */
function shortId(sessionId) {
	const key = normalizeSessionKey(sessionId);
	if (key === null) return '未知会话';
	const body = key.startsWith('session-') ? key.slice('session-'.length) : key;
	return body.slice(0, 8);
}

/**
 * **解析某个会话此刻生效的席位配置**（闸门、快照、日志全部走这里，不再有人直接读全局）。
 *
 * 规则：
 *   1. 拿不到会话 → 返回全局（没有会话可隔离）；
 *   2. 会话表里有记录 → 用会话自己那份（**完全独立**）；
 *   3. 会话表里没记录（= 这个对话第一次出现）→ 用全局把它**钉住**一份，
 *      以后这个会话和别的会话就再也不会互相影响了。
 *
 * 第 3 步的"钉住"必须发生，否则「新对话继承上一次设定」会退化成
 * 「所有没碰过开关的对话都跟着全局实时变」—— 那就又变成全局的了。
 */
function stateFor(store, sessionId) {
	const globalState = store.get();
	const key = normalizeSessionKey(sessionId);
	if (key === null) return globalState;
	const rec = seatSessions.get(key);
	if (rec !== void 0) {
		const state = { ...DEFAULTS, ...rec };
		// 这几个都是会话表内部的记账字段，只用于自愈判据与淘汰，不往外暴露。
		delete state.at;
		delete state.offAt;
		delete state.seededAt;
		delete state.soloProvider;
		delete state.soloModel;
		delete state.soloEffort;
		return state;
	}
	const pinned = { ...globalState };
	delete pinned.at;
	delete pinned.offAt;
	delete pinned.seededAt;
	delete pinned.soloProvider;
	delete pinned.soloModel;
	delete pinned.soloEffort;
	// `seededAt` 只用来标记"这条记录是被首次继承写入的"。以后任何一次真实配置写入
	// 都会把 `at` 顶到更新的时刻，于是 `seededAt === at` 不再成立 —— 自愈的时间基线
	// （见 sessionTouchedAt）就能区分"只是插件第一次看见它"和"用户真的关过双模型"。
	seatSessions.update(key, { ...pinned, seededAt: Date.now() });
	log(`会话 ${shortId(key)} 首次出现 → 从全局继承设定（${describeMode(pinned)}），此后与本会话独立`);
	return pinned;
}

/**
 * 排查用的"有哪些 selection 入口"探测（纯存在性检查，不调用、无副作用）。
 * 2026-09-10 实测：`ctx.agents`（Agent 服务）**没有** selectionFor，
 * 真正的入口在 `dsh-api-session-controller` 提供的 `sessionController` 上。
 *
 * 2026-09-10 二次实测（Cordis 内部机制）：**不能直接写 `ctx.sessionController`**。
 * cordis 的 get 陷阱在 `cannot get property "X" without inject` 处抛错。
 * 原因：服务真身只写在"提供它的那个插件自己的 fiber.store"里，
 * 而 get 陷阱的向上查找只走**祖先** fiber 的 store。
 * 我们跟 dsh-api-session-controller 是**兄弟**，不在它的祖先链上 → 永远取不到。
 * 但 `ctx.reflect` 是普通继承属性（get 陷阱第一行 `Reflect.has(target, prop)` 命中即放行），
 * 而 `ctx.reflect.get(name)` 是按"全局符号"读**根** store，**不需要 inject** —— 这才是正解。
 */
function describeGrab(label, grab) {
	try {
		const value = grab();
		if (value === undefined || value === null) return `${label}=空`;
		return `${label}=${typeof value === 'function' ? '函数' : typeof value}`;
	} catch (error) {
		const message = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
		return `${label}✗(${message.slice(0, 70)})`;
	}
}

/** 逐条记录每个入口"能不能拿到、为什么拿不到"，出错也不抛。 */
function serviceProbe(ctx) {
	return [
		describeGrab('reflect.get', () => ctx?.reflect?.get),
		describeGrab('reflect.sessionController', () => ctx?.reflect?.get?.('sessionController')),
		describeGrab('reflect.sessionController.agents', () => ctx?.reflect?.get?.('sessionController')?.agents),
		describeGrab('reflect…selectionFor', () => ctx?.reflect?.get?.('sessionController')?.agents?.selectionFor),
		describeGrab('ctx.sessionController', () => ctx?.sessionController),
		describeGrab('ctx.agents.selectionFor', () => ctx?.agents?.selectionFor)
	];
}

function selectionApiProbe(ctx) {
	const found = [];
	try {
		if (typeof ctx?.reflect?.get?.('sessionController')?.agents?.selectionFor === 'function') found.push('reflect.sessionController.agents');
	} catch (error) {
		/* 探测失败就当没有 */
	}
	try {
		if (typeof ctx?.sessionController?.agents?.selectionFor === 'function') found.push('sessionController.agents');
	} catch (error) {
		/* 直接取会抛 without inject，已实测 */
	}
	try {
		if (typeof ctx?.agents?.selectionFor === 'function') found.push('agents');
	} catch (error) {
		/* 探测失败就当没有 */
	}
	return found;
}

/** selection 入口解析成功后记下走的是哪一条；空 = 还没成功过。 */
let selectionChannel = null;

/** 拿到官方那个可变的 {current, assembled}。按可靠度依次尝试各个入口。 */
function selectionFor(ctx, agent) {
	if (agent === undefined || agent === null) return null;
	const candidates = [
		// ① reflect 直取：不依赖 inject，唯一能在"兄弟插件"身份下拿到官方 selection 的路子
		['reflect.sessionController.agents', () => ctx?.reflect?.get?.('sessionController')?.agents?.selectionFor?.(agent)],
		// ② 同上的"懒"读法：跳过"提供方 fiber 必须已 active"的检查，服务刚挂上但状态没翻过来时也能拿到
		['reflect(懒).sessionController.agents', () => ctx?.reflect?.get?.('sessionController', false)?.agents?.selectionFor?.(agent)],
		// ③ 直接取：只有把 sessionController 写进 inject 之后才有戏，留着当兜底
		['sessionController.agents', () => ctx?.sessionController?.agents?.selectionFor?.(agent)],
		['agents', () => ctx?.agents?.selectionFor?.(agent)]
	];
	for (const [label, resolve] of candidates) {
		try {
			const selection = resolve();
			if (selection !== undefined && selection !== null) {
				selectionChannel = label;
				return selection;
			}
		} catch (error) {
			/* 换下一个入口 */
		}
	}
	return null;
}

/** 判断上一份请求头的模型是不是"外人"选的（既不是会话选中，也不是两席之一）。 */
function isForeignRoute(headerRoute, selected, seats) {
	if (headerRoute === null) return false;
	if (sameRoute(headerRoute, selected)) return false;
	return !seats.some((seat) => seat.mode === 'model' && sameRoute(headerRoute, seat));
}

/* ==========================================================================
 * 「关掉双模型后，模型要还原成什么」
 *
 * 背景（用户实报 bug）：开着双模型用了一阵，再关成单模型，会话**仍然走主管那一席的模型**。
 *
 * 机理是官方 selection 的回落语义：它的 `current` 是带 getter/setter 的属性 ——
 *   · setter 只写内部 `picked`；
 *   · getter 在 `picked === undefined` 时**回落到 `session.requestHeader()`**
 *     （本会话上一次真正发出去的模型）。
 * 编排期间每个回合都在发主管/员工的请求，requestHeader 早被写成编排模型；
 * 于是"关闭"若只把 picked 清成 undefined，回落值恰好就是编排模型 —— 看起来就是没关掉。
 * 而且这条污染会一路带到**下一个真实请求**：官方 `system-prompt/assemble` 会把
 * `current` 快照进 `assembled`，`agent/request` 再照着 `assembled` 改写请求 ——
 * 一步不差地"继续走主管模型"。
 *
 * 所以关闭时**必须写回一个明确的单模型选择**（写 undefined 等于把决定权交给被污染的
 * requestHeader）。优先级：
 *   ① 开启双模型之前记下的那一份（最贴近用户意图）；
 *   ② 官方默认模型（settings 的 `agent-default-model`，与官方 selectionFor 的兜底同源）。
 * ========================================================================== */

/** 从一个路由对象抽出可写进 model/selection 事件的干净载荷。 */
function asSelection(route) {
	if (route === null || route === void 0) return null;
	const provider = String(route.provider ?? '').trim();
	const model = String(route.model ?? '').trim();
	if (provider === '' || model === '') return null;
	const effort = route.reasoningEffort;
	return effort === void 0 || effort === null || effort === ''
		? { provider, model }
		: { provider, model, reasoningEffort: String(effort) };
}

/** 读官方默认模型（settings 的 `agent-default-model` 命名空间）。读不到返回 null。 */
function officialDefaultSelection(ctx) {
	try {
		const settings = ctx?.settings?.get?.('agent-default-model');
		const route = asSelection(settings);
		if (route !== null) return route;
	} catch (error) {
		/* 换下一条路 */
	}
	// 兜底：直接问官方 selection 服务的默认（有就最好，没有也不影响）。
	try {
		const agents = ctx?.reflect?.get?.('sessionController')?.agents;
		const route = asSelection(agents?.ctx?.agentDefaultModel?.currentSelection?.());
		if (route !== null) return route;
	} catch (error) {
		/* 拿不到就算了 */
	}
	return null;
}

/** 本会话两席声明了哪几个具体模型（用于判断"当前选中是不是编排残留"）。 */
function seatRoutesOf(state) {
	const routes = [];
	for (const prefix of ['plan', 'exec']) {
		const route = toSelectionRoute(seatOf(state, prefix));
		if (route !== null) routes.push(asSelection(route));
	}
	return routes;
}

/**
 * 会话表里"这条记录最后一次真实配置写入"的时刻（ms），用作**双模型关闭时刻**的基线。
 *
 * 为什么要这个基线：`model/selection` 事件**不只是**"用户在单模型框里点模型"会写 ——
 * 客户端配置两席（`commit()`）时也会调官方 `select()`，于是成对落下
 * `model/selection`（实测 18:44:47 落 glm、18:44:50 落 deepseek，正是本会话的两席）。
 * 只按"事件流里最后一条"取，会把这类编排写入误认成用户意图 —— 而且员工席总是后写，
 * 于是"current 卡在员工席"时判据永远为真、自愈彻底失效。卡时间就能干净分开：
 * **关闭之后**落的事件才是用户真的动手选的。
 *
 * 取值优先级：
 *   ① `offAt` —— 关闭双模型那次写入顺手盖上的显式时间戳（本次新增，最准）；
 *   ② `at` —— 会话表每次 `update()` 都盖的写入时间（老记录只有这个；实测 4 条存量
 *      污染记录的 `at` 都正是关闭时刻，可直接当基线）；
 *   ③ 只被"首次继承全局种子"写过的那条记录（`seededAt === at`）不算数 —— 那只是
 *      "插件第一次看见这个对话"的时刻，与双模型开关无关；返回 0 表示"没有基线"，
 *      此时所有选择事件都算"关闭之后"，判据退到最保守（宁可少修，不误伤）。
 */
function sessionTouchedAt(sessionId) {
	const key = normalizeSessionKey(sessionId);
	if (key === null) return 0;
	const rec = seatSessions.get(key);
	if (rec === null || rec === void 0) return 0;
	if (typeof rec.offAt === 'number' && rec.offAt > 0) return rec.offAt;
	if (typeof rec.seededAt === 'number' && rec.seededAt === rec.at) return 0;
	return typeof rec.at === 'number' && rec.at > 0 ? rec.at : 0;
}

/**
 * 用户在**双模型关闭之后**有没有再显式选过模型（取最后一条）。
 *
 * 事件按 seq 有序、`time` 单调递增（`Session.append` 里就是 `Date.now()`），
 * 所以从后往前扫，一撞到"早于关闭时刻"的就可以直接收工。
 */
function lastSoloSelectionAfter(agent, offAt) {
	try {
		const events = agent?.session?.snapshotEvents?.() ?? [];
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== 'model/selection') continue;
			const time = typeof event.time === 'number' ? event.time : 0;
			if (time > 0 && time <= offAt) return null;
			const picked = asSelection(event.data);
			if (picked !== null) return picked;
		}
	} catch (error) {
		/* 读不到就算了 */
	}
	return null;
}

/**
 * 这具会话语义上"被编排污染了吗"。
 *
 * 判断要严 —— 四条同时成立才算污染，少一条都不碰：
 *   ① 会话**没开**双模型（开着就是编排在正常工作，current 落在席位上理所应当）；
 *   ② 本会话确实配过席位（没有席位就谈不上"落进编排的取值域"）；
 *   ③ 当前选中**恰好落在本会话某席**；
 *   ④ 用户在关闭之后**没有再亲手选过它**（选过 = 他就是想要这个模型，尊重他）。
 *
 * 第 ④ 条为什么必须卡"关闭之后"：见 `sessionTouchedAt` —— 配置两席本身就会写
 * `model/selection`，不卡时间的话"用户选过"永远为真。实测有一个会话正是这样被漏治的
 * （先选 glm-5.3-flash 当主管席、后选 deepseek-flash 当员工席，current 卡在 glm 上）。
 */
function looksContaminated(agent, state, current) {
	const route = asSelection(current);
	if (route === null) return false;
	if (state?.enabled === true) return false;
	const seats = seatRoutesOf(state);
	if (seats.length === 0) return false;
	if (!seats.some((seat) => sameRoute(seat, route))) return false;
	const after = lastSoloSelectionAfter(agent, sessionTouchedAt(sessionIdOf(agent)));
	if (after !== null && sameRoute(after, route)) return false;
	return true;
}

/**
 * 决定"还原成哪个模型"。按可靠度从高到低：
 *   ① 接管时记在内存里的那份（`soloSelections`，同一进程内最准）；
 *   ② 接管时**落过盘**的那份（`soloProvider/soloModel/soloEffort`）—— 内存记忆
 *      活不过进程重启，而"开着双模型 → 重启 App → 关掉"是极常见的路径，
 *      不落盘的话关闭时只能退到官方默认，把用户自己的单模型弄丢；
 *   ③ 用户在关闭之后亲手选的那个；
 *   ④ 官方默认模型（settings 的 `agent-default-model`，与官方 selectionFor 的兜底同源）。
 *
 * ①②③ 都原样采用 —— 它们都是用户自己的选择，哪怕恰好与某一席同名，
 * 那也是用户当初真的在用，没有理由替他改。
 */
function pickSoloFallback(ctx, agent, sessionId) {
	const key = normalizeSessionKey(sessionId);
	if (key !== null) {
		const remembered = asSelection(soloSelections.get(key));
		if (remembered !== null) return remembered;
		const rec = seatSessions.get(key);
		const persisted = asSelection({
			provider: rec?.soloProvider,
			model: rec?.soloModel,
			reasoningEffort: rec?.soloEffort
		});
		if (persisted !== null) return persisted;
	}
	const after = lastSoloSelectionAfter(agent, sessionTouchedAt(sessionId));
	if (after !== null) return after;
	return officialDefaultSelection(ctx);
}

/** 会话 id 的稳妥取法。 */
function sessionIdOf(agent) {
	try {
		const raw = agent?.session?.id ?? agent?.sessionId ?? agent?.id;
		return raw === undefined || raw === null ? '' : String(raw);
	} catch (error) {
		return '';
	}
}

/** 记下"当前这一步在用哪个模型"，供客户端显示。 */
function remember(agent, phase, seat, step, turn, reason) {
	try {
		const sessionId = sessionIdOf(agent);
		if (sessionId === '') return;
		// 顺手记下 agent：`turn/start` 发生在本回合第 1 步之前，那时只能用会话 id 反查 agent，
		// 而 agents.get 未必认得它；有了这份缓存，第二个回合起就一定能复位。
		agentBySession.set(sessionId, agent);
		if (agentBySession.size > 64) {
			const key = agentBySession.keys().next().value;
			if (key !== undefined) agentBySession.delete(key);
		}
		lastRoute.set(sessionId, {
			phase,
			reason: reason ?? null,
			provider: seat.provider,
			model: seat.model,
			reasoningEffort: seat.reasoningEffort ?? null,
			step,
			turn: turn ?? null,
			at: Date.now()
		});
		if (lastRoute.size > 64) {
			const oldest = [...lastRoute.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (oldest !== undefined) lastRoute.delete(oldest[0]);
		}
		// 逐步阶段记录：客户端拿它给对话里每一步贴"主管规划/主管介入/主管验收/员工执行"徽标。
		if (turn !== undefined && turn !== null && typeof step === 'number') {
			let map = phaseLog.get(sessionId);
			if (map === undefined) {
				map = new Map();
				phaseLog.set(sessionId, map);
			}
			map.set(`${turn}:${step}`, { phase, reason: reason ?? null, model: seat.model, at: Date.now() });
			while (map.size > PHASE_LOG_LIMIT) {
				const first = map.keys().next().value;
				if (first === undefined) break;
				map.delete(first);
			}
			if (phaseLog.size > 64) {
				const oldest = [...phaseLog.keys()][0];
				if (oldest !== undefined && oldest !== sessionId) phaseLog.delete(oldest);
			}
		}
	} catch (error) {
		/* 纯展示信息，失败无所谓 */
	}
}

/* ==========================================================================
 * 编排状态机
 * ========================================================================== */

/** 阶段中文名，日志与 UI 共用一套说法。 */
const PHASE_LABEL = {
	initial: '主管规划',
	plan: '主管规划',
	replan: '主管介入',
	verify: '主管验收',
	exec: '员工执行',
	done: '收尾'
};

/** 阶段配色语义：这批 reason 都算"主管"（主管模型），其余算"员工"。 */
const PLAN_REASONS = new Set(['initial', 'plan', 'replan', 'verify']);

/**
 * 双方在对话里用的"口令"。
 *
 * 阶段什么时候翻转，由模型自己说，宿主只负责听口令并兜底。
 * 口令用全角括号包裹，宿主匹配前会先剥掉所有空白，容忍 `【 规划 完毕 】` 这种写法。
 * 旧口令一律保留在列表里 —— 万一模型写回了老说法，也不会卡住流程。
 */
const MARKERS = {
	/** 主管交出执行方案 */
	plan: ['【规划完毕】'],
	/** 主管救火完毕（重新给了任务书） */
	replan: ['【介入完毕】', '【重规划完毕】'],
	/** 员工认为自己干完了（接下来转验收） */
	exec: ['【任务完成】', '【执行完毕】'],
	/** 员工卡住了、请求主管下场 */
	help: ['【求援】', '【求助主管】', '【需要主管】', '【无法完成】', '【需要帮助】'],
	/**
	 * 主管验收结论。
	 *
	 * 每种结论列多个变体：模型偶尔会把标记写成 `【验收不通过】`（少了中间的 `】`）或
	 * 「未通过」「不合格」。**漏识别不通过 = 任务在用户毫不知情时被判"通过"而结束** ——
	 * 这是用户实测过的"验收不通过却直接停止"的元凶，所以这里宁宽勿漏。
	 * （匹配前会先剥掉全部空白，`【 验收 】 不 通过` 这类写法也能命中。）
	 */
	pass: ['【验收】通过', '【验收通过】', '【验收】合格', '【验收合格】'],
	fail: ['【验收】不通过', '【验收不通过】', '【验收】未通过', '【验收未通过】', '【验收】不合格', '【验收不合格】']
};

/** 主管可以选的 8 种帮助方式（对齐设计稿的 help_action）。 */
const HELP_ACTIONS = {
	provide_context: '补充上下文',
	provide_example: '给示例',
	simplify_task: '降低难度',
	decompose_task: '拆成小任务',
	change_method: '换方法',
	relax_constraints: '放宽约束',
	ask_user: '向用户要信息',
	manager_do_step: '主管亲自做一小步'
};

/** 剥掉空白后再找口令，避免模型写成 `【 验收 】通过` 就漏掉。 */
function hasMarker(flatText, list) {
	if (typeof flatText !== 'string' || flatText === '') return false;
	for (const marker of list) if (flatText.includes(marker.replace(/\s+/g, ''))) return true;
	return false;
}

/** 找到第一个命中的口令，返回它在正文里的位置（用于截取"求援"正文）。 */
function markerIndex(rawText, list) {
	if (typeof rawText !== 'string' || rawText === '') return -1;
	for (const marker of list) {
		const index = rawText.indexOf(marker);
		if (index >= 0) return index + marker.length;
	}
	return -1;
}

/**
 * 解析某一条模型输出里的全部口令。
 * @returns {{planDone:boolean,replanDone:boolean,execDone:boolean,asksHelp:boolean,verifyPass:boolean,verifyFail:boolean,flat:string,raw:string}}
 */
function scanSignals(text) {
	const raw = typeof text === 'string' ? text : '';
	const flat = raw.replace(/\s+/g, '');
	return {
		planDone: hasMarker(flat, MARKERS.plan),
		replanDone: hasMarker(flat, MARKERS.replan),
		execDone: hasMarker(flat, MARKERS.exec),
		asksHelp: hasMarker(flat, MARKERS.help),
		verifyPass: hasMarker(flat, MARKERS.pass),
		verifyFail: hasMarker(flat, MARKERS.fail),
		flat,
		/** 原文（未剥空白）：验收打回时要把"验收意见原文"带给主管。 */
		raw
	};
}

/**
 * 从一段文本里抠出第一个完整的 JSON 对象。
 * 容忍 ```json 围栏、前后废话、以及字符串里的花括号。
 */
function extractJsonObject(text) {
	if (typeof text !== 'string' || text === '') return null;
	const start = text.indexOf('{');
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === '{') depth += 1;
		else if (char === '}') {
			depth -= 1;
			if (depth === 0) {
				try {
					const parsed = JSON.parse(text.slice(start, index + 1));
					return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
				} catch (error) {
					return null;
				}
			}
		}
	}
	return null;
}

/** 把数组字段渲染成 `- a` 列表，便于塞进给主管看的证据块。 */
function renderList(value, limit = 8) {
	if (!Array.isArray(value)) return '';
	return value
		.filter((item) => typeof item === 'string' && item.trim() !== '')
		.slice(0, limit)
		.map((item) => `- ${item.trim().slice(0, 300)}`)
		.join('\n');
}

/**
 * 解析员工的【求援】正文。
 *
 * 设计稿的关键点：员工不能只说"我失败了"，必须给结构性报告。宿主把 JSON 抽出来
 * 转成人话丢给主管（主管看人话比看原始 JSON 更省 token，也更不容易被废话带偏）。
 * 抽不到 JSON 就退回"原样正文"——绝不让流程卡在解析失败上。
 */
function parseHelpReport(text) {
	const start = markerIndex(text, MARKERS.help);
	const body = (start >= 0 ? text.slice(start) : typeof text === 'string' ? text : '').trim();
	const json = extractJsonObject(body);
	if (json !== null) {
		const lines = [];
		if (typeof json.problem_type === 'string' && json.problem_type.trim() !== '') lines.push(`问题类型：${json.problem_type.trim()}`);
		if (typeof json.description === 'string' && json.description.trim() !== '') lines.push(`卡在哪：${json.description.trim()}`);
		const tried = renderList(json.tried_methods);
		if (tried !== '') lines.push(`已经试过：\n${tried}`);
		const missing = renderList(json.missing_info);
		if (missing !== '') lines.push(`缺少的信息/资源：\n${missing}`);
		if (typeof json.request_to_manager === 'string' && json.request_to_manager.trim() !== '') lines.push(`希望主管怎么帮：${json.request_to_manager.trim()}`);
		const summary = lines.length > 0 ? lines.join('\n') : '';
		return { structured: true, summary, raw: body.slice(0, 1500) };
	}
	return { structured: false, summary: '', raw: body.replace(/\s+/g, ' ').slice(0, 1000) };
}

/**
 * 把求助报告渲染成交给主管看的文本。
 * 有结构化报告就用结构化的人话版，否则退回原文 —— 绝不让流程卡在解析失败上。
 */
function helpReportText(parsed) {
	if (parsed === null || parsed === void 0) return '';
	if (parsed.structured && parsed.summary.trim() !== '') {
		return `【员工结构化求助报告】\n${parsed.summary}`;
	}
	return `【员工的求援原话（没有按结构化格式写）】\n${parsed.raw}`;
}

/** HELP_ACTIONS 的全部键（兜底识别【帮助方式】那一行时用）。 */
const HELP_ACTION_KEYS = Object.keys(HELP_ACTIONS);

/**
 * 兜底：从【帮助方式】那一行附近认出键名（JSON 没写全、或压根没写 JSON 时用）。
 * 只认 HELP_ACTIONS 白名单里的键，避免把普通英文词误当成帮助方式。
 */
function declaredHelpAction(text) {
	const match = /【帮助方式】([^\n]{0,48})/.exec(typeof text === 'string' ? text : '');
	if (match === null) return '';
	return HELP_ACTION_KEYS.find((key) => match[1].includes(key)) ?? '';
}

/**
 * 解析主管【介入完毕】时给出的任务书 JSON（diagnosis / help_action / revised_task）。
 * 同样只做"尽力而为"的解析：抽不到就退回原文，主管的正文本身已经足够指导员工。
 *
 * ⚠️ 特殊照顾 `ask_user`：它是"验收不通过→重新规划"循环的**唯一收敛出口**
 * （把话筒交还用户）。实测中主管偶尔会漏写 JSON 的 help_action 字段，
 * 所以这里对【帮助方式】那一行做白名单兜底识别 —— 漏掉它会让循环空转烧算力。
 */
function parseManagerBrief(text) {
	const source = typeof text === 'string' ? text : '';
	const json = extractJsonObject(source);
	const declared = declaredHelpAction(source);
	if (json === null) {
		// 完全没有 JSON：至少把【帮助方式】认出来（其余正文原样交出）。
		if (declared === '') return null;
		return { action: declared, text: `【主管原文】\n${source.replace(/\s+/g, ' ').trim().slice(0, 1200)}` };
	}
	const diagnosis = typeof json.diagnosis === 'string' ? json.diagnosis.trim() : '';
	const actionKey = typeof json.help_action === 'string' && json.help_action.trim() !== '' ? json.help_action.trim() : declared;
	const revised = json.revised_task !== null && typeof json.revised_task === 'object' ? json.revised_task : null;
	const message = typeof json.message_to_worker === 'string' ? json.message_to_worker.trim() : '';
	if (diagnosis === '' && revised === null && message === '') return null;
	const lines = [];
	if (diagnosis !== '') lines.push(`【主管诊断】${diagnosis}`);
	if (actionKey !== '') {
		const known = Object.prototype.hasOwnProperty.call(HELP_ACTIONS, actionKey);
		lines.push(`【帮助方式】${known ? `${HELP_ACTIONS[actionKey]}（${actionKey}）` : actionKey}`);
	}
	if (revised !== null) {
		lines.push('【主管给的新任务书】');
		if (typeof revised.task_name === 'string' && revised.task_name.trim() !== '') lines.push(`任务：${revised.task_name.trim()}`);
		if (typeof revised.new_context === 'string' && revised.new_context.trim() !== '') lines.push(`补充背景：${revised.new_context.trim()}`);
		const sop = renderList(revised.new_sop);
		if (sop !== '') lines.push(`新的执行步骤：\n${sop}`);
		if (typeof revised.example === 'string' && revised.example.trim() !== '') lines.push(`示例：${revised.example.trim()}`);
		const constraints = renderList(revised.constraints);
		if (constraints !== '') lines.push(`约束：\n${constraints}`);
		const criteria = renderList(revised.acceptance_criteria);
		if (criteria !== '') lines.push(`验收标准：\n${criteria}`);
	}
	if (message !== '') lines.push(`【主管叮嘱】${message}`);
	return { action: actionKey, text: lines.join('\n') };
}

/**
 * 取（或建）某会话当前回合的编排状态。
 *
 * 结构：{ turn, phase, reason, remaining, round, escalated, workerReport, helpBrief,
 *        reviewBrief, reviewFailStreak, sigStreak, lastSig, sameErrorStreak, lastErrorText,
 *        execSteps, execToolCalls, instructed, stage, lastFailure, at }
 */
function orchFor(sessionId) {
	let state = orchestration.get(String(sessionId));
	if (state === undefined) {
		state = {
			turn: 0,
			/** 'plan'（主管初次规划）| 'replan'（主管下场救火）| 'exec'（员工执行）| 'verify'（主管验收）| 'done' */
			phase: 'plan',
			/** 'initial' | 'exec' | 'replan' | 'verify' */
			reason: 'initial',
			/** 本阶段还剩几步（安全阀；正常由模型的口令结束阶段）。 */
			remaining: 0,
			round: 1,
			/** 员工是否已经明确求援（模型自己喊的，不是宿主数的）。 */
			escalated: false,
			/** 员工的求助正文（结构化报告已转成人话）。 */
			workerReport: '',
			/** 主管下场后给员工的"诊断 + 新任务书"，会在员工阶段贴给它。 */
			helpBrief: '',
			/** 主管验收不通过的意见（历史字段：v6.2 起验收意见统一走 workerReport 交给主管，不再直接贴给员工）。 */
			reviewBrief: '',
			/** 累计验收不通过次数（含"没给明确结论"）：跨轮累计，直到验收通过或达到 maxRounds。 */
			reviewFailStreak: 0,
			/** 兜底：同一个工具调用连续重复几次。 */
			sigStreak: 0,
			lastSig: '',
			/** 兜底/触发器②：同一段报错连续重复几次。 */
			sameErrorStreak: 0,
			lastErrorText: '',
			execSteps: 0,
			/** 员工真正落地过几次工具调用（用它判断"到底动没动手"）。 */
			execToolCalls: 0,
			/** 已经为哪个阶段贴过指令消息，避免每步重复贴。 */
			instructed: null,
			/** 每次"换人"自增：指令按它去重，同一阶段只贴一次。 */
			stage: 0,
			lastFailure: '',
			at: Date.now()
		};
		orchestration.set(String(sessionId), state);
		if (orchestration.size > 64) {
			const oldest = [...orchestration.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (oldest !== undefined) orchestration.delete(oldest[0]);
		}
		state.remaining = TUNING.planSteps;
	}
	return state;
}

/** 回合开始：把状态机复位到「主管初次规划」。 */
function resetTurn(sessionId, turn) {
	const state = orchFor(sessionId);
	state.turn = turn ?? 0;
	state.phase = 'plan';
	state.reason = 'initial';
	state.remaining = TUNING.planSteps;
	state.round = 1;
	state.escalated = false;
	state.workerReport = '';
	state.helpBrief = '';
	state.reviewBrief = '';
	state.reviewFailStreak = 0;
	state.sigStreak = 0;
	state.lastSig = '';
	state.sameErrorStreak = 0;
	state.lastErrorText = '';
	state.execSteps = 0;
	state.execToolCalls = 0;
	state.instructed = null;
	state.stage = 0;
	state.lastFailure = '';
	state.at = Date.now();
	return state;
}

/** 把内容块摊平成纯文本（工具结果可能是字符串或块数组）。 */
function flattenText(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts = [];
	for (const block of content) {
		if (typeof block === 'string') parts.push(block);
		else if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
	}
	return parts.join('\n');
}

/**
 * 从一条 `tool/result` 事件里抽出"是不是报错、报错内容是什么"。
 *
 * 为什么必须走 session/event 而不是 agent/pre-step 的 payload.messages：
 * `dsh-agent-loop` 的 `commitReady()` 里，工具结果是用
 * `session.append("tool/result", …)` 落的，进 inbox 的只有
 * `result.additionalContexts`（大多数工具是空数组）。
 * 也就是说 **payload.messages 里根本没有工具结果**。
 */
function readToolResult(event) {
	const message = event?.data?.message;
	const content = Array.isArray(message?.content) ? message.content : [];
	let isError = false;
	const texts = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object') continue;
		if (block.type !== 'tool-result') continue;
		if (block.isError === true) isError = true;
		const text = flattenText(block.content).replace(/\s+/g, ' ').trim();
		if (text !== '') texts.push(text.slice(0, 220));
	}
	return { isError, text: texts.join('\n---\n').slice(0, 1200) };
}

/** 从会话派生历史里取最后一条有内容的 assistant 消息（文本 + 工具调用签名）。 */
function tailAssistant(agent) {
	try {
		const messages = agent?.session?.deriveMessages?.() ?? [];
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== 'assistant') continue;
			const content = Array.isArray(message.content) ? message.content : [];
			const texts = [];
			const calls = [];
			for (const block of content) {
				if (block === null || typeof block !== 'object') continue;
				if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
				else if (block.type === 'tool-call') calls.push(`${block.name ?? '?'}(${String(block.arguments ?? '')})`);
			}
			const text = texts.join('\n').trim();
			if (text !== '' || calls.length > 0) return { text, calls, index };
		}
	} catch (error) {
		/* 读不到就算了 */
	}
	return { text: '', calls: [], index: -1 };
}

/** 造一条编排指令消息（会被官方当 user/message 正常落到会话里）。 */
function instructionMessage(text, form) {
	return {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: {
			kind: 'plugin',
			plugin: 'dsh-plan-exec-models',
			// 'notice' 让客户端渲染成一行可折叠的提示，不喧宾夺主但随时可展开
			form: form ?? 'notice',
			summary: text.split('\n')[0].slice(0, 60)
		}
	};
}

/**
 * 各阶段的指令正文。
 *
 * 角色设定：主管 × 员工。关键点是**不要把流程写死** —— 给员工"自己想办法"的空间，
 * 但也明确告诉它想不出来时要**带着结构性报告来求援**（而不是默默硬试到超时）。
 */
const INSTRUCTIONS = {
	plan: [
		'【双模型编排 · 主管规划】',
		'你现在的角色是**主管**。用户的目标见本会话最早的那条消息。',
		'你的职责是：把用户的目标拆解成一份**可执行的任务书**，交给你的员工（另一个模型）去落地。',
		'**不要自己动手改文件 / 跑命令** —— 你的产出是"给员工的任务书"，不是结果本身。',
		'',
		'请按下面四段输出：',
		'1. 【目标与需求】2~4 行复述：用户到底要什么、怎样算成功、有什么约束（含用户没说透但显然在意的点）。',
		'2. 【执行方法 SOP】给出可照做的流程，每行形如 `步骤N: <做什么 · 用什么手段 · 产出什么>`。',
		'3. 【验收标准】2~6 条，每条形如 `标准N: …`，必须**可验证**（能被读文件 / 跑命令证实）。',
		'4. 【风险与备选】最可能卡住的地方，以及走不通时可以改走哪条路。',
		'',
		'写完后**单独一行**输出 `【规划完毕】`，系统会把执行权交给员工。'
	].join('\n'),
	exec: [
		'【双模型编排 · 员工执行】',
		'你的主管（另一个模型）已经在上面给出了【目标与需求】【执行方法 SOP】【验收标准】。现在由你落地。',
		'',
		'**工作方式（重要）**',
		'1. **按主管给的方法做**，逐条推进；每完成一条写一句 `标准N 已完成`。',
		'2. 某条方法走不通时，**先自己想办法**：换工具、换路径、把问题拆小、换个假设验证一下。自己最多试 **2 次**。',
		'   自己解决了就继续往下干 —— 不用请示。',
		'3. 试了 2 次仍然不通，**不要一直硬试、也不要谎报完成**。停下来，**单独一行**写 `【求援】`，',
		'   紧接着给出一份**结构性求助报告**（照抄字段名，值按你的实际情况填；这是给主管看的，写清楚才能拿到有用的帮助）：',
		'   {"problem_type":"信息不足 | 方法不对 | 约束冲突 | 权限或环境限制 | 其它",',
		'    "description":"卡在哪一步、为什么这样不行",',
		'    "tried_methods":["我已经试过的办法 1","办法 2"],',
		'    "missing_info":["缺少哪些信息或资源"],',
		'    "request_to_manager":"希望主管怎么帮你"}',
		'   主管会下场诊断根因、给你新方法，然后你接着干。',
		'4. 全部标准达成、并且你自己复核过结果之后，写一句产出小结，**单独一行**输出 `【任务完成】`。',
		'   之后主管会来验收，所以只要没真做完就不要写这一行。'
	].join('\n'),
	replan: [
		'【双模型编排 · 主管介入（重新规划）】',
		'现在轮到你重新规划，原因可能是：员工在执行中卡住了 / 主动求援了，**也可能是你刚才验收判了不通过**。',
		'下面是它的求助报告或你的验收意见，以及现场证据：',
		'',
		'```',
		'(__EVIDENCE__)',
		'```',
		'',
		'请以**主管**身份处理。**你的任务不是替员工把活干完**，而是：诊断根因 → 补上下文 / 换方法 / 拆细任务 →',
		'给出一份员工能直接照做的**新任务书**。如果这是验收打回后的重新规划，重点回应你的验收意见里',
		'点出的缺口 —— 说清"下一版怎么做才能过"，别让员工再走一遍老路。',
		'',
		'请严格按下面四段输出：',
		'1. 【诊断】根因是什么（方法本身不对？环境或权限限制？缺关键信息？约束互相冲突？员工误解了输出格式？）。不要只复述报错。',
		'2. 【帮助方式】从下面 8 种里挑**最贴切的一个**，单独一行写 `【帮助方式】<英文键名>`：',
		'   provide_context 补背景 · provide_example 给示例 · simplify_task 降难度 · decompose_task 拆小任务 ·',
		'   change_method 换方法 · relax_constraints 放宽约束 · ask_user 向用户要信息 · manager_do_step 主管亲自做一小步',
		'   （`manager_do_step` 会额外占用你的算力，**尽量少用** —— 能靠"给方法"解决就别自己上手。）',
		'3. 【给员工的新任务】紧跟一个 JSON 对象（员工会照着它执行，字段名照抄、用不到的填空）：',
		'   {"task_name":"任务名称",',
		'    "new_context":"补充的背景信息",',
		'    "new_sop":["新的步骤 1","新的步骤 2"],',
		'    "example":"一个可参考的示例",',
		'    "constraints":["约束 1"],',
		'    "acceptance_criteria":["验收标准 1"]}',
		'4. 【给员工的提醒】一句话：这次要注意什么、**不要再重复哪种做法**。',
		'',
		'⚠️ **例外——需要用户拍板时**：如果你判断"这个任务靠继续自动循环做不完 / 缺用户才能提供的信息 /',
		'必须用户在两个方案里选一个"，就把【帮助方式】设为 `ask_user`，并在【诊断】里写清要用户确认什么、',
		'为什么自动做不了。系统会把问题**直接交还给用户**（不再交回员工），等用户回复后再继续 ——',
		'这是唯一的"主动停下来找用户"通道，不要用"随便给个新任务书继续试"来回避它。',
		'',
		'写完后**单独一行**输出 `【介入完毕】`，系统会把执行权交回员工。'
	].join('\n'),
	verify: [
		'【双模型编排 · 主管验收】',
		'你的员工声称已完成。请以**主管**身份验收：对照用户最初的目标与【验收标准】，',
		'**实际去读文件 / 跑命令复核**，确认产出真的满足用户需求，而不是"看起来做了"。',
		'复核过程**保持安静**：工具照常调用，不必写"我正在读…""看到…"这类过程解说 —— 用户不看这些。',
		'',
		'- 确实满足 → **单独一行**输出 `【验收】通过`，紧接着写**给用户的最终答复**。',
		'  这是用户真正在等的唯一产出：不是给系统看的复核说明，而是"我问的问题，结论是什么"。长这样：',
		'',
		'  【验收】通过',
		'',
		'  **结论**：1~2 句，直接回答用户最初的问题。例：',
		'  "小米平板 11 二轮流脑度优化已完成：8 项后台冻结全部持久化，冷启动下降 32%；',
		'  天玑 6300 硬件上限导致的卡顿无法用软件消除（报告中已说明）。"',
		'',
		'  **关键结果**',
		'  - 3~6 条，每条一行：说用户能看懂的话、带上关键数字，但不铺细节。',
		'',
		'  **详细报告**：`reports/xxx.md`（完整数据与操作明细都在文档里；没有独立文档时省略这一行）',
		'',
		'  ⚠️ 这段答复会**原样送到用户面前**，按"交付文案"的标准写：',
		'  · **不许出现内部术语** —— 「复核依据 / 验收标准 / 员工 / 主管 / 编排 / 无缺口 / 本轮 / 交回」这类词；',
		'  · **不许**罗列命令、包名、逐条清单 —— 那是文档的内容（用户想看细节会自己打开文档）；',
		'  · **总长控制在 20 行以内**，宁短勿长；若前几轮发生过返工，只说最终状态，不必交代返工过程。',
		'  （例外：用户问的本身就是技术明细 / 操作清单时，可适度展开 —— 但按"用户的问题"来组织，而不是按验收视角。）',
		'',
		'- 没满足或有疑点 → **单独一行**输出 `【验收】不通过`，并写清缺什么 / 哪里不合格 / 要改成什么样。',
		'  系统会把你的验收意见交回给你自己，由你**重新规划任务**（给出新任务书），再让员工继续执行 ——',
		'  如此循环，直到你判通过为止。所以写不通过时，重点讲清"下一版应该怎么做"（可直接照做的新要求）。',
		'',
		'**必须给出明确结论**：只写"还有问题"却不写 `【验收】通过` / `【验收】不通过`，会被系统视为未通过。',
		'若判断"需要用户拍板才能继续"：先判**不通过**，然后在接下来给你的【主管介入】里用 `ask_user` 声明。',
		'注意：验收的标准是**用户的需求**，不是"员工说他做完了"。',
		'(__VERIFY_NOTE__)'
	].join('\n')
};

/** 员工拿到主管材料（救火产出 / 验收意见）时的执行指令。 */
const EXEC_WITH_BRIEFING = [
	'【双模型编排 · 员工执行（带着主管给的补充材料）】',
	'你在执行中卡住过（或被主管验收打回过）。主管已经看过现场，给了你新的材料：',
	'',
	'```',
	'(__BRIEFING__)',
	'```',
	'',
	'**你的新要求**',
	'1. **不要再重复之前失败的做法**；主管标出的坑要绕开。',
	'2. 严格按主管给的 new_sop / 修改意见执行；缺字段就按你判断补全，但方向以主管为准。',
	'3. 如果**仍然缺少关键信息**，继续 `【求援】` + 同一份结构性报告（别硬撑，也别谎报）。',
	'4. 完成后写产出小结，**单独一行**输出 `【任务完成】`。'
].join('\n');

/** 把员工方的补充材料拼成一块（救火产出在前，验收意见在后）。 */
function briefingOf(orch) {
	const parts = [];
	if (typeof orch.helpBrief === 'string' && orch.helpBrief.trim() !== '') parts.push(orch.helpBrief.trim());
	if (typeof orch.reviewBrief === 'string' && orch.reviewBrief.trim() !== '') parts.push(orch.reviewBrief.trim());
	return parts.join('\n\n---\n\n');
}

/**
 * 交回主管时要带的"现场证据"：员工的汇报在前，工具报错原文在后。
 *
 * 为什么必须两处共用：交棒有两条路径 —— pre-step（routeStep 判定 / 触发条件①②③）与
 * turn-stopping（模型口令判定）。早先只有 pre-step 这条路拼了 workerReport，
 * turn-stopping 那条只传 lastFailure，结果"员工主动【求援】"这条**主路径**反而把
 * 结构化求助报告弄丢了 —— 主管只能看到一句"员工没有留下明确汇报…"。
 * 现在两条路都走 evidenceOf()。
 */
function evidenceOf(orch) {
	if (orch === null || orch === undefined) return '';
	return [orch.workerReport, orch.lastFailure]
		.filter((part) => typeof part === 'string' && part.trim() !== '')
		.join('\n\n---\n\n');
}

/** 拼出一条阶段指令。 */
function buildInstruction(reason, orch, extras) {
	if (reason === 'replan') {
		const evidence = typeof extras === 'string' && extras.trim() !== ''
			? extras.trim().slice(0, 1800)
			: '（员工没有留下明确汇报，在没有产出的情况下就停住了）';
		return instructionMessage(INSTRUCTIONS.replan.replace('(__EVIDENCE__)', evidence));
	}
	if (reason === 'verify') {
		const round = orch !== null && orch !== void 0 && orch.reviewFailStreak > 0 ? orch.reviewFailStreak + 1 : 1;
		const note = round > 1
			? `这是**第 ${round} 次验收**：你上次判了不通过，任务已经按你的意见重新规划并执行过一轮。先确认这次是否真的改到位了；若仍不通过，继续按"重新规划"的思路写清下一版怎么做。`
			: '';
		return instructionMessage(INSTRUCTIONS.verify.replace('(__VERIFY_NOTE__)', note));
	}
	if (reason === 'exec') {
		const briefing = orch === null || orch === void 0 ? '' : briefingOf(orch);
		if (briefing.trim() !== '') return instructionMessage(EXEC_WITH_BRIEFING.replace('(__BRIEFING__)', briefing.slice(0, 2000)));
		return instructionMessage(INSTRUCTIONS.exec);
	}
	return instructionMessage(INSTRUCTIONS.plan);
}

/**
 * 决定"这一步"该由哪一位负责，并推进状态机。
 * **只有 isActive 为真时才接管**；否则返回 null（行为与没装插件完全一致）。
 *
 * 原则：阶段什么时候翻转由模型的口令决定，宿主只在四种情况下兜底插手：
 *   · 该阶段步数超过安全阀（TUNING.planSteps / replanSteps / verifySteps）
 *   · 员工重试超过 maxRetries 次仍失败（触发条件②）
 *   · 主管验收不通过 / 验收未表态（触发条件③：交回主管重新规划）
 *   · 同一个工具调用连续重复 stuckThreshold 次（真卡死）
 *
 * @param signals - scanSignals(tailAssistant(agent).text) 的结果
 * @returns {{phase:'plan'|'replan'|'exec'|'verify', reason:string, seat:object, why?:string}|null}
 */
function routeStep(state, orch, signals) {
	if (!isActive(state)) return null;
	const plan = seatOf(state, 'plan');
	const exec = seatOf(state, 'exec');
	const sig = signals ?? {};
	const maxRounds = clampRounds(state.maxRounds);
	const maxRetries = clampRetries(state.maxRetries);
	const canEscalate = TUNING.autoReplan && orch.round < maxRounds;

	// 1) 初次规划阶段：主管说"规划完毕"就交棒；否则最多待 planSteps 步（安全阀）
	if (orch.phase === 'plan') {
		const saidDone = sig.planDone === true;
		if (saidDone || orch.remaining <= 0) {
			orch.phase = 'exec';
			orch.reason = 'exec';
			orch.instructed = null;
			orch.stage += 1;
			orch.execSteps += 1;
			orch.remaining = 0;
			return { phase: 'exec', reason: 'exec', seat: exec, why: saidDone ? '主管交棒' : '规划步数达安全阀' };
		}
		orch.remaining -= 1;
		return { phase: 'plan', reason: orch.reason, seat: plan };
	}

	// 2) 主管救火阶段：主管说"介入完毕"就把活交回员工；步数只是安全阀
	if (orch.phase === 'replan') {
		const saidDone = sig.replanDone === true;
		if (saidDone || orch.remaining <= 0) {
			orch.phase = 'exec';
			orch.reason = 'exec';
			orch.instructed = null;
			orch.stage += 1;
			orch.execSteps += 1;
			orch.remaining = 0;
			return { phase: 'exec', reason: 'exec', seat: exec, why: saidDone ? '主管交回执行权' : '救火步数达安全阀' };
		}
		orch.remaining -= 1;
		return { phase: 'plan', reason: 'replan', seat: plan };
	}

	// 3) 验收阶段：主管自己决定说完没有；步数只是安全阀
	if (orch.phase === 'verify') {
		const decided = sig.verifyPass === true || sig.verifyFail === true;
		// a) 已给出"不通过"结论 → 交回主管重新规划（本步起由主管接手，pre-step 会贴上 replan 指令）
		if (decided && sig.verifyFail === true) {
			if (canEscalate) {
				prepareVerifyBounce(orch, sig.raw);
				return escalate(orch, plan, state, `验收不通过（第 ${orch.reviewFailStreak} 次）`);
			}
			// 上限已到：保持 verify 相位不动，等这一步停下时由 turn-stopping 向用户明确交代
			return null;
		}
		// b) 已给出"通过"结论 → 交棒到此为止，让这一回合自然收尾
		//    （v6.3：这一步的发言本身就是「给用户的交付总结」—— verify 指令已规定格式，
		//      宿主不再补充任何内容；用户最后看到的就是那份简练总结 + 文档路径。）
		if (decided) {
			orch.phase = 'done';
			return null;
		}
		// c) 安全阀：验收步数用完仍未表态 → 一律按"不通过"处理，交回主管重新规划。
		//    ⚠️ 这里绝不能直接 `done` —— 那正是用户实测到的"主管还没判完，任务却直接停止"
		//    （旧版把它当成"按通过处理"静默收尾）。
		if (orch.remaining <= 0) {
			if (canEscalate) {
				prepareVerifyBounce(orch, '');
				return escalate(orch, plan, state, `验收未给出明确结论（第 ${orch.reviewFailStreak} 次）`);
			}
			return null; // 同上：留给 turn-stopping 交代
		}
		orch.remaining -= 1;
		return { phase: 'plan', reason: 'verify', seat: plan };
	}

	// 4) 收尾：不再干预，让这一回合自然结束
	if (orch.phase === 'done') return null;

	// 5) 员工执行阶段
	orch.execSteps += 1;

	// 5a) 触发条件①：员工主动求助 —— 主路径
	if (sig.asksHelp === true && canEscalate) {
		return escalate(orch, plan, state, `员工求援：${orch.workerReport.slice(0, 120) || '（未给出正文）'}`);
	}

	if (canEscalate) {
		// 5b) 触发条件②：员工重试超过 maxRetries 次仍失败（同一段报错反复出现）
		if (orch.sameErrorStreak >= maxRetries) {
			if (orch.workerReport === '') {
				orch.workerReport = `（宿主判定）同一段报错连续出现 ${orch.sameErrorStreak} 次，员工没有主动求援：\n${orch.lastErrorText.slice(0, 300)}`;
			}
			return escalate(orch, plan, state, `员工重试 ${orch.sameErrorStreak} 次仍失败`);
		}
		// 5c) 兜底：真卡死（同一个动作反复原地打转）
		if (orch.sigStreak >= TUNING.stuckThreshold) {
			if (orch.workerReport === '') {
				orch.workerReport = `（宿主判定）同一个工具调用连续重复 ${orch.sigStreak} 次，员工既没有推进也没有求援。`;
			}
			return escalate(orch, plan, state, `卡死：同一动作重复 ${orch.sigStreak} 次`);
		}
	}
	return { phase: 'exec', reason: 'exec', seat: exec };
}

/**
 * 把控制权交回主管（救火 / 验收打回后重新规划）。
 *
 * 两条链共用这一个出口：
 *   · 员工卡住 / 求援 / 反复失败  → 主管下场"救火"；
 *   · 主管验收不通过（或验收没给明确结论）→ 主管**重新规划任务**，再交回员工执行。
 *     （v6.2 起：验收不通过不再"直接把意见甩给员工重做"，而是每次都回到主管手里 ——
 *       用户明确要求「不通过 → 主管重新规划 → 员工继续执行，直到验收通过为止」。）
 *
 * 注意：`phase` 必须真的写成 `'replan'` —— 救火/重规划是**独立相位**，不是"又来一次初次规划"。
 * （曾经的写法是 phase 停在 'plan'、只用 reason 记 'replan'，结果 routeStep / turn-stopping /
 * peekNextSeat 里所有 `phase === 'replan'` 分支全成了死代码：主管的【介入完毕】被当成
 * 普通的【规划完毕】，新任务书没人解析 —— 交回员工的是一条没有材料的裸指令。）
 *
 * @param why - 人类可读的原因，会进日志与证据块
 */
function escalate(orch, plan, state, why) {
	orch.round += 1;
	orch.phase = 'replan';
	orch.reason = 'replan';
	orch.remaining = TUNING.replanSteps;
	orch.sigStreak = 0;
	orch.lastSig = '';
	orch.sameErrorStreak = 0;
	orch.lastErrorText = '';
	orch.execToolCalls = 0;
	orch.execSteps = 0;
	orch.escalated = false;
	orch.instructed = null;
	orch.stage += 1;
	log(`交回主管（${why}）→ 第 ${orch.round} 轮救火`);
	return { phase: 'replan', reason: 'replan', seat: plan, why };
}

/**
 * 验收打回前的"现场包装"：把验收意见（或"没表态"这件事）记进 workerReport，
 * 主管重新规划时会在证据块里读到它。
 *
 * 三件事一次做完，供 routeStep 与 turn-stopping 两个入口共用：
 *   1) `reviewFailStreak += 1`（计"第几次验收不通过"，日志/证据/下一轮提示都用它）；
 *   2) 把原文写进 `workerReport`（交给主管的证据，比丢给员工更有价值 —— 主管据此重新规划）；
 *   3) 清掉 `helpBrief` / `reviewBrief` / `lastFailure`，避免旧材料混进新证据。
 *
 * @param text - 验收那一步的原文（可能为空：主管一步都没输出就停下了）
 * @returns {string} 写好的 workerReport
 */
function prepareVerifyBounce(orch, text) {
	orch.reviewFailStreak += 1;
	const body = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 1200) : '';
	orch.workerReport = body !== ''
		? `主管第 ${orch.reviewFailStreak} 次验收**不通过**。验收意见原文——${body}`
		: `主管第 ${orch.reviewFailStreak} 次验收**没有给出明确结论**（缺少【验收】通过 / 【验收】不通过 标记），按未通过处理。请先复核现场现状，再决定：给出能让员工通过的新任务书，或用 ask_user 把问题交还用户。`;
	orch.helpBrief = '';
	orch.reviewBrief = '';
	orch.lastFailure = '';
	return orch.workerReport;
}

/**
 * 达到轮数上限时，往对话里注入一条**给用户看的**暂停说明。
 *
 * 为什么必须注入而不是只写日志：套壳 App 里看不到插件 stdout，
 * 只写日志 = 用户眼里任务"莫名其妙停了" —— 这正是用户反馈的观感。
 * 暂停必须带原因、带数字、带下一步怎么做。
 */
function notifyRoundLimit(agent, orch, state, rounds) {
	const text = [
		'【双模型编排 · 已暂停】',
		`主管已连续 ${orch.reviewFailStreak} 次判定验收不通过，达到「最大轮数」上限（${rounds} 轮），编排已暂停。`,
		'请检查上方的验收意见后决定下一步：',
		'· 直接回复你的指示（例如「继续，先修 A 再修 B」），任务会带着你的指示重新开始；',
		'· 或把输入框上方「双模型」菜单里的「最大轮数」调大（最高 100），再要求继续。',
		`（本会话累计进行 ${orch.round} 轮。）`
	].join('\n');
	try {
		if (agent !== null && agent !== undefined && typeof agent.inject === 'function') {
			agent.inject(instructionMessage(text, 'notice'));
		}
	} catch (error) {
		log('暂停通知注入失败（不影响对话）', error);
	}
	log(`已达最大轮数 ${rounds}（累计 ${orch.reviewFailStreak} 次验收不通过）→ 暂停并已通知用户`);
}

/**
 * 主管声明 `ask_user`（向用户要信息）时，把话筒交还给用户。
 *
 * 这是"直到验收通过为止"这个无限循环的**收敛出口**：主管判断继续自动跑没有意义时，
 * 交还用户拍板，而不是让循环空转烧算力。
 */
function notifyAskUser(agent, orch) {
	const text = [
		'【双模型编排 · 等你拍板】',
		'主管在【介入】里声明需要你提供信息 / 做决定，本会话的双模型编排已暂停，话筒交还给你。',
		'请直接回复你的决定或补充信息 —— 任务会带着它重新开始。'
	].join('\n');
	try {
		if (agent !== null && agent !== undefined && typeof agent.inject === 'function') {
			agent.inject(instructionMessage(text, 'notice'));
		}
	} catch (error) {
		log('ask_user 通知注入失败（不影响对话）', error);
	}
	log('主管声明 ask_user → 编排暂停，话筒交还用户');
}

/**
 * 不动状态机地"偷看"下一步该由哪一席负责。
 *
 * 为什么要它：官方的 `system-prompt/assemble` 在 pre-step **之前**执行，把
 * `selection.current` 快照成 `assembled`。所以我们在这里写 current，实际影响的是
 * **下一步**。把 current 写成"下一步的目标"，下一步提示词里的 `{{model}}` 才是准的。
 */
function peekNextSeat(state, orch, signals) {
	if (!isActive(state)) return null;
	const plan = seatOf(state, 'plan');
	const exec = seatOf(state, 'exec');
	if (orch.phase === 'plan') {
		const saidDone = signals !== undefined && signals !== null && signals.planDone === true;
		return saidDone || orch.remaining <= 0 ? exec : plan;
	}
	if (orch.phase === 'replan') {
		const saidDone = signals !== undefined && signals !== null && signals.replanDone === true;
		return saidDone || orch.remaining <= 0 ? exec : plan;
	}
	if (orch.phase === 'verify') {
		const decided = signals !== undefined && signals !== null && (signals.verifyPass === true || signals.verifyFail === true);
		return decided || orch.remaining <= 0 ? null : plan;
	}
	if (orch.phase === 'done') return null;
	// 员工阶段默认继续员工；真求援/卡死时会在下一步的 pre-step 里被 routeStep 纠正。
	return exec;
}

/** 兜底通道（agent/request）里拿不到 step，只能推：同一回合就接着上一次 +1，换回合就归 1。 */
function nextStepOf(payload) {
	if (typeof payload?.step === 'number') return payload.step;
	try {
		const agent = payload?.agent;
		const sessionId = sessionIdOf(agent);
		if (sessionId === '') return 1;
		const last = lastRoute.get(sessionId);
		if (last === null || last === void 0) return 1;
		if (payload?.turn !== void 0 && last.turn !== payload.turn) return 1;
		if (typeof last.step === 'number') return last.step + 1;
	} catch (error) {
		/* 推不出来就当作第一步 */
	}
	return 1;
}

/** 从请求头里读上一份 config。 */
function headerConfig(agent) {
	try {
		return agent?.session?.requestHeader?.()?.config ?? null;
	} catch (error) {
		return null;
	}
}

/** 官方权限插件的设置命名空间；defaultPreset 就是"新会话默认权限"。 */
const PERMISSION_NS = 'permission';
/** 上一次已经写回的权限预设，用来去重，避免每步都写盘。 */
let lastPermissionPreset = null;

/**
 * 记住"上一次选的权限预设"，让下一次新会话默认沿用。
 * 官方只在 session/created 时读这个值，所以不会动到当前正在跑的会话。
 */
function rememberPermissionPreset(ctx, preset) {
	if (typeof preset !== 'string' || preset === '') return;
	if (preset === lastPermissionPreset) return;
	lastPermissionPreset = preset;

	const settings = ctx?.settings;
	if (settings === null || settings === void 0) return;
	if (typeof settings.update !== 'function') {
		log('settings 服务没有 update 方法，权限预设无法持久化');
		return;
	}

	try {
		if (typeof settings.get === 'function') {
			const current = settings.get(PERMISSION_NS);
			if (current !== null && typeof current === 'object' && current.defaultPreset === preset) {
				log(`权限预设已经是「${preset}」，无需写回`);
				return;
			}
		}
	} catch (error) {
		/* 读不到就照样尝试写 */
	}

	let pending;
	try {
		pending = settings.update(PERMISSION_NS, { defaultPreset: preset });
	} catch (error) {
		lastPermissionPreset = null;
		log(`权限预设「${preset}」写回失败`, error);
		return;
	}
	if (pending !== null && typeof pending?.then === 'function') {
		pending.then(
			() => log(`权限预设已记住：下次新会话默认「${preset}」`),
			(error) => {
				lastPermissionPreset = null;
				log(`权限预设「${preset}」写回失败`, error?.message ?? error);
			}
		);
	} else {
		log(`权限预设已记住：下次新会话默认「${preset}」`);
	}
}

/** 把 patch 里出现过的字段过滤成合法值，避免客户端塞进来奇怪的东西。 */
function sanitizePatch(input) {
	const patch = {};
	if (input === null || typeof input !== 'object') return patch;
	if (typeof input.enabled === 'boolean') patch.enabled = input.enabled;
	if (input.maxRounds !== undefined) patch.maxRounds = clampRounds(input.maxRounds);
	if (input.maxRetries !== undefined) patch.maxRetries = clampRetries(input.maxRetries);
	for (const key of ['planProvider', 'planModel', 'planEffort', 'execProvider', 'execModel', 'execEffort']) {
		const value = input[key];
		if (typeof value === 'string') patch[key] = value.slice(0, 200);
	}
	return patch;
}

/** 读请求体并解析 JSON；出错返回 null。 */
function readJsonBody(request, limit = 64 * 1024) {
	return new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		request.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				resolve(null);
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => {
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (error) {
				resolve(null);
			}
		});
		request.on('error', () => resolve(null));
	});
}

/** 统一的 JSON 响应。 */
function sendJson(response, status, payload) {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store'
	});
	response.end(JSON.stringify(payload));
}

/** 把某个会话的阶段地图压成纯对象（键 "turn:step"）。 */
function phasesOf(sessionId) {
	const map = sessionId === undefined ? undefined : phaseLog.get(String(sessionId));
	if (map === undefined) return {};
	const out = {};
	for (const [key, value] of map) out[key] = value;
	return out;
}

/** 拼出对外的状态快照。 */
function snapshot(store, sessionId) {
	// 快照永远取"这个会话此刻生效的那份"，不是全局 —— 全局只是新会话的种子。
	const key = normalizeSessionKey(sessionId);
	// 要在 stateFor **之前**问它有没有独立记录：stateFor 会给没记录的会话当场钉一份，
	// 钉完再问就永远是 true 了。
	const wasPinned = key === null ? null : seatSessions.has(key);
	const state = stateFor(store, sessionId);
	const plan = seatOf(state, 'plan');
	const exec = seatOf(state, 'exec');
	const route = sessionId === undefined ? undefined : lastRoute.get(String(sessionId));
	const orch = sessionId === undefined ? undefined : orchestration.get(String(sessionId));
	return {
		ok: true,
		storage: store.kind,
		seats: state,
		resolved: { plan, exec },
		/** 这个会话在本次调用前有没有自己的独立记录（false = 刚从全局继承）。 */
		pinned: wasPinned,
		/** 回显请求里带的会话 id（排障时一眼看出"这份快照是谁的"）。 */
		session: key,
		/** 总开关（关掉就完全退化为官方单模型生成）。 */
		enabled: state.enabled === true,
		/** 'off' | 'waiting'（开着但两席没配全）| 'active'。 */
		mode: modeOf(state),
		/** 只有它为 true 时本插件才会接管会话。 */
		orchestrating: isActive(state),
		seatsAreComplete: seatsComplete(state),
		/** 最近一次编排决策：{phase, reason, provider, model, step, at}，没跑过就是 null。 */
		active: route ?? null,
		/** 本回合状态机的现场。 */
		turn: orch === undefined
			? null
			: {
				phase: orch.phase,
				reason: orch.reason,
				round: orch.round,
				reviewFailStreak: orch.reviewFailStreak,
				remaining: orch.remaining,
				escalated: orch.escalated,
				workerReport: orch.workerReport,
				sigStreak: orch.sigStreak,
				sameErrorStreak: orch.sameErrorStreak,
				execToolCalls: orch.execToolCalls,
				lastFailure: orch.lastFailure
			},
		/** "turn:step" → {phase, reason, model}：给对话里每一步贴准确徽标。 */
		phases: phasesOf(sessionId),
		/* 编排参数（客户端只用来显示，不再暴露步数器） */
		maxRounds: clampRounds(state.maxRounds),
		maxRetries: clampRetries(state.maxRetries),
		autoReplan: TUNING.autoReplan,
		verifyOnFinish: TUNING.verifyOnFinish
	};
}

export function apply(ctx) {
	const store = createStore(ctx);
	/**
	 * 接线「动态档位」：从 `llm-pi-ai` 设置命名空间读某模型声明了哪些思考档位。
	 *
	 * 这样主管/员工席位只需要一个语义值（最高档 / 中间档），换任何模型都不会失效
	 * —— 档位会按目标模型自己的词表重新落位。读不到就返回 null，`snapEffort`
	 * 会原样放行请求值，等于退回改动前的行为。
	 */
	readDeclaredLevels = (provider, model) => {
		let settings;
		try {
			settings = ctx?.settings?.get?.('llm-pi-ai');
		} catch {
			return null;
		}
		const entry = settings?.providers?.[provider]?.models?.find?.((item) => item?.id === model);
		const efforts = entry?.reasoningEfforts;
		if (efforts === void 0 || efforts === null || efforts === false) return null;
		if (typeof efforts !== 'object') return null;
		const levels = Object.keys(efforts).filter((level) => EFFORT_ORDER.includes(level));
		if (levels.length === 0) return null;
		return levels.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
	};
	/**
	 * 会话席位表上线。
	 *
	 * `store` 是**全局**的（settings.yaml），每个对话共用一份 —— 用户明确要求
	 * "单双模型工作方式，每个对话内容都应该是独立的；只有新开对话才继承上一次设定"。
	 * 所以这里挂上第二层：全局只当种子，`sessions.json` 才是每个对话自己的那份。
	 */
	seatSessions = createSessionStore();
	/** 记录当前用的是哪条实现路径，方便排障。 */
	let mode = 'idle';
	let selectionProbeLogged = false;

	/** 列出当前活着的 agent（重置 selection 用）。 */
	function liveAgents() {
		try {
			return ctx?.agents?.list?.() ?? [];
		} catch (error) {
			return [];
		}
	}

	/**
	 * 接管前记下"用户此刻在用的单模型"，供关闭时还原。
	 *
	 * 两个来源，按可靠度：
	 *   ① selection.current —— 官方认定的"下一个请求要用的模型"（用户刚在单模型框里选过就是它）；
	 *   ② session.requestHeader() —— 上一次实际发出去的模型（什么都没选过时的真实值）。
	 * 都不像"用户的单模型选择"（恰好等于即将生效的两席模型）就放弃记录 ——
	 * 宁可不记（关闭时退到官方默认），也不要记一份本来就是编排模型的脏值。
	 */
	function rememberSoloBeforeTakeover(sessionId) {
		const key = normalizeSessionKey(sessionId);
		if (key === null) return;
		const state = stateFor(store, key);
		const seats = seatRoutesOf(state);
		const looksLikeSeat = (route) => route !== null && seats.some((seat) => sameRoute(seat, route));
		for (const agent of liveAgents()) {
			if (sessionIdOf(agent) !== key) continue;
			const route = readSoloCandidate(agent);
			if (route === null) continue;
			if (looksLikeSeat(route)) continue;
			soloSelections.set(key, route);
			// 同时落盘。内存记忆活不过进程重启，而"开着双模型 → 重启 App → 关掉"
			// 是极常见的路径；不落盘的话关闭时只能退到官方默认，把用户自己的单模型弄丢。
			// ⚠️ 这一步会盖 `at`（= 接管时刻），它比"关闭时刻"早 —— 正好符合基线语义，
			// 自愈的时间基线取的仍是关闭那次写入（见 sessionTouchedAt）。
			seatSessions.update(key, {
				soloProvider: route.provider,
				soloModel: route.model,
				soloEffort: route.reasoningEffort
			});
			log(`记下会话 ${shortId(key)} 接管前的单模型：${route.provider}/${route.model}（关闭双模型时会还原到它）`);
			return;
		}
	}

	/** 读"当前看起来是单模型那一个"：先问官方 selection，再问请求头。 */
	function readSoloCandidate(agent) {
		try {
			const selection = selectionFor(ctx, agent);
			if (selection !== null && selection !== void 0) {
				const picked = asSelection(selection.current);
				if (picked !== null) return picked;
			}
		} catch (error) {
			/* 落到请求头 */
		}
		try {
			const header = agent?.session?.requestHeader?.();
			return asSelection(header?.config);
		} catch (error) {
			return null;
		}
	}

	/**
	 * 关闭双模型时的一次性收尾 —— **只收尾一个会话**。
	 *   ① 把这个会话的 selection.current **写回一个明确的单模型选择**（见下方详述）；
	 *   ② 把这个会话的状态机标成 done，确保不会有滞留的【介入完毕】/交棒被继续处理。
	 *
	 * ## 为什么不能只写 undefined（user 实报：关掉了还在走主管模型）
	 *
	 * 官方 selection 的 current 是带 getter/setter 的属性：setter 写内部 `picked`，
	 * getter 在 `picked === undefined` 时**回落到 `session.requestHeader()`** ——
	 * 本会话**上一次实际发出去的模型**。编排期间每个回合都在发主管/员工请求，
	 * requestHeader 早被写成编排模型。于是"清成 undefined"的净效果是：
	 * 回落值 = 编排模型 = 用户抱怨的"还在走双模型那一席"。
	 *
	 * 更糟的是它会一路带到**下一个真实请求**：官方 `system-prompt/assemble` 把
	 * `current` 快照进 `assembled`，`agent/request` 再照 `assembled` 改写请求 ——
	 * 于是关了开关，下一个回合依旧走主管模型。
	 *
	 * 所以这里改成**显式还原**：
	 *   · 还原目标 =「开启双模型之前记下的那份单模型」（soloSelections），
	 *     拿不到就退到官方默认模型（settings 的 `agent-default-model`，与官方
	 *     selectionFor 自己的兜底同源）；
	 *   · 同时把这份选择 `append("model/selection")` 落进会话日志 —— 官方客户端的
	 *     "单模型"框读的正是 `modelSelection` 投影（`pending ?? lastUsed`），
	 *     不落事件的话框里会继续显示被编排污染的 lastUsed，用户照样以为没关掉。
	 *   · 万一两者都拿不到（极早期环境），才退回原来的"写 undefined"。
	 *
	 * **为什么不再"全局收尾"**：单双模型是每个对话各自的事。在 A 对话里关掉开关，
	 * 不该顺手把 B 对话正在跑的双模型也掐了 —— 那是另一个对话自己的设定。
	 * 拿不到会话 id 时（老客户端 / 非会话上下文）才退化成全局收尾。
	 */
	function releaseSessions(reason, sessionId) {
		const only = normalizeSessionKey(sessionId);
		if (only === null) {
			for (const orch of orchestration.values()) orch.phase = 'done';
		} else {
			const orch = orchestration.get(only);
			if (orch !== undefined) orch.phase = 'done';
		}
		/**
		 * 待复位的 agent：本会话状态下记过的那个 + 所有会话 id 对得上的活 agent。
		 * 两条路都走，是因为 `agentBySession` 是编排时顺手记的，而 `liveAgents()`
		 * 依赖 dsh 侧的 list() —— 任一条缺失都不能让"关闭"失效。
		 */
		const candidates = [];
		const seen = new Set();
		const collect = (agent) => {
			if (agent === null || agent === void 0 || seen.has(agent)) return;
			seen.add(agent);
			candidates.push(agent);
		};
		if (only !== null) collect(agentBySession.get(only));
		for (const agent of liveAgents()) {
			if (only !== null && sessionIdOf(agent) !== only) continue;
			collect(agent);
		}
		let released = 0;
		for (const agent of candidates) {
			try {
				const selection = selectionFor(ctx, agent);
				if (selection === null || selection === void 0) continue;
				const key = sessionIdOf(agent);
				const target = pickSoloFallback(ctx, agent, key);
				if (target === null) {
					// 实在拿不到还原目标：退回老行为（写 undefined，交给官方回落）。
					selection.current = undefined;
					released += 1;
					continue;
				}
				// ① 落一条 durable 的 model/selection —— 官方"单模型"框读的就是这份投影。
				try {
					agent?.session?.append?.('model/selection', target);
				} catch (error) {
					/* 落事件失败不影响下面直接写内存里的选择 */
				}
				// ② 直接写内存里的选择 —— 下一刻的 assemble / request 就用它。
				selection.current = target;
				released += 1;
				soloSelections.delete(key);
				log(`已把会话 ${shortId(key)} 的模型还原为单模型：${target.provider}/${target.model}${target.reasoningEffort === void 0 ? '' : '（' + target.reasoningEffort + '）'}`);
			} catch (error) {
				/* 单个会话复位失败不影响其它会话 */
			}
		}
		log(only === null
			? `已关闭双模型编排（${reason}，全局收尾）：${released} 个会话已还原为单模型，其它对话不受影响`
			: `已关闭本会话的双模型编排（${reason}，会话 ${shortId(only)}）：${released} 个会话已还原为单模型，其它对话不受影响`);
	}

	/**
	 * 单个会话的自愈：确认它是"关闭后残留"就把单模型选择还原回去。
	 *
	 * @returns 真的修了返回 true（调用方据此决定要不要落日志/计数）。
	 */
	function healSession(agent, trigger) {
		try {
			const key = sessionIdOf(agent);
			if (key === '') return false;
			// 会话表里**没有**这条记录 → 本插件从没见过这个对话，谈不上"双模型残留"。
			// ⚠️ 必须先于 `stateFor` 判断：`stateFor` 会顺手把新会话钉进表里，之后
			// 就分不出"它本来就在"还是"刚刚才被钉进来"了。
			if (!seatSessions.has(key)) return false;
			const state = stateFor(store, key);
			// 开关**只要开着**就一律不碰 —— 包括"开着但两席还没配全"（waiting）的中间态：
			// 用户正在那个对话里配置双模型，这时候替他改模型是帮倒忙。
			// 自愈只针对"用户已经关掉双模型"之后留下的残留。
			if (state.enabled === true) return false;
			const selection = selectionFor(ctx, agent);
			if (selection === null || selection === void 0) return false;
			let current;
			try {
				current = selection.current;
			} catch (error) {
				return false;
			}
			// 判断刻意从严（见 looksContaminated）—— 少一条都不碰。
			if (!looksContaminated(agent, state, current)) return false;
			const target = pickSoloFallback(ctx, agent, key);
			if (target === null) return false;
			try {
				agent?.session?.append?.('model/selection', target);
			} catch (error) {
				/* 忽略 */
			}
			selection.current = target;
			const from = asSelection(current);
			log(`自愈（${trigger}）：会话 ${shortId(key)} 的单模型选择还挂在编排模型 ${from?.provider}/${from?.model} 上，已还原为 ${target.provider}/${target.model}`);
			return true;
		} catch (error) {
			return false;
		}
	}

	/**
	 * 存量脏数据的自愈（全量）：**只在插件加载后扫一遍**。
	 *
	 * 要处理的正是"用户先前关过双模型、但当时的关闭逻辑只清了 picked"留下的会话：
	 * 它们的 selection.current 还挂在编排模型上，只要用户一发言就会继续走那个模型。
	 *
	 * 局限：`liveAgents()` 只列得出**已经被唤起过**的会话。没唤起过的（重启后没点开的）
	 * 扫不到 —— 那一部分由 `GET /seats` 的单会话自愈补上（用户一打开那个对话就修）。
	 */
	function healStaleSessions(trigger) {
		let healed = 0;
		for (const agent of liveAgents()) {
			if (healSession(agent, trigger)) healed += 1;
		}
		if (healed > 0) log(`自愈完成（${trigger}）：共修正 ${healed} 个会话`);
		return healed;
	}

	/** 按会话 id 找活着的 agent（没有就 null）。 */
	function liveAgentFor(sessionId) {
		const key = normalizeSessionKey(sessionId);
		if (key === null) return null;
		for (const agent of liveAgents()) {
			if (sessionIdOf(agent) === key) return agent;
		}
		return null;
	}

	/** 按会话 id 自愈一个会话（`GET /seats` 顺路调用）。 */
	function healOneSession(sessionId, trigger) {
		const agent = liveAgentFor(sessionId);
		return agent === null ? false : healSession(agent, trigger);
	}

	/** 打开会话"补扫"的定时器与去重表（见 scheduleHealRetry）。 */
	const healRetryTimers = [];
	const healRetryQueued = new Set();

	/**
	 * 打开会话时的"唤醒竞态"补网（v6.7 新增）。
	 *
	 * 实测（2026-09-15）：点开一个大会话（4.7MB 事件流）后，agent 要 ~30 秒才真正活过来，
	 * 而客户端的 `GET /seats` 在点开那一瞬间就发出 —— 单发一枪会落空。这里在"当时没有
	 * 活 agent"时排几枪迟到补扫，把唤醒完成的那一刻兜住。
	 * 每枪仍走 `healSession` 的从严判据、幂等：干净会话恒为 no-op，重复开枪不会误伤。
	 */
	function scheduleHealRetry(sessionId) {
		const key = normalizeSessionKey(sessionId);
		if (key === null || healRetryQueued.has(key)) return;
		healRetryQueued.add(key);
		for (const delay of [10000, 30000, 60000, 120000]) {
			try {
				const timer = setTimeout(() => {
					try {
						healOneSession(key, `打开后补扫 +${delay / 1000}s`);
					} catch (error) {
						/* 忽略 */
					}
				}, delay);
				if (typeof timer?.unref === 'function') timer.unref();
				healRetryTimers.push(timer);
			} catch (error) {
				/* 忽略 */
			}
		}
		try {
			const release = setTimeout(() => healRetryQueued.delete(key), 150000);
			if (typeof release?.unref === 'function') release.unref();
			healRetryTimers.push(release);
		} catch (error) {
			/* 忽略 */
		}
	}

	/** ① 首选路径：agent/pre-step 里改写官方 model selection，并在阶段边界追加指令消息。 */
	ctx.effect(() => {
		const dispose = ctx.on('agent/pre-step', async (payload, next) => {
			try {
				const agent = payload?.agent;
				const step = typeof payload?.step === 'number' ? payload.step : 1;
				const turn = payload?.turn;
				const state = stateFor(store, sessionIdOf(agent));
				// 总闸：没开或两席没配全 → 一步都不碰（连 selection 都不读，避免留下副作用）。
				if (!isActive(state)) {
					// 但"关掉双模型后仍走在编排模型上"这种**残留**必须在这里兜一下 ——
					// 这里是请求发出前的最后一道关，比"用户重新打开这个对话"可靠得多：
					// 历史遗留的脏会话不一定还会被点开，只要用户再发言就一定会经过这里。
					// 判据从严（见 looksContaminated），干净会话在这里恒为 no-op。
					healSession(agent, 'agent/pre-step');
					return next();
				}

				const selection = selectionFor(ctx, agent);
				if (selection === null) {
					// 换成兜底通道：模型照样会切，但阶段指令与提示词里的 {{model}} 不跟着变。
					if (!selectionProbeLogged) {
						selectionProbeLogged = true;
						const probe = selectionApiProbe(ctx);
						log(`⚠️ 拿不到官方 selection（现存入口=[${probe.join(', ') || '无'}]），本步起改用 agent/request 兜底通道：模型照样会切，但阶段指令与提示词里的 {{model}} 不会跟着变`);
						log(`服务探测：${serviceProbe(ctx).join(' | ')}`);
					}
					return next();
				}
				if (!selectionProbeLogged) {
					selectionProbeLogged = true;
					log(`已接上官方 selection 通道：${selectionChannel}`);
				}

				const seats = [seatOf(state, 'plan'), seatOf(state, 'exec')];
				const headerRoute = routeOf(headerConfig(agent));
				const selected = routeOf(selection.current);
				// 让路：上一份请求头是"外人"（例如自动续跑）选的模型，本步不插手。
				if (isForeignRoute(headerRoute, selected, seats)) {
					log('检测到其它插件主导的模型路由，本步让路', headerRoute);
					return next();
				}

				const sessionId = sessionIdOf(agent);
				if (sessionId === '') return next();
				const orch = orchFor(sessionId);
				// 状态机跟着回合走：换了回合先复位。
				if (typeof turn === 'number' && orch.turn !== turn) resetTurn(sessionId, turn);

				// 碰壁信号不在这里扫 payload.messages —— 那里面只有 additionalContexts，
				// 工具结果根本不走 inbox（见 readToolResult 的注释）。
				// execToolCalls / sameErrorStreak 由 session/event 监听器实时累计。
				// 这里只读"上一句发言"里的口令 + 工具调用签名。
				const tail = tailAssistant(agent);
				const signals = scanSignals(tail.text);

				// 员工求援：它自己喊的，正文解析成结构性报告留给主管看。
				// 只在**员工阶段**读这个口令 —— 否则主管正在写救火方案时，"上一句发言"还是
				// 员工那句【求援】，会被反复识别成新的求援。
				if (orch.phase === 'exec' && signals.asksHelp && !orch.escalated) {
					orch.escalated = true;
					orch.workerReport = helpReportText(parseHelpReport(tail.text));
					log(`员工求援：${orch.workerReport.slice(0, 200)}`);
				}

				// 兜底用的"原地打转"判定：同上一个工具调用签名一致就累计。
				const signature = tail.calls.join('|');
				if (signature !== '' && signature === orch.lastSig) orch.sigStreak += 1;
				else orch.sigStreak = signature === '' ? 0 : 1;
				orch.lastSig = signature;

				// 主管在救火这一步既写了方案又调了工具（所以 turn-stopping 没触发，材料没人收）：
				// 在这里补收一次，免得交回员工时只有一条光秃秃的"按主管说的做"。
				if (orch.phase === 'replan' && signals.replanDone && (orch.helpBrief ?? '') === '') {
					const brief = captureManagerBrief(orch, tail.text);
					log(`主管在工具步里说完【介入完毕】，就地补收新任务书（${orch.helpBrief.slice(0, 80)}…）`);
					// 同一出口的 ask_user：既然主管要用户拍板，就别把活再甩回员工。
					if (brief !== null && brief.action === 'ask_user') {
						orch.phase = 'done';
						notifyAskUser(agent, orch);
						orch.at = Date.now();
						return next();
					}
				}

				const route = routeStep(state, orch, signals);
				if (route === null) {
					orch.at = Date.now();
					return next();
				}

				// 顺序很关键：官方的 system-prompt/assemble 在 pre-step **之前**就把
				// selection.current 快照成了 assembled。所以在这个钩子里写 current 只影响"下一步"。
				// 由此得出两件事：
				// 1) 这里要把"下一步"的目标提前写进 current —— 这样下一步的 {{model}} 提示变量、
				//    官方 assembled、以及 "[model changed: ...]" 通知都是准的（不再晚一步）。
				// 2) "本步"的目标要直接对齐 assembled —— agent/request 只认 assembled，对齐了本步才用对模型。
				const decision = await next();
				if (decision?.kind === 'reject') return decision;

				const target = toSelectionRoute(route.seat);
				if (target !== null && !sameRoute(routeOf(selection.assembled), target)) {
					selection.assembled = target;
				}
				// current 写"下一步"的目标：这样下一步 assemble 出来的 {{model}} 与 assembled 都是准的。
				const upcoming = toSelectionRoute(peekNextSeat(state, orch, signals) ?? route.seat);
				if (upcoming !== null) selection.current = upcoming;

				// 阶段指令：每次"换人"只贴一次。
				if (orch.instructed !== orch.stage) {
					orch.instructed = orch.stage;
					decision.messages.push(buildInstruction(route.reason, orch, evidenceOf(orch)));
					log(`下达阶段指令：${PHASE_LABEL[route.reason] ?? route.reason}（回合 ${turn ?? '?'} 第 ${step} 步，${route.seat.model}）`);
				}

				const before = lastRoute.get(sessionId);
				remember(agent, route.phase, route.seat, step, turn, route.reason);
				orch.at = Date.now();
				if (before === undefined || before.phase !== route.phase || before.reason !== route.reason) {
					const label = PHASE_LABEL[route.reason] ?? route.phase;
					log(`换手：回合 ${turn ?? '?'} 第 ${step} 步起由「${label}」${route.seat.model} 负责（第 ${orch.round} 轮）${route.why !== undefined ? ' · ' + route.why : ''}`);
				}
				mode = 'selection';
				return decision;
			} catch (error) {
				log('pre-step 编排失败，回退官方行为', error);
			}
			return next();
		});
		return () => {
			try {
				dispose?.();
			} catch (error) {
				/* 卸载时忽略 */
			}
		};
	}, 'dsh-plan-exec-models: 按阶段切换模型 + 阶段指令（官方 selection 通道）');

	/** ② 兜底路径：拿不到官方 selection 时，自己改写 agent/request 的 config。 */
	ctx.effect(() => {
		const dispose = ctx.on('agent/request', async (payload, next) => {
			const config = await next();
			try {
				const agent = payload?.agent;
				if (selectionFor(ctx, agent) !== null) return config; // ① 已在工作
				const sessionId = sessionIdOf(agent);
				const state = stateFor(store, sessionId);
				if (!isActive(state)) return config;

				if (sessionId === '') return config;
				const orch = orchFor(sessionId);
				const turn = payload?.turn;
				if (typeof turn === 'number' && orch.turn !== turn) resetTurn(sessionId, turn);

				const seats = [seatOf(state, 'plan'), seatOf(state, 'exec')];
				const headerRoute = routeOf(headerConfig(agent));
				const selected = routeOf(selectionFor(ctx, agent)?.current);
				if (isForeignRoute(headerRoute, selected, seats)) return config;

				const route = routeStep(state, orch);
				if (route === null) return config;
				const step = nextStepOf(payload);
				remember(agent, route.phase, route.seat, step, turn, route.reason);
				mode = 'request';
				const patched = { ...config, provider: route.seat.provider, model: route.seat.model };
				if (route.seat.reasoningEffort === undefined) delete patched.reasoningEffort;
				else patched.reasoningEffort = route.seat.reasoningEffort;
				return patched;
			} catch (error) {
				log('request 编排失败，回退原配置', error);
				return config;
			}
		});
		return () => {
			try {
				dispose?.();
			} catch (error) {
				/* 卸载时忽略 */
			}
		};
	}, 'dsh-plan-exec-models: 按阶段切换模型（agent/request 兜底通道）');

	/**
	 * ②′ 交棒：某一方"停下不说话了"的时候，决定下一步该谁上。
	 *
	 * `agent/turn-stopping` 是官方在本步没有工具调用、回合即将结束时触发的钩子；
	 * dispatch 是 fused(payload) = {...payload, agent}，所以这里能直接拿到 agent。
	 * 用官方 API `agent.inject(message)`（写 next-step、不唤醒驱动）就能让**同一个回合**
	 * 再多跑一步 —— 这一步正好换到另一方。整个任务因此仍在一个回合内完成。
	 *
	 * 交棒规则：
	 *   主管规划停下        → 员工上
	 *   员工停下            → 已【求援】→ 主管介入；一步没动手 → 主管介入；否则 → 主管验收
	 *   主管救火停下        → 员工上（带主管的新任务书）；若声明 ask_user → 把话筒交还用户
	 *   主管验收停下        → 读【验收】通过/不通过：
	 *                         · 通过   → 编排完成（唯一的正常收尾）
	 *                         · 不通过 → 交回主管**重新规划**（第几次都如此）→ 员工按新任务书继续
	 *                         · 没表态 → 与"不通过"同路（**绝不按通过静默收尾**）
	 *                         循环直到通过，或达到「最大轮数」（到顶时明确通知用户，不静默停止）
	 */
	ctx.effect(() => {
		const dispose = ctx.on('agent/turn-stopping', (payload) => {
			try {
				const agent = payload?.agent;
				const sessionId = sessionIdOf(agent);
				const state = stateFor(store, sessionId);
				if (!isActive(state)) return;
				if (sessionId === '') return;
				const orch = orchFor(sessionId);
				const turn = payload?.turn;
				if (typeof turn === 'number' && orch.turn !== turn) resetTurn(sessionId, turn);
				const maxRounds = clampRounds(state.maxRounds);
				const canEscalate = TUNING.autoReplan && orch.round < maxRounds;
				const tail = tailAssistant(agent);
				const signals = scanSignals(tail.text);

				if (orch.phase === 'plan') {
					// 主管把话说完了（没有工具调用就结束）→ 交给员工
					orch.phase = 'exec';
					orch.reason = 'exec';
					orch.instructed = null;
					orch.stage += 1;
					orch.execToolCalls = 0;
					orch.sigStreak = 0;
					orch.lastSig = '';
					orch.sameErrorStreak = 0;
					orch.lastErrorText = '';
					handOver(agent, orch, 'exec', turn);
					return;
				}

				if (orch.phase === 'replan') {
					// 主管救火完毕 → 把活交回员工（带上它的诊断与新任务书）
					const brief = captureManagerBrief(orch, tail.text);
					// 例外：主管声明 ask_user（向用户要信息）→ 不再交回员工，把话筒交还用户。
					// 这是"验收不通过就重新规划、直到通过"这个循环的收敛出口：
					// 主管判断再自动跑也没意义时，让用户拍板，而不是让循环空转烧算力。
					if (brief !== null && brief.action === 'ask_user') {
						orch.phase = 'done';
						notifyAskUser(agent, orch);
						return;
					}
					orch.phase = 'exec';
					orch.reason = 'exec';
					orch.instructed = null;
					orch.stage += 1;
					orch.execToolCalls = 0;
					orch.sigStreak = 0;
					orch.lastSig = '';
					orch.sameErrorStreak = 0;
					orch.lastErrorText = '';
					orch.reviewBrief = '';
					log(`主管救火完毕（帮助方式=${brief?.action || '未声明'}）→ 交回员工`);
					handOver(agent, orch, 'exec', turn);
					return;
				}

				if (orch.phase === 'exec') {
					if (signals.asksHelp && !orch.escalated) {
						orch.escalated = true;
						orch.workerReport = helpReportText(parseHelpReport(tail.text));
					}
					// a) 触发条件①：员工自己求援了 → 交回主管（主路径）
					if (orch.escalated && canEscalate) {
						escalate(orch, seatOf(state, 'plan'), state, '员工主动求援');
						handOver(agent, orch, 'replan', turn);
						return;
					}
					// b) 员工什么都没干、也没说自己完成 → 主管的方法没落地，交回主管
					//    （若它明确说了【任务完成】，即使这一步没调工具也走验收 —— 谎报由验收兜住）
					if (!signals.execDone && orch.execToolCalls === 0 && canEscalate) {
						escalate(orch, seatOf(state, 'plan'), state, '员工没有任何动作');
						orch.workerReport = '员工一步都没动手就停住了：既没有产生工具调用，也没有求援。（可能是主管给的方法无法落地，或它把任务当成了纯问答。）';
						handOver(agent, orch, 'replan', turn);
						return;
					}
					// c) 正常干完了 → 交给主管验收
					if (TUNING.verifyOnFinish) {
						orch.phase = 'verify';
						orch.reason = 'verify';
						orch.remaining = TUNING.verifySteps;
						orch.instructed = null;
						orch.stage += 1;
						handOver(agent, orch, 'verify', turn);
						return;
					}
					orch.phase = 'done';
					log(`回合 ${turn ?? '?'} 员工收尾，验收已关闭，结束编排`);
					return;
				}

				if (orch.phase === 'verify') {
					const text = tail.text;
					// 通过 → 整个编排完成（唯一会让编排正常收尾的验收结论）。
					// v6.3：这条发言按 verify 指令就是「给用户的交付总结」（结论 / 关键结果 / 详细报告），
					// 所以这里**什么都不注入** —— 多余的收尾消息只会把干净的交付文案冲散。
					if (signals.verifyPass === true) {
						log('验收结论：通过，双模型编排完成');
						orch.phase = 'done';
						return;
					}
					// 不通过 / 没给明确结论 → 一律交回主管重新规划，直到通过为止。
					// （v6.2：不再有"第 1 次先让员工按意见重做"的捷径 —— 用户要求不通过就重新规划。）
					// ⚠️ "没给结论"绝不能按通过处理：旧版就是在这里静默收尾，
					//    用户看到的现象是"主管正在验收，任务却突然停了"。
					const explicitFail = signals.verifyFail === true;
					prepareVerifyBounce(orch, text);
					const why = explicitFail
						? `验收不通过（第 ${orch.reviewFailStreak} 次）`
						: `验收未给出明确结论（第 ${orch.reviewFailStreak} 次）`;
					if (canEscalate) {
						log(`验收结论：${explicitFail ? '不通过' : '未给出明确结论'} → 交回主管重新规划（累计 ${orch.reviewFailStreak} 次）`);
						escalate(orch, seatOf(state, 'plan'), state, why);
						handOver(agent, orch, 'replan', turn);
						return;
					}
					// 轮数上限已到：明确交代给用户，而不是让任务静默消失
					log(`验收结论：${explicitFail ? '不通过' : '未给出明确结论'}，但已达最大轮数 ${maxRounds} 轮`);
					orch.phase = 'done';
					notifyRoundLimit(agent, orch, state, maxRounds);
					return;
				}
			} catch (error) {
				log('turn-stopping 交棒失败（不影响对话）', error);
			}
		});
		return () => {
			try {
				dispose?.();
			} catch (error) {
				/* 卸载时忽略 */
			}
		};
	}, 'dsh-plan-exec-models: 阶段交棒（agent/turn-stopping）');

	/**
	 * 收起主管【介入完毕】那一段正文，转成"给员工的补充材料"。
	 *
	 * 两条路都会调它：turn-stopping（主管说完就停 —— 常态）与 pre-step（主管边说边调工具，
	 * 本步不触发 turn-stopping，只好在下一步的 pre-step 里补收）。两条路都不做的话，
	 * 就会出现"主管救火完毕、交回员工的却是一条没有材料的裸指令"。
	 */
	function captureManagerBrief(orch, text) {
		const brief = parseManagerBrief(typeof text === 'string' ? text : '');
		orch.helpBrief = brief !== null
			? brief.text
			: `【主管原文】\n${typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 1200) : ''}`;
		return brief;
	}

	/** 把控制权交给下一席：注入一条指令消息，让同一个回合再跑一步。 */
	function handOver(agent, orch, reason, turn) {
		try {
			if (agent === null || agent === undefined || typeof agent.inject !== 'function') {
				log('agent 没有 inject 方法，无法交棒', reason);
				return;
			}
			agent.inject(buildInstruction(reason, orch, evidenceOf(orch)));
			// 记下"这个阶段的指令已经贴过了"，免得 pre-step 又贴一条重复的。
			orch.instructed = orch.stage;
			orch.at = Date.now();
			log(`交棒 → ${PHASE_LABEL[reason] ?? reason}（回合 ${turn ?? '?'}，第 ${orch.round} 轮）`);
		} catch (error) {
			log('交棒注入失败（不影响对话）', error);
		}
	}

	/**
	 * ②″ 回合边界复位 + 碰壁信号采集 + 权限预设持久化。
	 *
	 * - `turn/start` 是本回合第 1 步之前唯一能抓到的时机。没有它，回合第一步的
	 *   {{model}} 提示变量会停留在上一回合最后一步的模型上，状态机也不会复位。
	 * - `tool/result` 是**唯一**能拿到工具执行结果的时机（结果不进 inbox）。
	 * - `permission/preset` 是官方权限插件往会话里落的事件。
	 */
	ctx.effect(() => {
		const dispose = ctx.on('session/event', (session, event) => {
			try {
				if (event?.type === 'tool/result') {
					const rawId = session?.id;
					if (rawId === void 0) return;
					const orch = orchestration.get(String(rawId));
					// 还没编排过 / 已收尾：不统计，别给无关会话凭空造状态。
					if (orch === undefined || orch.phase === 'done') return;
					const result = readToolResult(event);
					// 只有员工真正落地的工具调用才算"动过手"。
					if (orch.phase === 'exec') orch.execToolCalls += 1;
					if (result.isError && result.text !== '') {
						// 不按"报错次数"抢方向盘（那会剥夺员工自己想办法的空间），
						// 只统计**同一段报错连续重复**多少次 —— 那是真的卡住了（触发条件②）。
						orch.sameErrorStreak = result.text === orch.lastErrorText ? orch.sameErrorStreak + 1 : 1;
						orch.lastErrorText = result.text;
						orch.lastFailure = result.text;
						log(`工具报错（同一段报错连续第 ${orch.sameErrorStreak} 次，当前阶段 ${orch.reason}）：${result.text.slice(0, 140)}`);
					} else if (!result.isError) {
						// 报错之间的任何一次成功，都说明还没卡死。
						orch.sameErrorStreak = 0;
					}
					return;
				}
				if (event?.type === 'turn/start') {
					const rawId = session?.id;
					if (rawId === void 0) return;
					const id = String(rawId);
					// 用**这个会话**的席位表判定：别的对话开着双模型，不该影响这里。
					const state = stateFor(store, id);
					if (!isActive(state)) return;
					const turn = event?.data?.turn;
					const orch = resetTurn(id, turn);
					const agent = ctx.agents?.get?.(rawId) ?? agentBySession.get(id);
					if (agent === null || agent === void 0) return;
					const selection = selectionFor(ctx, agent);
					const route = toSelectionRoute(seatOf(state, 'plan'));
					if (selection === null || route === null) return;
					agentBySession.set(id, agent);
					selection.current = route;
					log(`回合 ${turn ?? '?'} 开始，主管拿到话语权：${route.model}（阶段安全阀 ${orch.remaining} 步，正常由它自己说「规划完毕」交棒）`);
					return;
				}
				if (event?.type === 'permission/preset') rememberPermissionPreset(ctx, event?.data?.preset);
			} catch (error) {
				log('session 事件处理失败（不影响对话）', error);
			}
		});
		return () => {
			try {
				dispose?.();
			} catch (error) {
				/* 卸载时忽略 */
			}
		};
	}, 'dsh-plan-exec-models: 回合复位 + 碰壁信号采集 + 权限持久化');

	/** ③ 给客户端的 HTTP 接口：读写席位 + 查当前编排状态。 */
	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: API_PREFIX,
		handler: async (request, response) => {
			let pathname = '/';
			let sessionId;
			try {
				const url = new URL(request.url ?? '/', 'http://localhost');
				pathname = url.pathname.slice(API_PREFIX.length) || '/';
				sessionId = url.searchParams.get('sessionId') ?? undefined;
			} catch (error) {
				sendJson(response, 400, { ok: false, error: 'bad-url' });
				return true;
			}

			if (pathname === '/seats' && request.method === 'GET') {
				// 顺路自愈：客户端切到某个对话时会拉一次这里 —— 正好是"用户马上要在这个
				// 对话里说话"的时机。若这个对话还挂着先前关闭双模型时留下的编排模型，
				// 就在这一刻修掉，别等用户发出请求才发现走错了模型。
				try {
					if (liveAgentFor(sessionId) === null) {
						// 会话还没醒（打开是异步的，大会话实测要 ~30s）—— 排几枪迟到补扫；
						// 醒着但干净/已修好的会话不排，避免无谓开枪。
						scheduleHealRetry(sessionId);
					} else {
						healOneSession(sessionId, 'GET /seats');
					}
				} catch (error) {
					/* 自愈失败不影响正常读配置 */
				}
				sendJson(response, 200, snapshot(store, sessionId));
				return true;
			}
			if (pathname === '/seats' && (request.method === 'PUT' || request.method === 'POST')) {
				const body = await readJsonBody(request);
				if (body === null) {
					sendJson(response, 400, { ok: false, error: 'bad-json' });
					return true;
				}
				const key = normalizeSessionKey(sessionId);
				const before = stateFor(store, sessionId);
				const patch = sanitizePatch(body);
				if (Object.keys(patch).length > 0) {
					// ① 写**本对话**那一份 —— 这就是"每个对话各自独立"的落点。
					//    写在前面，是因为全局那份只是种子，会话那份才是此刻生效的。
					if (key !== null) {
						// 只有**显式关闭**这一种写入才钉 offAt（两席被清空而隐式失效的走 `at`，
						// 反正那一次写入就是关闭时刻）。刻意不写成"enabled !== true 就钉" ——
						// 否则"关掉之后又改了改席位"会把基线顶到改席位的那一刻，
						// 把用户在关闭之后、改席位之前的那次真实选择误判成"关闭之前"。
						const stamp = patch.enabled === false ? { offAt: Date.now() } : {};
						seatSessions.update(key, { ...patch, ...stamp });
					}
					// ② 全局那份照样更新，但它只当"新对话的种子"：
					//    记下最近一次设定，新开的对话才会继承到它。
					//    （老客户端不带 sessionId，走这里等价于原来的全局行为。）
					await store.update(patch);
				}
				const after = stateFor(store, sessionId);
				const where = key === null ? '全局' : `会话 ${shortId(key)}`;
				// 开关每一次真的翻转都留痕。原来只记"关闭"、不记"打开"，于是
				// "明明关了却又生效"这种问题在日志里查不到中间那次打开 —— 只能靠猜。
				if (typeof patch.enabled === 'boolean' && before.enabled !== after.enabled) {
					log(`总开关（${where}）：${before.enabled === true ? '开' : '关'} → ${after.enabled === true ? '开' : '关'}（mode=${modeOf(after)}）`);
				}
				// 总开关从"开"翻到"关"（或两席被清空）→ 立刻把这个会话还原成单模型。
				// 这一步不做的话，当前正在跑的会话会停在上一次编排选的模型上，
				// 用户会以为"关了还生效"。注意只收尾本会话：别的对话有自己的设定。
				if (isActive(before) && !isActive(after)) {
					releaseSessions(after.enabled !== true ? '总开关关闭' : '两席未选全', sessionId);
				} else if (!isActive(before) && isActive(after)) {
					// 接管前先记下"用户此刻在用的单模型" —— 关掉时靠它还原回去。
					// 必须在写 selection.current 之前记：一旦编排跑起来，
					// selection.current 与 requestHeader 都会被换成编排模型，就再也读不到这份原值了。
					rememberSoloBeforeTakeover(sessionId);
					log(`双模型编排开始接管（${where}）：主管规划 → 员工执行 → 求援则主管救火 → 主管验收`);
				}
				sendJson(response, 200, snapshot(store, sessionId));
				return true;
			}
			// 排障用：不跑回合也能验证"官方 selection 通道到底接不接得上"。
			if (pathname === '/probe' && request.method === 'GET') {
				const live = liveAgents();
				sendJson(response, 200, {
					ok: true,
					/** ⚠️ 字段名是 implMode，不能叫 mode —— 见 /state 处的说明。 */
					implMode: mode,
					selectionChannel,
					services: serviceProbe(ctx),
					selectionEntries: selectionApiProbe(ctx),
					liveAgents: live.length,
					resolved: live.map((agent) => {
						const id = String(agent?.session?.id ?? agent?.id ?? '?');
						try {
							const selection = selectionFor(ctx, agent);
							if (selection === null) return { id, ok: false, reason: 'selectionFor 返回空' };
							const current = (() => {
								try {
									return selection.current ?? null;
								} catch (error) {
									return { error: String(error?.message ?? error).slice(0, 80) };
								}
							})();
							return {
								id,
								ok: true,
								channel: selectionChannel,
								current,
								assembled: selection.assembled ?? null
							};
						} catch (error) {
							return { id, ok: false, reason: String(error?.message ?? error).slice(0, 120) };
						}
					})
				});
				return true;
			}
			if (pathname === '/state' && request.method === 'GET') {
				// serviceProbe 放在这里实时算：请求发生在启动完成之后，此时服务才齐，测得准。
				sendJson(response, 200, {
					...snapshot(store, sessionId),
					/**
					 * ⚠️ 这个字段**必须**叫 implMode，绝对不能叫 mode。
					 *
					 * `snapshot()` 里已经有一个 `mode`（'off' | 'waiting' | 'active'，表示
					 * 双模型编排开没开），而这里想带的是"走的哪条实现通道"（'selection' |
					 * 'request' | 'idle'）。两个 mode 撞名后，这里会把前者的值覆盖成
					 * 'selection'，于是前端每 2 秒轮询一次就把它读到的编排状态冲掉：
					 * 界面会一边显示"双模型 待设置"、一边显示"双模型工作 已关闭"，
					 * 用户看到的就是"明明关了却像还开着/明明开了却像关着"。
					 */
					implMode: mode,
					selectionChannel,
					services: serviceProbe(ctx),
					selectionEntries: selectionApiProbe(ctx)
				});
				return true;
			}
			// 排障用：套壳 App 里拿不到子进程 stdout，靠这个看"到底有没有真的在切模型"。
			if (pathname === '/log' && request.method === 'GET') {
				sendJson(response, 200, {
					ok: true,
					file: logFilePath(),
					/** ⚠️ 字段名是 implMode，不能叫 mode —— 见 /state 处的说明。 */
					implMode: mode,
					selectionChannel,
					services: serviceProbe(ctx),
					selectionEntries: selectionApiProbe(ctx),
					trackedSessions: [...lastRoute.keys()],
					/** 会话席位表：排障时看"某个对话到底记了什么"。 */
					seatSessions: { file: seatSessions.file, count: seatSessions.count() },
					sessionSeats: sessionId === undefined ? null : stateFor(store, sessionId),
					route: sessionId === undefined ? null : (lastRoute.get(String(sessionId)) ?? null),
					lines: recentLog.slice(-200)
				});
				return true;
			}
			sendJson(response, 404, { ok: false, error: 'not-found', path: pathname });
			return true;
		}
	}), 'dsh-plan-exec-models: HTTP 接口');

	const seed = store.get();
	// 关掉双模型时的还原语义（v6.6 起）：不再只清 picked（那会回落到被编排污染的
	// requestHeader），而是**显式写回**用户接管前的单模型 —— 见 releaseSessions。
	log(`Host 侧已加载：存储=${store.kind}，会话席位表=${seatSessions.file}（已有 ${seatSessions.count()} 个对话的独立记录）；全局种子=${describeMode(seed)}（新对话会继承它）；每个对话的单/双模型设定互相独立；编排 v6.7（验收不通过→重新规划继续；通过→输出用户视角的交付总结：结论+关键结果+详细文档；关闭时显式还原单模型；残留会话打开时自动补扫）`);

	/**
	 * 启动自愈：把先前版本留下的"关了双模型却仍挂在编排模型上"的会话修回来。
	 *
	 * 为什么要延后跑：插件加载时 dsh 的 agent 列表还没建好（`ctx.agents.list()` 为空），
	 * 立刻扫会一个都扫不到。延后一点、并且再补一次，覆盖"加载后才有会话被唤起"的情形。
	 * 自愈本身是幂等的（判据见 `looksContaminated`），跑几次都不会误伤。
	 *
	 * 这一路只扫得到**已经活着**的会话。所以另外还有两道网：
	 *   · `GET /seats`（用户一点开那个对话就修；打开有唤醒延迟、GET 会抢跑，
	 *     所以还会自动排几枪迟到补扫，见 `scheduleHealRetry`）；
	 *   · `agent/pre-step`（用户再发言时、请求发出前修）—— 这一道最可靠，
	 *     历史脏会话不一定还会被点开，但只要再发言就一定会经过它。
	 */
	const healTimers = [];
	for (const delay of [1500, 8000]) {
		try {
			const timer = setTimeout(() => {
				try {
					healStaleSessions(`启动自愈 +${delay}ms`);
				} catch (error) {
					log('启动自愈失败（不影响使用）', error);
				}
			}, delay);
			if (typeof timer?.unref === 'function') timer.unref();
			healTimers.push(timer);
		} catch (error) {
			/* 忽略 */
		}
	}
	ctx.effect(() => () => {
		for (const timer of healTimers) {
			try {
				clearTimeout(timer);
			} catch (error) {
				/* 忽略 */
			}
		}
	}, 'dsh-plan-exec-models: 启动自愈定时器清理');
}
