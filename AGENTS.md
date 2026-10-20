# DSH Bilingual i18n - Agent Knowledge Base

**Type:** DSH 客户端插件（npm 包；浏览器半侧为主，宿主半侧只声明配置）
**Size:** 2 个源文件（`lib/client.js` ≈ 750 行，手写、无构建；`lib/index.js` ≈ 40 行）+ 测试与脚本

## Overview

在 DSH「设置 → 通用」里加一行 **英文占比** 滑块，5 档：最左中英并列，最右纯英文。
越往右，只显示英文的文案越多，按英文词数由短到长切换（≤1 / ≤2 / ≤5 词 / 全部）。

插件不带文案表：读取运行时里已注册的 zh / en 词典，给每个命名空间注册一份
**Proxy 词典**（语言 id `zh-en`），取词时按当前档位现算。第 5 档直接切到内置 `en`。

用户原始需求与来龙去脉见 [docs/开发记录.md](docs/开发记录.md)；
DSH 客户端机制的源码级笔记见 [docs/DSH客户端机制调研.md](docs/DSH客户端机制调研.md)。

## Project Structure

```
dsh-bilingual-i18n/
├── package.json             # dsh.bundle.patch + dsh.client（inject 只决定加载顺序）；schemastery 是可选 peer
├── cordis.patch.yml         # DSH 挂载声明（insert，id 必须 = 包名）
├── lib/client.js            # 浏览器半侧：合成规则 → Proxy 词典 → 偏好 → 设置行 → apply
├── lib/index.js             # 宿主半侧：只声明 volatile Config { level, order }
├── test/run-tests.mjs       # 自测 85 项：规则 / 偏好 / 设置行 / Config / 真实词典集成
├── test/support/            # asar 读取、真实 DSH 词典环境、插件加载与替身（脚本也复用）
├── scripts/calibrate.mjs    # 用本机真实词典标定各档占比、列原子条目、看单条结果
├── scripts/e2e.mjs          # 隔离的 dsh web + 无头 Chrome，在真实界面里走一遍
├── docs/开发记录.md          # 为什么这么做 + 踩坑
├── docs/DSH客户端机制调研.md  # locale / 插槽 / 设置表单 / 模块系统
└── README.md                # 用户向用法
```

## Run & Verify Commands

```bash
npm test                         # 85 项；第 4、5 组需要本机装有 DSH（读 app.asar，DSH_APP_ASAR 可改路径）
npm run calibrate                # 各档纯英文占比 + 英文词数分布
npm run calibrate -- --atomic    # 列出全部原子条目，检查有没有误伤普通文案
npm run calibrate -- --key chat:chat.deepDivingFor   # 某一条在 5 档下的结果
npm install && npm run e2e       # 真实界面端到端（11 项），截图在 .e2e/shots/；-- --keep 保留服务
```

改了 `lib/client.js` 的规则：先 `npm run calibrate` 看占比仍单调、间隔均匀，再 `npm test`、`npm run e2e`。

## Install / Uninstall

```bash
# 桌面 profile 由 Electron 独占，CLI 装不了 → 手改三处（与 dsh-quota-bridge 相同）：
#   ~/.dsh/profiles/desktop/package.json
#     dependencies["dsh-bilingual-i18n"] = "link:/Users/fwmbam4/CodeHub/Frankie/dsh-bilingual-i18n"
#     dsh.profile.bundles += "dsh-bilingual-i18n"
#   ~/.dsh/profiles/desktop/pnpm-lock.yaml 里同名条目的 specifier / version
#   ~/.dsh/profiles/desktop/node_modules/dsh-bilingual-i18n -> ../../../../CodeHub/Frankie/dsh-bilingual-i18n
# 或者改完 package.json 后用 DSH 自带的 pnpm 重新 install：
node "$DSH_APP/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install --ignore-scripts
# 然后重启 DSH Desktop。web profile 可以直接：dsh plugin --profile web add link:<本目录>
```

卸载：从 bundles 删掉这一行，再删依赖。

## 关键不变量（改动前务必确认）

1. **各档纯英文占比严格单调递增**：第 1 档全部并列（0%），第 5 档就是内置 `en`（100%，不是合成出来的）。
   旧版第 3、4 档英文反而比第 1 档少，用户因此打回——这是需求本身。
2. **原子条目永不并列**：语言代码（`time.locale` 传给 `Intl`）、URL、分隔符、单位、首尾带空格的片段、
   缩写模板、键名以 prefix/suffix/separator/join/comma 结尾、路径含 unit(s)/weekday(s)、中文只有 ≤1 个汉字。
   第 1 档取中文，到其词数对应的档位整体换英文。加规则后用 `calibrate --atomic` 查误伤。
