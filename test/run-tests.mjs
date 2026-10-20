// dsh-bilingual-i18n 的自测脚本
//
//   node test/run-tests.mjs        （或 npm test）
//
// [1] 合成规则：5 档词数阈值与单调性、原子条目、占位符、多行文案、语序
// [2] 偏好：本机缓存，Host 配置的采用、迁移、写入合并与只读
// [3] 设置行：用最小的假 React 渲染，检查刻度、滑块值与回调
// [4] 宿主半侧：Config 的默认值、校验与 volatile 标记
// [5] 集成：从本机 app.asar 抽出真实的 locale 运行时和全部内置客户端插件，注册真实
//     词典后运行本插件，逐档断言取词结果，并检查原子条目、占位符、第 5 档预览、
//     迟到的命名空间、卸载清理与重复加载
//
// [4] 的 Config 校验和 [5] 需要本机装有 DeepSeek Harness；找不到 app.asar 时跳过
// （可用 DSH_APP_ASAR 指定路径）。真实界面里的端到端验证见 scripts/e2e.mjs。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { PACKAGES, asarPath, openAsar } from './support/asar.mjs';
import { loadDshLocale } from './support/dsh-runtime.mjs';
import { SegmentedControl, createForm, createHarness, createStorage, findAll, loadPlugin, placeholders, pluginRoot, settle, textOf } from './support/plugin.mjs';

let failures = 0;
function check(label, condition, detail = '') {
	const ok = Boolean(condition);
	if (!ok) failures++;
	console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	return ok;
}

// ─────────────────────────────────────────────────────────────
console.log('\n[1] 合成规则');
// ─────────────────────────────────────────────────────────────
const plugin = loadPlugin();
const { LEVELS, NS_ZH, RatioRow, composeEntry, createPreferences, isAtomic, normalizePrefs, positionOf, wordCount } = plugin;

check('共 5 档，取值 1–5', LEVELS.length === 5 && LEVELS.every((level, index) => level.value === index + 1));
check('词数阈值严格递增：越往右纯英文越多', LEVELS.every((level, index) => index === 0 || level.maxWords > LEVELS[index - 1].maxWords));
check('第 1 档没有纯英文，第 5 档全部纯英文', LEVELS[0].maxWords < 0 && LEVELS[4].maxWords === Infinity);
check('词数不计占位符与标点', wordCount('Delete {provider}?') === 1 && wordCount('{count} · {total}') === 0 && wordCount('Stop and archive this session?') === 5);

const cancel = ['common.cancel', '取消', 'Cancel'];
const newSession = ['session.new', '新建会话', 'New session'];
const archive = ['archive.title', '停止并归档此会话？', 'Stop and archive this session?'];
const sentence = ['models.deleteDescription', '删除 {provider} 会移除其配置和存储的 API 密钥。', 'Deleting {provider} removes its configuration and stored API key.'];
const at = (level, [key, zh, en], order = 'zh-first') => composeEntry(key, zh, en, level, order);

check('第 1 档：全部中英并列', at(1, cancel) === '取消 Cancel' && at(1, sentence).startsWith('删除 {provider}'));
check('第 2 档：单个单词只显示英文', at(2, cancel) === 'Cancel' && at(2, newSession) === '新建会话 New session');
check('第 3 档：两个词以内只显示英文', at(3, newSession) === 'New session' && at(3, archive) === '停止并归档此会话？ Stop and archive this session?');
check('第 4 档：五个词以内只显示英文，长句保留中文', at(4, archive) === 'Stop and archive this session?' && at(4, sentence).startsWith('删除'));
check('第 5 档：全部英文', [cancel, newSession, archive, sentence].every((entry) => at(5, entry) === entry[2]));
check('英文在前', at(1, cancel, 'en-first') === 'Cancel 取消');
check('占位符在两半各保留一份（运行时会全部替换）', at(1, ['x', '删除 {provider}', 'Delete {provider}']) === '删除 {provider} Delete {provider}');

const monotonic = [cancel, newSession, archive, sentence].every((entry) => {
	const englishAt = LEVELS.map((level) => at(level.value, entry) === entry[2]);
	return englishAt.every((english, index) => index === 0 || !englishAt[index - 1] || english);
});
check('一条文案一旦只显示英文，更右的档位保持英文', monotonic);

