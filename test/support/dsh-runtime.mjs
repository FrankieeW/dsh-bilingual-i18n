// 在 Node 里搭一个「真实 DSH 词典环境」：真实的 locale 运行时 + 全部内置客户端插件
// 注册的真实 zh / en 词典。测试和 scripts/calibrate.mjs 共用。
//
// 内置插件的 apply 会调用各种服务，这里给它们一个「什么都接得住」的替身上下文，
// 只关心 ctx.locale.register 落进真实运行时。个别插件跑不完 apply 没关系，
// 它们在出错前注册的词典已经生效。

import vm from 'node:vm';
import { PACKAGES } from './asar.mjs';

const REACT_NAMES = ['memo', 'forwardRef', 'createContext', 'useState', 'useEffect', 'useLayoutEffect', 'useMemo', 'useCallback', 'useRef', 'useContext', 'useReducer', 'useId', 'useSyncExternalStore', 'createElement', 'Fragment', 'Children', 'Component', 'PureComponent', 'lazy', 'Suspense', 'jsx', 'jsxs', 'createPortal'];

/** 任意取属性、任意调用都返回自身的替身。 */
function anything(label) {
	return new Proxy(function stub() {}, {
		get: (_target, prop) => (prop === 'then' ? undefined : prop === Symbol.toPrimitive ? () => '' : prop === Symbol.iterator ? function* empty() {} : anything(`${label}.${String(prop)}`)),
		apply: () => anything(`${label}()`),
		construct: () => anything(`new ${label}`)
	});
}

/** 内置插件 require 的模块替身：React 的常用导出预先摆好，避免模块顶层调用 react.memo 等失败。 */
function stubRequire(id) {
	return new Proxy(Object.fromEntries(REACT_NAMES.map((name) => [name, anything(`${id}.${name}`)])), {
		get: (target, prop) => (prop in target ? target[prop] : prop === 'then' ? undefined : anything(`${id}.${String(prop)}`))
	});
}

function permissiveContext(locale) {
	const swallow = (fn) => {
		try {
			fn();
		} catch {
			// 替身环境里的副作用失败与词典无关
		}
	};
	return new Proxy({}, {
		get(_target, prop) {
			if (prop === 'locale') return locale;
			if (prop === 'effect') return (fn) => swallow(fn);
			if (prop === 'inject') return (_deps, callback) => swallow(() => callback(permissiveContext(locale)));
			if (prop === 'then') return undefined;
			return anything(`ctx.${String(prop)}`);
		}
	});
}

function browserContext(factories) {
	const noop = () => 0;
	const style = () => ({ setProperty() {}, removeProperty() {}, getPropertyValue: () => '' });
	const context = vm.createContext({
		console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
		navigator: { languages: ['zh-CN', 'en'], language: 'zh-CN' },
		document: {
			documentElement: { lang: '', dataset: {}, style: style(), setAttribute() {} },
			body: { dataset: {}, style: style(), appendChild() {}, setAttribute() {} },
			head: { appendChild() {} },
			createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
			querySelector: () => null,
			querySelectorAll: () => [],
			addEventListener() {},
			removeEventListener() {}
		},
		window: { __ModuleLoader__: { load: (entry) => factories.set(entry.id, entry.factory) } },
		// 内置插件的定时器一律不执行，免得它们在测试结束后还在后台跑
		setTimeout: noop,
		clearTimeout: noop,
		setInterval: noop,
		clearInterval: noop,
		requestAnimationFrame: noop,
		queueMicrotask: (fn) => queueMicrotask(fn),
		AbortController,
		AbortSignal,
		URL,
		TextEncoder,
		TextDecoder,
		crypto: globalThis.crypto,
		Intl
	});
	context.globalThis = context;
	return context;
}

/**
 * @param asar - openAsar() 的返回值。
 * @returns { locale, namespaces }：真实的 LocaleRuntime，以及同时有 zh / en 的命名空间列表。
 */
export async function loadDshLocale(asar) {
	const factories = new Map();
	const context = browserContext(factories);

	vm.runInContext(asar.read(`${PACKAGES}/dsh-client-locale/lib/client.js`), context);
	const localeModule = factories.get('@deepseek-ai/dsh-client-locale')(stubRequire);
	const provided = new Map();
	await localeModule.apply({
		fiber: { uid: 1 },
		effect: (fn) => fn(),
		on() {},
		emit() {},
		provide: (name, value) => provided.set(name, value),
		configForms: { get: () => undefined },
		slots: { installLocale() {}, inject() {}, register() {} }
	});
	const locale = provided.get('locale');

	const swallow = () => {};
	process.on('unhandledRejection', swallow);
	try {
		for (const pkg of asar.list(PACKAGES)) {
			if (!/^dsh-(client|experimental-client)-/.test(pkg) || /^dsh-client-(locale|modules|hmr)$/.test(pkg)) continue;
			const entryPath = `${PACKAGES}/${pkg}/lib/client.js`;
			if (!asar.has(entryPath)) continue;
			try {
				vm.runInContext(asar.read(entryPath), context);
				const module = factories.get(`@deepseek-ai/${pkg}`)?.(stubRequire);
				module?.apply?.(permissiveContext(locale), anything('config'))?.catch?.(swallow);
			} catch {
				// 见文件头注释
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		process.off('unhandledRejection', swallow);
	}

	const namespaces = [...locale.dicts].filter(([, locales]) => locales.has('zh') && locales.has('en')).map(([ns]) => ns);
	return { locale, namespaces };
}
