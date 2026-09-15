/**
 * 会话隔离 · 离线仿真
 *
 * 用户的需求原话：
 *   > 是否为单双模型工作方式，应该每个对话内容都是独立的；
 *   > 只有在新开对话的时候，才继承上一次对话的最后设定。
 *
 * 这里用假 ctx 把 Host 插件点起来，直接打 HTTP 接口，验证：
 *   ① 在 A 对话里开双模型，**B 对话不受影响**；
 *   ② 全新对话 C 出现时，**继承全局种子**（= 上一次的设定）；
 *   ③ 席位（主管/员工模型）也是按会话各记一份，互不覆盖；
 *   ④ A 里关掉不会掐掉 B 正在跑的双模型（收尾只针对本会话）；
 *   ⑤ 编排层（pre-step 写官方 selection）同样只听本会话的闸门；
 *   ⑥ 老客户端不带 sessionId 时退回全局行为，不至于坏掉。
 *
 * 用法：node test/session-isolation.mjs
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ---------- 把 Host 插件点起来（假 ctx） ---------- */
const home = join(tmpdir(), 'pem-session-home');
process.env.DSH_HOME = home;
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const API = '/dsh-plan-exec-models/api';

const handlers = new Map();
let httpHandler = null;

/** 全局那份（= settings.yaml）：只当"新对话的种子"。 */
const settingState = {
	enabled: false,
	maxRounds: 3,
	maxRetries: 2,
	planProvider: '', planModel: '', planEffort: '',
	execProvider: '', execModel: '', execEffort: ''
};