const markdown = composeEntry('guide', '### 工作方式\n\n直接调用工具。', '### How it works\n\nThe agent calls tools directly to read files.', 1, 'zh-first');
check('多行文案按段落拼接，标题仍在行首', markdown === '### 工作方式\n\n直接调用工具。\n\n### How it works\n\nThe agent calls tools directly to read files.');
check('中英相同时不重复', composeEntry('x', 'Cursor', 'Cursor', 1, 'zh-first') === 'Cursor');
check('缺英文时用中文、缺中文时用英文', composeEntry('x', '只有中文', undefined, 1) === '只有中文' && composeEntry('x', undefined, 'English only', 1) === 'English only');
check('两种都没有时交给运行时的回退链', composeEntry('x', undefined, undefined, 1) === undefined);

const atomicCases = [
	['schedule.manager.time.locale', 'zh-CN', 'en', '语言代码'],
	['settings.webSearch.searchGuideUrl', 'https://api-docs.deepseek.com/zh-cn/guides/search', 'https://api-docs.deepseek.com/guides/search', 'URL'],
	['chat.message.referenceSeparator', '、', ', ', '分隔符'],
	['chat.duration.secondUnit', '秒', 's', '单位'],
	['chat.message.turnProcess.took', '已完成，用时 ', 'Completed in ', '首尾带空格的句子片段'],
	['settings.account.onboardingPurposePrefix', '你希望', 'What would you like', '键名标明的前缀'],
	['reference.time.minutes', '{n}分钟', '{n}min', '单位缩写模板'],
	['schedule.catalog.unit.minute.other', '分钟', 'minutes', 'unit 路径下的词'],
	['conversation.detail.weekday.1', '周一', 'Mon', '星期名'],
	['trajectory.request.retryProgress', '{retry}/{maximum}', '{retry} of {maximum}', '无中文的格式模板']
];
for (const [key, zh, en, label] of atomicCases) {
	check(`原子条目（${label}）只能二选一，不并列`, isAtomic(key, zh, en) && composeEntry(key, zh, en, 1, 'zh-first') === zh && composeEntry(key, zh, en, 5, 'zh-first') === en, JSON.stringify(composeEntry(key, zh, en, 1, 'zh-first')));
}
check('普通文案不是原子条目', [cancel, newSession, ['models.deleteTitle', '删除 {provider}？', 'Delete {provider}?'], ['theme.title', '外观', 'Appearance']].every(([key, zh, en]) => !isAtomic(key, zh, en)));
check('原子条目第 1 档用中文，到其词数对应的档位整体换成英文', at(1, ['time.locale', 'zh-CN', 'en']) === 'zh-CN' && at(2, ['time.locale', 'zh-CN', 'en']) === 'en');

check('偏好校验：非法值回到默认', normalizePrefs({ level: 9, order: 'x' }).level === 1 && normalizePrefs({ level: 9, order: 'x' }).order === 'zh-first');
check('偏好只存第 1–4 档（第 5 档就是内置 English）', normalizePrefs({ level: 5 }).level === 1 && normalizePrefs({ level: 4 }).level === 4);
check('滑块位置：English 或正在预览 English → 5', positionOf({ active: 'en', level: 2, available: true }) === 5 && positionOf({ active: 'zh-en', level: 2, available: true, previewEnglish: true }) === 5);
check('滑块位置：中英双语 → 保存的档位', positionOf({ active: 'zh-en', level: 3, available: true }) === 3);
check('滑块位置：中文等其它语言 → 0（不在区间内）', positionOf({ active: 'zh', level: 3, available: true }) === 0);

