// dsh-bilingual-i18n —— 宿主半侧
//
// 语言与词典都是浏览器半侧的事；宿主半侧只声明滑块的两个偏好，让它们像其它
// 「通用」设置一样经 DSH 设置服务保存进 profile（cordis.patch.yml），换浏览器也在：
//
//   - id: dsh-bilingual-i18n
//     config:
//       level: 3          # 1 双语 · 2 单词 · 3 短语 · 4 短句（第 5 档即内置 English）
//       order: zh-first   # zh-first 中文在前 · en-first 英文在前
//
// Schemastery 取自运行中的 DSH（peerDependency）。取不到时不声明 Config，
// 浏览器半侧改为只在本机记住偏好，其余功能不受影响。

const name = 'dsh-bilingual-i18n';

async function loadSchemastery() {
	try {
		return (await import('@deepseek-ai/schemastery')).default;
	} catch (error) {
		// 在 DSH 之外（例如单独跑测试）找不到是预期的；别的错误（解析器要求重启等）要留痕
		if (error?.code !== 'ERR_MODULE_NOT_FOUND') console.warn(`[${name}] 加载 schemastery 失败，偏好只保存在浏览器本地：`, error);
		return undefined;
	}
}

const z = await loadSchemastery();

/** 两个字段都是 volatile：设置面板改动即时生效，不重启插件。 */
const Config = z?.object({
	level: z.union([1, 2, 3, 4]).default(1).volatile(),
	order: z.union(['zh-first', 'en-first']).default('zh-first').volatile()
});

function apply(ctx) {
	if (Config === undefined) return;
	// 设置页由浏览器半侧的滑块行承担，不需要按 schema 自动生成表单
	ctx.inject(['settings'], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
}

export { Config, apply, name };
