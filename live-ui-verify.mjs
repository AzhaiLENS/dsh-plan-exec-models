// 脱敏版:凭据改从环境变量读取(原文件含本机真实 cookie,不入库)
/**
 * 【Phase F 真机验证】"双模型 / 单模型" 两个框的新界面。
 *
 * 验的东西（对应用户原话）：
 *   ① 只剩两个框：左边「双模型」、右边官方「单模型」（主管/员工不再各占一个框）
 *   ② 双模型关着 → 框显示"未启用"，官方「单模型」完全可用、不压暗
 *   ③ 点开只有**一个**"双模型工作"菜单，总开关就在里面（不再有"先关主管再关员工"）
 *   ④ 打开总开关 → 菜单里出现主管模型 / 员工模型 两行；官方「单模型」框压暗 + "已让位"
 *   ⑤ 关掉总开关 → 一切复原
 *
 * 全程不发消息、不产生对话。结束前把 Host 状态还原成进来时的样子。
 * 用法：node /tmp/pem_f_verify.mjs
 */
import { webkit } from '/Users/azhai/.workbuddy/binaries/node/node_modules/playwright/index.mjs';

const COOKIE_NAME = process.env.DSH_AUTH_NAME || '';
const COOKIE_VALUE = process.env.DSH_AUTH_VALUE || '';
const BASE = 'http://127.0.0.1:47615/';
const API = `${BASE}dsh-plan-exec-models/api/seats`;
const OFFICIAL_TRIGGER = 'button[class*="_7KE1Ra_trigger"]';

let failures = 0;
const check = (label, ok, actual) => {
	if (ok !== true) failures += 1;
	console.log(`${ok === true ? '  ✓' : '  ✗'} ${label}${ok === true ? '' : `   实际=${JSON.stringify(actual)}`}`);
};

const headers = { cookie: `${COOKIE_NAME}=${COOKIE_VALUE}`, 'content-type': 'application/json' };
/**
 * v5 起宿主**按会话**记账（sessions.json）：席位请求必须带上"当前正在看的那个对话"，
 * 否则读到的是全局种子、写进去也不落在本对话头上。
 * 会话 id 从页面的 body[data-pem-session] 上取（客户端渲染时写的）。
 */
let SESSION_ID = null;
const apiUrl = () => API + (SESSION_ID === null ? '' : '?sessionId=' + encodeURIComponent(SESSION_ID));
const getSeats = async () => (await fetch(apiUrl(), { headers })).json();
const putSeats = async (patch) => (await fetch(apiUrl(), { method: 'PUT', headers, body: JSON.stringify(patch) })).json();

/* ---------- 0. 原状态等页面起来再记（要先知道是哪个会话） ---------- */
let original = null;

