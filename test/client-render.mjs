/**
 * 客户端双席组件 · 离线渲染校验
 *
 * 为什么值得单独跑：这是纯 DOM React 组件，语法错误不一定能靠肉眼发现，
 * 而 TDZ（"Cannot access 'x' before initialization"）之类的错误会让 React 把
 * 整个组件摘掉 —— 表现是"双席直接消失"，很难查。这里用一个极简 hook 运行时
 * 把它真的渲染两遍（第二遍打开菜单），把这类问题挡在重启 App 之前。
 *
 * 用法：node /tmp/pem_client_check.mjs
 */
import { readFileSync } from 'node:fs';

/* ---------- 极简 hook 运行时 ---------- */
let hooks = [];
let cursor = 0;
let effects = [];
const ReactStub = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
	useCallback: (fn) => fn,
	useRef: (init) => {
		const index = cursor++;
		if (hooks[index] === undefined) hooks[index] = { current: init };
		return hooks[index];
	},
	useState: (init) => {
		const index = cursor++;
		if (hooks[index] === undefined) {
			hooks[index] = [typeof init === 'function' ? init() : init, (value) => { hooks[index][0] = value; }];
		}
		return hooks[index];
	},
	useEffect: (fn) => { effects.push(fn); }
};

/* ---------- 假 DOM / 假宿主 ---------- */
const noop = () => {};
const element = () => ({
	getAttribute: () => null,
	setAttribute: noop,
	querySelector: () => null,
	querySelectorAll: () => [],
	classList: { contains: () => false, add: noop, remove: noop },
	getBoundingClientRect: () => ({ top: 800, bottom: 828, right: 900, left: 620, width: 280, height: 28 }),
	insertBefore: noop,
	remove: noop,
	appendChild: noop,
	dataset: {},
	style: {}
});
const documentStub = {
	querySelector: () => null,
	querySelectorAll: () => [],
	createElement: () => element(),
	head: { appendChild: noop },
	body: { appendChild: noop },
	addEventListener: noop,
	visibilityState: 'visible'
};
const windowStub = {
	innerHeight: 900,
	innerWidth: 1280,
	setTimeout: (fn) => { return 1; },
	clearTimeout: noop,
	setInterval: () => 1,
	clearInterval: noop,
	addEventListener: noop,
	localStorage: { getItem: () => null, setItem: noop },
	MutationObserver: class { observe() {} disconnect() {} }
};

globalThis.window = windowStub;
globalThis.document = documentStub;

/* ---------- 载入客户端插件 ---------- */
const source = readFileSync('/Users/azhai/.dsh/local-plugins/dsh-plan-exec-models/lib/client.js', 'utf8');
let descriptor = null;
windowStub.__ModuleLoader__ = { load: (value) => { descriptor = value; } };
new Function('window', 'document', source)(windowStub, documentStub);
const exportsObject = descriptor.factory((name) => (name === 'react' ? ReactStub : {}));

/* ---------- 假 ctx：把注册上来的组件捞出来 ---------- */
let component = null;
const directory = {
	subscribe: () => () => {},
	getSnapshot: () => ({
		current: { provider: 'vendorA', model: 'Manager-1' },
		routable: null,
		groups: [
			{ id: 'vendorA', name: '提供方 A', models: [{ id: 'Manager-1', name: 'Manager-1' }, { id: 'Worker-1', name: 'Worker-1' }] },
			{ id: 'vendorB', name: '提供方 B', models: [{ id: 'Worker-1', name: 'Worker-1' }] }
		],
		failures: []
	})
};
const ctx = {
	sessions: { subagentAddress: () => undefined },
	inject: (services, callback) => {
		callback({
			modelDirectories: {
				directoryFor: () => ({ store: directory, load: () => Promise.resolve() })
			},
			slots: {
				inject: (name, fn) => fn(),
				register: (options, Component) => { component = Component; return { name: options.name, id: options.id }; }
			}
		});
	}
};

