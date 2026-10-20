# DSH 客户端插件机制调研（源码级笔记）

写 DSH 浏览器半侧插件时用到的机制，全部从本机 **DeepSeek Harness 0.2.1-rc.2** 的 `app.asar` 里读源码确认过。
写其它 DSH 插件时也能直接用。

## 0. 怎么读源码

- 位置：`/Applications/Homebrew Casks/DeepSeek Harness.app/Contents/Resources/app.asar`（一个文件，不是目录）。
- 格式：第 12 字节起 uint32LE 头长度，第 16 字节起 JSON 头，数据区按 4 字节对齐；叶子节点 `{ size, offset }`。
  现成的读取器：[`test/support/asar.mjs`](../test/support/asar.mjs)。
- 内置包：`dsh/node_modules/@deepseek-ai/<包>/lib/{client,index}.js`，每个包都带 README（有中文版）。
- React、UI 原语、插槽系统打包在 `dsh-web-frontend/dist/assets/index-*.js` 里（压缩过）。

## 1. 模块系统（`dsh-client-modules`）

- 浏览器半侧就是 `lib/client.js`：`window.__ModuleLoader__.load({ id, factory: (require) => module.exports })`。
  执行 bundle 只登记 factory，**所有副作用（包括注入 CSS）都应写在 factory 里**，materialize 时才跑。
- `require` 只能拿到**平台共享模块表**里的模块（其它直接抛错）：
  `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`。要用别的插件的模块，得在 `dsh.client.external` 里声明。
- `package.json` 的 `dsh.client.inject` 只决定**加载顺序**（列出的包先到）；列了不存在的包会被忽略。
- 插件的 `<style>` 要带 `data-plugin="<包名>"`：插件卸载时模块系统按这个属性清理样式。

## 2. 语言运行时（`dsh-client-locale`，服务名 `locale`）

| API | 行为（关键细节） |
|---|---|
| `register(ns, { zh, en })` / `register(ns, locale, dict)` | 同一命名空间同一语言**重复注册直接抛错**；返回 disposer（只在对象身份相同时才删）。每次注册 / 撤销都同步 `publish()` |
| `subscribe(fn)` | 每次 `publish()` **同步**调用；在回调里再注册会重入 |
| `bind(ns)` → `t(key, params)` | 沿当前语言的 fallback 链在 `ns` 里找，找不到再在 `common` 里找一遍，最后返回键名；`{param}` **全部**替换 |
| `addLanguage({ id, label, fallback })` | id 需是 BCP 47 风格；重复 id 抛错；fallback 必须已注册且最终到 `en`。每门语言都会出现在设置的语言下拉里 |
| `setLocale(id)` | 未注册的 id 抛错；**每次调用都写一次 Host 偏好**（`locale.preference`），只有语言真的变了才发 `locale/change` |
| `getSnapshot()` | `{ active, locales, revision }`；注册词典也会推进 revision，插槽里的界面据此重渲染 |
| `resolveText(text)` | 插件标题等 LocalizedText 用，沿 fallback 链取值，**不查词典** |
| `dicts` | 内部字段 `Map<ns, Map<localeKey, dict>>`，词典按小写 id 存 |

其它：
- 偏好存在 Host 的 `locale.preference`；存了外部语言而它还没注册时，先用浏览器推断的语言，注册后自动切过去。
- Host 偏好由 `configForms` 镜像驱动，**连续多次 `setLocale` 时会采用到旧值、界面闪回**（本插件第 5 档用「预览 + 延迟切换」绕开）。
- `<html lang>` 跟随当前语言（`zh` 写成 `zh-CN`）。
- 桌面壳通过 `__DSH_LOCALE__` 拿语言；只认 `zh` / `en`，其它 id 时原生菜单跟随系统语言（不会出错）。

## 3. 插槽（设置页的行）

```js
ctx.slots.inject('settings.general.item', () => ctx.slots.register({
	name: 'settings.general.item',
	id: 'my-row',
	order: 1,                // 语言 0、外观 10、字号 11、工作步骤 12、链接 17、性能 30
	locale: 'my.ns',         // 组件拿到的 t 绑定这个命名空间
	inject: () => ({ hooks: { thing: snapshotStore }, doSomething })
}, MyRow));
// MyRow({ t, useThing, doSomething })：hooks 里的 thing 变成 useThing(selector)
```

