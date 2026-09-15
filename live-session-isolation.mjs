// 脱敏版:凭据改从环境变量读取(原文件含本机真实 cookie,不入库)
/**
 * 【Phase G 真机验证】单/双模型工作方式是否**按对话独立**。
 *
 * 用户原话：
 *   > 会不会做的是全局设置？…如果是的话，不要这样。是否为单双模型工作方式，
 *   > 应该每个对话内容都是独立的；只有在新开对话的时候，才继承上一次对话的最后设定。
 *
 * 用用户自己的两个对话做对照实验（都不发消息、不新建会话）：
 *   A = 打开 App 时那个新对话（只当"没被动过的对照组"）
 *   B = 用户自己的真实对话（侧栏里点开）
 *
 * 验的东西：
 *   ① 在 B 里打开双模型 → A **不受影响**（宿主的按会话解析对两边给出不同答案）；
 *   ② B 的界面显示"已接管"，A 的记录还是关闭 —— 界面读的是**这个对话自己**的那份；
 *   ③ 刷新页面 → B 的设定从**会话记录**取回（不是从全局），A 依旧不动；
 *   ④ 全局种子会跟着记下"上一次的设定"（新对话继承的那一份）；
 *   ⑤ 在 B 里关掉 → 全局回到关闭，A 始终没被碰过。
 *
 * 用法：node test/live-session-isolation.mjs
 */
import { mkdirSync } from 'node:fs';
import { webkit } from '/Users/azhai/.workbuddy/binaries/node/node_modules/playwright/index.mjs';

const COOKIE_NAME = process.env.DSH_AUTH_NAME || '';
const COOKIE_VALUE = process.env.DSH_AUTH_VALUE || '';
const BASE = 'http://127.0.0.1:47615/';
const API = `${BASE}dsh-plan-exec-models/api/seats`;
const LOG_API = `${BASE}dsh-plan-exec-models/api/log`;
const SHOT_DIR = '/Users/azhai/Desktop/dsh-plan-exec-models-截图';
const OFFICIAL_TRIGGER = 'button[class*="_7KE1Ra_trigger"]';

let failures = 0;
const check = (label, ok, actual) => {
	if (ok !== true) failures += 1;
	console.log(`${ok === true ? '  ✓' : '  ✗'} ${label}${ok === true ? '' : `   实际=${JSON.stringify(actual)}`}`);
};

const headers = { cookie: `${COOKIE_NAME}=${COOKIE_VALUE}`, 'content-type': 'application/json' };
const seatsOf = async (sessionId) => {
	const url = API + (sessionId === undefined || sessionId === null ? '' : '?sessionId=' + encodeURIComponent(sessionId));
	return (await fetch(url, { headers })).json();
};
/** 宿主**按会话**解析出来的那份配置（排障接口，不进对话）。 */
const sessionSeatsOf = async (sessionId) => {
	const url = LOG_API + (sessionId === undefined || sessionId === null ? '' : '?sessionId=' + encodeURIComponent(sessionId));
	return (await fetch(url, { headers })).json();
};
const brief = (s) => ({ enabled: s.enabled, mode: s.mode, pinned: s.pinned, plan: s.seats?.planModel, exec: s.seats?.execModel });
/** 按会话写一份配置（用于把起点拉回确定状态）。 */
const setSeats = async (sessionId, body) => {
	const url = API + (sessionId === undefined || sessionId === null ? '' : '?sessionId=' + encodeURIComponent(sessionId));
	const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
	return res.status;
};

mkdirSync(SHOT_DIR, { recursive: true });

