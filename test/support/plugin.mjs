// 在 Node 里加载本插件的浏览器半侧，以及测试用的各种替身。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientSource = fs.readFileSync(path.join(pluginRoot, 'lib/client.js'), 'utf8');

/** 最小 React：createElement 生成普通对象树，useId 返回固定值。 */
export const fakeReact = {
	createElement: (type, props, ...children) => ({
		type,
		props: props ?? {},
		children: children.flat(Infinity).filter((child) => child !== false && child !== null && child !== undefined)
	}),
	useId: () => ':r0:'
};

export function createSnapshotStore(initial) {
	let value = initial;
	const listeners = new Set();
	return {
		getSnapshot: () => value,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			value = next;
			for (const listener of [...listeners]) listener();
		}
	};
}

export function SegmentedControl() {
	return null;
}

function pluginRequire(id) {
	if (id === 'react') return fakeReact;
	if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore };
	if (id === '@deepseek-ai/dsh-client-ui-primitives') return { SegmentedControl };
	throw new Error(`unexpected require: ${id}`);
}

/**
 * 在给定的 VM 上下文里执行 lib/client.js，返回它注册的模块导出。
 * @param context - 默认新建一个只有 console 的上下文（没有定时器、没有 localStorage）。
 */
export function loadPlugin(context = vm.createContext({ console })) {
	let factory;
	context.window = { ...context.window, __ModuleLoader__: { load: (entry) => { factory = entry.factory; } } };
	vm.runInContext(clientSource, context);
	return factory(pluginRequire);
}

export function createStorage(initial = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, String(value));
		}
	};
}

/**
 * 假的 configForms 表单，照 DSH 的 ConfigFormController（dsh-client-ui-settings）实现：
 * - 同一表单的写入串行执行；
 * - 写入被接受后，只有它仍是最后一次排队的写入时才把 Host 文档折回快照（generation 规则）；
 * - mode 'refuse'：Host 拒绝，控制器重新读取镜像后 resolve(false)；
 * - mode 'drop'：传输层出错（比如连接断了），直接 reject，快照不动。
 * doc 是 Host 上的文档；serve() 模拟 Host 推来就绪快照，reload() 模拟镜像整体刷新。
 */
export function createForm({ status = 'loading', value, user, writable = status === 'ready' } = {}, { mode = 'accept', delay = 1 } = {}) {
	const listeners = new Set();
	const doc = { value: { ...value }, user: user === undefined ? undefined : { ...user } };
	let current = { status, value, user, writable };
	let tail = Promise.resolve();
	let writeGeneration = 0;
	const push = (next) => {
		current = next;
		for (const listener of [...listeners]) listener();
	};
	const snapshotOfDoc = () => ({ value: { ...doc.value }, user: doc.user === undefined ? undefined : { ...doc.user } });
	const form = {
		mode,
		doc,
		writes: [],
		push,
		getSnapshot: () => current,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		serve(next, { writable: nextWritable = true } = {}) {
			doc.value = { ...next.value };
			doc.user = next.user === undefined ? undefined : { ...next.user };
			push({ status: 'ready', ...snapshotOfDoc(), writable: nextWritable });
		},
		reload() {
			push({ ...current, status: 'ready', ...snapshotOfDoc() });
		},
		set(field, next) {
			form.writes.push([field, next]);
			const generation = ++writeGeneration;
			const task = tail.then(() => new Promise((resolve, reject) => setTimeout(() => {
				if (form.mode === 'drop') {
					reject(new Error('socket closed'));
					return;
				}
				if (form.mode === 'refuse') {
					form.reload();
					resolve(false);
					return;
				}
				doc.value = { ...doc.value, [field]: next };
				doc.user = { ...doc.user, [field]: next };
				if (generation === writeGeneration) form.reload();
				resolve(true);
			}, delay)));
			tail = task.then(() => {}, () => {});
			return task;
		}
	};
	return form;
}

/** 本插件 apply 用的上下文替身：记录 effect 的 disposer 和注册的设置行。 */
export function createHarness(locale, form) {
	const disposers = [];
	const rows = [];
	const ctx = {
		locale,
		effect(fn) {
			const dispose = fn();
			if (typeof dispose === 'function') disposers.push(dispose);
		},
		inject(deps, callback) {
			if (deps.includes('configForms') && form !== undefined) callback({ configForms: { get: () => form }, effect: ctx.effect });
		},
		slots: {
			inject: (_name, callback) => callback(),
			register(entry, component) {
				rows.push({ entry, component });
				return () => {};
			}
		}
	};
	return { ctx, rows, dispose: () => disposers.splice(0).reverse().forEach((dispose) => dispose()) };
}

export const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

export function findAll(node, predicate, found = []) {
	if (node === null || typeof node !== 'object') return found;
	if (predicate(node)) found.push(node);
	for (const child of node.children ?? []) findAll(child, predicate, found);
	return found;
}

export function textOf(node) {
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	return (node?.children ?? []).map(textOf).join(' ');
}

export function placeholders(text) {
	return new Set(text.match(/\{\w+\}/g) ?? []);
}