// ─────────────────────────────────────────────────────────────
console.log('\n[2] 偏好');
// ─────────────────────────────────────────────────────────────
// createForm 照 DSH 真实的 ConfigFormController：写入串行、只折回最后一次写入、可拒绝 / 断线
{
	const KEY = 'dsh-bilingual-i18n:prefs';
	const cachedPrefs = (storage) => JSON.parse(storage.data.get(KEY));

	const cached = createPreferences(createStorage({ [KEY]: JSON.stringify({ level: 3, order: 'en-first' }) }));
	check('启动时读本机缓存', cached.get().level === 3 && cached.get().order === 'en-first');
	check('缓存损坏时用默认值', createPreferences(createStorage({ [KEY]: '{oops' })).get().level === 1);
	{
		const storage = createStorage();
		const prefs = createPreferences(storage);
		let notified = 0;
		prefs.subscribe(() => notified++);
		prefs.update({ level: 2 });
		prefs.update({ level: 2 });
		check('改动写入缓存且只通知一次', notified === 1 && cachedPrefs(storage).level === 2);
	}

	// 启动：设置表单还在加载时改的值，就绪后补写，不被 Host 的旧值覆盖
	{
		const storage = createStorage();
		const prefs = createPreferences(storage);
		const form = createForm();
		prefs.attachHost(form);
		prefs.update({ level: 2 });
		check('Host 加载中只改本机、不写', form.writes.length === 0 && prefs.get().level === 2 && cachedPrefs(storage).pending.includes('level'));
		form.serve({ value: { level: 3, order: 'zh-first' }, user: { level: 3 } });
		await settle();
		check('就绪后补写加载期间的改动，不被 Host 旧值覆盖', prefs.get().level === 2 && form.doc.user.level === 2 && cachedPrefs(storage).pending.length === 0, JSON.stringify(form.writes));
	}
	{
		const prefs = createPreferences(createStorage({ [KEY]: JSON.stringify({ level: 4, order: 'zh-first' }) }));
		const form = createForm();
		prefs.attachHost(form);
		form.serve({ value: { level: 1, order: 'zh-first' }, user: undefined });
		await settle();
		check('Host 没存过、本机不是默认值：迁移写回 Host', prefs.get().level === 4 && JSON.stringify(form.writes) === '[["level",4]]');
		form.serve({ value: { level: 2, order: 'en-first' }, user: { level: 2, order: 'en-first' } });
		check('Host 上显式保存的值优先（跨浏览器同步）', prefs.get().level === 2 && prefs.get().order === 'en-first');
	}

	// 拖动滑块：连续三次改档，写入途中镜像又推来旧快照
	{
		const prefs = createPreferences(createStorage());
		const form = createForm();
		prefs.attachHost(form);
		form.serve({ value: { level: 4, order: 'zh-first' }, user: { level: 4 } });
		const seen = [];
		prefs.subscribe((state) => seen.push(`${state.level}/${state.order}`));
		prefs.update({ level: 1 });
		prefs.update({ level: 2 });
		prefs.update({ level: 3 });
		form.reload();
		await settle();
		check('连续改档合并写入：一次在路上，写完只补写最新值', JSON.stringify(form.writes) === '[["level",1],["level",3]]', JSON.stringify(form.writes));
		check('写完之前 Host 推来的中间值不会把滑块拽回去', JSON.stringify(seen) === '["1/zh-first","2/zh-first","3/zh-first"]' && form.doc.user.level === 3, JSON.stringify(seen));
	}

	// 同一来回里先改档位再改语序：真实控制器不折回档位那次写入的结果；语序还在路上时，
	// 镜像又因 document-updated 推来一个还不含档位的旧快照
	{
		const prefs = createPreferences(createStorage());
		const form = createForm({}, { delay: 20 });
		prefs.attachHost(form);
		form.serve({ value: { level: 1, order: 'zh-first' }, user: { level: 1, order: 'zh-first' } });
		const stale = form.getSnapshot();
		const seen = [];
		prefs.subscribe((state) => seen.push(`${state.level}/${state.order}`));
		prefs.update({ level: 3 });
		prefs.update({ order: 'en-first' });
		await settle(30);
		form.push(stale);
		await settle(40);
		check('档位和语序先后改、途中推来旧快照：不会跳回旧档位', JSON.stringify(seen) === '["3/zh-first","3/en-first"]' && form.doc.user.level === 3 && form.doc.user.order === 'en-first', JSON.stringify(seen));
	}

	// 断线：写入抛错时保留本机值，Host 恢复后补写
	{
		const storage = createStorage();
		const prefs = createPreferences(storage);
		const form = createForm({}, { mode: 'drop' });
		prefs.attachHost(form);
		form.serve({ value: { level: 1, order: 'zh-first' }, user: { level: 1 } });
		prefs.update({ level: 4 });
		await settle();
		check('写入因连接失败抛错：保留本机值、不回退', prefs.get().level === 4 && cachedPrefs(storage).pending.includes('level') && form.writes.length === 1);
		form.mode = 'accept';
		form.reload();
		await settle();
		check('Host 恢复后自动补写', form.doc.user.level === 4 && prefs.get().level === 4 && cachedPrefs(storage).pending.length === 0);
	}

	// 写入途中插件重载：新实例从缓存里接着补写
	{
		const storage = createStorage();
		const form = createForm();
		form.serve({ value: { level: 1, order: 'zh-first' }, user: { level: 1 } });
		const before = createPreferences(storage);
		const detach = before.attachHost(form);
		before.update({ level: 2 });
		before.update({ level: 3 });
		detach();
		const after = createPreferences(storage);
		after.attachHost(form);
		await settle();
		check('写入途中重载：最新的值仍会写进 Host', after.get().level === 3 && form.doc.user.level === 3 && cachedPrefs(storage).pending.length === 0, JSON.stringify(form.writes));
	}

	// Host 拒绝：以 Host 为准
	{
		const prefs = createPreferences(createStorage());
		const form = createForm({}, { mode: 'refuse' });
		prefs.attachHost(form);
		form.serve({ value: { level: 2, order: 'zh-first' }, user: { level: 2 } });
		prefs.update({ level: 4 });
		await settle();
		check('Host 拒绝写入时回到 Host 的值', prefs.get().level === 2 && JSON.stringify(form.writes) === '[["level",4]]');
	}

	// 不该写的时候不写
	{
		const prefs = createPreferences(createStorage());
		const form = createForm();
		prefs.attachHost(form);
		form.serve({ value: { level: 1, order: 'zh-first' }, user: undefined }, { writable: false });
		prefs.update({ level: 3 });
		await settle();
		check('Host 只读时不写、本机照常', form.writes.length === 0 && prefs.get().level === 3);
	}
	{
		const prefs = createPreferences(createStorage());
		const form = createForm({ status: 'unavailable', writable: true });
		prefs.attachHost(form);
		prefs.update({ level: 3 });
		await settle();
		check('Host 不提供这份配置（unavailable）时不写', form.writes.length === 0 && prefs.get().level === 3);
	}
	{
		const prefs = createPreferences(createStorage());
		const form = createForm();
		const detach = prefs.attachHost(form);
		form.serve({ value: { level: 1, order: 'zh-first' }, user: { level: 1 } });
		prefs.update({ level: 4 });
		await settle();
		detach();
		form.serve({ value: { level: 2, order: 'zh-first' }, user: { level: 2 } });
		check('解绑后不再跟随 Host', prefs.get().level === 4);
	}
}

