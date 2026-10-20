// 用本机 DSH 的真实词典标定 5 档：各档纯英文占比、英文词数分布、原子条目清单。
//
//   node scripts/calibrate.mjs              占比 + 词数分布
//   node scripts/calibrate.mjs --atomic     另列出全部原子条目（只能二选一、不并列的）
//   node scripts/calibrate.mjs --key chat:chat.deepDivingFor   看某一条在各档的结果
//
// DSH 升级或改动 lib/client.js 的规则后跑一次，确认各档占比仍单调递增、间隔大致均匀，
// 原子条目里没有混进本该并列的普通文案。需要本机装有 DeepSeek Harness（DSH_APP_ASAR 可改路径）。

import fs from 'node:fs';
import { asarPath, openAsar } from '../test/support/asar.mjs';
import { loadDshLocale } from '../test/support/dsh-runtime.mjs';
import { loadPlugin } from '../test/support/plugin.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};

const file = asarPath();
if (!fs.existsSync(file)) {
	console.error(`找不到 app.asar：${file}（可用 DSH_APP_ASAR 指定）`);
	process.exit(1);
}

const { LEVELS, composeEntry, isAtomic, wordCount } = loadPlugin();
const { locale, namespaces } = await loadDshLocale(openAsar(file));

const entries = [];
for (const ns of namespaces) {
	const zh = locale.dicts.get(ns).get('zh');
	const en = locale.dicts.get(ns).get('en');
	for (const key of Object.keys(zh)) {
		if (typeof zh[key] === 'string' && typeof en[key] === 'string' && zh[key] !== en[key]) entries.push({ ns, key, zh: zh[key], en: en[key] });
	}
}

const percent = (count) => `${((count / entries.length) * 100).toFixed(1)}%`;
console.log(`${namespaces.length} 个命名空间，${entries.length} 条中英不同的文案\n`);

console.log('各档只显示英文的占比：');
for (const level of LEVELS) {
	const english = entries.filter((entry) => composeEntry(entry.key, entry.zh, entry.en, level.value, 'zh-first') === entry.en).length;
	const rule = level.maxWords < 0 ? '无' : level.maxWords === Infinity ? '全部' : `≤ ${level.maxWords} 词`;
	console.log(`  第 ${level.value} 档 ${level.key.padEnd(9)} ${rule.padEnd(6)} ${percent(english)}`);
}

const histogram = new Map();
for (const entry of entries) {
	const words = Math.min(wordCount(entry.en), 10);
	histogram.set(words, (histogram.get(words) ?? 0) + 1);
}
console.log('\n英文词数分布（10 = 10 词及以上）：');
for (const [words, count] of [...histogram].sort(([a], [b]) => a - b)) console.log(`  ${String(words).padStart(2)} 词  ${String(count).padStart(5)}  ${percent(count)}`);

const atomic = entries.filter((entry) => isAtomic(entry.key, entry.zh, entry.en));
console.log(`\n原子条目：${atomic.length} 条（${percent(atomic.length)}）${flag('--atomic') ? '' : '，加 --atomic 列出'}`);
if (flag('--atomic')) {
	for (const entry of atomic) console.log(`  ${entry.ns}:${entry.key}  zh=${JSON.stringify(entry.zh).slice(0, 50)}  en=${JSON.stringify(entry.en).slice(0, 50)}`);
}

const target = option('--key');
if (target !== undefined) {
	const separator = target.indexOf(':');
	const entry = entries.find((item) => item.ns === target.slice(0, separator) && item.key === target.slice(separator + 1));
	if (entry === undefined) {
		console.log(`\n没有找到 ${target}（格式：命名空间:键，且中英文案不同）`);
	} else {
		console.log(`\n${target}（${wordCount(entry.en)} 词，${isAtomic(entry.key, entry.zh, entry.en) ? '原子条目' : '可并列'}）`);
		for (const level of LEVELS) console.log(`  第 ${level.value} 档：${JSON.stringify(composeEntry(entry.key, entry.zh, entry.en, level.value, 'zh-first'))}`);
	}
}
