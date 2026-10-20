// dsh-bilingual-i18n —— 浏览器半侧
//
// 「英文占比」滑块：最左中英双语，最右纯英文，共 5 档。越往右，只显示英文的文案
// 越多——按英文的词数由短到长逐批切换：先是单个单词，再是短语、短句，最后全部。
//
//   档 | 名称 | 只显示英文的文案（英文词数，不计占位符） | 内置词典实测占比
//   1  | 双语 | 无，全部「中文 English」并列              | 0%
//   2  | 单词 | ≤ 1 个词                                 | ≈ 30%
//   3  | 短语 | ≤ 2 个词                                 | ≈ 57%
//   4  | 短句 | ≤ 5 个词                                 | ≈ 80%
//   5  | 英文 | 全部（切到内置 English）                  | 100%
//
// 第 1–4 档共用一门语言「中英双语」（id zh-en）。它的词典不是静态表，而是一组
// Proxy：取词时读取运行时里已注册的 zh / en 词典，按当前档位现算。所以切档只需
// 让运行时刷新一次渲染，之后才加载的插件词典也会自动纳入。
//
// 依赖的公开 API（@deepseek-ai/dsh-client-locale）：addLanguage / register /
// subscribe / getSnapshot / setLocale；另读取内部字段 locale.dicts
// （ns → Map(locale → 词典)）。该字段若改名，插件不注册语言，滑块行提示不可用。
window.__ModuleLoader__.load({
	id: 'dsh-bilingual-i18n',
	factory: (require) => {
		const module = { exports: {} };
		const React = require('react');
		const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
		const { SegmentedControl } = require('@deepseek-ai/dsh-client-ui-primitives');

		//#region 常量
		const PLUGIN_ID = 'dsh-bilingual-i18n';
		/** Host 侧配置所在的 profile entry id（见 cordis.patch.yml）。 */
		const ENTRY_ID = 'dsh-bilingual-i18n';
		/** 第 1–4 档共用的语言；沿用旧版 id，选过旧版第 1 档的用户无需重选。 */
		const LOCALE_ID = 'zh-en';
		const LOCALE_LABEL = '中英双语 · Bilingual';
		const ENGLISH = 'en';
		const NS = 'dsh.bilingual';
		const STORAGE_KEY = 'dsh-bilingual-i18n:prefs';

		/** maxWords：英文词数不超过它的文案只显示英文。 */
		const LEVELS = Object.freeze([
			Object.freeze({ value: 1, key: 'bilingual', maxWords: -1 }),
			Object.freeze({ value: 2, key: 'words', maxWords: 1 }),
			Object.freeze({ value: 3, key: 'phrases', maxWords: 2 }),
			Object.freeze({ value: 4, key: 'sentences', maxWords: 5 }),
			Object.freeze({ value: 5, key: 'english', maxWords: Infinity })
		]);
		const ENGLISH_LEVEL = 5;
		/** 选第 5 档后停稳多久才真正切到内置 English（毫秒）。 */
		const ENGLISH_DELAY = 400;
		/** 能存进偏好的档位；第 5 档就是内置 English，由语言偏好本身记住。 */
		const STORED_LEVELS = [1, 2, 3, 4];
		const ORDERS = ['zh-first', 'en-first'];
		const DEFAULT_PREFS = Object.freeze({ level: 1, order: 'zh-first' });
		const PREF_FIELDS = Object.keys(DEFAULT_PREFS);
		const NO_SHARES = Object.freeze([0, 0, 0, 0, 1]);

		const NS_ZH = {
			'ratio.title': '英文占比',
			'ratio.caption.off': '当前界面语言为「{language}」。拖动滑块或点选任一档，即可切换为中英混合界面。',
			'ratio.caption.unavailable': '当前 DSH 版本无法读取内置词典，中英双语暂不可用。',
			'ratio.caption.bilingual': '所有文案中英并列。',
			'ratio.caption.words': '单个英文单词只显示英文，其余中英并列。',
			'ratio.caption.phrases': '两个词以内的短语只显示英文，其余中英并列。',
			'ratio.caption.sentences': '五个词以内的短句只显示英文，长句保留中文对照。',
			'ratio.caption.english': '界面全部为英文，即内置的 English。',
			'ratio.level.bilingual': '双语',
			'ratio.level.words': '单词',
			'ratio.level.phrases': '短语',
			'ratio.level.sentences': '短句',
			'ratio.level.english': '英文',
			'ratio.order': '中英顺序',
			'ratio.order.zhFirst': '中文在前',
			'ratio.order.enFirst': '英文在前',
			'ratio.order.zhFirst.short': '中 EN',
			'ratio.order.enFirst.short': 'EN 中'
		};
		const NS_EN = {
			'ratio.title': 'English share',
			'ratio.caption.off': 'The interface language is {language}. Drag the slider or pick a stop to switch to mixed Chinese and English.',
			'ratio.caption.unavailable': 'This DSH version does not expose its dictionaries, so the bilingual interface is unavailable.',
			'ratio.caption.bilingual': 'Every string shows Chinese and English side by side.',
			'ratio.caption.words': 'Single words show English only; everything else stays bilingual.',
			'ratio.caption.phrases': 'Phrases of up to two words show English only; everything else stays bilingual.',
			'ratio.caption.sentences': 'Sentences of up to five words show English only; longer ones keep the Chinese.',
			'ratio.caption.english': 'The whole interface is in English, the built-in English language.',
			'ratio.level.bilingual': 'Bilingual',
			'ratio.level.words': 'Words',
			'ratio.level.phrases': 'Phrases',
			'ratio.level.sentences': 'Sentences',
			'ratio.level.english': 'English',
			'ratio.order': 'Order',
			'ratio.order.zhFirst': 'Chinese first',
			'ratio.order.enFirst': 'English first',
			'ratio.order.zhFirst.short': '中 EN',
			'ratio.order.enFirst.short': 'EN 中'
		};
		//#endregion

		//#region 合成规则（纯函数）
		const PLACEHOLDER = /\{\w+\}/g;
		const HAS_PLACEHOLDER = /\{\w+\}/;
		const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
		const LATIN = /[A-Za-z]/;
		/** 键名末段是这些词的条目是拼句子用的零件：前后缀、分隔符、连接词。 */
		const FRAGMENT_KEY = /(prefix|suffix|separator|join|comma)$/i;
		/**
		 * 键路径含这些段的条目会被填进别的句子或被程序解析：单位、星期名、指令拼写。
		 * 例如 command:token.goal 是输入框里 /goal 的拼写，DSH 只认「目标」或「goal」，
		 * 并列成「目标 goal」会让恢复的草稿把 goal 当成参数。
		 */
		const BUILDING_BLOCK_SEGMENT = /^(units?|weekdays?|tokens?)$/i;
		/** 整条就是一个 URL：并列会变成两个地址拼在一起，链接直接打不开。 */
		const URL_VALUE = /^https?:\/\/\S+$/i;
		/** 单位缩写：只由这些词组成、且带占位符的英文是格式模板（{n}min、{days}d {hours}h）。 */
		const UNIT_ABBREVIATIONS = new Set(['ms', 's', 'm', 'min', 'h', 'd', 'mo', 'y']);

		function withoutPlaceholders(text) {
			return text.replace(PLACEHOLDER, ' ');
		}

		/** 英文词数：按空白切分，含拉丁字母的片段才算词，占位符不算。 */
		function wordCount(text) {
			return withoutPlaceholders(text).split(/\s+/).filter((token) => LATIN.test(token)).length;
		}

		function hanCount(text) {
			return (withoutPlaceholders(text).match(HAN) ?? []).length;
		}

		/** 带占位符、英文部分只有单位缩写的模板：「{n}min」「{days}d {hours}h」「~{months}mo」。 */
		function isAbbreviationTemplate(en) {
			if (!HAS_PLACEHOLDER.test(en)) return false;
			return withoutPlaceholders(en).split(/[^A-Za-z]+/).filter(Boolean).every((word) => UNIT_ABBREVIATIONS.has(word));
		}

		/**
		 * 不能中英并列、只能二选一的条目：拼进句子的零件、语言代码、URL、符号、单位模板。
		 * 并列它们会产生「zh-CN en」「， , 」「3分 m」这样的坏值。
		 */
		function isAtomic(key, zh, en) {
			if (zh.trim() === '' || en.trim() === '') return true;
			if (zh !== zh.trim() || en !== en.trim()) return true;
			// 整条是 URL 就二选一。注意只认「整条都是地址」，
			// 提示文案里顺带写了地址的（baseUrlHint 之类）仍可并列。
			if (URL_VALUE.test(zh) || URL_VALUE.test(en)) return true;
			if (hanCount(zh) <= 1) return true;
			if (!LATIN.test(withoutPlaceholders(en))) return true;
			const segments = key.split('.');
			if (FRAGMENT_KEY.test(segments[segments.length - 1])) return true;
			if (segments.some((segment) => BUILDING_BLOCK_SEGMENT.test(segment))) return true;
			return isAbbreviationTemplate(en);
		}

		/** 并列两种语言；多行文案（Markdown）按段落分隔，保证标题仍在行首。 */
		function joinBilingual(zh, en, order) {
			const [first, second] = order === 'en-first' ? [en, zh] : [zh, en];
			const separator = first.includes('\n') || second.includes('\n') ? '\n\n' : ' ';
			return first + separator + second;
		}

		function levelOf(value) {
			return LEVELS.find((level) => level.value === value) ?? LEVELS[0];
		}

		/**
		 * 合成一条文案。占位符在两半里各保留一份，运行时会把它们全部替换。
		 * @returns 合成结果；两种语言都没有这条时返回 undefined，交给运行时的回退链。
		 */
		function composeEntry(key, zh, en, level, order) {
			const hasZh = typeof zh === 'string';
			const hasEn = typeof en === 'string';
			if (!hasZh || !hasEn) return hasEn ? en : hasZh ? zh : undefined;
			if (zh === en || wordCount(en) <= levelOf(level).maxWords) return en;
			if (isAtomic(key, zh, en)) return zh;
			return joinBilingual(zh, en, order);
		}
		//#endregion

		//#region 合成词典：每个同时有 zh / en 的命名空间注册一个 Proxy
		function readEntry(dict, key) {
			return dict !== undefined && Object.hasOwn(dict, key) ? dict[key] : undefined;
		}

		/**
		 * @param locale - 运行时 locale 服务（需有 dicts 字段）。
		 * @param getPrefs - 读取当前 { level, order }。
		 */
		function createComposer(locale, getPrefs) {
			const owned = new Map();
			const memo = new Map();
			const warned = new Set();
			const dictIds = new WeakMap();
			let memoTag = '';
			let nextDictId = 1;
			let shareCache = { signature: '', shares: NO_SHARES };
			let syncing = false;
			let pending = false;

			function sources(ns) {
				const locales = locale.dicts.get(ns);
				return { zh: locales?.get('zh'), en: locales?.get('en') };
			}

			function lookup(ns, key) {
				const { level, order } = getPrefs();
				const tag = `${level}/${order}`;
				if (tag !== memoTag) {
					memo.clear();
					memoTag = tag;
				}
				const { zh, en } = sources(ns);
				const zhValue = readEntry(zh, key);
				const enValue = readEntry(en, key);
				const cache = memo.get(ns) ?? new Map();
				memo.set(ns, cache);
				const hit = cache.get(key);
				if (hit !== undefined && hit.zh === zhValue && hit.en === enValue) return hit.value;
				const value = composeEntry(key, zhValue, enValue, level, order);
				cache.set(key, { zh: zhValue, en: enValue, value });
				return value;
			}

			function keysOf(ns) {
				const { zh, en } = sources(ns);
				return [...new Set([...Object.keys(zh ?? {}), ...Object.keys(en ?? {})])];
			}

			function dictionaryFor(ns) {
				return new Proxy(Object.create(null), {
					get: (_target, key) => (typeof key === 'string' ? lookup(ns, key) : undefined),
					has: (_target, key) => typeof key === 'string' && lookup(ns, key) !== undefined,
					ownKeys: () => keysOf(ns),
					getOwnPropertyDescriptor: (_target, key) => {
						const value = typeof key === 'string' ? lookup(ns, key) : undefined;
						return value === undefined ? undefined : { value, writable: false, enumerable: true, configurable: true };
					}
				});
			}

			function attach(ns) {
				try {
					owned.set(ns, locale.register(ns, LOCALE_ID, dictionaryFor(ns)));
				} catch (error) {
					if (warned.has(ns)) return;
					warned.add(ns);
					console.warn(`[${PLUGIN_ID}] 跳过命名空间 ${ns}：`, error instanceof Error ? error.message : error);
				}
			}

			function detach(ns) {
				const dispose = owned.get(ns);
				owned.delete(ns);
				memo.delete(ns);
				dispose?.();
			}

			function composable(locales) {
				return locales.has('zh') && locales.has('en');
			}

			/** 让已注册的命名空间与运行时对齐；注册会同步回调订阅者，所以重入时只记一笔。 */
			function sync() {
				if (syncing) {
					pending = true;
					return;
				}
				syncing = true;
				try {
					do {
						pending = false;
						for (const [ns, locales] of locale.dicts) {
							const mine = owned.has(ns);
							if (composable(locales) && !mine) attach(ns);
							else if (!composable(locales) && mine) detach(ns);
						}
					} while (pending);
				} finally {
					syncing = false;
				}
			}

			/**
			 * 档位或语序变了：Proxy 取到的值已经跟着变，只需让运行时推进一次 revision，
			 * 已渲染的界面就会重新取词。重注册一个命名空间即可做到。
			 */
			function refresh() {
				memo.clear();
				const ns = owned.has(NS) ? NS : owned.keys().next().value;
				if (ns === undefined) return;
				// 自己就是被重入的那个 sync 时，只置标志，交给外层的 do…while 收尾；
				// 否则由这里再补一次 sync，别指望调用方的循环一定还活着。
				pending = true;
				const outer = syncing;
				syncing = true;
				try {
					detach(ns);
					attach(ns);
				} finally {
					syncing = outer;
				}
				if (pending && !outer) {
					pending = false;
					sync();
				}
			}

			function dispose() {
				for (const ns of [...owned.keys()]) detach(ns);
			}

			function dictId(dict) {
				if (!dictIds.has(dict)) dictIds.set(dict, nextDictId++);
				return dictIds.get(dict);
			}

			/** 各档只显示英文的文案占比（只统计中英不同的条目），词典没变就复用上次结果。 */
			function shares() {
				const pairs = [];
				for (const ns of owned.keys()) {
					const { zh, en } = sources(ns);
					if (zh !== undefined && en !== undefined) pairs.push([zh, en]);
				}
				const signature = pairs.map(([zh, en]) => `${dictId(zh)}:${dictId(en)}`).join(',');
				if (signature === shareCache.signature) return shareCache.shares;
				const englishOnly = LEVELS.map(() => 0);
				let total = 0;
				for (const [zh, en] of pairs) {
					for (const key of Object.keys(zh)) {
						const zhValue = zh[key];
						const enValue = readEntry(en, key);
						if (typeof zhValue !== 'string' || typeof enValue !== 'string' || zhValue === enValue) continue;
						total += 1;
						LEVELS.forEach((level, index) => {
							if (composeEntry(key, zhValue, enValue, level.value, DEFAULT_PREFS.order) === enValue) englishOnly[index] += 1;
						});
					}
				}
				const result = total === 0 ? NO_SHARES : Object.freeze(englishOnly.map((count) => count / total));
				shareCache = { signature, shares: result };
				return result;
			}

			return { sync, refresh, dispose, shares, lookup };
		}
		//#endregion

		//#region 偏好：本机缓存保证启动即用，Host 配置负责跨浏览器同步
		function normalizePrefs(input) {
			const level = STORED_LEVELS.includes(input?.level) ? input.level : DEFAULT_PREFS.level;
			const order = ORDERS.includes(input?.order) ? input.order : DEFAULT_PREFS.order;
			return Object.freeze({ level, order });
		}

		function safeStorage() {
			try {
				return globalThis.localStorage;
			} catch {
				return undefined;
			}
		}

		/**
		 * 偏好以本机为准，尽力同步到 Host（设置表单 = DSH 的 ConfigFormController）：
		 * - 本机改过、Host 还没确认的字段记为 pending，随缓存一起持久化：启动加载期、断线、
		 *   插件重载时改的值都不会丢，等 Host 就绪后补写；
		 * - 每个字段同时只有一次写入在路上，期间只记最新值，写完再补写一次（拖一次滑块最多写两次）；
		 * - 有任何写入在路上时不采用 Host 快照：同一表单的写入串行，只有最后一次的结果会折回快照，
		 *   中间推来的都是旧值，采用了滑块就会被拽回中间档；
		 * - 写入被 Host 拒绝时以 Host 为准；因连接失败抛错时保留本机值，等 Host 推来新快照
		 *   （例如重连后的整体刷新）再补写。
		 */
		function createPreferences(storage) {
			const listeners = new Set();
			/** 字段 → { sent, wanted }：已发出的值和发出后用户又改成的值。 */
			const inflight = new Map();
			const cached = readCache();
			const pending = new Set(Array.isArray(cached?.pending) ? cached.pending.filter((field) => PREF_FIELDS.includes(field)) : []);
			let state = normalizePrefs(cached);
			let host;
			let migrated = false;
			let stalled = false;

			function readCache() {
				try {
					return JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
				} catch {
					return null;
				}
			}

			function writeCache() {
				try {
					storage?.setItem(STORAGE_KEY, JSON.stringify({ ...state, pending: [...pending] }));
				} catch {
					// 隐私模式等场景写不进去：只影响下次启动的初始值
				}
			}

			function commit(next) {
				if (next.level === state.level && next.order === state.order) return false;
				state = next;
				for (const listener of [...listeners]) listener(state);
				return true;
			}

			function canWrite(form) {
				const snapshot = form.getSnapshot();
				return snapshot.status === 'ready' && snapshot.writable === true;
			}

			function flush() {
				if (host === undefined || stalled || !canWrite(host)) return;
				for (const field of pending) {
					const entry = inflight.get(field);
					if (entry === undefined) send(host, field, state[field]);
					else entry.wanted = state[field];
				}
			}

			function send(form, field, value) {
				const entry = { sent: value, wanted: value };
				inflight.set(field, entry);
				Promise.resolve()
					.then(() => form.set(field, value))
					.then((accepted) => settle(form, field, entry, accepted === true ? 'accepted' : 'refused'), (error) => {
						console.warn(`[${PLUGIN_ID}] 偏好写入 Host 失败，Host 恢复后重试：`, error instanceof Error ? error.message : error);
						settle(form, field, entry, 'failed');
					});
			}

			function settle(form, field, entry, outcome) {
				inflight.delete(field);
				if (host === form) {
					if (outcome === 'failed') stalled = true;
					// 写成功时 Host 已是这个值，被拒绝时以 Host 为准；用户没再改过就不必再写
					else if (entry.wanted === entry.sent) pending.delete(field);
					writeCache();
				}
				// 表单已解绑（插件重载、设置服务重建）时不碰缓存：pending 早已随缓存落盘，由接手的实例补写
				if (inflight.size === 0) adopt();
			}

			/** Host 快照 → 本机。pending 字段以本机为准并补写，其余字段采用 Host 上显式保存的值。 */
			function adopt() {
				if (host === undefined || inflight.size > 0) return;
				const snapshot = host.getSnapshot();
				if (snapshot.status !== 'ready' || snapshot.value === undefined) return;
				const saved = snapshot.user ?? {};
				if (!migrated) {
					migrated = true;
					// Host 从没存过、本机却不是默认值（例如在没有 Host 配置时改的）：当作待写
					for (const field of PREF_FIELDS) if (saved[field] === undefined && state[field] !== DEFAULT_PREFS[field]) pending.add(field);
				}
				for (const field of [...pending]) if (snapshot.value[field] === state[field]) pending.delete(field);
				const adoptable = PREF_FIELDS.filter((field) => saved[field] !== undefined && !pending.has(field));
				commit(normalizePrefs({ ...state, ...Object.fromEntries(adoptable.map((field) => [field, snapshot.value[field]])) }));
				writeCache();
				flush();
			}

			/** @returns 是否真的改了值。 */
			function update(patch) {
				const before = state;
				if (!commit(normalizePrefs({ ...state, ...patch }))) return false;
				for (const field of PREF_FIELDS) if (state[field] !== before[field]) pending.add(field);
				writeCache();
				flush();
				return true;
			}

			function attachHost(form) {
				host = form;
				migrated = false;
				stalled = false;
				const unsubscribe = form.subscribe(() => {
					stalled = false;
					adopt();
				});
				adopt();
				return () => {
					unsubscribe();
					if (host === form) host = undefined;
				};
			}

			return {
				get: () => state,
				update,
				attachHost,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				}
			};
		}
		//#endregion

		//#region 设置行
		const STYLE_ID = `${PLUGIN_ID}/ratio-row.css`;
		const CSS = [
			'.dshb-row{border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:14px;padding:16px 0}',
			'.dshb-head{display:flex;align-items:center;gap:8px}',
			'.dshb-text{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0;padding-right:48px}',
			'.dshb-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
			'.dshb-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
			'.dshb-order{flex:none}',
			'.dshb-scale{display:flex;flex-direction:column;gap:6px}',
			'.dshb-track{position:relative;height:24px}',
			'.dshb-rail{position:absolute;top:10px;left:8px;right:8px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l3);overflow:hidden;pointer-events:none}',
			'.dshb-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .16s ease}',
			'.dshb-tick{position:absolute;top:8px;width:8px;height:8px;margin-left:-4px;box-sizing:border-box;border:2px solid var(--dsw-alias-border-l3);border-radius:50%;background:var(--dsw-alias-bg-layer-2);pointer-events:none}',
			'.dshb-tick[data-on=true]{border-color:var(--dsw-alias-brand-primary)}',
			'.dshb-input{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;background:transparent;cursor:pointer;-webkit-appearance:none;appearance:none}',
			'.dshb-input:disabled{cursor:default}',
			'.dshb-input:focus{outline:none}',
			'.dshb-input::-webkit-slider-runnable-track{height:24px;background:transparent;border:0}',
			'.dshb-input::-moz-range-track{height:24px;background:transparent;border:0}',
			'.dshb-input::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:4px;border:0;border-radius:50%;background:#fff;box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 1px 3px rgba(0,0,0,.22);transition:transform .12s ease}',
			'.dshb-input::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:#fff;box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 1px 3px rgba(0,0,0,.22)}',
			'.dshb-input:active::-webkit-slider-thumb{transform:scale(1.12)}',
			'.dshb-input:focus-visible::-webkit-slider-thumb{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
			'.dshb-input:focus-visible::-moz-range-thumb{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
			'.dshb-track[data-off=true] .dshb-input::-webkit-slider-thumb{opacity:0}',
			'.dshb-track[data-off=true] .dshb-input::-moz-range-thumb{opacity:0}',
			'.dshb-stops{position:relative;height:38px}',
			'.dshb-stop{position:absolute;top:0;display:flex;flex-direction:column;align-items:center;padding:2px 6px;border:0;border-radius:var(--dsw-radius-sm);background:none;font:inherit;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer;transform:translateX(-50%)}',
			'.dshb-stop:first-child{align-items:flex-start;transform:translateX(-14px)}',
			'.dshb-stop:last-child{align-items:flex-end;transform:translateX(calc(14px - 100%))}',
			'.dshb-stop:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshb-stop:disabled{cursor:default;opacity:.5}',
			'.dshb-stop[aria-pressed=true]{color:var(--dsw-alias-label-primary);font-weight:500}',
			'.dshb-stop-name{font-size:12px;line-height:18px}',
			'.dshb-stop-share{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;line-height:16px;font-variant-numeric:tabular-nums}'
		].join('');

		if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = PLUGIN_ID;
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** 滑块位置：1–4 为中英双语的档位，5 为内置 English（或正在预览它），0 表示当前是中文等其它语言。 */
		function positionOf(view) {
			if (view.active === ENGLISH || view.previewEnglish) return ENGLISH_LEVEL;
			if (view.active === LOCALE_ID && view.available) return view.level;
			return 0;
		}

		/** 刻度在轨道上的横坐标：两端各留出 8px 给滑块半径，与原生 range 的滑块中心对齐。 */
		function stopLeft(index) {
			return `calc(8px + (100% - 16px) * ${index / (LEVELS.length - 1)})`;
		}

		function percent(share) {
			return `${Math.round(share * 100)}%`;
		}

		function RatioRow({ t, useBilingual, selectLevel, setOrder, getShares }) {
			const h = React.createElement;
			const view = useBilingual((state) => state);
			const baseId = React.useId();
			const shares = getShares();
			const position = positionOf(view);
			const bilingual = position >= 1 && position < ENGLISH_LEVEL;
			// 中英双语不可用时整条禁用：第 1–4 档选了也生效不了，第 5 档用语言下拉即可
			const disabled = !view.available;
			const current = position === 0 ? undefined : levelOf(position);
			const caption = disabled ? t('ratio.caption.unavailable') : current === undefined ? t('ratio.caption.off', { language: view.activeLabel }) : t(`ratio.caption.${current.key}`);
			// 不在这里跳过「当前档」：拖得快时这个闭包里的 position 可能落后几帧，
			// 去重交给 selectLevel 按实时状态判断
			const pick = (value) => {
				if (!disabled) selectLevel(value);
			};

			const head = h('div', { className: 'dshb-head' },
				h('div', { className: 'dshb-text' },
					h('div', { className: 'dshb-title', id: `${baseId}-title` }, t('ratio.title')),
					h('div', { className: 'dshb-desc', id: `${baseId}-desc` }, caption)),
				bilingual && h(SegmentedControl, {
					id: `${baseId}-order`,
					className: 'dshb-order',
					value: view.order,
					label: t('ratio.order'),
					options: [
						{ value: 'zh-first', label: t('ratio.order.zhFirst.short'), title: t('ratio.order.zhFirst') },
						{ value: 'en-first', label: t('ratio.order.enFirst.short'), title: t('ratio.order.enFirst') }
					],
					onChange: setOrder
				}));

			const track = h('div', { className: 'dshb-track', 'data-off': position === 0 },
				h('div', { className: 'dshb-rail' },
					h('div', { className: 'dshb-fill', style: { width: position <= 1 ? '0%' : `${((position - 1) / (LEVELS.length - 1)) * 100}%` } })),
				LEVELS.map((level, index) => h('span', { key: level.key, className: 'dshb-tick', 'data-on': position >= level.value, style: { left: stopLeft(index) } })),
				h('input', {
					type: 'range',
					className: 'dshb-input',
					min: 1,
					max: LEVELS.length,
					step: 1,
					value: position === 0 ? 1 : position,
					disabled,
					'aria-labelledby': `${baseId}-title`,
					'aria-describedby': `${baseId}-desc`,
					'aria-valuetext': current === undefined ? view.activeLabel : `${t(`ratio.level.${current.key}`)} · ${percent(shares[current.value - 1])}`,
					onChange: (event) => pick(Number(event.currentTarget.value)),
					// 当前不在中↔英区间时，点在第 1 档上不会触发 change，这里补上
					onClick: (event) => pick(Number(event.currentTarget.value)),
					onKeyDown: (event) => {
						if (position === 0 && (event.key === 'Enter' || event.key === ' ')) pick(Number(event.currentTarget.value));
					}
				}));

			const stops = h('div', { className: 'dshb-stops' },
				LEVELS.map((level, index) => h('button', {
					key: level.key,
					type: 'button',
					className: 'dshb-stop',
					tabIndex: -1,
					disabled,
					'aria-pressed': position === level.value,
					style: { left: stopLeft(index) },
					onClick: () => pick(level.value)
				},
				h('span', { className: 'dshb-stop-name' }, t(`ratio.level.${level.key}`)),
				h('span', { className: 'dshb-stop-share' }, percent(shares[index])))));

			return h('div', { className: 'dshb-row' }, head, h('div', { className: 'dshb-scale' }, track, stops));
		}
		//#endregion

		//#region 插件入口
		const name = PLUGIN_ID;
		const inject = ['locale', 'slots'];

		/** locale.dicts 是内部字段：只认得出「ns → Map(locale → 词典)」的形状才使用。 */
		function isDictionaryRegistry(dicts) {
			return typeof dicts?.get === 'function' && typeof dicts?.[Symbol.iterator] === 'function';
		}

		function apply(ctx) {
			const locale = ctx.locale;
			const prefs = createPreferences(safeStorage());
			/** 第 5 档预览期间的合成偏好（见 selectLevel）；平时为 undefined。 */
			let englishPreview;
			let englishTimer;
			const composerPrefs = () => englishPreview ?? prefs.get();
			const composer = isDictionaryRegistry(locale.dicts) ? createComposer(locale, composerPrefs) : undefined;
			if (composer === undefined) console.warn(`[${PLUGIN_ID}] locale.dicts 不可用，不注册中英双语`);

			// 注册抛错（比如上一次实例没清理干净、同名语言已存在）会让整个插件失效，
			// 所以和 addLanguage 一样兜住：失败只少设置行自己的词典，插件其余部分照常。
			ctx.effect(() => {
				try {
					return locale.register(NS, { zh: NS_ZH, en: NS_EN });
				} catch (error) {
					console.warn(`[${PLUGIN_ID}] 设置行词典注册失败：`, error instanceof Error ? error.message : error);
					return undefined;
				}
			}, 'bilingual: row dictionaries');

			if (composer !== undefined) {
				ctx.effect(() => {
					composer.sync();
					const unsubscribe = locale.subscribe(composer.sync);
					return () => {
						unsubscribe();
						composer.dispose();
					};
				}, 'bilingual: composed dictionaries');
				ctx.effect(() => {
					try {
						return locale.addLanguage({ id: LOCALE_ID, label: LOCALE_LABEL, fallback: 'zh' });
					} catch (error) {
						console.warn(`[${PLUGIN_ID}] 语言 ${LOCALE_ID} 注册失败：`, error instanceof Error ? error.message : error);
						return undefined;
					}
				}, 'bilingual: language');
			}

			const snapshotView = () => {
				const snapshot = locale.getSnapshot();
				const { level, order } = prefs.get();
				return {
					active: snapshot.active,
					activeLabel: snapshot.locales.find((item) => item.id === snapshot.active)?.label ?? snapshot.active,
					available: composer !== undefined && snapshot.locales.some((item) => item.id === LOCALE_ID),
					previewEnglish: englishPreview !== undefined,
					level,
					order,
					revision: snapshot.revision
				};
			};
			const view = createSnapshotStore(snapshotView());
			const refreshView = () => {
				view.set(snapshotView());
			};
			const rerender = () => {
				composer?.refresh();
				refreshView();
			};
			/** @returns 是否确实取消了一次预览。 */
			const cancelEnglishPreview = () => {
				clearTimeout(englishTimer);
				englishTimer = undefined;
				if (englishPreview === undefined) return false;
				englishPreview = undefined;
				return true;
			};
			ctx.effect(() => locale.subscribe(() => {
				// 预览期间用户从语言下拉改选了别的语言：放弃这次切换
				if (englishPreview !== undefined && locale.getSnapshot().active !== LOCALE_ID) cancelEnglishPreview();
				refreshView();
			}), 'bilingual: row state');
			ctx.effect(() => prefs.subscribe(rerender), 'bilingual: preference changes');
			ctx.effect(() => () => {
				cancelEnglishPreview();
			}, 'bilingual: pending english switch');
			// configForms 由设置面板提供；没有它时偏好只存在本机
			ctx.inject(['configForms'], (scope) => {
				scope.effect(() => prefs.attachHost(scope.configForms.get(ENTRY_ID)), 'bilingual: host preferences');
			});

			/**
			 * 选中某一档；已经在这一档时什么也不做（setLocale 每次都会写一次语言偏好）。
			 * 从中英双语选第 5 档时先在当前语言里显示纯英文，停稳 ENGLISH_DELAY 后再切到内置
			 * English：来回拖过第 4、5 档时不会连发语言偏好写入，DSH 也就不会把界面闪回旧语言。
			 */
			const selectLevel = (value) => {
				try {
					const active = locale.getSnapshot().active;
					if (value === ENGLISH_LEVEL) {
						if (active === ENGLISH || englishPreview !== undefined) return;
						if (active !== LOCALE_ID || composer === undefined) {
							locale.setLocale(ENGLISH);
							return;
						}
						englishPreview = Object.freeze({ ...prefs.get(), level: ENGLISH_LEVEL });
						rerender();
						englishTimer = setTimeout(() => {
							englishTimer = undefined;
							englishPreview = undefined;
							try {
								if (locale.getSnapshot().active === LOCALE_ID) locale.setLocale(ENGLISH);
							} catch (error) {
								console.warn(`[${PLUGIN_ID}] 切换到 English 失败：`, error instanceof Error ? error.message : error);
								rerender();
							}
						}, ENGLISH_DELAY);
						return;
					}
					// 中英双语没注册成功（内部字段缺失或 id 被占）时，不改档位、不写偏好
					if (!snapshotView().available) return;
					const previewCancelled = cancelEnglishPreview();
					const levelChanged = prefs.update({ level: value });
					if (active !== LOCALE_ID) locale.setLocale(LOCALE_ID);
					else if (previewCancelled && !levelChanged) rerender();
				} catch (error) {
					console.warn(`[${PLUGIN_ID}] 切换档位失败：`, error instanceof Error ? error.message : error);
				}
			};

			ctx.slots.inject('settings.general.item', () => ctx.slots.register({
				name: 'settings.general.item',
				id: 'bilingual-ratio',
				order: 1,
				locale: NS,
				inject: () => ({
					hooks: { bilingual: view },
					selectLevel,
					setOrder: (order) => {
						prefs.update({ order });
					},
					getShares: () => composer?.shares() ?? NO_SHARES
				})
			}, RatioRow));
		}
		//#endregion

		module.exports = {
			apply,
			inject,
			name,
			LEVELS,
			LOCALE_ID,
			NS,
			NS_ZH,
			NS_EN,
			composeEntry,
			createComposer,
			createPreferences,
			isAtomic,
			joinBilingual,
			normalizePrefs,
			positionOf,
			wordCount,
			RatioRow
		};
		return module.exports;
	}
});
