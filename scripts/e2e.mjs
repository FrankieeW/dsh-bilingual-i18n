// 在真实的 DSH 界面里端到端验证本插件，不碰 ~/.dsh 里你自己的 profile。
//
//   npm install            # 首次：装 playwright-core（只用来驱动浏览器）
//   npm run e2e            # 跑完自动关服务；截图在 .e2e/shots/
//   npm run e2e -- --keep  # 跑完不关服务，打印地址，方便手动看
//
// 过程：用临时 DSH_HOME（.e2e/home）建一个 web profile，`dsh plugin add link:` 装上本插件，
// `dsh --profile web --port 0` 起服务；再用本机的 Chrome for Testing 打开「设置 → 通用」，
// 依次走：初始（中文）→ 第 1 档 → 第 3 档 → 语序 → 语言下拉 → 重载后偏好仍在 →
// 快速往返拖动 → 第 4、5 档之间来回拖 → 暗色截图。
//
// 环境变量：DSH_CLI（dsh 可执行文件）、CHROME_PATH（浏览器可执行文件）。

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { pluginRoot } from '../test/support/plugin.mjs';

const DSH_CLI = process.env.DSH_CLI ?? '/Applications/Homebrew Casks/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const KEEP = process.argv.includes('--keep');
const E2E_DIR = path.join(pluginRoot, '.e2e');
const HOME = path.join(E2E_DIR, 'home');
const SHOTS = path.join(E2E_DIR, 'shots');

let failures = 0;
function check(label, condition, detail = '') {
	const ok = Boolean(condition);
	if (!ok) failures++;
	console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	return ok;
}