3. **占位符两半各留一份**：运行时 `translate` 会替换全部同名 `{param}`，删掉任何一份都会少字。
4. **只注册一门语言 `zh-en`，fallback 必须是 `zh`**：只有 zh 的命名空间才不会露出键名；
   不要再为每档注册语言（语言下拉会被塞满）。
5. **每个注册都把 disposer 交给 `ctx.effect`**（register / addLanguage / subscribe / 定时器）；
   `ctx.effect` 的回调只能返回函数或 undefined。`apply` 里不能抛异常，否则整个插件失效。
6. **切档只重注册一个命名空间来推进 revision**；Proxy 读的是实时档位，不需要重注册全部。
7. **Host 偏好写入**：每个字段同时只有一次写入在路上，期间的改动只记最新值；
   写完之前不采用 Host 推来的该字段值。否则拖完滑块会被拽回中间档。
8. **选第 5 档**：在 `zh-en` 里先预览纯英文，停稳 400ms 再 `setLocale('en')`；离开第 5 档或改选别的语言即取消。
   直接切会触发 DSH LocaleRuntime 的偏好竞态，界面闪回。
9. **去重看实时状态**：`selectLevel` 用 `locale.getSnapshot()` 判断，不用渲染闭包里的 `position`（快速拖动时它会落后几帧）。
10. **浏览器半侧只 require 平台共享模块**：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`、
    `@deepseek-ai/dsh-client-store` 等（清单见调研文档）；其它模块在 materialize 时直接抛错。
11. **可选服务不进 `inject`**：`configForms` 用 `ctx.inject(['configForms'], cb)` 包起来，没有设置面板时插件照常工作。
12. **宿主半侧不打包任何依赖**：schemastery 走可选 peerDependency 由运行时提供，取不到就不声明 Config
   （浏览器半侧退回 localStorage）。

## 踩坑速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `register` 抛 `already has locale` | 同一命名空间同一语言只能注册一次 | 先 dispose 再 register；注册全放进 `ctx.effect` |
| 日期格式化报错 / 文档链接打不开 | 把 `zh-CN`/`en`、URL 并列成了 `zh-CN en` | 原子条目二选一 |
| 只有中文的插件词典显示成键名 | 语言 fallback 设成了 `en` | `fallback: 'zh'` |
| 快速拖动停错档（差一档） | 渲染闭包里的 `position` 落后，最后一次被当成「没变」 | 去重挪到 `selectLevel`，看实时状态 |
| 松手后滑块跳回中间档 | 设置镜像陆续推来排队写入的中间值，被当成外部修改采用了 | in-flight 字段不采用；写入合并 |
| 在第 4、5 档来回拖，松手后闪回中英 | DSH 的 LocaleRuntime 采用了旧的 `locale.preference` | 第 5 档先预览，停稳再切 |
| `Config({})` 打印成 `{"level":{}}` | volatile 字段解析成引用对象 | 用 `.get()` 取值 |
| `dsh plugin --profile desktop` 报 Electron 独占 | desktop profile 不归 CLI 管 | 见上面的安装步骤 |
| E2E 里 `waitForLoadState('networkidle')` 超时 | DSH 页面一直挂着 SSE | 等具体元素出现 |
| Playwright 找不到 headless shell | playwright-core 版本与缓存的浏览器不匹配 | `executablePath` 指向缓存的 Chrome for Testing |
| E2E 结束后服务还在 | DSH 收到 SIGTERM 要几秒优雅退出 | 等 `exit` 事件，5 秒后 SIGKILL |
| 改了代码桌面版没变化 | 插件以 `link:` 安装，代码在启动时加载 | 重启 DSH Desktop |

## 与上游的约定

- 在 DSH **0.2.1-rc.2** 上验证。依赖内部字段 `ctx.locale.dicts`（`Map<ns, Map<locale, dict>>`）；
  它不在时插件只提示不可用，不注册语言。
- `settings.general.item` 插槽：语言行 order 0，本行 order 1，外观 10、字号 11、工作步骤 12、链接 17、性能 30。
- 宿主半侧导出 `{ name, Config, apply }`；`apply` 里 `settings.configure({ auto: false })` 声明设置页自带。
- 姊妹项目：[dsh-quota-bridge](../dsh-quota-bridge)（DSH 额度 → CC Switch）。