let browser;
try {
	/* ---------- 0. 记下原状态 ---------- */
	const seedBefore = await seatsOf();
	console.log(`【全局种子】${JSON.stringify(brief(seedBefore))}`);

	browser = await webkit.launch({ headless: true });
	const context = await browser.newContext({ viewport: { width: 1500, height: 1050 } });
	await context.addCookies([{ name: COOKIE_NAME, value: COOKIE_VALUE, url: BASE, httpOnly: false, secure: false, sameSite: 'Lax' }]);
	const page = await context.newPage();
	await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });

	const waitBox = async (timeout = 40000) => {
		await page.waitForFunction(() => document.querySelector('.pem-seat') !== null, null, { timeout });
		await page.waitForTimeout(900);
	};
	const currentSession = () => page.evaluate(() => document.body.dataset.pemSession ?? null);
	const waitSessionChange = async (previous, timeout = 30000) => {
		await page.waitForFunction((prev) => {
			const now = document.body.dataset.pemSession ?? null;
			return now !== null && now !== prev;
		}, previous, { timeout });
		await page.waitForTimeout(1600);
	};
	/**
	 * 切到"另一个"对话：点侧栏里**当前没被选中**的那条会话。
	 * 不按序号点（侧栏按最近使用排序，序号会漂），用真鼠标按坐标点、只点行左侧。
	 */
	const switchConversation = async () => {
		const clickUnselected = async () => {
			const point = await page.evaluate(() => {
				const rows = [...document.querySelectorAll('div[class*="sessionRow"]')];
				const row = rows.find((el) => !(el.getAttribute('aria-selected') === 'true' || String(el.className).includes('selected')));
				if (row === undefined) return null;
				const rect = row.getBoundingClientRect();
				return { x: rect.x + 60, y: rect.y + rect.height / 2 };
			});
			if (point === null) return null;
			await page.mouse.click(point.x, point.y);
			await page.waitForTimeout(1400);
			return point;
		};
		const prev = await currentSession();
		const point = await clickUnselected();
		if (point === null) return null;
		if ((await currentSession()) === prev) await clickUnselected();
		await waitSessionChange(prev);
		await waitBox();
		return currentSession();
	};
	const readSnap = () => page.evaluate((sel) => {
		const box = document.querySelector('.pem-seat');
		const trigger = document.querySelector(sel);
		const menu = document.querySelector('.pem-menu');
		return {
			boxText: box === null ? null : (box.textContent || '').trim(),
			dualAttr: document.body.dataset.pemDual ?? null,
			switchNote: menu === null ? null : (menu.querySelector('.pem-status-note')?.textContent ?? null),
			switchFlag: menu === null ? null : (menu.querySelector('.pem-status-flag')?.textContent ?? null),
			menuTitle: menu === null ? null : (menu.querySelector('.pem-menu-title')?.textContent ?? null),
			triggerBefore: trigger === null ? null : getComputedStyle(trigger, '::before').content,
			triggerPointer: trigger === null ? null : getComputedStyle(trigger).pointerEvents,
			triggerOpacity: trigger === null ? null : getComputedStyle(trigger).opacity
		};
	}, OFFICIAL_TRIGGER);
	const menuIsOpen = () => page.evaluate(() => document.querySelector('.pem-menu') !== null);
	/**
	 * 菜单是**开/关切换**的：席位按钮 onClick 里 `menu !== null` 时会 setMenu(null)。
	 * 所以"打开"不能无脑点 —— 已经开着再点一下反而会关掉它。这里先判存在性。
	 */
	const openMenu = async () => {
		if (await menuIsOpen()) return;
		await page.evaluate(() => { const b = document.querySelector('.pem-seat'); if (b !== null) b.click(); });
		await page.waitForTimeout(700);
	};
	const closeMenu = async () => {
		if (!(await menuIsOpen())) return;
		await page.evaluate(() => { const b = document.querySelector('.pem-seat'); if (b !== null) b.click(); });
		await page.waitForTimeout(400);
	};
	/**
	 * 快照。菜单相关的字段（开关文案、旗标、菜单标题）**只在菜单开着时才有值**：
	 * 插件会因为一次布局回流/滚动回声把菜单自动收起，此时读到的 null 是"没开着"，
	 * 不是"界面错了"。所以先确保菜单是开的，再取值；取不到就重开一次重取。
	 */
	const snap = async () => {
		let out = await readSnap();
		for (let i = 0; i < 3; i += 1) {
			if (out.switchNote !== null && out.menuTitle !== null) break;
			await openMenu();
			out = await readSnap();
		}
		return out;
	};
	const toggleSwitch = async () => {
		await openMenu();
		await page.evaluate(() => { const b = document.querySelector('.pem-menu .pem-status'); if (b !== null) b.click(); });
		await page.waitForTimeout(2200);
	};

	await waitBox();
	const a = await currentSession();   // 对照组：开 App 时的那个新对话
	/**
	 * 起点归一化：这个脚本验的是"按对话独立"，不是"开 App 时恰好是关的"。
	 * 上一轮跑剩的残留（比如上一次中途失败）会让 A 带着"开"进来，于是下面那句
	 * "A 的界面此刻是关闭态"平白失败 —— 先把 A 和全局种子都归零，起点才是确定的。
	 */
	const aStart = await seatsOf(a);
	if (aStart.enabled === true) {
		console.log('   （起点归一化：把 A 和全局种子都置为关闭）');
		await setSeats(a, { enabled: false });
		await setSeats(null, { enabled: false });
		await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
		await waitBox();
	}
	const seedNormalized = await seatsOf();
	const aBefore = await seatsOf(a);
	console.log(`\n【进入时】当前对话 A=${a}`);
	console.log(`            A → ${JSON.stringify(brief(aBefore))}`);
	check('客户端把当前会话 id 交给了宿主（body[data-pem-session]）', typeof a === 'string' && a.startsWith('session-'), a);
	check('宿主给 A 单独记了一份', aBefore.pinned === true, aBefore.pinned);
	check('A 的这份就是全局种子（首次继承）', aBefore.enabled === seedNormalized.enabled, { a: aBefore.enabled, seed: seedNormalized.enabled });
	check('起点是确定的（A 与全局种子都是关）', aBefore.enabled === false && seedNormalized.enabled === false, { a: aBefore.enabled, seed: seedNormalized.enabled });
	let s = await snap();
	check('A 的界面此刻是关闭态', s.dualAttr === 'off' && (s.boxText ?? '').includes('未启用'), { dual: s.dualAttr, box: s.boxText });
	await closeMenu();

	/* ---------- 1. 切到用户的真实对话 ---------- */
	console.log('\n【① 切到另一个对话（用户自己的真实对话）】');
	const b = await switchConversation();
	check('确实切到了另一个对话', typeof b === 'string' && b !== a, { a, b });
	if (b === null || b === a) throw new Error('没能切到第二个对话，无法做对照实验');
	const bBefore = await seatsOf(b);
	console.log(`    B=${b} → ${JSON.stringify(brief(bBefore))}`);
	check('B 也拿到了自己的一份', bBefore.pinned === true, bBefore.pinned);
	check('B 此刻是关闭的', bBefore.enabled === false, bBefore.enabled);

	/* ---------- 2. 在 B 里打开双模型 → A 不受影响 ---------- */
	console.log('\n【② 在 B 里打开双模型 → A 不该有任何变化】');
	s = await snap();
	check('打开前 B 的界面是关闭态', s.dualAttr === 'off', s.dualAttr);
	await toggleSwitch();
	const bOn = await seatsOf(b);
	s = await snap();
	check('B 已开启（宿主）', bOn.enabled === true, bOn.enabled);
	check('B 已接管（宿主）', bOn.mode === 'active', bOn.mode);
	check('B 的界面显示「已接管」', (s.switchNote ?? '') === '已接管', s.switchNote);
	check('B 的官方「单模型」框已让位', (s.triggerBefore ?? '').includes('已让位'), s.triggerBefore);
	await page.screenshot({ path: `${SHOT_DIR}/G-对话B-已接管.png` });

	const aAfter = await seatsOf(a);
	console.log(`    A → ${JSON.stringify(brief(aAfter))}`);
	check('★ A 仍然关闭（← 核心：不再是"一处开、处处开"）', aAfter.enabled === false, aAfter.enabled);
	check('★ A 的席位一个字节都没动',
		JSON.stringify(aAfter.seats) === JSON.stringify(aBefore.seats),
		{ 前: brief(aBefore), 后: brief(aAfter) });
	const seedOn = await seatsOf();
	check('全局种子记下了"上一次的设定 = 开启"（新对话会继承它）', seedOn.enabled === true, seedOn.enabled);

	/* ---------- 3. 宿主按会话解析：两个对话答案不同 ---------- */
	console.log('\n【③ 宿主按会话解析：同一个全局，两个对话给出不同答案】');
	const logB = await sessionSeatsOf(b);
	const logA = await sessionSeatsOf(a);
	check('宿主对 B 的解析 = 开启', logB.sessionSeats?.enabled === true, logB.sessionSeats?.enabled);
	check('宿主对 A 的解析 = 关闭（← 核心）', logA.sessionSeats?.enabled === false, logA.sessionSeats?.enabled);
	check('会话席位表里已经有两个对话的独立记录', (logB.seatSessions?.count ?? 0) >= 2, logB.seatSessions);

	/* ---------- 4. 刷新页面：设定从"会话记录"取回 ---------- */
	console.log('\n【④ 刷新页面 → 设定从会话记录取回，A 依旧不动】');
	await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
	await waitBox();
	check('刷新后仍是 B', (await currentSession()) === b, await currentSession());
	s = await snap();
	console.log(`    刷新后 B：框="${s.boxText}"  dual=${s.dualAttr}`);
	check('刷新后 B 仍是"已接管"（从它自己的记录取回，不是从全局）',
		s.dualAttr === 'on' && (s.boxText ?? '').includes('×'), { dual: s.dualAttr, box: s.boxText });
	const aAfterReload = await seatsOf(a);
	check('刷新没有把 A 的席位覆盖掉（← 核心：不再"本地优先"串过去）',
		JSON.stringify(aAfterReload.seats) === JSON.stringify(aBefore.seats),
		{ 前: brief(aBefore), 后: brief(aAfterReload) });
	check('刷新没有把 A 打开', aAfterReload.enabled === false, aAfterReload.enabled);
	const bAfterReload = await seatsOf(b);
	check('B 自己也没被刷新搞乱', bAfterReload.enabled === true && bAfterReload.seats?.planModel === bBefore.seats?.planModel,
		brief(bAfterReload));

	/* ---------- 5. 在 B 里关掉 → A 仍是关闭，全局回到关闭 ---------- */
	console.log('\n【⑤ 在 B 里关掉 → 只影响 B；A 全程没被碰过】');
	await toggleSwitch();
	const bOff = await seatsOf(b);
	s = await snap();
	check('B 已关闭', bOff.enabled === false, bOff.enabled);
	check('B 的界面回到「已关闭」', (s.switchNote ?? '') === '已关闭', s.switchNote);
	check('B 的两席仍是原来那两个', bOff.seats?.planModel === bBefore.seats?.planModel && bOff.seats?.execModel === bBefore.seats?.execModel,
		{ plan: bOff.seats?.planModel, exec: bOff.seats?.execModel });
	await openMenu();
	s = await snap();
	await page.screenshot({ path: `${SHOT_DIR}/G-对话B-已关闭.png` });
	await closeMenu();
	const aFinal = await seatsOf(a);
	check('★ A 从头到尾都是关闭', aFinal.enabled === false, aFinal.enabled);
	check('★ A 的两席从头到尾没动过', JSON.stringify(aFinal.seats) === JSON.stringify(aBefore.seats), brief(aFinal));
	const seedAfter = await seatsOf();
	check('全局种子回到"关闭"（新对话仍会继承关闭）', seedAfter.enabled === false, seedAfter.enabled);
	check('全局种子的两席没被动过',
		seedAfter.seats?.planModel === seedBefore.seats?.planModel && seedAfter.seats?.execModel === seedBefore.seats?.execModel,
		brief(seedAfter));
	console.log(`\n【留档】A=${JSON.stringify(brief(aFinal))}`);
	console.log(`        B=${JSON.stringify(brief(bOff))}`);
	console.log('        （两条记录各自独立，全程未影响对方的席位与开关）');
} finally {
	if (browser !== undefined) await browser.close();
}

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✓' : `${failures} 项未通过 ✗`} ===`);
process.exit(failures === 0 ? 0 : 1);