// ─────────────────────────────────────────────────────────────
console.log('\n[3] 设置行');
// ─────────────────────────────────────────────────────────────
{
	const t = (key, params) => (NS_ZH[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match);
	const render = (view) => {
		const calls = { select: [], order: [] };
		const tree = RatioRow({
			t,
			useBilingual: (selector) => selector(view),
			selectLevel: (value) => calls.select.push(value),
			setOrder: (order) => calls.order.push(order),
			getShares: () => [0, 0.3, 0.57, 0.79, 1]
		});
		return {
			tree,
			calls,
			input: findAll(tree, (node) => node.type === 'input')[0],
			stops: findAll(tree, (node) => node.props?.className === 'dshb-stop'),
			order: findAll(tree, (node) => node.type === SegmentedControl)
		};
	};
	const view = { active: 'zh-en', activeLabel: '中英双语 · Bilingual', available: true, level: 3, order: 'zh-first', revision: 1 };

	const bilingual = render(view);
	check('5 个刻度，标出各档英文占比', bilingual.stops.length === 5 && textOf(bilingual.stops[2]).includes('短语') && textOf(bilingual.stops[2]).includes('57%'));
	check('滑块值等于当前档位，读屏文本带占比', bilingual.input.props.value === 3 && bilingual.input.props['aria-valuetext'] === '短语 · 57%');
	check('中英双语时显示语序切换', bilingual.order.length === 1 && bilingual.order[0].props.value === 'zh-first');
	bilingual.input.props.onChange({ currentTarget: { value: '4' } });
	bilingual.stops[0].props.onClick();
	check('拖动或点刻度都会切档', JSON.stringify(bilingual.calls.select) === '[4,1]');

	// 回归：从第 4 档快速拖到第 1 档再拖回第 4 档时，界面还没来得及重渲染，
	// 回调里的 position 仍是 4；旧实现会把最后这次「拖回 4」当成没变化丢掉
	const stale = render({ ...view, level: 4 });
	for (const value of ['1', '2', '3', '4']) stale.input.props.onChange({ currentTarget: { value } });
	check('快速拖动时不会因渲染滞后丢掉最后一档', JSON.stringify(stale.calls.select) === '[1,2,3,4]', JSON.stringify(stale.calls.select));
	bilingual.order[0].props.onChange('en-first');
	check('语序切换回调', bilingual.calls.order[0] === 'en-first');

	const chinese = render({ ...view, active: 'zh', activeLabel: '中文' });
	check('中文时滑块不落在任何档位，并说明当前语言', findAll(chinese.tree, (node) => node.props?.['data-off'] === true).length === 1 && textOf(chinese.tree).includes('「中文」'));
	chinese.input.props.onClick({ currentTarget: { value: '1' } });
	check('中文时点第 1 档也能切到双语（range 不会触发 change）', chinese.calls.select[0] === 1);
	check('中文时不显示语序切换', chinese.order.length === 0);

	const english = render({ ...view, active: 'en', activeLabel: 'English' });
	check('English 时停在第 5 档，不显示语序切换', english.input.props.value === 5 && english.order.length === 0);

	const unavailable = render({ ...view, active: 'zh', available: false });
	check('词典不可用时禁用并说明原因', unavailable.input.props.disabled === true && textOf(unavailable.tree).includes('无法读取内置词典'));
	const unavailableEnglish = render({ ...view, active: 'en', available: false });
	unavailableEnglish.stops[2].props.onClick();
	unavailableEnglish.input.props.onChange({ currentTarget: { value: '3' } });
	check('词典不可用时即使当前是 English 也整条禁用，点了不切档', unavailableEnglish.input.props.disabled === true && unavailableEnglish.stops.every((stop) => stop.props.disabled === true) && unavailableEnglish.calls.select.length === 0 && textOf(unavailableEnglish.tree).includes('无法读取内置词典'));
}

// ─────────────────────────────────────────────────────────────
console.log('\n[4] 宿主半侧');
// ─────────────────────────────────────────────────────────────
const ASAR = asarPath();
const asarAvailable = fs.existsSync(ASAR);
const asar = asarAvailable ? openAsar(ASAR) : undefined;

{
	const host = await import(pathToFileURL(path.join(pluginRoot, 'lib/index.js')).href);
	check('导出 name / apply', host.name === 'dsh-bilingual-i18n' && typeof host.apply === 'function');
	if (!asarAvailable) {
		console.log(`⏭️  跳过 Config 校验：找不到 app.asar（${ASAR}）`);
	} else {
		// 把运行时的 schemastery 摆进临时 node_modules，导入一份宿主半侧的副本
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bilingual-test-'));
		for (const [pkg, files] of [['schemastery', ['package.json', 'lib/index.mjs']], ['cosmokit', ['package.json', 'lib/index.js']]]) {
			for (const file of files) {
				const target = path.join(tmp, 'node_modules/@deepseek-ai', pkg, file);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, asar.read(`${PACKAGES}/${pkg}/${file}`));
			}
		}
		fs.copyFileSync(path.join(pluginRoot, 'lib/index.js'), path.join(tmp, 'index.mjs'));
		const { Config, apply } = await import(pathToFileURL(path.join(tmp, 'index.mjs')).href);
		const defaults = Config?.({});
		check('Config 默认值：第 1 档、中文在前', defaults?.level.get() === 1 && defaults?.order.get() === 'zh-first');
		check('两个字段都是 volatile（设置改动即时生效）', Config?.dict.level.meta.volatile === true && Config?.dict.order.meta.volatile === true);
		const rejects = (input) => {
			try {
				Config(input);
				return false;
			} catch {
				return true;
			}
		};
		check('拒绝非法档位与语序', rejects({ level: 5 }) && rejects({ level: 0 }) && rejects({ order: 'zh' }));
		const configured = [];
		apply({ fiber: 'fiber', inject: (deps, callback) => callback({ effect: (fn) => fn(), settings: { configure: (options, fiber) => configured.push([deps, options, fiber]) } }) });
		check('声明自带设置界面（不自动生成表单）', configured.length === 1 && configured[0][0][0] === 'settings' && configured[0][1].auto === false && configured[0][2] === 'fiber');
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

// ─────────────────────────────────────────────────────────────
console.log('\n[5] 集成测试（真实 locale 运行时 + 全部内置插件词典）');
// ─────────────────────────────────────────────────────────────
if (!asarAvailable) {
	console.log(`⏭️  跳过：找不到 app.asar（${ASAR}），可用 DSH_APP_ASAR 指定`);
} else {
	const { locale, namespaces: builtIn } = await loadDshLocale(asar);
	check('载入 DSH 的 locale 运行时', Boolean(locale?.dicts));
	const builtInKeys = builtIn.reduce((sum, ns) => sum + Object.keys(locale.dicts.get(ns).get('zh')).length, 0);
	check('注册了真实的内置词典', builtIn.length >= 40 && builtInKeys >= 2000, `${builtIn.length} 个命名空间，${builtInKeys} 条`);

	// 3) 运行本插件。内置插件的上下文把定时器换成了空函数，本插件放在另一个带真实定时器的
	//    上下文里，与 locale 运行时跨上下文协作（浏览器里两者本来就共享同一组对象）
	const warnings = [];
	const pluginContext = vm.createContext({ console: { warn: (...args) => warnings.push(args.join(' ')) }, setTimeout, clearTimeout });
	const ourPlugin = loadPlugin(pluginContext);
	const harness = (form) => createHarness(locale, form);
	const form = createForm({ status: 'ready', value: { level: 1, order: 'zh-first' }, user: undefined, writable: true });
	const first = harness(form);
	ourPlugin.apply(first.ctx);

	const catalog = locale.getSnapshot().locales;
	const added = catalog.filter((item) => item.id !== 'zh' && item.id !== 'en');
	check('只往语言下拉里加一项「中英双语」', added.length === 1 && added[0].id === 'zh-en', catalog.map((item) => item.label).join(' / '));
	check('回退链 zh-en → zh → en（只有中文的词典也不会露出键名）', added[0]?.fallback === 'zh');

	const row = first.rows.find((item) => item.entry.id === 'bilingual-ratio');
	check('滑块行注册进「设置 → 通用」，排在语言行之后', row?.entry.name === 'settings.general.item' && row?.entry.order === 1 && row?.entry.locale === 'dsh.bilingual');
	const actions = row.entry.inject();
	const common = locale.bind('common');
	const zhCommon = locale.dicts.get('common').get('zh');
	const enCommon = locale.dicts.get('common').get('en');

	let renders = 0;
	const stopCounting = locale.subscribe(() => renders++);
	actions.selectLevel(1);
	check('第 1 档：切到中英双语，文案并列', locale.getSnapshot().active === 'zh-en' && common('cancel') === `${zhCommon.cancel} ${enCommon.cancel}`, common('cancel'));

	const mismatches = [];
	const broken = [];
	const englishShare = [];
	for (const level of [1, 2, 3, 4]) {
		renders = 0;
		actions.selectLevel(level);
		if (level > 1 && renders === 0) mismatches.push(`第 ${level} 档没有触发重新渲染`);
		let english = 0;
		let total = 0;
		for (const ns of builtIn) {
			const zh = locale.dicts.get(ns).get('zh');
			const en = locale.dicts.get(ns).get('en');
			const t = locale.bind(ns);
			for (const key of Object.keys(zh)) {
				if (typeof zh[key] !== 'string' || typeof en[key] !== 'string') continue;
				const value = t(key);
				const expected = composeEntry(key, zh[key], en[key], level, 'zh-first');
				if (value !== expected && mismatches.length < 5) mismatches.push(`${ns}:${key} 第 ${level} 档 "${value}" ≠ "${expected}"`);
				const missing = [...placeholders(value === en[key] ? en[key] : value === zh[key] ? zh[key] : `${zh[key]} ${en[key]}`)].filter((name) => !value.includes(name));
				if (missing.length > 0 && broken.length < 5) broken.push(`${ns}:${key} 丢了 ${missing.join(',')}`);
				if (zh[key] === en[key]) continue;
				total += 1;
				if (value === en[key]) english += 1;
			}
		}
		englishShare.push(english / total);
	}
	stopCounting();
	check('每一档的取词结果都与合成规则一致、且切档会重新渲染', mismatches.length === 0, mismatches.join(' ｜ '));
	check('占位符一个不少', broken.length === 0, broken.join(' ｜ '));
	const shares = actions.getShares();
	check('第 1–4 档纯英文占比严格递增', englishShare.every((share, index) => index === 0 || share > englishShare[index - 1]), englishShare.map((share) => `${Math.round(share * 100)}%`).join(' → '));
	check('设置行显示的占比与实际取词一致（0% … 100%）', shares[0] === 0 && shares[4] === 1 && shares.slice(0, 4).every((share, index) => Math.abs(share - englishShare[index]) < 0.02), shares.map((share) => `${Math.round(share * 100)}%`).join(' / '));

	const timeLocales = [];
	const urls = [];
	for (const level of [1, 2, 3, 4]) {
		actions.selectLevel(level);
		for (const ns of ['schedule.manager', 'schedule.catalog']) if (locale.dicts.has(ns)) timeLocales.push(locale.bind(ns)('time.locale'));
		if (locale.dicts.has('settings.webSearch')) urls.push(locale.bind('settings.webSearch')('searchGuideUrl'));
	}
	const validLocale = (tag) => {
		try {
			return Intl.DateTimeFormat.supportedLocalesOf([tag]).length === 1;
		} catch {
			return false;
		}
	};
	const validUrl = (text) => {
		try {
			return new URL(text).protocol === 'https:';
		} catch {
			return false;
		}
	};
	check('日期格式用的语言代码在每一档都合法', timeLocales.length > 0 && timeLocales.every(validLocale), [...new Set(timeLocales)].join(', '));
	check('文档链接在每一档都是一个合法 URL', urls.length > 0 && urls.every(validUrl));

	// 斜杠指令：输入框里的 /goal 用 t('token.goal') 当拼写，DSH 只认原词典里的「目标」或「goal」
	const commandZh = locale.dicts.get('command')?.get('zh') ?? {};
	const commandEn = locale.dicts.get('command')?.get('en') ?? {};
	const tokenKeys = Object.keys(commandZh).filter((key) => key.startsWith('token.'));
	const badTokens = [];
	for (const level of [1, 2, 3, 4]) {
		actions.selectLevel(level);
		for (const order of ['zh-first', 'en-first']) {
			actions.setOrder(order);
			const spelled = locale.bind('command');
			for (const key of tokenKeys) if (![commandZh[key], commandEn[key]].includes(spelled(key))) badTokens.push(`第 ${level} 档 ${key}="${spelled(key)}"`);
		}
	}
	actions.setOrder('zh-first');
	check('斜杠指令的拼写每一档都是 DSH 认得的写法（不会拼成「目标 goal」）', tokenKeys.length > 0 && badTokens.length === 0, badTokens.slice(0, 3).join(' ｜ ') || `${tokenKeys.length} 个指令`);

	actions.selectLevel(1);
	actions.setOrder('en-first');
	check('语序切到英文在前', common('cancel') === `${enCommon.cancel} ${zhCommon.cancel}`, common('cancel'));
	actions.setOrder('zh-first');
	actions.selectLevel(3);
	await settle();
	const saved = form.getSnapshot().user;
	check('档位与语序写回 Host 配置', saved?.level === 3 && saved?.order === 'zh-first' && form.writes.some(([field, value]) => field === 'order' && value === 'en-first'), JSON.stringify(saved));

	const lateDispose = locale.register('late.plugin', { zh: { greet: '你好 {name}', ok: '好的' }, en: { greet: 'Hello {name}', ok: 'Fine' } });
	actions.selectLevel(1);
	check('之后才注册的插件词典自动纳入', locale.bind('late.plugin')('greet', { name: 'DSH' }) === '你好 DSH Hello DSH', locale.bind('late.plugin')('greet', { name: 'DSH' }));
	lateDispose();
	const zhOnlyDispose = locale.register('zh.only', 'zh', { tip: '只有中文' });
	check('只有中文的词典显示中文而不是键名', locale.bind('zh.only')('tip') === '只有中文');
	zhOnlyDispose();

	const setLocale = locale.setLocale.bind(locale);
	let setLocaleCalls = 0;
	locale.setLocale = (id) => {
		setLocaleCalls += 1;
		return setLocale(id);
	};
	renders = 0;
	await settle();
	const writesBefore = form.writes.length;
	const stopCountingAgain = locale.subscribe(() => renders++);
	actions.selectLevel(1);
	await settle();
	stopCountingAgain();
	check('重复选当前档什么也不做（不重渲染、不写 Host）', renders === 0 && setLocaleCalls === 0 && form.writes.length === writesBefore);

	const ENGLISH_DELAY = 400;
	const rowView = () => actions.hooks.bilingual.getSnapshot();
	actions.selectLevel(5);
	check('选第 5 档立刻显示纯英文，滑块停在第 5 档', common('cancel') === enCommon.cancel && rowView().previewEnglish === true && setLocaleCalls === 0);
	actions.selectLevel(4);
	actions.selectLevel(5);
	actions.selectLevel(4);
	await new Promise((resolve) => setTimeout(resolve, ENGLISH_DELAY + 100));
	check('在第 4、5 档之间来回拖不写语言偏好', setLocaleCalls === 0 && locale.getSnapshot().active === 'zh-en' && rowView().previewEnglish === false && common('cancel') === enCommon.cancel);
	actions.selectLevel(5);
	actions.selectLevel(5);
	await new Promise((resolve) => setTimeout(resolve, ENGLISH_DELAY + 100));
	check('在第 5 档停稳后切到内置 English，只写一次', locale.getSnapshot().active === 'en' && common('cancel') === enCommon.cancel && setLocaleCalls === 1);

	actions.selectLevel(1);
	actions.selectLevel(5);
	locale.setLocale('zh');
	await new Promise((resolve) => setTimeout(resolve, ENGLISH_DELAY + 100));
	check('预览期间从语言下拉改选中文，放弃切到 English', locale.getSnapshot().active === 'zh' && rowView().previewEnglish === false);
	delete locale.setLocale;

	actions.selectLevel(2);
	actions.selectLevel(5);
	first.dispose();
	const leftovers = [...locale.dicts].filter(([, locales]) => locales.has('zh-en')).map(([ns]) => ns);
	check('卸载后不留任何注册，界面退回可用语言', leftovers.length === 0 && !locale.getSnapshot().locales.some((item) => item.id === 'zh-en') && locale.getSnapshot().active !== 'zh-en', leftovers.join(', '));

	// 预览第 5 档时卸载、马上又重新加载（HMR / 重新启用）：语言偏好仍是 zh-en，所以中英双语重新生效；
	// 旧实例的定时器要是没取消，400ms 后会把界面切到 English
	warnings.length = 0;
	const second = harness(undefined);
	ourPlugin.apply(second.ctx);
	check('重复加载（HMR / 重新启用）不报「已注册」，偏好仍生效', warnings.length === 0 && locale.getSnapshot().active === 'zh-en', warnings.join(' ｜ '));
	await new Promise((resolve) => setTimeout(resolve, ENGLISH_DELAY + 100));
	check('卸载时取消了还没执行的 English 切换', locale.getSnapshot().active === 'zh-en', locale.getSnapshot().active);
	second.rows[0].entry.inject().selectLevel(1);
	check('重新加载后照常工作', common('cancel') === `${zhCommon.cancel} ${enCommon.cancel}`, common('cancel'));
	second.dispose();
}

console.log(`\n${failures === 0 ? '🎉 全部通过' : `⚠️  ${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
