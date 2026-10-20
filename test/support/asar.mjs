// 只读访问 DeepSeek Harness 的 app.asar（DSH 的全部内置包都打在这个文件里）。
//
// asar 格式：第 12 字节起是 uint32LE 的头长度，第 16 字节起是 JSON 头，
// 文件数据紧跟在头后面（按 4 字节对齐）；叶子节点带 { size, offset }。

import fs from 'node:fs';

export const DEFAULT_ASAR = '/Applications/Homebrew Casks/DeepSeek Harness.app/Contents/Resources/app.asar';

/** DSH 内置包在 asar 里的目录。 */
export const PACKAGES = 'dsh/node_modules/@deepseek-ai';

/** @returns 环境变量 DSH_APP_ASAR 指定的路径，否则默认安装位置。 */
export function asarPath() {
	return process.env.DSH_APP_ASAR ?? DEFAULT_ASAR;
}

/**
 * @param file - app.asar 路径。
 * @returns { has, list, read }，路径用「/」分隔、相对 asar 根目录。
 */
export function openAsar(file = asarPath()) {
	const buffer = fs.readFileSync(file);
	const headerSize = buffer.readUInt32LE(12);
	const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8'));
	const dataStart = 16 + headerSize + ((4 - (headerSize % 4)) % 4);
	const node = (entryPath) => entryPath.split('/').reduce((current, part) => current?.files?.[part], header);
	return {
		has: (entryPath) => node(entryPath) !== undefined,
		list: (dir) => Object.keys(node(dir)?.files ?? {}),
		read(entryPath) {
			const entry = node(entryPath);
			if (entry === undefined) throw new Error(`asar 里没有 ${entryPath}`);
			const start = dataStart + Number(entry.offset);
			return buffer.subarray(start, start + entry.size).toString('utf8');
		}
	};
}