- 传 `store`（`defineStore`）时组件拿到 `useStore(selector)`，`inject(actions)` 的参数是 store 的 actions。
- selector 要返回稳定引用（整个快照或原始值），每次返回新对象会让 `useSyncExternalStore` 反复渲染。
- `createSnapshotStore(initial)` → `{ getSnapshot, subscribe, set, update }`；`set` 会深冻结。

## 4. 设置表单（`configForms`，由 `dsh-client-ui-settings` 提供）

- 宿主半侧导出 `Config`，其中 `.volatile()` 的字段才会出现在表单里、改动即时生效（不重启插件）。
  `apply` 里 `ctx.inject(['settings'], (c) => c.effect(() => c.settings.configure({ auto: false }, ctx.fiber)))`
  声明设置界面由插件自己提供。
- 浏览器半侧：`ctx.configForms.get(entryId)` → 表单，`entryId` 是 profile 里那一行的 id。
  - `getSnapshot()` → `{ status: 'loading' | 'ready' | 'unavailable', value, base, user, revision, writable }`；
    `user` 是 profile 里**显式写过**的字段，`value` 是合并后的实际值。
  - `set(field, value)` → `Promise<boolean>`；同一表单的写入串行执行，写完把结果折回镜像。
  - 镜像还会因 `settings/document-updated` 事件整体刷新，所以**写入途中会陆续推来中间状态**。
- 写入落在 profile 的 `cordis.patch.yml`：`- id: <entryId>\n  config: { ... }`。
- volatile 字段解析后是引用对象，`Config({}).level` 要 `.get()` 才拿到值。

## 5. 宿主半侧的依赖解析

- 以 `link:` 安装的外部目录，`package.json` 里声明为 **peerDependencies** 的包会解析到 DSH 运行时自带的那份
  （「peer-aware ancestor lookup」）。所以 `@deepseek-ai/schemastery` 写成可选 peer 即可，不用打包。
- `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围会和运行时版本比对，不匹配就拒绝加载插件；
  `schemastery` 不在此列。
- 拿不到也别让插件挂：`await import()` 包 try/catch，取不到就不导出 Config。

## 6. cordis 小抄

- `ctx.effect(fn, label)`：`fn` 返回函数（作为 disposer）或 undefined；返回其它非空值会抛 `Invalid effect`；
  `fn` 同步抛错会让 `apply` 失败。也可以返回 generator，每个 yield 一个 disposer。
- 可选服务用 `ctx.inject(['svc'], (scope) => …)`，不要写进导出的 `inject` 数组（缺了整个插件就不 apply）。

## 7. 设计 token 与原语

- 设置行：`.row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0}`，标题 14px/22px
  `--dsw-alias-label-primary`，描述 12px/18px `--dsw-alias-label-tertiary`，右侧控件 36px 高、
  `--dsw-radius-md`、`--dsw-alias-bg-module-platform`。
- Switch 开启色 `--dsw-alias-brand-primary`（浅色黑、深色白），关闭 `--dsw-alias-border-l3`；
  焦点环 `--dsw-focus-ring-width` / `--dsw-focus-ring-color`。
- 原语（`@deepseek-ai/dsh-client-ui-primitives`）里有 `Button`、`Checkbox`、`Input`、`Menu`、`Modal`、`Pill`、
  `SegmentedControl({ id, value, options:[{value,label,title}], onChange, label })`、`SettingsForm`、
  `Switch({ checked, onChange, label })`、`Tag`、`Toast`、`Tooltip` 以及 `Icon*` 图标。**没有滑块**，要自己做。

## 8. 端到端验证（不碰自己的 profile）

`DSH_HOME=<临时目录> dsh plugin --profile web add link:<插件目录>`，再 `dsh --profile web --no-open --port 0`，
日志里有带 `?token=` 的地址。浏览器用 Playwright 缓存里的 Chrome for Testing
（`~/Library/Caches/ms-playwright/chromium-*/…`）。首次打开会弹「预览版说明」；设置在左下「更多」→「设置」。
页面一直挂着 SSE，别用 `networkidle` 等待。完整脚本见 [`scripts/e2e.mjs`](../scripts/e2e.mjs)。
