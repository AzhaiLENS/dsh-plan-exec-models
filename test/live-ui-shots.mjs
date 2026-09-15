// 脱敏版:凭据改从环境变量读取(原文件含本机真实 cookie,不入库)
/** 给用户看的两张成品截图：关闭态 / 打开态（菜单开着）。跑完自动还原 Host 状态。 */
import { webkit } from '/Users/azhai/.workbuddy/binaries/node/node_modules/playwright/index.mjs';

const COOKIE_NAME = process.env.DSH_AUTH_NAME || '';
const COOKIE_VALUE = process.env.DSH_AUTH_VALUE || '';
const BASE = 'http://127.0.0.1:47615/';
const API = `${BASE}dsh-plan-exec-models/api/seats`;
const headers = { cookie: `${COOKIE_NAME}=${COOKIE_VALUE}`, 'content-type': 'application/json' };
const get = async () => (await fetch(API, { headers })).json();
const put = async (p) => (await fetch(API, { method: 'PUT', headers, body: JSON.stringify(p) })).json();
const setEnabled = (on) => put({ enabled: on });

const original = await get();
console.log('原状态 enabled =', original.enabled);

const browser = await webkit.launch({ headless: true });
try {
	const context = await browser.newContext({ viewport: { width: 1500, height: 1050 }, deviceScaleFactor: 2 });
	await context.addCookies([{ name: COOKIE_NAME, value: COOKIE_VALUE, url: BASE, httpOnly: false, secure: false, sameSite: 'Lax' }]);
	const page = await context.newPage();
	await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
	await page.waitForTimeout(12000);

	/** 只截输入框那一行 + 菜单。 */
	const clipShot = async (name, clickBox) => {
		if (clickBox) {
			await page.evaluate(() => { const b = document.querySelector('.pem-seat'); if (b !== null) b.click(); });
			await page.waitForTimeout(800);
		}
		const box = await page.evaluate(() => {
			const root = document.querySelector('.pem-root');
			const menu = document.querySelector('.pem-menu');
			if (root === null) return null;
			// 用整行 composer 容器（含官方那一席）当左/右边界，再加菜单。
			// 注意：要往上找到"整行"（宽 ≈ composer 宽度），不能用第一个含官方按钮的
			// 内层容器 —— 那个只有 308px 宽，会把截图右半边裁掉。
			let row = root;
			let n = root;
			for (let i = 0; i < 9 && n !== null; i += 1) {
				const r = n.getBoundingClientRect();
				if (r.width >= 700 && n.querySelector('button[class*="_7KE1Ra_trigger"]') !== null) row = n;
				n = n.parentElement;
			}
			const rects = [row.getBoundingClientRect()];
			if (menu !== null) rects.push(menu.getBoundingClientRect());
			const left = Math.min(...rects.map((r) => r.left));
			const top = Math.min(...rects.map((r) => r.top));
			const right = Math.max(...rects.map((r) => r.right));
			const bottom = Math.max(...rects.map((r) => r.bottom));
			const pad = 18;
			return {
				x: Math.max(0, Math.round(left - pad)),
				y: Math.max(0, Math.round(top - pad)),
				width: Math.round(right - left + pad * 2),
				height: Math.round(bottom - top + pad * 2)
			};
		});
		if (box === null) { console.log('  裁切失败'); return; }
		await page.screenshot({ path: name, clip: box });
		console.log(`  ✓ ${name}  ${box.width}×${box.height}`);
		if (clickBox) {
			await page.evaluate(() => { const b = document.querySelector('.pem-seat'); if (b !== null) b.click(); });
			await page.waitForTimeout(400);
		}
	};

	// ① 关闭态（先确保是关的）
	await setEnabled(false);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(12000);
	await clipShot('/tmp/pem-f-1-closed.png', false);

	// ② 打开态（菜单展开）
	await setEnabled(true);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(12000);
	await clipShot('/tmp/pem-f-2-open.png', true);

	// 还原
	await setEnabled(original.enabled);
	console.log('已还原 enabled =', original.enabled);
} finally {
	await browser.close();
}