/** 优先 CHROME_PATH，其次 Playwright 缓存里最新的 Chrome for Testing，最后系统 Chrome。 */
function findChrome() {
	if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
	const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
	const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
	for (const build of builds) {
		for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
			const candidate = path.join(cache, build, arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	const system = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
	return fs.existsSync(system) ? system : undefined;
}

/** 新建隔离的 web profile 并启动服务，返回 { url, pid, stop }；pid 是服务所在进程组的 id。 */
async function startServer() {
	fs.rmSync(HOME, { recursive: true, force: true });
	fs.mkdirSync(HOME, { recursive: true });
	const env = { ...process.env, DSH_HOME: HOME };
	execFileSync(DSH_CLI, ['plugin', '--profile', 'web', 'add', `link:${pluginRoot}`], { env, stdio: 'ignore' });
	const server = spawn(DSH_CLI, ['--profile', 'web', '--no-open', '--port', '0'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	const exited = new Promise((resolve) => server.once('exit', resolve));
	const signal = (name) => {
		try {
			process.kill(-server.pid, name);
		} catch {
			// 已经退出
		}
	};
	/** DSH 收到 SIGTERM 会优雅退出；5 秒还没退就强杀。 */
	const stop = async () => {
		signal('SIGTERM');
		const timer = setTimeout(() => signal('SIGKILL'), 5000);
		await exited;
		clearTimeout(timer);
	};
	const url = await new Promise((resolve, reject) => {
		let output = '';
		const timer = setTimeout(() => reject(new Error(`dsh web 60 秒内没有就绪：\n${output}`)), 60_000);
		const onData = (chunk) => {
			output += chunk;
			const match = output.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
			if (match) {
				clearTimeout(timer);
				resolve(match[0]);
			}
		};
		server.stdout.on('data', onData);
		server.stderr.on('data', onData);
		server.on('exit', (code) => reject(new Error(`dsh web 提前退出（${code}）：\n${output}`)));
	});
	return { url, pid: server.pid, stop };
}

async function openSettings(page, url) {
	await page.goto(url);
	await page.getByText(/^(更多|More)$/).first().waitFor({ timeout: 60_000 });
	// 全新的 DSH_HOME 首屏会弹好几层全屏遮罩：「预览版说明」、「等待登录」……
	// 它们盖住整个视口（z-index 1000），侧栏底部的「更多」正好在下面，点不动。
	// 能按文案点掉就点掉；点不掉（登录引导一直在）就把遮罩摘了 —— 这一步只想测插件。
	const dismiss = /^(继续|取消|关闭|稍后|跳过|Continue|Cancel|Close|Skip|Later)$/;
	for (let round = 0; round < 6; round++) {
		const overlay = page.locator('[role=presentation]').filter({ has: page.locator('[class*="mask"]') }).last();
		if (!(await overlay.isVisible().catch(() => false))) break;
		const button = overlay.getByRole('button', { name: dismiss }).first();
		await button.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
		if (await button.isEnabled().catch(() => false)) {
			await button.click({ timeout: 10_000 }).catch(() => {});
			await page.waitForTimeout(500);
			continue;
		}
		await overlay.evaluate((node) => node.remove());
		await page.waitForTimeout(200);
	}
	await page.getByText(/^(更多|More)$/).first().click();
	await page.getByRole('menuitem', { name: /设置|Settings/ }).first().click();
	await page.locator('.dshb-row').waitFor();
}

async function state(page) {
	return page.evaluate(() => ({
		lang: document.documentElement.lang,
		value: document.querySelector('.dshb-input')?.value,
		off: document.querySelector('.dshb-track')?.dataset.off === 'true',
		title: document.querySelector('.dshb-title')?.innerText,
		caption: document.querySelector('.dshb-desc')?.innerText,
		shares: [...document.querySelectorAll('.dshb-stop-share')].map((node) => node.innerText)
	}));
}

/** 按住滑块，沿给定档位依次拖动（档位 1–5），每段 steps 步。 */
async function drag(page, stops, steps = 10) {
	const box = await page.locator('.dshb-input').boundingBox();
	const xAt = (level) => box.x + 8 + (box.width - 16) * ((level - 1) / 4);
	const y = box.y + box.height / 2;
	await page.mouse.move(xAt(stops[0]), y);
	await page.mouse.down();
	for (let index = 1; index < stops.length; index++) {
		for (let step = 1; step <= steps; step++) await page.mouse.move(xAt(stops[index - 1]) + (xAt(stops[index]) - xAt(stops[index - 1])) * (step / steps), y);
	}
	await page.mouse.up();
}

async function shot(page, name) {
	await page.locator('.dshb-row').screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const chrome = findChrome();
if (!fs.existsSync(DSH_CLI)) {
	console.error(`找不到 dsh：${DSH_CLI}（可用 DSH_CLI 指定）`);
	process.exit(1);
}
fs.mkdirSync(SHOTS, { recursive: true });
const { url, pid, stop } = await startServer();
const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', deviceScaleFactor: 2 });
	const page = await context.newPage();
	const problems = [];
	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`);
	});
	page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

	await openSettings(page, url);
	let current = await state(page);
	await shot(page, '1-chinese');
	check('设置 → 通用里出现「英文占比」行，中文界面下滑块不落档', current.title === '英文占比' && current.off, JSON.stringify(current.shares));
	check('各档英文占比从 0% 递增到 100%', current.shares[0] === '0%' && current.shares[4] === '100%' && current.shares.map((share) => parseInt(share, 10)).every((share, index, all) => index === 0 || share > all[index - 1]));

	await page.locator('.dshb-stop').nth(0).click();
	await page.waitForTimeout(500);
	current = await state(page);
	await shot(page, '2-bilingual');
	check('第 1 档：切到中英双语，标题中英并列', current.lang === 'zh-en' && current.title === '英文占比 English share', current.title);

	await page.locator('.dshb-stop').nth(2).click();
	await page.waitForTimeout(500);
	current = await state(page);
	check('第 3 档：两个词的标题只剩英文', current.value === '3' && current.title === 'English share', current.title);

	await page.locator('.dshb-order [role=tab]').nth(1).click();
	await page.waitForTimeout(500);
	current = await state(page);
	await shot(page, '3-phrases-en-first');
	check('语序切到英文在前', current.caption.startsWith('Phrases'), current.caption.slice(0, 40));

	await page.locator('[aria-haspopup=menu]').filter({ hasText: '中英双语' }).first().click();
	const languages = await page.locator('[role=menu] [role^=menuitem]').allInnerTexts();
	await page.keyboard.press('Escape');
	check('语言下拉只多一项「中英双语」', languages.length === 3 && languages.includes('中英双语 · Bilingual'), languages.join(' / '));

	await openSettings(page, url);
	current = await state(page);
	const patch = fs.readFileSync(path.join(HOME, 'profiles/web/cordis.patch.yml'), 'utf8');
	check('重载后档位与语序仍在，并写进了 profile', current.lang === 'zh-en' && current.value === '3' && current.caption.startsWith('Phrases') && /level: 3/.test(patch) && /order: en-first/.test(patch));

	await page.locator('.dshb-stop').nth(3).click();
	await page.waitForTimeout(500);
	const landed = [];
	for (let round = 0; round < 3; round++) {
		await drag(page, [4, 1, 4], 6);
		await page.waitForTimeout(600);
		landed.push((await state(page)).value);
	}
	check('快速往返拖动（4 → 1 → 4）每次都停在第 4 档', landed.every((value) => value === '4'), landed.join(','));

	await drag(page, [3, 5, 3, 5], 6);
	const samples = [];
	for (let index = 0; index < 8; index++) {
		await page.waitForTimeout(150);
		const sample = await state(page);
		samples.push(`${sample.value}/${sample.lang}`);
	}
	check('在第 4、5 档之间来回拖，松手后稳定在第 5 档、不闪回', samples.every((sample) => sample.startsWith('5/')) && samples.at(-1) === '5/en', samples.join(' '));

	await drag(page, [5, 2], 8);
	await page.waitForTimeout(800);
	current = await state(page);
	await shot(page, '4-words');
	check('从 English 拖回第 2 档', current.value === '2' && current.lang === 'zh-en');

	// 在第 5 档停够 400ms（已真正切到内置 English），马上又点回第 4 档。
	// 用 MutationObserver 记下 <html lang> 的每一次变化，哪怕只闪一帧也能抓到
	await page.locator('.dshb-stop').nth(4).click();
	await page.waitForTimeout(450);
	await page.evaluate(() => {
		window.__langTrail = [document.documentElement.lang];
		new MutationObserver(() => window.__langTrail.push(document.documentElement.lang)).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
	});
	await page.locator('.dshb-stop').nth(3).click();
	await page.waitForTimeout(1500);
	const trail = await page.evaluate(() => window.__langTrail);
	check('从 English 马上回到第 4 档，不闪回 English', trail.join(' → ') === 'en → zh-en', trail.join(' → '));
	check('控制台没有错误和警告', problems.length === 0, problems.slice(0, 3).join(' ｜ '));

	const dark = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', colorScheme: 'dark', deviceScaleFactor: 2 });
	const darkPage = await dark.newPage();
	await openSettings(darkPage, url);
	await shot(darkPage, '5-dark');
	console.log(`\n截图：${SHOTS}`);
} finally {
	await browser.close();
	if (KEEP) console.log(`\n服务仍在运行：${url}\n关闭：kill -TERM -${pid}`);
	else await stop();
}

console.log(`\n${failures === 0 ? '🎉 全部通过' : `⚠️  ${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
