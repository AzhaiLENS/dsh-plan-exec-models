window.__ModuleLoader__.load({
	id: "dsh-plan-exec-models",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		/**
		 * react-dom 只用来把菜单 portal 到 document.body。
		 * 菜单此前内联渲染在输入区（conversation.input.right）里，会被那里的层叠上下文和
		 * 更上层的工作台面板（z-index 2147483000）盖住 —— 拥挤视图下"菜单显示不全/被遮挡"
		 * 的根因。拿不到 react-dom 时退回内联渲染（此时靠 CSS 里的同款 z-index 兜底）。
		 */
		let ReactDOM = null;
		try {
			ReactDOM = require("react-dom");
		} catch (error) {
			ReactDOM = null;
		}

		/**
		 * 激活门控只保留始终存在的服务；模型目录（modelDirectories）由
		 * @deepseek-ai/dsh-client-ui-model-selection 提供，可能晚于本插件就绪，
		 * 因此放到 apply 内部再 inject（与官方 model-selection 同一模式），
		 * 避免整个插件被挂起。
		 */
		const inject = ["slots", "sessions", "remote", "remote.session"];

		/** 两个选择席：主管在前、员工在后（顺序即界面顺序）。 */
		const SEATS = [
			{
				key: "plan",
				label: "主管",
				title: "选择主管模型",
				hint: "主管：拆解用户目标、给出执行方法 SOP 与验收标准，交给员工落地；员工求援或连续不合格时下场救火；最后负责验收"
			},
			{
				key: "exec",
				label: "员工",
				title: "选择员工模型",
				hint: "员工：按主管给的方法落地，遇阻先自己想办法（最多 2 次），实在不行才带着结构化报告向主管求援"
			}
		];

		/**
		 * 阶段元数据：主管的四种子阶段配色/文案。
		 * 与 Host 侧 lib/index.js 的 PHASE_LABEL 保持同一套说法。
		 */
		const PHASE_META = {
			initial: { role: "is-plan", label: "主管规划" },
			plan: { role: "is-plan", label: "主管规划" },
			replan: { role: "is-replan", label: "主管介入" },
			verify: { role: "is-verify", label: "主管验收" },
			exec: { role: "is-exec", label: "员工执行" },
			done: { role: "is-exec", label: "已收尾" }
		};

		/** 编排参数的取值范围（与 Host 侧 clamp 保持一致）。 */
		const PARAM_RANGE = {
			maxRounds: [1, 10],
			maxRetries: [1, 5]
		};

		/** 两个预设的本地存储键。 */
		const PRESET_KEY = "dsh-plan-exec-models.presets.v1";

		/** 目录尚未加载时的空快照（保持同一引用，供 useSyncExternalStore 使用）。 */
		const EMPTY_STATE = { current: null, routable: null, groups: [], failures: [] };
		const EMPTY_STORE = {
			subscribe: () => () => {},
			getSnapshot: () => EMPTY_STATE
		};

		/**
		 * 官方模型席（@deepseek-ai/dsh-client-ui-model-selection）CSS Modules 前缀的兜底值。
		 * 正常路径是运行时从样式表里现查（见 officialSeatPrefix），这里只在前缀查不到时保底。
		 */
		const OFFICIAL_SEAT_FALLBACK_PREFIX = "_7KE1Ra";

		function log(message, detail) {
			try {
				if (detail === void 0) console.log("[dsh-plan-exec-models] " + message);
				else console.log("[dsh-plan-exec-models] " + message, detail);
			} catch (error) {
				/* 控制台不可用时忽略 */
			}
		}

		function readPresets() {
			try {
				const raw = window.localStorage.getItem(PRESET_KEY);
				if (raw === null) return {};
				const parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" ? parsed : {};
			} catch (error) {
				return {};
			}
		}

		function writePresets(presets) {
			try {
				window.localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
			} catch (error) {
				// 本地存储不可用时静默降级：预设只在本次页面生命期内有效。
			}
		}

		/**
		 * 席位取值「跟随默认」：该阶段不干预，直接用官方「默认」席选中的模型。
		 * 与 Host 侧 lib/index.js 里的 FOLLOW_DEFAULT 必须保持一致。
		 */
		const FOLLOW_DEFAULT = "__default__";

		/** Host 侧席位接口；Host 需要它才能做自动编排（浏览器存储它读不到）。 */
		const SEATS_ENDPOINT = "/dsh-plan-exec-models/api/seats";
		const STATE_ENDPOINT = "/dsh-plan-exec-models/api/state";

		/** 把一个席位预设翻译成 { provider, model, effort }，供 Host 存储。 */
		function presetToSeat(prefix, preset) {
			const seat = { [prefix + "Provider"]: "", [prefix + "Model"]: "", [prefix + "Effort"]: "" };
			if (preset === null || preset === void 0) return seat;
			if (preset.model === FOLLOW_DEFAULT) {
				seat[prefix + "Model"] = FOLLOW_DEFAULT;
				return seat;
			}
			seat[prefix + "Provider"] = typeof preset.provider === "string" ? preset.provider : "";
			seat[prefix + "Model"] = typeof preset.model === "string" ? preset.model : "";
			seat[prefix + "Effort"] = typeof preset.reasoningEffort === "string" ? preset.reasoningEffort : "";
			return seat;
		}

		/** 把 Host 的席位字段还原成席位预设。 */
		function seatToPreset(state, prefix) {
			if (state === null || state === void 0) return void 0;
			const model = typeof state[prefix + "Model"] === "string" ? state[prefix + "Model"].trim() : "";
			if (model === "") return void 0;
			if (model === FOLLOW_DEFAULT) return { provider: "", model: FOLLOW_DEFAULT };
			const provider = typeof state[prefix + "Provider"] === "string" ? state[prefix + "Provider"].trim() : "";
			if (provider === "") return void 0;
			const effort = typeof state[prefix + "Effort"] === "string" ? state[prefix + "Effort"].trim() : "";
			return effort === "" ? { provider, model } : { provider, model, reasoningEffort: effort };
		}

		/**
		 * 给席位接口拼上会话 id。
		 *
		 * Host 侧是**按对话**记账的（`~/.dsh/dsh-plan-exec-models/sessions.json`）：
		 * 不带 sessionId 就会被当成"没有会话"，读到的只是全局种子、写进去也不落在本对话头上，
		 * 界面就会出现"在 A 对话开的开关跑到 B 对话去了"。所以这两个请求必须带会话 id。
		 */
		function withSession(url, sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") return url;
			return url + "?sessionId=" + encodeURIComponent(sessionId);
		}

		/** 请求 Host 的席位配置；失败返回 null（Host 不在也不该影响席位可用性）。 */
		function fetchHostSeats(sessionId) {
			return fetch(withSession(SEATS_ENDPOINT, sessionId), { credentials: "same-origin" })
				.then((response) => (response.ok ? response.json() : null))
				.then((snapshot) => {
					setStepSeatInfo(snapshot);
					return snapshot;
				})
				.catch(() => null);
		}

		/**
		 * 把席位配置推给 Host，并返回 Host 的快照。
		 *
		 * 拿到快照后必须**顺手喂给 `setStepSeatInfo`** —— 用户关掉双模型走的就是这条路，
		 * 而阶段徽标读的是 `stepSeatInfo`（模块级单例）。以前只有"拉取"两条路会更新它，
		 * 于是"关闭"这个动作对它不可见：`orchestrating` 一直停在 true，第 1 步的
		 * 「主管规划 · 主管模型」徽标就被一路留着，用户看到的是"关掉了却还挂着 doubao"。
		 */
		function pushHostSeats(presets, extra, sessionId) {
			const body = Object.assign(
				{},
				presetToSeat("plan", presets.plan),
				presetToSeat("exec", presets.exec),
				extra !== void 0 ? extra : {}
			);
			return fetch(withSession(SEATS_ENDPOINT, sessionId), {
				method: "PUT",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			})
				.then((response) => (response.ok ? response.json() : null))
				.then((snapshot) => {
					setStepSeatInfo(snapshot);
					return snapshot;
				})
				.catch(() => null);
		}

		/** 查询 Host 的编排状态（当前哪一步、用哪个模型）。 */
		function fetchHostState(sessionId) {
			const url = STATE_ENDPOINT + (sessionId === void 0 ? "" : "?sessionId=" + encodeURIComponent(String(sessionId)));
			return fetch(url, { credentials: "same-origin" })
				.then((response) => (response.ok ? response.json() : null))
				.then((snapshot) => {
					setStepSeatInfo(snapshot);
					return snapshot;
				})
				.catch(() => null);
		}

		/* ------------------------------------------------------------------
		 * A：对话里"这一步是哪个模型在操作"的阶段徽标
		 *
		 * 为什么走 DOM 而不是插槽：官方把每一步的助手节点注册在 conversation.chat.node
		 * 的 assistant-step 这个 keyed 槽位上，而该槽位是"同名即顶替"的
		 * （shadows-shipped-ui）——注册同名 key 会把 AssistantNodeView 整个替换掉，
		 * 一旦 props 对不上，整个对话就白屏。这里改成"只往官方节点里追加一个自己的小标签、
		 * 永不删除官方节点"，所以不可能把对话渲染弄坏。
		 * ------------------------------------------------------------------ */

		/** 最近一次从 Host 拿到的编排信息，供阶段徽标使用。 */
		const stepSeatInfo = {
			known: false,
			orchestrating: false,
			plan: null,
			exec: null,
			/** "turn:step" → {phase, reason, model}：Host 记录的真实阶段。 */
			phases: {},
			/**
			 * Host 报的"此刻正在跑的那一步"：{phase, provider, model, step, turn, at}。
			 * 用于给"当前正在编排的那个回合"贴兜底徽标 —— 见 `stepBadgeFor`。
			 */
			active: null,
			/**
			 * 这份快照属于哪个会话。
			 *
			 * 这个插件有**两种**状态源：React 里的 `host`（全局体，随会话切换重新拉取）
			 * 和这个模块级的 `stepSeatInfo`（单例，被所有会话共享）。两者不一定同步 ——
			 * 所以贴徽标前必须确认"手里的快照就是眼前这个会话的"，否则会把 A 会话的阶段
			 * 贴到 B 会话的消息上。`document.body.dataset.pemSession` 是插件自己写的
			 * "眼前这个框属于哪个会话"，直接拿它比对。
			 */
			sessionId: null
		};
		let badgeObserver = null;
		let badgeTimer = null;

		/** 从 Host 快照里抽出阶段徽标需要的信息；拿不到编排字段就保持原样。 */
		function setStepSeatInfo(snapshot) {
			if (snapshot === null || typeof snapshot !== "object") return;
			if (snapshot.orchestrating === void 0) return;
			const resolved = snapshot.resolved ?? {};
			stepSeatInfo.known = true;
			stepSeatInfo.orchestrating = snapshot.orchestrating === true;
			stepSeatInfo.plan = typeof resolved.plan?.model === "string" && resolved.plan.model !== "" ? resolved.plan.model : null;
			stepSeatInfo.exec = typeof resolved.exec?.model === "string" && resolved.exec.model !== "" ? resolved.exec.model : null;
			stepSeatInfo.phases = snapshot.phases !== null && typeof snapshot.phases === "object" && snapshot.phases !== void 0
				? snapshot.phases
				: {};
			stepSeatInfo.active = snapshot.active !== null && typeof snapshot.active === "object" ? snapshot.active : null;
			stepSeatInfo.sessionId = typeof snapshot.session === "string" && snapshot.session !== "" ? snapshot.session : null;
			scheduleBadgeRefresh();
		}

		/** 从节点上读"这是本回合的第几步"。读不出、或与回合号对不上，就退回同回合内的出现次序。 */
		function stepNumberOf(element, turn, fallback) {
			const anchor = element.getAttribute("data-chat-anchor-key") ?? "";
			const matched = /^(\d+):(\d+)$/.exec(anchor);
			if (matched !== null && (turn === "" || matched[1] === turn)) {
				const value = Number(matched[2]);
				if (Number.isFinite(value) && value > 0) return value;
			}
			return fallback;
		}

		/**
		 * 眼前的这一帧对话，是不是就是快照所属的那个会话。
		 *
		 * `stepSeatInfo` 是模块级单例、被所有会话共用，而 React 侧切会话时它是**不会**
		 * 被清掉的。所以贴徽标前必须先确认身份，否则就会出现"在 B 会话里看到 A 会话的
		 * 主管模型徽标"这种串台。拿不到任一侧的信息时保守放行（老版本 Host 不返回
		 * `session` 字段，不能因此把徽标功能整个关掉）。
		 */
		function sameSessionAsSnapshot() {
			if (stepSeatInfo.sessionId === null) return true;
			if (typeof document === "undefined") return true;
			const onScreen = document.body?.dataset?.pemSession ?? "";
			if (onScreen === "") return true;
			return onScreen === stepSeatInfo.sessionId;
		}

		/**
		 * 第 turn 回合第 step 步由哪一席负责、处于哪个子阶段。
		 *
		 * 优先用 Host 汇报的**真实阶段**（`phases` 映射）—— 因为编排是事件驱动的，
		 * 「规划在第几步」不再是个固定值，客户端自己算不出来。
		 *
		 * 没有记录时才退到"每回合第 1 步一定是主管"这条**兜底**，而且必须同时满足：
		 *   · 这一步所属的回合，正是 Host 此刻在编排的那个回合（`active.turn` 对得上）。
		 * 为什么兜底要卡这么死：兜底曾经只看 `orchestrating`，于是任何回合的第 1 步都会
		 * 被贴上「主管规划 · 主管模型」—— 包括**编排开始之前的历史回合**，以及
		 * **关掉双模型之后**（快照还没刷新到 off 的那一小段时间）。用户看到的正是
		 * "都切成单模型了，怎么还写着 doubao-seed-evolving"。宁可不标，也不乱标。
		 */
		function stepBadgeFor(step, turn) {
			if (!stepSeatInfo.known || stepSeatInfo.orchestrating !== true) return null;
			if (stepSeatInfo.plan === null || stepSeatInfo.exec === null) return null;
			if (!sameSessionAsSnapshot()) return null;
			const recorded = turn === "" ? void 0 : stepSeatInfo.phases[turn + ":" + step];
			if (recorded !== void 0 && recorded !== null) {
				// reason 更细（初始规划/救火用同一套渲染），phase 兜底，都没有就按员工算。
				const meta = PHASE_META[recorded.reason] ?? PHASE_META[recorded.phase] ?? PHASE_META.exec;
				const model = typeof recorded.model === "string" && recorded.model !== ""
					? recorded.model
					: (meta === PHASE_META.exec ? stepSeatInfo.exec : stepSeatInfo.plan);
				return { role: meta.role, text: meta.label + " · " + model };
			}
			if (step === 1 && isOrchestratingTurn(turn)) {
				return {
					role: PHASE_META.plan.role,
					text: PHASE_META.plan.label + " · " + stepSeatInfo.plan
				};
			}
			return null;
		}

		/**
		 * 这个回合是不是"Host 此刻正在编排的那一个"。
		 *
		 * `active` 是 Host 每走一步都会刷新的现场（{phase, model, step, turn, at}），
		 * 所以拿它的回合号跟 DOM 上的回合号比即可。历史回合对不上 → 不兜底；
		 * 编排结束后 `active` 停留在最后一次编排的回合上 → 那个回合照旧保留徽标，
		 * 其余回合不受影响。
		 */
		function isOrchestratingTurn(turn) {
			const active = stepSeatInfo.active;
			if (active === null || active === void 0) return false;
			if (typeof turn !== "string" || turn === "") return false;
			const activeTurn = active.turn;
			if (activeTurn === null || activeTurn === void 0) return false;
			return String(activeTurn) === turn;
		}

		/** 给每一步的助手节点贴/更新/摘掉阶段徽标。幂等，随时可重复调用。 */
		function refreshStepBadges() {
			if (typeof document === "undefined") return;
			let nodes;
			try {
				nodes = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]');
			} catch (error) {
				return;
			}
			let seen = 0;
			let turn = null;
			for (const element of nodes) {
				const currentTurn = element.getAttribute("data-chat-turn") ?? "";
				if (currentTurn !== turn) {
					turn = currentTurn;
					seen = 0;
				}
				seen += 1;
				const wanted = stepBadgeFor(stepNumberOf(element, currentTurn, seen), currentTurn);
				let badge = element.querySelector(":scope > .pem-stepbadge");
				if (wanted === null) {
					if (badge !== null) badge.remove();
					continue;
				}
				if (badge === null) {
					badge = document.createElement("div");
					badge.className = "pem-stepbadge";
					element.insertBefore(badge, element.firstChild);
				}
				if (badge.textContent !== wanted.text) badge.textContent = wanted.text;
				if (!badge.classList.contains(wanted.role)) {
					badge.classList.remove("is-plan", "is-replan", "is-verify", "is-exec");
					badge.classList.add(wanted.role);
				}
			}
		}

		/** 合并短时间内的多次 DOM 变动，避免流式输出时反复重排。 */
		function scheduleBadgeRefresh() {
			if (typeof window === "undefined") return;
			if (badgeTimer !== null) return;
			badgeTimer = window.setTimeout(() => {
				badgeTimer = null;
				refreshStepBadges();
			}, 120);
		}

		/** 挂上观察器：对话是流式渲染的，新节点出现或重渲染时把徽标补回去。 */
		function installStepBadges() {
			if (typeof document === "undefined" || typeof MutationObserver !== "function") return;
			if (badgeObserver !== null) return;
			const root = document.querySelector("[data-conversation-scroll]") ?? document.body;
			if (root === null || root === void 0) {
				// 插件可能在 DOM 就绪前加载：稍后重试，别把徽标永久丢掉。
				window.setTimeout(() => installStepBadges(), 300);
				return;
			}
			badgeObserver = new MutationObserver(() => scheduleBadgeRefresh());
			badgeObserver.observe(root, { childList: true, subtree: true });
			refreshStepBadges();
		}

		function sameModel(left, right) {
			return left !== null && left !== void 0 && right !== null && right !== void 0
				&& left.provider === right.provider && left.model === right.model;
		}

		/** 在目录快照里定位一个模型条目。 */
		function findModel(state, providerId, modelId) {
			const groups = Array.isArray(state && state.groups) ? state.groups : [];
			for (const group of groups) {
				const models = Array.isArray(group.models) ? group.models : [];
				for (const model of models) {
					if (group.id === providerId && model.id === modelId) return { group, model };
				}
			}
			return null;
		}

		/** 思考档位由低到高；off 的语义是"不思考"，不算思考档。 */
		const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

		/**
		 * 每个席位自动采用的思考档位（v6.4 起的选择模型即自动匹配档位）：
		 * 主管 = 最高档（拆解/救火/验收都要最强推理），员工 = 中间档（落地执行够用且省钱）。
		 * 与 Host 侧 settings.yaml 的 planEffort/execEffort 默认值一致。
		 */
		const SEAT_EFFORT = { plan: "max", exec: "medium" };

		/**
		 * 把一个"语义档位"（max / medium）落到某模型**真正声明的**档位上。
		 * 与 Host 侧 `snapEffort` 完全同一套语义（幂等，Host 再 snap 一次也不会变）：
		 *   max → 最高档；medium → 正中间档（length-1 的中点，向下取整）；
		 * 模型没声明档位元数据 → undefined（交给模型自己的默认档）。
		 * @param reasoning - 模型目录里的 reasoning 元数据。
		 * @param requested - 语义档位（"max" / "medium" / 具体档位名）。
		 */
		function snapEffortFor(reasoning, requested) {
			if (reasoning === null || reasoning === void 0) return void 0;
			const levels = Array.isArray(reasoning.efforts) ? reasoning.efforts.map((level) => String(level.id)) : [];
			if (levels.length === 0) return void 0;
			if (levels.includes(requested)) return requested;
			const thinking = levels
				.filter((level) => level !== "off" && EFFORT_ORDER.includes(level))
				.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
			if (thinking.length === 0) return void 0;
			if (requested === "max") return thinking[thinking.length - 1];
			if (requested === "medium" || requested === "mid") {
				return thinking[Math.floor((thinking.length - 1) / 2)];
			}
			const want = EFFORT_ORDER.indexOf(requested);
			if (want < 0) return void 0;
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

		/** 档位 id → 可读名（列表里显示"主管/员工将自动采用的档位"用）。 */
		function effortNameOfLevel(reasoning, level) {
			if (reasoning === null || reasoning === void 0 || level === void 0) return null;
			const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
			for (const item of efforts) {
				if (String(item.id) === String(level)) return item.name !== void 0 ? item.name : String(item.id);
			}
			return String(level);
		}

		/** 把一个模型的 reasoning 元数据摊平成可选推理等级（含"提供方默认"）。 */
		function effortChoicesOf(reasoning) {
			if (reasoning === null || reasoning === void 0) return [];
			const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
			const choices = [];
			if (reasoning.defaultEffort === void 0) {
				choices.push({ key: "provider-default", effort: void 0, label: "提供方默认" });
			}
			for (const level of efforts) {
				choices.push({
					key: "effort:" + String(level.id),
					effort: level.id,
					label: level.name !== void 0 ? level.name : String(level.id)
				});
			}
			return choices;
		}

		/** 读取某模型在一个选择快照上实际生效的推理等级名（无推理元数据时返回 null）。 */
		function effortLabelOf(state, selection) {
			if (selection === null || selection === void 0) return null;
			const found = findModel(state, selection.provider, selection.model);
			if (found === null) return null;
			const reasoning = found.model.reasoning;
			if (reasoning === null || reasoning === void 0) return null;
			const active = selection.reasoningEffort !== void 0 ? selection.reasoningEffort : reasoning.defaultEffort;
			if (active === void 0) return "默认";
			const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
			for (const level of efforts) {
				if (level.id === active) return level.name !== void 0 ? level.name : String(active);
			}
			return String(active);
		}

		/** 把预设还原成可读的模型名（目录里找不到时退回模型 id）。 */
		function modelNameOf(state, selection) {
			if (selection === null || selection === void 0) return null;
			const found = findModel(state, selection.provider, selection.model);
			if (found === null) return selection.model;
			return found.model.name !== void 0 ? found.model.name : found.model.id;
		}

		/** 组装 select() 所需的选择快照：显式等级优先，其次该模型的默认等级。 */
		function selectionOf(state, providerId, modelId, effort) {
			const base = { provider: providerId, model: modelId };
			if (effort !== void 0) return Object.assign({}, base, { reasoningEffort: effort });
			const found = findModel(state, providerId, modelId);
			const reasoning = found === null ? null : found.model.reasoning;
			if (reasoning !== null && reasoning !== void 0 && reasoning.defaultEffort !== void 0) {
				return Object.assign({}, base, { reasoningEffort: reasoning.defaultEffort });
			}
			return base;
		}

		const CSS = `
.pem-root{display:flex;align-items:center;gap:6px;min-width:0}
.pem-seat{position:relative;display:inline-flex;align-items:center;gap:6px;height:28px;max-width:224px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary,#9a9aa2);font-size:12px;font-weight:500;line-height:20px;cursor:pointer;white-space:nowrap;transition:background .16s ease,border-color .16s ease,color .16s ease,box-shadow .16s ease}
.pem-seat:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.46))}
.pem-seat[data-open="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.pem-seat.is-match{color:var(--dsw-alias-label-primary,#eaeaea)}
.pem-seat.is-running{cursor:pointer}
/* 输入框下方席位徽标的配色：这里不写死任何色值，只消费 --pem-ink / --pem-tint。
   色板在下方 .pem-stepbadge 那一节统一定义一次，两个徽标共用，
   所以同一个标注（如「主管验收」）在两处必然是同一个颜色。 */
.pem-seat.is-running.is-plan,.pem-seat.is-running.is-replan,.pem-seat.is-running.is-verify,.pem-seat.is-running.is-exec{color:var(--pem-ink,#B49BFF);border-color:color-mix(in srgb,var(--pem-tint,#8B5CF6) 72%,transparent);background:color-mix(in srgb,var(--pem-tint,#8B5CF6) 16%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--pem-tint,#8B5CF6) 34%,transparent),0 0 14px color-mix(in srgb,var(--pem-tint,#8B5CF6) 20%,transparent)}
.pem-seat.is-running:hover{filter:brightness(1.08)}
.pem-dot{flex:none;width:6px;height:6px;border-radius:999px;background:currentColor;box-shadow:0 0 7px currentColor;animation:pem-breathe 1.4s ease-in-out infinite}
@keyframes pem-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.28;transform:scale(.6)}}
.pem-seat-tag{flex:none;font-size:11px;font-weight:600;letter-spacing:.02em;opacity:.78}
.pem-seat.is-running .pem-seat-tag{opacity:1}
.pem-seat-value{min-width:0;overflow:hidden;text-overflow:ellipsis}
.pem-seat-effort{flex:none;font-size:11px;opacity:.62}
.pem-seat-round{flex:none;margin-left:1px;padding:0 5px;border-radius:6px;background:rgba(128,128,128,.22);font-size:10px;line-height:15px;opacity:.92}
/* 双模型框的三种状态：关着（压暗）/ 开着但两席没选全（琥珀警示）/ 已接管（正常亮度）。 */
.pem-seat.is-off{opacity:.74}
.pem-seat.is-warn{color:#F0B429;border-color:rgba(240,180,41,.6);background:color-mix(in srgb,#F0B429 12%,transparent)}
.pem-seat.is-warn .pem-seat-value{opacity:1}
.pem-menu{position:fixed;z-index:2147483200;display:flex;flex-direction:column;box-sizing:border-box;min-width:0;max-width:min(392px,92vw);max-height:min(420px,66vh);overflow-y:auto;overscroll-behavior:contain;padding:6px;border-radius:18px;background:var(--dsw-specific-menu,#23232a);color:var(--dsw-alias-label-primary,#eaeaea);box-shadow:var(--dsw-elevation-prominent,0 10px 30px rgba(0,0,0,.42))}
.pem-menu-title{padding:6px 10px 4px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}
.pem-group{padding:2px 0}
.pem-group-title{padding:6px 10px 2px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}
.pem-option{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:10px;background:0 0;color:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.pem-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.pem-option-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pem-option-value{flex:none;max-width:196px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#9a9aa2);font-size:12px}
.pem-badge{flex:none;padding:0 6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:999px;color:var(--dsw-alias-label-tertiary,#999);font-size:10px;line-height:16px}
.pem-badge.is-current{color:#B49BFF;border-color:currentColor}
.pem-check{flex:none;color:var(--dsw-alias-button-primary-fill,#5AA7F2);font-size:12px}
.pem-back{display:flex;align-items:center;gap:4px;width:100%;padding:6px 10px;border:0;border-radius:10px;background:0 0;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;text-align:left;cursor:pointer}
.pem-back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.pem-empty,.pem-failure{padding:8px 10px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.pem-status{display:flex;align-items:center;gap:8px;width:100%;margin:0;padding:6px 10px;border:0;border-radius:10px;background:0 0;color:var(--dsw-alias-label-tertiary,#888);text-align:left;cursor:pointer;font:inherit;font-size:11px;line-height:16px}
.pem-status:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.pem-status.is-on{color:#4ADEA6}
.pem-status-flag{flex:none;margin-left:auto;min-width:18px;padding:0 5px;border-radius:8px;background:var(--dsw-alias-border-l2,rgba(128,128,128,.3));color:var(--dsw-alias-label-secondary,#999);font-size:10px;line-height:16px;text-align:center}
.pem-status.is-on .pem-status-flag{background:color-mix(in srgb,#10B981 26%,transparent);color:#4ADEA6}
.pem-status-note{flex:none;margin-left:2px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}
.pem-status.is-on .pem-status-note{color:#4ADEA6}
.pem-hint{padding:2px 10px 8px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;line-height:17px;white-space:normal}
.pem-hint.is-warn{color:#F0B429}
.pem-params{display:flex;flex-direction:column;gap:1px;margin:2px 0 6px;padding:4px 0 6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16))}
.pem-param{display:flex;align-items:center;gap:8px;width:100%;padding:5px 10px;border:0;border-radius:10px;background:0 0;color:var(--dsw-alias-label-secondary,#9a9aa2);font:inherit;font-size:12px;line-height:18px;text-align:left}
.pem-param-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pem-param-value{flex:none;color:var(--dsw-alias-label-primary,#eaeaea);font-variant-numeric:tabular-nums}
.pem-stepper{flex:none;display:flex;align-items:center;gap:2px}
.pem-step{width:20px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary,#999);font-size:12px;line-height:18px;text-align:center;cursor:pointer}
.pem-step:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#eaeaea)}
.pem-step:disabled{opacity:.34;cursor:default}
.pem-mismatch{flex:none;height:20px;padding:0 8px;border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:999px;color:var(--dsw-alias-label-caption,#888);font-size:10px;line-height:18px;white-space:nowrap}
.pem-warn{flex:none;width:18px;height:18px;border-radius:999px;background:#E0A020;color:#1a1a1a;font-size:11px;font-weight:700;line-height:18px;text-align:center;cursor:help}
.pem-notice{flex:none;max-width:280px;height:22px;padding:0 9px;border-radius:999px;background:rgba(224,64,64,.16);color:#E06060;font-size:11px;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pem-stepbadge{display:block;width:max-content;max-width:100%;margin:2px 0 6px;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:18px;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;user-select:none;opacity:.94;color:var(--pem-ink,#B49BFF);background:color-mix(in srgb,var(--pem-tint,#8B5CF6) 16%,transparent)}
/* ⭐ 相位色板：全插件唯一定义处。
   对话记录里的步骤徽标（.pem-stepbadge）与输入框下方的席位徽标（.pem-seat）
   共同消费这四个变量 —— 同一个标注（如「主管验收」）两处必然同色。
   要调色只改这里；不要再往上面两条规则里写十六进制色值。 */
.pem-stepbadge.is-plan,.pem-seat.is-running.is-plan{--pem-ink:#B49BFF;--pem-tint:#8B5CF6}
.pem-stepbadge.is-replan,.pem-seat.is-running.is-replan{--pem-ink:#F0B429;--pem-tint:#F0B429}
.pem-stepbadge.is-verify,.pem-seat.is-running.is-verify{--pem-ink:#6CB2FF;--pem-tint:#3B82F6}
.pem-stepbadge.is-exec,.pem-seat.is-running.is-exec{--pem-ink:#4ADEA6;--pem-tint:#10B981}
`;

		function installStyles() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-plan-exec-models/styles";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plan-exec-models";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * 反查官方模型选择席（@deepseek-ai/dsh-client-ui-model-selection）的 CSS Modules 哈希前缀。
		 * 该类名前缀带内容哈希，dsh 升级后可能变化，所以运行时从已注入的样式表里现查，不写死。
		 * @returns 形如 "_7KE1Ra" 的前缀；尚未注入时返回 null。
		 */
		function officialSeatPrefix() {
			if (typeof document === "undefined") return null;
			const tags = document.querySelectorAll("style");
			for (const tag of tags) {
				const css = tag.textContent;
				if (typeof css !== "string" || css.indexOf("_triggerEffort") === -1) continue;
				const matched = css.match(/\.([A-Za-z0-9_-]+)_triggerEffort\b/);
				if (matched !== null) return matched[1];
			}
			return null;
		}

		/**
		 * 给官方模型选择席穿上「单模型」的外衣，并让它随总开关让位。
		 *
		 * 官方席仍由官方组件渲染，本插件**只加一条 ::before 标签**、并按 `body[data-pem-dual]`
		 * 切换两种外观：
		 *   双模型关着 → 「单模型 + 当前模型名」，完全可用（此时它是唯一的选模型入口）；
		 *   双模型开着 → 「单模型 · 已让位」，压暗 + 禁点（编排期间模型由两席决定，选它不生效）。
		 *
		 * 注意：只"装扮"不卸载 —— 官方席继续提供 modelDirectories 服务、继续 load()，
		 * 所以本插件的模型目录与官方菜单都不受影响。想彻底隐藏整席，把下面几条换成
		 * `.${prefix}_root{display:none!important}` 即可。
		 * @param prefix - 官方席的 CSS Modules 前缀；由 officialSeatPrefix() 现查得到。
		 */
		function installOfficialSeatCompact(prefix) {
			if (typeof document === "undefined" || prefix === null) return false;
			const tagId = "dsh-plan-exec-models/official-seat-compact";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return true;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plan-exec-models";
			tag.dataset.pluginCss = tagId;
			tag.textContent = `
/* 推理等级文字省掉，腾地方给「单模型」标签 */
.${prefix}_triggerEffort{display:none!important}
.${prefix}_trigger::before{content:"单模型";font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#999)}
/* 总开关打开 → 让位：压暗、禁点、名字换成「已让位」（模型由主管/员工两席决定） */
body[data-pem-dual="on"] .${prefix}_trigger{opacity:.4;filter:grayscale(1);pointer-events:none}
body[data-pem-dual="on"] .${prefix}_triggerLabel{display:none!important}
body[data-pem-dual="on"] .${prefix}_trigger::before{content:"单模型 · 已让位"}
`;
			document.head.appendChild(tag);
			return true;
		}

		/**
		 * 官方样式表通常晚于本插件注入，且顺序不保证：先等它出现，查不到前缀就轮询重试；
		 * 约 6 秒仍未出现（例如 dsh 换了注入方式）才退回写死前缀兜底，避免 UI 直接失效。
		 */
		function watchOfficialSeat() {
			if (typeof document === "undefined") return;
			const RETRY_LIMIT = 20;
			let tries = 0;
			const attempt = () => {
				const discovered = officialSeatPrefix();
				if (discovered !== null) return installOfficialSeatCompact(discovered);
				tries += 1;
				if (tries < RETRY_LIMIT) return false;
				return installOfficialSeatCompact(OFFICIAL_SEAT_FALLBACK_PREFIX);
			};
			if (attempt()) return;
			const timer = setInterval(() => {
				if (attempt()) clearInterval(timer);
			}, 300);
		}

		/**
		 * 输入栏右下角的两个模型席：各自可选模型，并在该模型公布推理等级时继续选等级。
		 * @param props - 由 register 的 inject 面提供：{ available, sessionId, directory, load, select }。
		 * @returns 两个触发按钮、编排状态提示，以及打开时的共享菜单。
		 */
		function PlanExecSeats(props) {
			const directory = props.directory !== null && props.directory !== void 0 && typeof props.directory.subscribe === "function"
				? props.directory
				: EMPTY_STORE;
			const load = typeof props.load === "function" ? props.load : null;
			const select = typeof props.select === "function" ? props.select : null;
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : void 0;
			/**
			 * 本对话专属的席位读写 —— 所有席位请求都带上 sessionId。
			 *
			 * Host 靠 sessionId 把"这个对话用单模型还是双模型"分别记账；不带的话所有对话
			 * 共用一份全局配置，正是用户反馈的"在一个对话里开了双模型，别的对话也跟着开"。
			 * useCallback 是为了让下面的 effect 依赖数组干净：会话一变，函数引用跟着变。
			 */
			const pullSeats = React.useCallback(() => fetchHostSeats(sessionId), [sessionId]);
			const pushSeats = React.useCallback((next, extra) => pushHostSeats(next, extra, sessionId), [sessionId]);

			const state = React.useSyncExternalStore(
				React.useCallback((notify) => directory.subscribe(notify), [directory]),
				React.useCallback(() => directory.getSnapshot(), [directory])
			);
			// 这几个派生值必须放在所有 effect 之前：effect 的依赖数组是在渲染期求值的，
			// 放后面会踩 TDZ（Cannot access 'current' before initialization），整个组件会被 React 摘掉。
			const current = state !== null && state !== void 0 ? state.current : null;
			const groups = Array.isArray(state && state.groups) ? state.groups : [];
			const failures = Array.isArray(state && state.failures) ? state.failures : [];
			const [presets, setPresets] = React.useState(readPresets);
			const [menu, setMenu] = React.useState(null);
			const [host, setHost] = React.useState(null);
			/** Host 最近一次编排决策：{ phase, provider, model, step, at } —— 用来显示"现在哪一步、哪个模型在操作"。 */
			const [live, setLive] = React.useState(null);
			/** Host 的席位配置是否已经拉过一次（用于延后"默认采用上次模型"的播种）。 */
			const [hostLoaded, setHostLoaded] = React.useState(false);
			/** 播种只做一次，否则用户手动清空席位后会被反复填回来。 */
			const seededRef = React.useRef(false);
			const [notice, setNotice] = React.useState(null);
			const rootRef = React.useRef(null);
			/**
			 * 指针是否停在菜单上。
			 * 用来区分「菜单外的滚动」到底是用户真的去滚别处，还是菜单自己滚到底后
			 * 溢出的回声（惯性滚动 / 橡皮筋）。后者不能关菜单。
			 */
			const pointerInMenuRef = React.useRef(false);
			/** 提示自动消失的定时器；放 ref 里才能跨渲染取消上一次。 */
			const flashTimer = React.useRef(null);
			/**
			 * 单模型框（官方席）该不该让位。
			 * 判据刻意取**总开关本身**（不是 orchestrating）：用户的原话是"总开关开启的状态下，
			 * 官方模型入口不生效"。host 还没答上来时给 null —— 不做任何装扮，免得闪一下。
			 */
			const dualFlag = host === null || host === void 0 || host.seats === void 0
				? null
				: host.seats.enabled === true ? "on" : "off";

			React.useEffect(() => {
				if (typeof document === "undefined" || typeof sessionId !== "string" || sessionId === "") return void 0;
				// 排障用：把"眼前这个框属于哪个会话"写到 body 上。配合宿主侧的
				// sessions.json，一眼就能看出"这个对话的单双模型设定是它自己的、还是继承来的"。
				document.body.dataset.pemSession = sessionId;
				return () => {
					if (document.body.dataset.pemSession === sessionId) delete document.body.dataset.pemSession;
				};
			}, [sessionId]);

			React.useEffect(() => {
				if (typeof document === "undefined" || dualFlag === null) return void 0;
				document.body.dataset.pemDual = dualFlag;
				return () => {
					// 只在还是自己写的那份时才清掉，避免把别的实例/后续渲染的状态抹了。
					if (document.body.dataset.pemDual === dualFlag) delete document.body.dataset.pemDual;
				};
			}, [dualFlag]);

			React.useEffect(() => {
				if (load !== null) load();
			}, [load]);

			// 席位配置要和 Host 对齐：Host 要做自动编排，读不到浏览器的 localStorage。
			//
			// **Host 上这个对话的记录才是权威**（每个对话一份，见 sessions.json），
			// 浏览器里那份 localStorage 只是"Host 上还没有记录"时的兜底。
			// 以前是反过来的（本地优先 → 推给 Host），于是切到别的对话时会把上一个对话的
			// 选择推过去，看起来就像"单双模型设置是全局的"。
			React.useEffect(() => {
				let alive = true;
				pullSeats().then((snapshot) => {
					if (!alive) return;
					setHostLoaded(true);
					if (snapshot === null || snapshot.ok !== true) return;
					setHost(snapshot);
					const remote = snapshot.seats !== null && snapshot.seats !== void 0 ? snapshot.seats : {};
					const remotePlan = seatToPreset(remote, "plan");
					const remoteExec = seatToPreset(remote, "exec");
					if (remotePlan !== void 0 || remoteExec !== void 0) {
						const adopted = { plan: remotePlan, exec: remoteExec };
						setPresets(adopted);
						writePresets(adopted);
						return;
					}
					// Host 这边这个对话确实什么都没有（全新安装）→ 才把本地既有选择带过去。
					if (presets.plan === void 0 && presets.exec === void 0) return;
					pushSeats(presets).then((next) => {
						if (alive && next !== null) setHost(next);
					});
				});
				return () => {
					alive = false;
				};
				// 会话一变就按新会话的记录重新对齐一次；之后每次改动都走 commit 主动推送。
			}, [sessionId]);

			// 两席都还没设过时，默认采用"上一次调用的模型"—— 省得用户一上来面对两个「未设置」发呆。
			// 必须等 Host 那边先答完（可能本来就有配置），否则会盖掉 Host 的既有席位。
			React.useEffect(() => {
				if (!hostLoaded || seededRef.current) return;
				if (current === null || current === void 0) return;
				if (presets.plan !== void 0 || presets.exec !== void 0) return;
				seededRef.current = true;
				const seed = typeof current.reasoningEffort === "string" && current.reasoningEffort !== ""
					? { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort }
					: { provider: current.provider, model: current.model };
				const next = { plan: seed, exec: seed };
				setPresets(next);
				writePresets(next);
				pushSeats(next).then((snapshot) => {
					if (snapshot !== null) setHost(snapshot);
				});
			}, [hostLoaded, current, presets]);

			// 编排是 Host 侧做的，浏览器看不到；所以按 2 秒轮询一次 Host 的现场，
			// 让「当前正在跑的那一席」亮起来（不再额外挂一个"当前模型"的框）。页面不可见时不轮询。
			React.useEffect(() => {
				if (host === null || host.orchestrating !== true) {
					setLive(null);
					return void 0;
				}
				let alive = true;
				const tick = () => {
					if (document.visibilityState !== "visible") return;
					fetchHostState(sessionId).then((snapshot) => {
						if (!alive || snapshot === null) return;
						setHost(snapshot);
						const active = snapshot.active;
						// 超过 90 秒没动静就当作本轮已结束，别一直亮着。
						setLive(active !== null && active !== void 0 && Date.now() - active.at < 90000 ? active : null);
					});
				};
				tick();
				const timer = window.setInterval(tick, 2000);
				return () => {
					alive = false;
					window.clearInterval(timer);
				};
			}, [host === null ? null : host.orchestrating, sessionId]);

			// 目录为空时持续重试：新会话刚建立、首次加载失败都能自愈，不再永久停在"正在加载…"。
			React.useEffect(() => {
				if (load === null) return void 0;
				const snap = directory.getSnapshot();
				const empty = !Array.isArray(snap && snap.groups) || snap.groups.length === 0;
				if (!empty) return void 0;
				const timer = setInterval(() => load(), 1500);
				return () => clearInterval(timer);
			}, [load, directory, state]);

			React.useEffect(() => {
				if (menu === null) {
					// 菜单关掉了：清掉指针标记，下次打开是干净的。
					pointerInMenuRef.current = false;
					return void 0;
				}
				const root = rootRef.current;
				/**
				 * "算在本插件范围内"的两个区域：输入区的 .pem-root（席位框），
				 * 以及 portal 到 body 的 .pem-menu（菜单已不在 rootRef 的 DOM 子树里，
				 * 必须单独认，否则点菜单会被判成"点了外部"立刻收起）。
				 */
				const inRoot = (target) => (root !== null && target instanceof Node && root.contains(target))
					|| (target instanceof Node && typeof target.closest === "function" && target.closest(".pem-menu") !== null);
				// 记一下"最近一次滚轮是不是落在菜单上"。用来识别**滚动链**：
				// 菜单列表滚到底后，多余的滚动会传给下面的对话容器，于是 scroll 事件的
				// target 变成对话容器而不是菜单 —— 若直接关菜单，用户手感就是
				// "拉到最底再滚一下，菜单自己没了"。CSS 的 overscroll-behavior:contain
				// 已经在源头阻断，这段是给 WebKit 旧版本的兜底。
				let wheelInRootAt = 0;
				/**
				 * 滚轮是**意图**，scroll 是**回声**。
				 * 用户滚轮落在菜单外 → 他就是想滚别处 → 立刻收起（确定性，不依赖浏览器
				 * 怎么实现滚动链）。
				 * 落在菜单内 → 记一笔时间戳，让随后的 scroll 回声（惯性、橡皮筋、链式传递）
				 * 不至于把菜单关掉。
				 */
				const onWheel = (event) => {
					if (inRoot(event.target)) {
						wheelInRootAt = Date.now();
						return;
					}
					setMenu(null);
				};
				const onPointerDown = (event) => {
					if (inRoot(event.target)) return;
					setMenu(null);
				};
				// 兜底：滚动条拖动、程序化滚动这类没有 wheel 事件的路径。
				// 关键是**不能**把菜单自己滚到底之后的回声误判成"用户滚了别处"，两道护栏：
				//   ① 指针还在菜单上 —— 用户此刻的意图就是"在菜单里翻"；
				//   ② 刚在菜单上滚过 —— 兜住指针恰好移开一点点的那一瞬间。
				const onScroll = (event) => {
					if (inRoot(event.target)) return;
					if (pointerInMenuRef.current === true) return;
					if (Date.now() - wheelInRootAt < 600) return;
					setMenu(null);
				};
				const onResize = () => setMenu(null);
				const onKeyDown = (event) => {
					if (event.key === "Escape") setMenu(null);
				};
				document.addEventListener("wheel", onWheel, true);
				document.addEventListener("mousedown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				window.addEventListener("scroll", onScroll, true);
				window.addEventListener("resize", onResize);
				return () => {
					document.removeEventListener("wheel", onWheel, true);
					document.removeEventListener("mousedown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
					window.removeEventListener("scroll", onScroll, true);
					window.removeEventListener("resize", onResize);
				};
			}, [menu]);

			/**
			 * 打开某个席位的下拉菜单（v6.4 重写定位）。
			 *
			 * 三件事一起做对：
			 *   ① **宽度显式给死**（不再依赖内容自适应）——以前菜单只有 max/min-width、
			 *      没有 width，宽度是 shrink-to-fit：定位用的 right 偏移一大，
			 *      可用宽度就被挤压，菜单会"莫名变窄"（560px 档实测复现）。
			 *      现在按 min(340, 视口-留白) 定宽，并写进 style。
			 *   ② **水平位置夹在视口内**：优先右对齐席位，但左右都留 margin，
			 *      拥挤视图里也整块可见。
			 *   ③ **纵向按实测空间翻上/翻下**，并把 max-height 按可用空间给足。
			 *
			 * 菜单实际渲染在 document.body（portal，见下方 menuNode），
			 * 所以这里的视口坐标与 CSS 的 position:fixed 严格一致。
			 */
			const openMenu = (event) => {
				const rect = event.currentTarget.getBoundingClientRect();
				/** 离视口边缘留一点，免得菜单贴着边或压住输入框。 */
				const margin = 14;
				const gap = 8;
				const vw = window.innerWidth;
				const vh = window.innerHeight;
				/** 低于这个高度就翻到上面去（上方更宽裕才翻）。 */
				const MIN_ROOM = 260;
				/** 显式宽度：340 是设计宽，但不许超过视口（左右各留 margin）。 */
				const width = Math.round(Math.max(248, Math.min(340, vw - margin * 2)));
				const spaceBelow = vh - rect.bottom - gap - margin;
				const spaceAbove = rect.top - gap - margin;
				const flip = spaceBelow < MIN_ROOM && spaceAbove > spaceBelow;
				// 实际能用的高度：夹在 [160, 520] 之间；上下都紧张时也别给 0。
				const room = Math.max(160, Math.min(520, flip ? spaceAbove : spaceBelow));
				// 右对齐席位右边缘，再整体夹进视口。
				const left = Math.round(Math.max(margin, Math.min(rect.right - width, vw - width - margin)));
				const placement = { left, width, maxHeight: Math.round(room) };
				if (flip) placement.bottom = Math.max(gap, Math.round(vh - rect.top + gap));
				else placement.top = Math.round(rect.bottom + gap);
				// 只有这一个框了：菜单永远从「双模型工作」首页开（总开关 + 两席 + 两个旋钮）。
				setMenu({
					pane: "home",
					seat: null,
					target: null,
					placement
				});
			};

			/** 短暂提示（选失败、Host 不可达等），4 秒后自动消失。 */
			const flash = (text) => {
				setNotice(text);
				if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
				flashTimer.current = window.setTimeout(() => setNotice(null), 4000);
			};

			/**
			 * 提交一次选择。
			 * @param selection - 具体模型；传 null 表示「跟随默认」（不切本会话模型，只在编排里让位给官方默认席）。
			 */
			const commit = (key, selection) => {
				const next = Object.assign({}, presets);
				next[key] = selection === null ? { provider: "", model: FOLLOW_DEFAULT } : selection;
				setPresets(next);
				writePresets(next);
				// 选完回到「双模型工作」首页、菜单继续开着：用户挑完主管那一行，
				// 立刻就能看到"员工模型 未选择"和那句琥珀色提示，顺手接着挑第二个。
				// （关掉菜单的话，两席就得开两次菜单才能配齐。）
				setMenu((prev) => prev === null ? null : Object.assign({}, prev, { pane: "home", seat: null, target: null }));
				pushSeats(next).then((snapshot) => {
					if (snapshot === null) flash("编排配置同步到 Host 失败，自动编排可能不生效");
					else setHost(snapshot);
				});
				if (selection === null) return;
				if (select !== null) {
					select(selection).then((ok) => {
						if (ok === false) {
							log("切换被拒绝（该模型此刻不可路由）", selection);
							flash("切换失败：" + (modelNameOf(state, selection) || selection.model) + " 此刻不可用");
						}
					}).catch(() => {
						flash("切换失败：与本机服务通信中断");
					});
				}
			};

			/**
			 * 点模型：**直接提交**，思考档位按席位自动匹配 ——
			 * 主管 = 最高档、员工 = 中间档（见 SEAT_EFFORT / snapEffortFor）；
			 * 模型没声明档位就跟随模型自己的默认。
			 *
			 * v6.4 起不再强制进二级「推理等级」面板：用户反馈"选完模型还要再选档位，太繁琐"，
			 * 要求主管/员工的思考强度自动匹配、点一下模型就完成。
			 */
			const pickModel = (key, providerId, modelId) => {
				const found = findModel(state, providerId, modelId);
				const reasoning = found === null ? null : found.model.reasoning;
				const wanted = SEAT_EFFORT[key];
				const effort = wanted === void 0 ? void 0 : snapEffortFor(reasoning, wanted);
				commit(key, selectionOf(state, providerId, modelId, effort));
			};

			// 只有明确告知不可用（已寻址的 subagent 会话）才隐藏；其余情况照常渲染，便于排障。
			if (props.available === false) return null;

			/** 一个席位预设 → 可读模型名；没选、或旧的"跟随默认"都算"没选"（界面只认具体模型）。 */
			const seatNameOf = (preset) => {
				if (preset === void 0 || preset === null) return null;
				if (typeof preset.model !== "string" || preset.model === "" || preset.model === FOLLOW_DEFAULT) return null;
				return modelNameOf(state, preset) || preset.model;
			};

			const planName = seatNameOf(presets.plan);
			const execName = seatNameOf(presets.exec);
			/** 两席是否都选好了"具体模型"——只有这时 Host 才会接管编排。 */
			const concreteSeats = SEATS.filter((seat) => seatNameOf(presets[seat.key]) !== null);
			/** 当前会话实际在跑的模型对不上任何一席时，提示"未匹配"，避免用户以为插件失灵。 */
			const unmatched = current !== null && current !== void 0
				&& concreteSeats.length === 2
				&& !SEATS.some((seat) => sameModel(current, presets[seat.key]));

			/**
			 * Host 的三种形态（唯一真相来源，客户端不再自己拼）：
			 *   off     = 总开关关着，官方单模型生成；
			 *   waiting = 总开关开着但两席没选全，编排待命；
			 *   active  = 正在编排（主管 × 员工轮流接手）。
			 */
			const dualMode = host === null || host === void 0 || typeof host.mode !== "string" ? null : host.mode;
			const dualOn = dualMode !== null && dualMode !== "off";
			const dualReady = dualMode === "active";

			/**
			 * 此刻正在跑的那一席：直接用 Host 回报的阶段（不再是客户端猜）。
			 * 编排是模型驱动的："第几步归谁"是模型自己说出来的，客户端算不出来，只能由 Host 告诉前端。
			 *
			 * 主管席负责 plan / replan（下场救火）/ verify（验收）三种相位；员工席只负责 exec。
			 * 收尾（done）或插件没接管时不算"在跑" —— 亮错了比不亮更误导。
			 */
			const runningPhase = live === null || live === void 0
				? null
				: live.phase === "exec" ? "exec" : live.phase === "done" ? null : "plan";
			const runningMeta = live !== null && live !== void 0 ? (PHASE_META[live.reason] ?? PHASE_META[live.phase] ?? null) : null;
			const round = host !== null && host !== void 0 && host.turn !== null && host.turn !== void 0 ? host.turn.round : 1;
			/** 员工是否刚刚求援过 —— 主管介入时提示一下，让用户知道是谁喊的。 */
			// ⚠️ 必须声明在下面用到它的地方之前：JS 的 const 是 TDZ 的，
			// 声明在后面会让整个组件被 React 摘掉（框直接消失）。
			const escalated = host !== null && host !== void 0 && host.turn !== null && host.turn !== void 0 && host.turn.escalated === true;

			/* ------------------------------------------------------------------
			 * 唯一的「双模型」框
			 * 原来主管、员工各占一个框，用户看到的是两个开关、实际上只有一个是总开关，
			 * 于是"先关主管的、再关员工的"第二次点击把总开关又打开了 —— 这正是
			 * "明明关了却还在编排"的根因。现在两席收进同一个菜单，框只剩这一个。
			 * ------------------------------------------------------------------ */
			const runningModel = runningPhase === null ? null : runningPhase === "exec" ? execName : planName;
			const boxTag = runningPhase === null ? "双模型" : (runningMeta === null ? "编排中" : runningMeta.label);
			/**
			 * 配色用的相位类：与 boxTag **同源**（同一个 runningMeta），
			 * 所以输入框下方的席位徽标与对话记录里的步骤徽标对同一阶段给出同一种颜色。
			 * 这里曾经把所有非 exec 的阶段一律塌成 is-plan，于是同一个「主管验收」
			 * 在会话记录里是蓝色（is-verify）、在输入框下方却是紫色（is-plan）。
			 * 拿不到 runningMeta 时才退回老规则（exec 绿 / 其余紫）。
			 */
			const runningRole = runningPhase === null
				? null
				: runningMeta !== null
					? runningMeta.role
					: runningPhase === "exec" ? "is-exec" : "is-plan";
			const boxValue = runningPhase !== null
				? (runningModel ?? "…")
				: dualMode === null
					? "…"
					: dualMode === "off"
						? "未启用"
						: dualReady && planName !== null && execName !== null
							? planName + " × " + execName
							: "待设置";
			const boxTitle = runningPhase !== null
				? "正在运行：" + boxTag + " · " + boxValue
					+ (round > 1 ? "（第 " + String(round) + " 轮）" : "")
					+ (escalated ? " · 员工已向主管求援" : "")
				: dualMode === null
					? "正在读取双模型工作状态…"
					: dualMode === "off"
						? "双模型工作已关闭 —— 模型由右边「单模型」框决定。点开可以打开总开关、指定主管与员工模型。"
						: dualReady
							? "双模型工作已接管：主管 " + (planName ?? "?") + " 负责规划 / 救火 / 验收，员工 " + (execName ?? "?") + " 负责执行。点开可调整或关掉。"
							: "总开关已打开，但两席还没选全 —— 点开把主管模型和员工模型都选上，编排才会接管。";

			const dualBox = React.createElement("button", {
				type: "button",
				className: "pem-seat"
					+ (runningRole !== null ? " is-running " + runningRole : "")
					+ (dualReady && runningPhase === null ? " is-match" : "")
					+ (dualOn && !dualReady ? " is-warn" : "")
					+ (!dualOn ? " is-off" : ""),
				"data-open": menu !== null ? "true" : void 0,
				title: boxTitle,
				onClick: (event) => {
					if (menu !== null) {
						setMenu(null);
						return;
					}
					openMenu(event);
				}
			},
				runningPhase !== null ? React.createElement("span", { className: "pem-dot" }) : null,
				React.createElement("span", { className: "pem-seat-tag" }, boxTag),
				React.createElement("span", { className: "pem-seat-value" }, boxValue),
				runningPhase !== null && round > 1 ? React.createElement("span", { className: "pem-seat-round" }, "第" + String(round) + "轮") : null
			);

			/* ---- 菜单里的编排控制：一个总开关 + 两席模型 + 两个真正有意义的旋钮 ---- */
			/** 只剩两个旋钮：来回轮数上限、失败重试次数。步数安全阀已收进宿主内部常量。 */
			const paramValues = {
				maxRounds: host !== null && host !== void 0 && Number.isFinite(Number(host.maxRounds)) ? Math.trunc(Number(host.maxRounds)) : 3,
				maxRetries: host !== null && host !== void 0 && Number.isFinite(Number(host.maxRetries)) ? Math.trunc(Number(host.maxRetries)) : 2
			};

			/** 推配置给 Host；`override` 用于"本次连席位一起改"（开关要顺手补齐两席）。 */
			const push = (extra, failText, override) => {
				pushSeats(override !== void 0 ? override : presets, extra).then((snapshot) => {
					if (snapshot === null) flash(failText);
					else setHost(snapshot);
				});
			};

			/**
			 * 总开关。关掉 = **完全不接管**：不换模型、不注入指令、连选择都不碰，
			 * 行为与"没装这个插件"一致（官方单模型生成）。正在跑的会话会在关闭瞬间
			 * 由宿主把选择权交还官方（selection.current 清空），所以不用等下一回合才生效。
			 *
			 * 打开时顺手把没选过的席用"当前官方模型"补齐 —— 否则会出现"开关开了、
			 * 单模型框又让位了、两席还是空的"死角：那时候用户反而没地方选模型。
			 */
			const toggleOrchestration = () => {
				if (dualOn) {
					push({ enabled: false }, "关闭总开关失败");
					return;
				}
				const next = Object.assign({}, presets);
				let seeded = false;
				for (const seat of SEATS) {
					if (seatNameOf(next[seat.key]) !== null) continue;
					if (current === null || current === void 0) continue;
					next[seat.key] = typeof current.reasoningEffort === "string" && current.reasoningEffort !== ""
						? { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort }
						: { provider: current.provider, model: current.model };
					seeded = true;
				}
				if (seeded) {
					setPresets(next);
					writePresets(next);
				}
				push({ enabled: true }, "开启总开关失败", next);
			};

			const orchestrationButton = React.createElement("button", {
				key: "switch",
				type: "button",
				className: "pem-status" + (dualReady ? " is-on" : ""),
				title: dualOn
					? "点一下关掉：本插件立刻停止接管，正在跑的会话马上交还官方单模型生成"
					: "点一下打开：开启后由上方两席指定主管与员工模型，编排期间官方「单模型」框让位",
				onClick: toggleOrchestration
			},
				React.createElement("span", null, "双模型工作"),
				React.createElement("span", { className: "pem-status-note" },
					// 只用"能不能接管"来分档，不写死 host 的 mode 词表 ——
					// 早先判等 "waiting"，宿主词表一变文案就变成"已关闭"，很坑。
					dualReady ? "已接管" : dualOn ? "待设置两席" : "已关闭"),
				React.createElement("span", { className: "pem-status-flag" }, dualReady ? "开" : dualOn ? "待" : "关")
			);

			/** 一个「− 值 +」的行；点按钮改参数并立刻同步到 Host。 */
			const paramRow = (key, label, hint, min, max) => React.createElement("div", { className: "pem-param", key, title: hint },
				React.createElement("span", { className: "pem-param-name" }, label),
				React.createElement("span", { className: "pem-stepper" },
					React.createElement("button", {
						type: "button",
						className: "pem-step",
						disabled: paramValues[key] <= min,
						onClick: () => push({ [key]: Math.max(min, paramValues[key] - 1) }, "参数同步失败")
					}, "−"),
					React.createElement("span", { className: "pem-param-value" }, String(paramValues[key])),
					React.createElement("button", {
						type: "button",
						className: "pem-step",
						disabled: paramValues[key] >= max,
						onClick: () => push({ [key]: Math.min(max, paramValues[key] + 1) }, "参数同步失败")
					}, "+")
				)
			);

			/**
			 * 只留两个用户真会调的旋钮；步数上限、是否允许求援、是否验收这些
			 * 安全阀全部收进宿主内部常量（TUNING），界面上不再出现。
			 */
			const paramRows = React.createElement("div", { className: "pem-params", key: "params" },
				paramRow(
					"maxRounds",
					"最大轮数",
					"「主管规划 → 员工执行 → 主管介入」最多来回几轮，防止死循环",
					PARAM_RANGE.maxRounds[0],
					PARAM_RANGE.maxRounds[1]
				),
				paramRow(
					"maxRetries",
					"重试次数",
					"员工在同一段报错上重试几次后，主管下场接手；也是验收连续不合格几次后主管下场",
					PARAM_RANGE.maxRetries[0],
					PARAM_RANGE.maxRetries[1]
				)
			);

			/**
			 * 「双模型工作」菜单。三个面板在同一个菜单容器里换，不再有"每个席一个菜单"：
			 *   home   —— 总开关 + 主管/员工两席 + 两个旋钮（默认面板）
			 *   pick   —— 给某一席挑模型（按提供方分组）
			 *   effort —— 给已挑的模型挑推理等级
			 */
			let menuNode = null;
			if (menu !== null) {
				const menuStyle = Object.assign({}, menu.placement ?? { left: 8, top: 8 });
				const menuChrome = {
					onPointerEnter: () => { pointerInMenuRef.current = true; },
					onPointerLeave: () => { pointerInMenuRef.current = false; }
				};
				const paneSeat = menu.seat === null || menu.seat === void 0
					? void 0
					: SEATS.filter((seat) => seat.key === menu.seat)[0];
				const children = [];

				if (menu.pane === "effort" && menu.target !== null && paneSeat !== void 0) {
					/* ---------- 面板③：推理等级 ---------- */
					const found = findModel(state, menu.target.provider, menu.target.model);
					const choices = effortChoicesOf(found === null ? null : found.model.reasoning);
					const picked = presets[menu.seat];
					const chosen = picked !== void 0 && picked !== null
						&& picked.provider === menu.target.provider && picked.model === menu.target.model
						? picked.reasoningEffort
						: void 0;
					children.push(React.createElement("button", {
						key: "back",
						type: "button",
						className: "pem-back",
						onClick: () => setMenu(Object.assign({}, menu, { pane: "pick", target: null }))
					}, "‹ 返回模型列表"));
					children.push(React.createElement("div", { key: "title", className: "pem-menu-title" },
						"推理等级 · " + paneSeat.label + " · " + (modelNameOf(state, menu.target) || menu.target.model)));
					children.push(choices.map((choice) => React.createElement("button", {
						key: choice.key,
						type: "button",
						className: "pem-option",
						onClick: () => commit(menu.seat, selectionOf(state, menu.target.provider, menu.target.model, choice.effort))
					},
						React.createElement("span", { className: "pem-option-name" }, choice.label),
						choice.effort === chosen ? React.createElement("span", { className: "pem-check" }, "✓") : null
					)));
				} else if (menu.pane === "pick" && paneSeat !== void 0) {
					/* ---------- 面板②：挑模型 ---------- */
					const picked = presets[menu.seat];
					const pickedName = seatNameOf(picked);
					children.push(React.createElement("button", {
						key: "back",
						type: "button",
						className: "pem-back",
						onClick: () => setMenu(Object.assign({}, menu, { pane: "home", seat: null, target: null }))
					}, "‹ 返回双模型工作"));
					children.push(React.createElement("div", { key: "title", className: "pem-menu-title" },
						paneSeat.title + (pickedName === null ? "" : " · 当前 " + pickedName)));
					if (groups.length === 0) {
						children.push(React.createElement("div", { key: "empty", className: "pem-empty" }, "正在加载模型目录…"));
					}
					children.push(groups.map((group) => React.createElement("div", { className: "pem-group", key: group.id },
						React.createElement("div", { className: "pem-group-title" }, group.name !== void 0 ? group.name : group.id),
						(Array.isArray(group.models) ? group.models : []).map((model) => {
							const isCurrent = current !== null && current !== void 0 && current.provider === group.id && current.model === model.id;
							const isPicked = picked !== void 0 && picked !== null && picked.model !== FOLLOW_DEFAULT
								&& picked.provider === group.id && picked.model === model.id;
							const reasoning = model.reasoning;
							/**
							 * 点这个模型后会自动采用的档位（主管=最高、员工=中间），
							 * 直接标在行尾 —— 选模型即完成，不需要再进二级面板。
							 */
							const seatWanted = SEAT_EFFORT[menu.seat];
							const autoLevel = seatWanted === void 0 ? void 0 : snapEffortFor(reasoning, seatWanted);
							const autoName = effortNameOfLevel(reasoning, autoLevel);
							return React.createElement("button", {
								key: model.id,
								type: "button",
								className: "pem-option",
								title: autoName === null
									? "点一下选用（该模型未声明思考档位，跟随模型默认）"
									: "点一下选用；思考档位自动 = " + autoName,
								onClick: () => pickModel(menu.seat, group.id, model.id)
							},
								React.createElement("span", { className: "pem-option-name" }, model.name !== void 0 ? model.name : model.id),
								autoName === null ? null : React.createElement("span", { className: "pem-option-value" }, autoName),
								isPicked ? React.createElement("span", { className: "pem-badge" }, "已选") : null,
								isCurrent ? React.createElement("span", { className: "pem-badge is-current" }, "当前") : null
							);
						})
					)));
					if (failures.length > 0) {
						children.push(React.createElement("div", { key: "failures", className: "pem-failure" },
							"部分提供方目录加载失败：" + failures.map((item) => item.name !== void 0 ? item.name : item.id).join("、")));
					}
				} else {
					/* ---------- 面板①：双模型工作（总开关 + 两席 + 两个旋钮） ---------- */
					children.push(React.createElement("div", { key: "title", className: "pem-menu-title" }, "双模型工作"));
					children.push(orchestrationButton);
					if (!dualOn) {
						children.push(React.createElement("div", { key: "hint", className: "pem-hint" },
							"已关闭：现在完全走官方单模型 —— 用右边「单模型」框选模型即可。"
							+ "打开上面的总开关，才由主管与员工两席接管。"));
					} else {
						const seatRow = (seat) => {
							const picked = presets[seat.key];
							const name = seatNameOf(picked);
							const effort = name === null ? null : effortLabelOf(state, picked);
							return React.createElement("button", {
								key: "seat-" + seat.key,
								type: "button",
								className: "pem-option",
								title: seat.hint,
								onClick: () => setMenu(Object.assign({}, menu, { pane: "pick", seat: seat.key, target: null }))
							},
								React.createElement("span", { className: "pem-option-name" }, seat.label + "模型"),
								React.createElement("span", { className: "pem-option-value" },
									name === null ? "未选择" : effort === null ? name : name + " · " + effort),
								React.createElement("span", { className: "pem-check" }, "›")
							);
						};
						children.push(seatRow(SEATS[0]));
						children.push(seatRow(SEATS[1]));
						children.push(paramRows);
						children.push(React.createElement("div", {
							key: "hint",
							className: "pem-hint" + (dualReady ? "" : " is-warn")
						}, dualReady
							? "编排进行中：模型由上面两席决定，右边「单模型」框已让位。"
							: "两席还没选全，编排尚未接管 —— 点上面的「主管模型」「员工模型」各选一个。"));
					}
				}
				const menuEl = React.createElement("div", Object.assign({ className: "pem-menu", style: menuStyle }, menuChrome), children);
				/**
				 * portal 到 document.body —— 菜单从输入区的层叠上下文里"拎出来"，
				 * 配合同款 z-index（2147483200）盖过工作台面板（better-sidebar 用 2147483000）。
				 * 拿不到 react-dom（模块系统不提供）时退回内联渲染，行为与旧版一致。
				 */
				menuNode = ReactDOM !== null && typeof document !== "undefined" && document.body !== null
					? ReactDOM.createPortal(menuEl, document.body)
					: menuEl;
			}

			const warnChip = failures.length === 0
				? null
				: React.createElement("span", {
					className: "pem-warn",
					title: "有 " + String(failures.length) + " 个提供方的模型目录加载失败，点开「双模型」框可看详情"
				}, "!");

			// 两个框：左边这个「双模型」（主管/员工收在它的菜单里），右边是官方那席「单模型」。
			// 总开关打开时官方席由 CSS 让位（见 installOfficialSeatCompact），不需要动它的 DOM。
			return React.createElement("div", { className: "pem-root", ref: rootRef },
				dualBox,
				unmatched ? React.createElement("span", { className: "pem-mismatch", title: "当前会话模型不在两席之内（可能是手工切换的）" }, "未匹配") : null,
				warnChip,
				notice !== null ? React.createElement("span", { className: "pem-notice" }, notice) : null,
				menuNode);
		}

		function apply(ctx) {
			installStyles();
			watchOfficialSeat();
			installStepBadges();
			log("客户端插件已加载，等待 modelDirectories 服务");
			ctx.inject(["modelDirectories"], (scope) => {
				const models = scope.modelDirectories;
				const sessions = ctx.sessions;
				scope.slots.inject("conversation.input.right", () => {
					log("conversation.input.right 位已声明，注册「双模型」框（主管/员工收在它的菜单里）");
					return scope.slots.register({
						name: "conversation.input.right",
						id: "dsh-plan-exec-models",
						order: 40,
						inject: (sessionId) => {
							try {
								const available = sessions.subagentAddress(sessionId) === void 0;
								const directory = models.directoryFor(sessionId);
								return {
									available,
									sessionId: String(sessionId),
									directory: directory.store,
									load: () => {
										if (available) directory.load().catch(() => {});
									},
									select: (selection) => available
										? directory.select(selection).then(() => true, () => false)
										: Promise.resolve(false)
								};
							} catch (error) {
								// 新建会话的首帧目录可能尚未建立：仍然渲染席位（菜单会提示"正在加载模型目录…"），
								// 下一次投影更新会重新调用 inject 并接上真实目录，避免席位整块消失。
								log("会话目录未就绪，先渲染空席位并持续重试", error);
								return {
									available: true,
									load: () => {
										try {
											models.directoryFor(sessionId).load().catch(() => {});
										} catch (retryError) {
											/* 仍未就绪：交给下一次重试 */
										}
									}
								};
							}
						}
					}, PlanExecSeats);
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