let failures = 0;
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures += 1;
	console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `\n      期望=${JSON.stringify(expected)}\n      实际=${JSON.stringify(actual)}`}`);
};

exportsObject.apply(ctx);
check('双席组件已注册到 conversation.input.right', typeof component, 'function');

/* ---------- 渲染 1：默认态（两席未设置） ---------- */
const sampleProps = {
	available: true,
	sessionId: 's1',
	directory,
	load: noop,
	select: () => Promise.resolve(true)
};
const render = () => {
	cursor = 0;
	effects = [];
	return component(sampleProps);
};

console.log('\n【渲染 1】默认态（Host 未应答）');
const first = render();
check('渲染成功且是容器节点', first.type, 'div');
/** React 的 children 可以是嵌套数组，摊平一层再找。 */
const flatten = (node) => (Array.isArray(node) ? node.flat(2) : [node]).filter((child) => child !== null && child !== void 0);
const seatNodes = flatten(first.children).filter((child) => String(child?.props?.className ?? '').startsWith('pem-seat'));
// v5：两席收进同一个菜单，输入栏上只剩**一个**框（以前是主管、员工各一个框）。
check('输入栏只剩一个「双模型」框（不再两席各占一个）', seatNodes.length, 1);
const boxTags = seatNodes.map((node) => node.children[1].children[0]);
check('框标签是「双模型」', boxTags, ['双模型']);
check('框上不再直接出现「主管」「员工」两个独立框',
	seatNodes.some((node) => {
		const text = JSON.stringify(node.children);
		return text.includes('"主管"') || text.includes('"员工"');
	}), false);

/* ---------- 渲染 2：点开唯一的「双模型工作」菜单 ---------- */
console.log('\n【渲染 2】点开「双模型工作」菜单（Host 未应答 → 显示"已关闭"）');
const boxButton = seatNodes[0];
boxButton.props.onClick({ currentTarget: element() });
const second = render();
const menu = flatten(second.children).filter((child) => child?.props?.className === 'pem-menu')[0];
check('菜单渲染成功', menu !== void 0 && menu !== null, true);
let flatText = JSON.stringify(menu);
check('菜单标题是「双模型工作」', flatText.includes('双模型工作'), true);
check('关闭态开关显示「已关闭」', flatText.includes('已关闭'), true);
check('关闭态只有一个开关按钮（不再每席一个）', (flatText.match(/pem-status"/g) ?? []).length, 1);
check('关闭态不显示主管/员工两行', flatText.includes('主管模型'), false);
check('关闭态给出"用右边单模型框"的指引', flatText.includes('用右边「单模型」框'), true);
check('已删除步数上限参数', ['planSteps', 'replanSteps', 'verifySteps', '步数上限'].some((name) => flatText.includes(name)), false);
check('已删除那两个开关行', ['autoReplan', 'verifyOnFinish', 'pem-switch'].some((name) => flatText.includes(name)), false);

/* ---------- 渲染 3：Host 已开启且两席选全 → 显示两席 + 两个旋钮 ---------- */
console.log('\n【渲染 3】Host 已接管 → 出现两席与两个旋钮');
globalThis.fetch = async () => ({
	ok: true,
	json: async () => ({
		ok: true,
		storage: 'settings',
		seats: {
			enabled: true, maxRounds: 3, maxRetries: 2,
			planProvider: 'vendorA', planModel: 'Manager-1', planEffort: '',
			execProvider: 'vendorB', execModel: 'Worker-1', execEffort: ''
		},
		resolved: { plan: { mode: 'model', provider: 'vendorA', model: 'Manager-1' }, exec: { mode: 'model', provider: 'vendorB', model: 'Worker-1' } },
		enabled: true,
		mode: 'active',
		orchestrating: true,
		seatsAreComplete: true,
		active: null,
		turn: null,
		phases: {},
		maxRounds: 3,
		maxRetries: 2,
		autoReplan: true,
		verifyOnFinish: true
	})
});
for (const effect of effects) {
	try { effect(); } catch (error) { console.log('    （effect 抛错，忽略）', String(error).slice(0, 80)); }
}
await new Promise((resolve) => setTimeout(resolve, 20));
const third = render();
const menu3 = flatten(third.children).filter((child) => child?.props?.className === 'pem-menu')[0];
flatText = JSON.stringify(menu3);
check('开启后出现「主管模型」行', flatText.includes('主管模型'), true);
check('开启后出现「员工模型」行', flatText.includes('员工模型'), true);
check('两席都带具体模型名', flatText.includes('Manager-1') && flatText.includes('Worker-1'), true);
check('菜单标题仍是「双模型工作」', flatText.includes('双模型工作'), true);
check('开启后开关显示「已接管」', flatText.includes('已接管'), true);
check('开启后开关标记为「开」', flatText.includes('"开"'), true);
check('参数行只剩两个', (flatText.match(/pem-param-name/g) ?? []).length, 2);
check('参数名是「最大轮数」「重试次数」', ['最大轮数', '重试次数'].every((name) => flatText.includes(name)), true);
check('开启后提示「已让位」', flatText.includes('已让位'), true);
// v5 关键回归：框本身要能表达"开着且两席齐"
const box3 = flatten(third.children).filter((child) => String(child?.props?.className ?? '').startsWith('pem-seat'))[0];
const boxText3 = JSON.stringify(box3.children);
check('框上显示「主管名 × 员工名」', boxText3.includes('×') && boxText3.includes('Manager-1') && boxText3.includes('Worker-1'), true);

/* ---------- 渲染 4：运行中「主管验收」→ 席位徽标必须与步骤徽标同色 ---------- */
console.log('\n【渲染 4】运行中「主管验收」→ 席位徽标与对话记录里的步骤徽标同色');
// Host 正在 verify 相位。active 必须是"刚刚"的（客户端只认 90 秒内的）。
globalThis.fetch = async () => ({
	ok: true,
	json: async () => ({
		ok: true,
		storage: 'settings',
		seats: {
			enabled: true, maxRounds: 3, maxRetries: 2,
			planProvider: 'vendorA', planModel: 'Manager-1', planEffort: '',
			execProvider: 'vendorB', execModel: 'Worker-1', execEffort: ''
		},
		resolved: { plan: { mode: 'model', provider: 'vendorA', model: 'Manager-1' }, exec: { mode: 'model', provider: 'vendorB', model: 'Worker-1' } },
		enabled: true,
		mode: 'active',
		orchestrating: true,
		seatsAreComplete: true,
		active: { phase: 'verify', reason: 'verify', provider: 'vendorA', model: 'Manager-1', step: 6, at: Date.now() },
		turn: { round: 1, escalated: false },
		phases: {},
		maxRounds: 3,
		maxRetries: 2
	})
});
render(); // 只为收集本轮 effects（本轮 host.orchestrating 已是 true → 轮询 effect 会被登记）
for (const effect of effects) {
	try { effect(); } catch (error) { /* 假 DOM 缺 body.dataset 等，忽略 */ }
}
await new Promise((resolve) => setTimeout(resolve, 20));
const fourth = render();
const box4 = flatten(fourth.children).filter((child) => String(child?.props?.className ?? '').startsWith('pem-seat'))[0];
const cls4 = String(box4?.props?.className ?? '');
const hasCls = (cls, name) => new RegExp('(^|\\s)' + name + '(\\s|$)').test(cls);
check('运行中 → 席位徽标带 is-running', hasCls(cls4, 'is-running'), true);
check('「主管验收」用 is-verify（不再被塌成 is-plan）', hasCls(cls4, 'is-verify'), true);
check('席位徽标没有同时带上错误的 is-plan（紫）', hasCls(cls4, 'is-plan'), false);
check('框内文案仍是「主管验收」', JSON.stringify(box4?.children ?? []).includes('主管验收'), true);

// 同色的硬保证 = 两处徽标消费同一组 CSS 变量。静态不变量：色板改错会被这里拦住。
const paletteRoles = ['is-plan', 'is-replan', 'is-verify', 'is-exec'];
const paletteOk = paletteRoles.map((role) => new RegExp(
	'\\.pem-stepbadge\\.' + role + ',\\.pem-seat\\.is-running\\.' + role + '\\{--pem-ink:(#[0-9A-Fa-f]{6});--pem-tint:(#[0-9A-Fa-f]{6})\\}'
).test(source));
check('四个相位色板各定义一次、且两处徽标共用同一选择器', paletteOk, [true, true, true, true]);
check('步骤徽标配色取自色板变量', /\.pem-stepbadge\{[^}]*color:var\(--pem-ink/.test(source), true);
check('席位徽标配色取自色板变量',
	/\.pem-seat\.is-running\.is-plan,\.pem-seat\.is-running\.is-replan,\.pem-seat\.is-running\.is-verify,\.pem-seat\.is-running\.is-exec\{color:var\(--pem-ink/.test(source), true);
check('席位徽标不再写死十六进制色值（防再次跑偏）', /\.pem-seat\.is-running\.is-plan\{color:#/.test(source), false);
check('配色类与文案同源（runningRole 由 runningMeta 得出）',
	/const runningRole = runningPhase === null[\s\S]{0,220}?runningMeta\.role/.test(source), true);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'} ===`);
process.exit(failures === 0 ? 0 : 1);
