// 脱敏版:凭据改从环境变量读取(原文件含本机真实 cookie,不入库)
/**
 * 【真机验证】选择模型菜单：滚到底后继续滚，不应退出菜单。
 *
 * 与 /tmp/pem_menu_scroll.mjs 的差别：
 *   那版是"护栏契约"验证（手工派发事件），本版是**在重启后的真实 App 实例上**
 *   端到端跑一遍，包住开关的开启/还原，保证不给用户留下状态残留。
 *   只有插件 active 时，conversation.input.right 插槽才会渲染出双席 UI。
 *
 * 全程不发送任何消息（不产生对话、不烧 token），只点开关 + 点菜单 + 滚轮。
 *
 * 用法：node /tmp/pem_menu_scroll_live.mjs
 */
import { webkit } from '/Users/azhai/.workbuddy/binaries/node/node_modules/playwright/index.mjs';

const COOKIE_NAME = process.env.DSH_AUTH_NAME || '';
const COOKIE_VALUE = process.env.DSH_AUTH_VALUE || '';
const BASE = 'http://127.0.0.1:47615/';
const API = `${BASE}dsh-plan-exec-models/api/seats`;

let failures = 0;
const checkTrue = (label, condition, hint) => {
	const ok = condition === true;
	if (!ok) failures += 1;
	console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `  实际=${JSON.stringify(hint)}`}`);
};

const headers = { cookie: `${COOKIE_NAME}=${COOKIE_VALUE}`, 'content-type': 'application/json' };
const getSeats = async () => (await fetch(API, { headers })).json();
const patchSeats = async (patch) => (await fetch(API, { method: 'PUT', headers, body: JSON.stringify(patch) })).json();

/* ---------- 0. 记住原状态，开启插件（真机 UI 只在 active 时渲染） ---------- */
const before = await getSeats();
const originalEnabled = before.enabled;
console.log(`\n【前置】插件原状态 enabled=${originalEnabled}，本轮临时开启`);
const on = await patchSeats({ enabled: true });
checkTrue('插件已临时开启（active）', on.enabled === true && on.mode !== 'off', on.mode);
console.log(`    两席：主管=${on.resolved?.plan?.model} / 员工=${on.resolved?.exec?.model}`);

let browser;
try {
	browser = await webkit.launch({ headless: true });
	const context = await browser.newContext({ viewport: { width: 1500, height: 1050 } });
	await context.addCookies([{ name: COOKIE_NAME, value: COOKIE_VALUE, url: BASE, httpOnly: false, secure: false, sameSite: 'Lax' }]);
	const page = await context.newPage();
	await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
	await page.waitForTimeout(11000);

	const menuPresent = () => page.evaluate(() => document.querySelector('.pem-menu') !== null);

	async function openSeatMenu() {
		const opened = await page.evaluate(() => {
			const seat = [...document.querySelectorAll('button[class*="pem-seat"]')].find((b) => (b.textContent || '').includes('主管'));
			if (seat === undefined) return false;
			seat.click();
			return true;
		});
		await page.waitForTimeout(900);
		return opened;
	}

	const geom = () => page.evaluate(() => {
		const menu = document.querySelector('.pem-menu');
		if (menu === null) return { present: false };
		const r = menu.getBoundingClientRect();
		return {
			present: true,
			top: Math.round(r.top),
			bottom: Math.round(r.bottom),
			height: Math.round(r.height),
			scrollTop: Math.round(menu.scrollTop),
			scrollMax: Math.round(menu.scrollHeight - menu.clientHeight),
			inlineMaxHeight: menu.style.maxHeight,
			overscroll: getComputedStyle(menu).overscrollBehaviorY,
			viewportH: window.innerHeight,
			rootScrollY: Math.round(window.scrollY)
		};
	});

	const menuCenter = () => page.evaluate(() => {
		const menu = document.querySelector('.pem-menu');
		if (menu === null) return null;
		const r = menu.getBoundingClientRect();
		return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
	});

	const wheel = async (dy, times) => { for (let i = 0; i < times; i += 1) await page.mouse.wheel(0, dy); };

	const outsideScroll = () => page.evaluate(() => {
		const menu = document.querySelector('.pem-menu');
		if (menu === null) return 'no-menu';
		let node = menu.parentElement;
		while (node !== null && node !== document.documentElement) {
			if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) { node.dispatchEvent(new Event('scroll')); return 'dispatched'; }
			node = node.parentElement;
		}
		return 'no-ancestor';
	});

	/* ================= ① 新代码真的被 App 加载了 ================= */
	console.log('\n【① 重启后的 App 已加载新代码】');
	const loaded = await page.evaluate(() => {
		const tag = document.querySelector('style[data-plugin-css="dsh-plan-exec-models/styles"]');
		return tag !== null && tag.textContent.includes('overscroll-behavior:contain');
	});
	checkTrue('样式表已含 overscroll-behavior:contain（本机磁盘上的新版生效）', loaded, loaded);

	const seatDump = await page.evaluate(() => {
		const btns = [...document.querySelectorAll('button[class*="pem-seat"]')];
		return btns.map((b) => ({ label: (b.textContent || '').trim().slice(0, 30), cls: b.className }));
	});
	console.log('    找到的席位按钮：', JSON.stringify(seatDump));

	/* ================= ② 菜单不溢出视口 ================= */
	console.log('\n【② 菜单高度按可用空间算，不溢出视口】');
	checkTrue('点开了主管席菜单', await openSeatMenu(), { seatDump });
	const box = await geom();
	console.log('    菜单几何：', JSON.stringify(box));
	checkTrue('菜单上边不越界', box.top >= 0, box);
	checkTrue('★ 菜单下边不越界（最后一条看得见）', box.bottom <= box.viewportH, box);
	checkTrue('高度是内联算出来的（不再写死 66vh）', box.inlineMaxHeight !== '' && box.inlineMaxHeight !== undefined, box.inlineMaxHeight);
	checkTrue('CSS 防线在线：overscroll-behavior = contain', box.overscroll === 'contain', box.overscroll);

	/* ================= ③ 滚到底 → 继续猛滚（用户的 bug 点） ================= */
	console.log('\n【③ 滚到底 → 继续猛滚（用户报的 bug 点）】');
	const at = await menuCenter();
	await page.mouse.move(at.cx, at.cy);
	await wheel(400, 10);
	await page.waitForTimeout(600);
	const bottom = await geom();
	console.log('    滚到底：', JSON.stringify(bottom));
	checkTrue('菜单确实已滚动到底部（说明可滚、场景成立）', bottom.scrollTop >= bottom.scrollMax - 2, bottom);

	await wheel(400, 8);
	await page.waitForTimeout(700);
	const after = await geom();
	console.log('    继续滚：', JSON.stringify(after));
	checkTrue('★ 继续滚动后菜单仍然在（不再自动退出）', after.present === true, after);
	checkTrue('菜单仍停在底部（没跳回顶部）', after.scrollTop >= after.scrollMax - 2, after);
	checkTrue('页面背景没有被连带滚动（overscroll 被吃掉）', after.rootScrollY === bottom.rootScrollY, { before: bottom.rootScrollY, after: after.rootScrollY });
	await page.screenshot({ path: '/tmp/pem_menu_scroll_live_bottom.png' });

	/* ================= ④ 护栏契约 ================= */
	console.log('\n【④ 护栏契约：外来的 scroll 到底关不关菜单】');
	await page.waitForTimeout(900);
	const dispatchedA = await outsideScroll();
	await page.waitForTimeout(600);
	const guardA = await menuPresent();
	checkTrue('★ 指针在菜单上时，外来 scroll 不会关菜单（指针护栏独立有效）', guardA === true, { dispatchedA, stillOpen: guardA });

	await page.mouse.move(420, 220);
	await page.mouse.wheel(0, 200);
	await page.waitForTimeout(600);
	checkTrue('★ 滚轮落在菜单外 → 立刻收起（意图信号）', (await menuPresent()) === false, { stillOpen: await menuPresent() });

	checkTrue('重新打开菜单（为 4c 准备）', await openSeatMenu(), false);
	await page.mouse.move(300, 300);
	await page.waitForTimeout(900);
	const dispatchedB = await outsideScroll();
	await page.waitForTimeout(600);
	checkTrue('指针移开后，外来 scroll 仍会正常收起菜单（兜底通道完好）', (await menuPresent()) === false, { dispatchedB, stillOpen: await menuPresent() });

	/* ================= ⑤ 菜单自身可滚 + 常规关闭手段 ================= */
	console.log('\n【⑤ 菜单自身可滚 / 点外面 / Esc】');
	checkTrue('重新打开菜单', await openSeatMenu(), false);
	const at2 = await menuCenter();
	await page.mouse.move(at2.cx, at2.cy);
	await wheel(400, 10);
	await page.waitForTimeout(400);
	await wheel(-400, 10);
	await page.waitForTimeout(600);
	const backTop = await geom();
	console.log('    滚回顶部：', JSON.stringify(backTop));
	checkTrue('向上滚能回到列表顶部（菜单滚动功能完好）', backTop.scrollTop <= 2, backTop);

	await page.mouse.click(300, 300);
	await page.waitForTimeout(600);
	checkTrue('点菜单外仍然会收起菜单', (await menuPresent()) === false, '菜单没关');

	checkTrue('再次打开菜单', await openSeatMenu(), false);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(600);
	checkTrue('Esc 也能收起菜单', (await menuPresent()) === false, '菜单没关');
} finally {
	if (browser !== undefined) await browser.close();
	/* ---------- 还原：不给用户留状态残留 ---------- */
	const restored = await patchSeats({ enabled: originalEnabled });
	const okRestore = restored.enabled === originalEnabled;
	if (!okRestore) failures += 1;
	console.log(`\n【还原】enabled 已恢复为 ${JSON.stringify(originalEnabled)} → 实际 ${JSON.stringify(restored.enabled)} ${okRestore ? '✓' : '✗'}`);
}

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'} ===`);
process.exit(failures === 0 ? 0 : 1);