/** sessionId → agent（liveAgents 用）。 */
const agentsBySession = new Map();
/** 官方 selection 的共享替身：本插件要写的就这一个。 */
const fakeSelection = { current: undefined, assembled: undefined };

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
let failures = 0;
let total = 0;
function check(label, actual, expected) {
	total += 1;
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures += 1;
	console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `\n      期望=${JSON.stringify(expected)}\n      实际=${JSON.stringify(actual)}`}`);
}
function checkTrue(label, actual) {
	total += 1;
	if (!actual) failures += 1;
	console.log(`${actual ? '  ✓' : '  ✗'} ${label}`);
}

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

/** 带会话去读席位（客户端对齐时走的就是这条路）。 */
const seatsOf = async (sessionId) => (await api('GET', API + '/seats' + (sessionId === undefined ? '' : '?sessionId=' + encodeURIComponent(sessionId)))).payload;
/** 带会话去写席位。 */
const putSeats = async (sessionId, body) => (await api('PUT', API + '/seats' + (sessionId === undefined ? '' : '?sessionId=' + encodeURIComponent(sessionId)), body)).payload;
/** 读日志（排障接口）。 */
const logOf = async (sessionId) => (await api('GET', API + '/log' + (sessionId === undefined ? '' : '?sessionId=' + encodeURIComponent(sessionId)))).payload;

function makeAgent(sessionId) {
	const agent = {
		session: { id: sessionId, deriveMessages: () => [], requestHeader: () => undefined },
		inject: () => {}
	};
	agentsBySession.set(sessionId, agent);
	return agent;
}

/** 跑一次 pre-step（编排的唯一入口），看它有没有真的去写官方 selection。 */
async function preStep(sessionId) {
	fakeSelection.current = undefined;
	fakeSelection.assembled = undefined;
	const agent = makeAgent(sessionId);
	await handlers.get('agent/pre-step')({ agent, turn: 1, step: 1 }, async () => ({ kind: 'ok', messages: [] }));
	return fakeSelection.current;
}

const SEATS_ON = {
	enabled: true,
	planProvider: 'vendorA', planModel: 'Manager-1', planEffort: '',
	execProvider: 'vendorB', execModel: 'Worker-1', execEffort: ''
};

console.log('【场景 1】全新环境：每个对话首次出现都从全局（= 关闭）继承');
let a = await seatsOf('sess-A');
check('A 首次读取 → 关闭', a.enabled, false);
check('A 首次读取 → 还没自己的记录（pinned=false）', a.pinned, false);
let b = await seatsOf('sess-B');
check('B 首次读取 → 关闭', b.enabled, false);

console.log('\n【场景 2】在 A 里打开双模型 → B 不受影响，新对话继承');
await putSeats('sess-A', SEATS_ON);
a = await seatsOf('sess-A');
check('A → 已接管', a.mode, 'active');
check('A → 已有自己的记录（pinned=true）', a.pinned, true);
b = await seatsOf('sess-B');
check('B 仍然是关闭（← 核心：不再跟着 A 一起开）', b.enabled, false);
check('B 的席位也没被 A 的覆盖', [b.seats.planModel, b.seats.execModel], ['', '']);
const c1 = await seatsOf('sess-C');
check('全新对话 C → 继承"上一次的设定"（开启）', c1.enabled, true);
check('全新对话 C → 继承时才钉住（pinned=false）', c1.pinned, false);

console.log('\n【场景 3】编排层同样只听本会话的闸门');
const routeA = await preStep('sess-A');
check('A 的 pre-step 拿到了主管席（Manager-1）', routeA, { provider: 'vendorA', model: 'Manager-1' });
const routeB = await preStep('sess-B');
check('B 的 pre-step 什么都没写（关闭 = 完全交还官方）', routeB, undefined);

console.log('\n【场景 4】席位按会话各记一份');
await putSeats('sess-B', { planProvider: 'vendorZ', planModel: 'Manager-9', enabled: false });
b = await seatsOf('sess-B');
check('B 的主管席改成 Manager-9', b.seats.planModel, 'Manager-9');
check('B 仍然是关闭（改席位不该顺手打开开关）', b.enabled, false);
a = await seatsOf('sess-A');
check('A 的主管席不受影响（仍是 Manager-1）', a.seats.planModel, 'Manager-1');

console.log('\n【场景 5】各自开关：B 开、A 关，互不掐断');
await putSeats('sess-B', { enabled: true });
check('B 打开后 A 仍开启', (await seatsOf('sess-A')).enabled, true);
await putSeats('sess-A', { enabled: false });
check('A 关闭', (await seatsOf('sess-A')).enabled, false);
check('A 关闭后 B 依然开启（← 核心：收尾只针对本会话）', (await seatsOf('sess-B')).enabled, true);
const log = await logOf('sess-B');
checkTrue('日志写明"只关了本会话"', log.lines.some((line) => line.includes('已关闭本会话的双模型编排（总开关关闭，会话 sess-A）')));
checkTrue('日志写明"其它对话不受影响"', log.lines.some((line) => line.includes('其它对话不受影响')));
checkTrue('没有出现"全局收尾"字样', !log.lines.some((line) => line.includes('全局收尾')));
const d1 = await seatsOf('sess-D');
check('全新对话 D → 继承全局（A 最后写的关闭）', d1.enabled, false);

console.log('\n【场景 6】老客户端（不带 sessionId）退回全局行为');
const legacy = await seatsOf();
check('不带会话 → 读全局（关闭）', legacy.enabled, false);
await putSeats(undefined, { enabled: true });
check('不带会话 → 写全局（开启）', (await seatsOf()).enabled, true);
check('A 自己的记录不受全局变化影响（仍是关闭）', (await seatsOf('sess-A')).enabled, false);
check('B 自己的记录不受全局变化影响（仍是开启）', (await seatsOf('sess-B')).enabled, true);

console.log('\n【场景 7】会话表真的落了盘');
const file = join(home, 'dsh-plan-exec-models', 'sessions.json');
const saved = JSON.parse(readFileSync(file, 'utf8'));
check('sessions.json version', saved.version, 1);
const keys = Object.keys(saved.sessions).sort();
check('四个对话各有一条记录', keys, ['sess-A', 'sess-B', 'sess-C', 'sess-D']);
check('A 记录 = 关闭 + Manager-1', [saved.sessions['sess-A'].enabled, saved.sessions['sess-A'].planModel], [false, 'Manager-1']);
check('B 记录 = 开启 + Manager-9', [saved.sessions['sess-B'].enabled, saved.sessions['sess-B'].planModel], [true, 'Manager-9']);
check('每条都带写入时间（淘汰用，对外不暴露）',
	keys.every((key) => typeof saved.sessions[key].at === 'number'), true);
check('对外快照里没有 at 字段', Object.prototype.hasOwnProperty.call((await seatsOf('sess-A')).seats, 'at'), false);

console.log(`\n=== 结果：${total - failures}/${total} 通过 ${failures === 0 ? '✓' : '✗'} ===`);
process.exit(failures === 0 ? 0 : 1);