let browser;
try {
	browser = await webkit.launch({ headless: true });
	const context = await browser.newContext({ viewport: { width: 1500, height: 1050 } });
	await context.addCookies([{ name: COOKIE_NAME, value: COOKIE_VALUE, url: BASE, httpOnly: false, secure: false, sameSite: 'Lax' }]);
	const page = await context.newPage();
	await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
	await page.waitForTimeout(12000);

	// 先认出"当前这个对话"，之后所有席位读写都带着它。
	SESSION_ID = await page.evaluate(() => document.body.dataset.pemSession ?? null);
	original = await getSeats();
	console.log('【原状态】', JSON.stringify({
		会话: SESSION_ID,
		enabled: original.enabled, mode: original.mode,
		plan: original.seats?.planModel, exec: original.seats?.execModel,
		maxRounds: original.seats?.maxRounds, maxRetries: original.seats?.maxRetries
	}));

	/** 读当前 UI 快照。 */
	const snap = () => page.evaluate((sel) => {
		const box = document.querySelector('.pem-seat');
		const trigger = document.querySelector(sel);
		const menu = document.querySelector('.pem-menu');
		const seats = [...document.querySelectorAll('button[class*="pem-seat"]')];
		return {
			boxCount: seats.length,
			boxText: box === null ? null : (box.textContent || '').trim(),
			boxClass: box === null ? null : box.className,
			dualAttr: document.body.dataset.pemDual ?? null,
			triggerBefore: trigger === null ? null : getComputedStyle(trigger, '::before').content,
			triggerOpacity: trigger === null ? null : getComputedStyle(trigger).opacity,
			triggerPointer: trigger === null ? null : getComputedStyle(trigger).pointerEvents,
			triggerLabelVisible: trigger === null ? null
				: (() => { const l = trigger.querySelector('[class*="_triggerLabel"]'); return l === null ? null : getComputedStyle(l).display; })(),
			menuOpen: menu !== null,
			menuTitle: menu === null ? null : (menu.querySelector('.pem-menu-title')?.textContent ?? ''),
			menuSwitch: menu === null ? null : (() => { const b = menu.querySelector('.pem-status'); return b === null ? null : (b.textContent || '').trim(); })(),
			menuSwitchFlag: menu === null ? null : (() => { const f = menu.querySelector('.pem-status-flag'); return f === null ? null : f.textContent; })(),
			menuSeatRows: menu === null ? [] : [...menu.querySelectorAll('.pem-option')].map((b) => (b.textContent || '').trim()).slice(0, 6),
			menuHint: menu === null ? null : (menu.querySelector('.pem-hint')?.textContent ?? null),
			menuParams: menu === null ? 0 : menu.querySelectorAll('.pem-param').length
		};
	}, OFFICIAL_TRIGGER);

	const openMenu = async () => {
		await page.evaluate(() => { const b = document.querySelector('.pem-seat'); if (b !== null) b.click(); });
		await page.waitForTimeout(700);
	};
	const closeMenu = async () => {
		await page.evaluate(() => { const b = document.querySelector('.pem-seat'); if (b !== null) b.click(); });
		await page.waitForTimeout(400);
	};
	const clickSwitch = async () => {
		await page.evaluate(() => { const b = document.querySelector('.pem-menu .pem-status'); if (b !== null) b.click(); });
		await page.waitForTimeout(1800);
	};

	/* ================= ① 只剩一个「双模型」框 ================= */
	console.log('\n【① 输入栏只剩一个「双模型」框，主管/员工不再各占一个框】');
	let s = await snap();
	console.log(`    框文字="${s.boxText}"  class="${s.boxClass}"`);
	check('输入栏里 .pem-seat 只剩 1 个', s.boxCount === 1, s.boxCount);
	check('框上写的是「双模型」', s.boxText.startsWith('双模型'), s.boxText);
	check('关闭态显示"未启用"', s.boxText.includes('未启用'), s.boxText);
	check('关闭态带 is-off 样式', s.boxClass.includes('is-off'), s.boxClass);
	check('界面上已不存在「主管」「员工」两个独立框', !s.boxText.includes('主管') && !s.boxText.includes('员工'), s.boxText);

	/* ================= ② 官方框 = 「单模型」 ================= */
	console.log('\n【② 官方那席穿上「单模型」外衣，关闭时不压暗、可用】');
	check('官方框前加了「单模型」标签', (s.triggerBefore ?? '').includes('单模型'), s.triggerBefore);
	check('关闭态不压暗（opacity=1）', s.triggerOpacity === '1', s.triggerOpacity);
	check('关闭态可点击', s.triggerPointer !== 'none', s.triggerPointer);
	check('关闭态仍显示真实模型名', s.triggerLabelVisible !== 'none', s.triggerLabelVisible);
	check('body 上没有 dual=on 标记', s.dualAttr === 'off', s.dualAttr);

	/* ================= ③ 菜单：只有一个总开关 ================= */
	console.log('\n【③ 点开是唯一的「双模型工作」菜单，总开关在里面】');
	await openMenu();
	s = await snap();
	console.log(`    菜单标题="${s.menuTitle}"  开关行="${s.menuSwitch}"  旗标="${s.menuSwitchFlag}"`);
	console.log(`    提示="${s.menuHint}"`);
	check('菜单已打开', s.menuOpen === true, s.menuOpen);
	check('菜单叫「双模型工作」', s.menuTitle === '双模型工作', s.menuTitle);
	check('总开关行也叫「双模型工作」', (s.menuSwitch ?? '').startsWith('双模型工作'), s.menuSwitch);
	check('关闭态旗标=关', s.menuSwitchFlag === '关', s.menuSwitchFlag);
	check('关闭态只有一个开关按钮（不再两个菜各一个）', await page.evaluate(() => document.querySelectorAll('.pem-menu .pem-status').length) === 1);
	check('关闭态不显示主管/员工两行', !s.menuSeatRows.some((t) => t.includes('主管模型') || t.includes('员工模型')), s.menuSeatRows);
	check('关闭态给出"用右边单模型框"的说明', (s.menuHint ?? '').includes('单模型'), s.menuHint);
	await page.screenshot({ path: '/tmp/pem-f-1-off-menu.png' });

	/* ================= ④ 打开总开关 ================= */
	console.log('\n【④ 打开总开关 → 出现两席，官方「单模型」框让位】');
	await clickSwitch();
	const afterOn = await getSeats();
	check('Host 已开启', afterOn.enabled === true, afterOn.enabled);
	s = await snap();
	console.log(`    框文字="${s.boxText}"  class="${s.boxClass}"  dualAttr=${s.dualAttr}`);
	console.log(`    开关行="${s.menuSwitch}"  旗标="${s.menuSwitchFlag}"`);
	console.log(`    两席行=${JSON.stringify(s.menuSeatRows)}`);
	console.log(`    提示="${s.menuHint}"`);
	check('菜单里出现「主管模型」行', s.menuSeatRows.some((t) => t.includes('主管模型')), s.menuSeatRows);
	check('菜单里出现「员工模型」行', s.menuSeatRows.some((t) => t.includes('员工模型')), s.menuSeatRows);
	check('两席都显示出了具体模型名', s.menuSeatRows.filter((t) => t.includes('kimi') || t.includes('glm')).length >= 2, s.menuSeatRows);
	check('两个旋钮还在（最大轮数/重试次数）', s.menuParams === 2, s.menuParams);
	check('body 标记为 dual=on', s.dualAttr === 'on', s.dualAttr);
	check('官方「单模型」框文字变「已让位」', (s.triggerBefore ?? '').includes('已让位'), s.triggerBefore);
	check('官方框已压暗', Number(s.triggerOpacity) < 0.6, s.triggerOpacity);
	check('官方框已禁点（选了也不生效）', s.triggerPointer === 'none', s.triggerPointer);
	check('开关文案与框一致（都是"开着"语义）',
		s.menuSwitch.includes('已接管') || s.menuSwitch.includes('待设置两席'), s.menuSwitch);
	await page.screenshot({ path: '/tmp/pem-f-2-on-menu.png' });

	/* ============ ④′ 回归：2 秒轮询不能再把 mode 冲掉 ============ */
	console.log('\n【④′ 回归测试：等 2 秒轮询跑过一轮，开关文案不能变回"已关闭"】');
	console.log('    （原根因：/api/state 把 snapshot 的 mode 覆盖成实现通道名，前端每 2 秒轮询就把编排状态冲掉）');
	const pollMode = await page.evaluate(async () => {
		const r = await fetch('/dsh-plan-exec-models/api/state', { credentials: 'same-origin' });
		const j = await r.json();
		return { mode: j.mode, implMode: j.implMode };
	});
	console.log(`    /api/state 直读：${JSON.stringify(pollMode)}`);
	check('/api/state 的 mode 仍是编排状态（active）', pollMode.mode === 'active', pollMode);
	check('/api/state 额外带 implMode（实现通道，不再撞名）', typeof pollMode.implMode === 'string', pollMode);
	await page.waitForTimeout(5000);
	s = await snap();
	console.log(`    等 5 秒后：框="${s.boxText}"  开关="${s.menuSwitch}"`);
	// 核心回归：开着的时候**绝不能**显示"已关闭"（原 bug 就是轮询把状态冲成已关闭）。
	check('开着时开关不显示"已关闭"', !s.menuSwitch.includes('已关闭'), s.menuSwitch);
	// 框与开关必须语义一致：两席齐 → × 与 已接管；两席缺 → 待设置 与 待设置两席。
	const boxReady = s.boxText.includes('×');
	const switchReady = s.menuSwitch.includes('已接管');
	const boxWaiting = s.boxText.includes('待设置');
	const switchWaiting = s.menuSwitch.includes('待设置两席');
	check('框与开关语义一致（不会一个说接管、一个说已关闭）',
		(boxReady && switchReady) || (boxWaiting && switchWaiting),
		{ box: s.boxText, sw: s.menuSwitch });
	check('旗标与状态一致', s.menuSwitchFlag === (boxReady ? '开' : '待'), s.menuSwitchFlag);

	/* ================= ⑤ 从菜单里换一席的模型 ================= */
	console.log('\n【⑤ 点「主管模型」进第二层，选一个模型】');
	await page.evaluate(() => {
		const row = [...document.querySelectorAll('.pem-menu .pem-option')].find((b) => (b.textContent || '').includes('主管模型'));
		if (row !== undefined) row.click();
	});
	await page.waitForTimeout(700);
	s = await snap();
	console.log(`    二级标题="${s.menuTitle}"`);
	check('进入"选择主管模型"面板', s.menuTitle.startsWith('选择主管模型'), s.menuTitle);
	check('二级面板有"返回双模型工作"', await page.evaluate(() => [...document.querySelectorAll('.pem-menu .pem-back')].some((b) => (b.textContent || '').includes('返回双模型工作'))));
	const modelCount = await page.evaluate(() => document.querySelectorAll('.pem-menu .pem-option').length);
	console.log(`    可选模型条目：${modelCount} 个`);
	check('模型列表非空', modelCount > 2, modelCount);
	await page.screenshot({ path: '/tmp/pem-f-3-pick.png' });
	// 选回原来那个模型（选第 1 个带"已选"的，即当前值，避免改配置）
	const picked = await page.evaluate(() => {
		const marked = [...document.querySelectorAll('.pem-menu .pem-option')].find((b) => (b.textContent || '').includes('已选'));
		const target = marked ?? [...document.querySelectorAll('.pem-menu .pem-option')][0];
		if (target === undefined) return null;
		target.click();
		return (target.textContent || '').trim();
	});
	await page.waitForTimeout(1500);
	console.log(`    点了：「${picked}」`);
	s = await snap();
	console.log(`    选完的菜单标题="${s.menuTitle}"（应回到首页并保持打开）`);
	check('选完自动回到"双模型工作"面板', s.menuTitle === '双模型工作', s.menuTitle);
	check('菜单保持打开（方便接着配另一席）', s.menuOpen === true, s.menuOpen);
	check('两席都显示具体模型 → 编排已接管', s.boxText.includes('×'), s.boxText);
	check('接管后开关显示"已接管/开"', s.menuSwitch.includes('已接管') && s.menuSwitchFlag === '开', s.menuSwitch);
	await page.screenshot({ path: '/tmp/pem-f-3b-after-pick.png' });

	/* ================= ⑥ 关掉总开关 → 复原 ================= */
	console.log('\n【⑥ 关掉总开关 → 一切复原】');
	await clickSwitch();
	const afterOff = await getSeats();
	check('Host 已关闭', afterOff.enabled === false, afterOff.enabled);
	s = await snap();
	console.log(`    框文字="${s.boxText}"  dualAttr=${s.dualAttr}`);
	check('框回到"未启用"', s.boxText.includes('未启用'), s.boxText);
	check('官方框恢复可用', s.triggerPointer !== 'none' && Number(s.triggerOpacity) > 0.9, { p: s.triggerPointer, o: s.triggerOpacity });
	check('官方框标签回到「单模型」', (s.triggerBefore ?? '').includes('单模型') && !(s.triggerBefore ?? '').includes('已让位'), s.triggerBefore);
	await page.screenshot({ path: '/tmp/pem-f-4-restored.png' });

	/* ================= ⑦ 还原配置 ================= */
	console.log('\n【⑦ 把 Host 配置还原成进来时的样子】');
	const restored = await putSeats({
		enabled: original.enabled,
		maxRounds: original.seats?.maxRounds,
		maxRetries: original.seats?.maxRetries,
		planProvider: original.seats?.planProvider, planModel: original.seats?.planModel, planEffort: original.seats?.planEffort,
		execProvider: original.seats?.execProvider, execModel: original.seats?.execModel, execEffort: original.seats?.execEffort
	});
	check('原状已还原（enabled）', restored.enabled === original.enabled, restored.enabled);
	check('原状已还原（主管）', restored.seats?.planModel === original.seats?.planModel,
		`${restored.seats?.planModel} vs ${original.seats?.planModel}`);
	check('原状已还原（员工）', restored.seats?.execModel === original.seats?.execModel,
		`${restored.seats?.execModel} vs ${original.seats?.execModel}`);
} finally {
	if (browser !== undefined) await browser.close();
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`);
process.exit(failures === 0 ? 0 : 1);
