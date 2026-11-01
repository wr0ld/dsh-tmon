# dsh-tmon

把 [tmon](https://github.com/cy745/tmon) 的工作台搬进 Harness：会话顶部多一个「命令终端」标签，里面是 tmon 自己的网页；`tmon` 技能带上它的使用说明，系统提示里有一段提醒模型把长命令套进 tmon；`tmon_tasks` 工具让模型能查任务状态和输出。**tmon 本身要先自己装好，这个插件只显示它记录的东西。**

## 它解决的是什么问题

tmon 官方把自己的用途说得很直接：

> AI Agent 执行长任务（大文件下载、编译、数据迁移）时，往往会放到后台——**状态完全不可见**：你无法判断它是卡死了、在缓慢爬行、还是即将完成；出问题时也没有任何干预手段。
>
> — [tmon README](https://github.com/cy745/tmon/blob/main/README.zh-CN.md)

原话是 "you can't tell if it's stuck, crawling, or about to finish"（[English README](https://github.com/cy745/tmon)），包的描述则是 *Real-time terminal monitoring & control for AI Agent long-running commands*。

一句话：**防止 AI 卡在一条命令上**——既包括命令真的卡住，也包括模型不知道自己卡住、只能靠猜和超时硬判。

官方的解法是一层透明代理：

```bash
tmon "curl -o big.bin https://example.com/big.bin"
```

对调用方行为完全一致（同样的输出、同样的退出码），同时把每一行输出连同时间戳记下来，于是「卡死」和「缓慢」在时间轴上就分得开；人还能在网页终端里一键取消、代答交互提示。

这个插件做两件事，分别补上这条链的两端：

- **人那一侧**：把 tmon 的工作台搬进会话面板，不用切窗口、不用记端口。
- **模型那一侧**：`tmon_tasks` 把「卡了没有」从猜测变成可查的事实——距上次输出多久、已跑多久、最近一次进度上报是什么。

之所以直接嵌网页而不是重画一套：tmon 的界面本身就是终端模拟器，自己实现只会一直落后于它。

## 插件提供什么

| 半边 | 给谁 | 是什么 |
| --- | --- | --- |
| 面板 | 用户 | `conversation.view` 标签（id `tmon`，order 40）打开后挂在主面板 `main`（键 `tmon`），内容是 tmon 网页的 iframe |
| 技能 | 模型 | `skill.md` 注册为 `tmon` 技能，来源 `bundled` |
| 提示段 | 模型 | `ctx.systemPrompt.section()`，名称 `tool:tmon`，order 1650，排在 shell 与后台任务两条工具说明之后 |
| 工具 | 模型 | `tmon_tasks`，查任务列表、单任务、输出 |

后三项都挂在 `ctx.inject([...], …)` 上而不是插件自身的 `inject` 列表里：没有对应服务的组合照样能加载面板，只是少那一块。

## 面板

整个 tmon 网页嵌在面板里，顶部两行是 Harness 自己的：

- 标题与「tmon 运行于 127.0.0.1:<端口>」；tmon 没起来时这一行变红显示「tmon 没有响应」。
- 「重新加载」重挂内嵌页面；「在浏览器打开」用系统浏览器打开同一地址，方便对照或全屏。

网页里的功能就是 tmon 自己的：任务列表、实时输出、给任务发输入、停止运行中的任务、复制任务 id。

tmon 没在运行时，面板不报错，而是显示「连不上 tmon」、它读到的端口和启动办法。服务没起来是面板的普通状态，不是故障。

## 它怎么拿到数据

tmon 的 HTTP API 只接受 Host 和 Origin 都是本机的请求。内嵌页面自己就是 `127.0.0.1:<端口>`，请求天然带对的 Origin，可以直接调；面板唯一需要宿主帮忙的是「端口是多少、tmon 在不在」。

| 半边 | 职责 |
| --- | --- |
| 宿主 `index.js` | 注册 `GET /tmon/status`：端口从 `~/.tmon/port` 读，用宿主进程的 `fetch` 探一次 `/api/health`，返回 `{ reachable, port, version }` |
| 客户端 `client.js` | 每 10 秒问一次 `/tmon/status`，拿到端口就把 `http://127.0.0.1:<端口>/` 塞进 iframe |

路由经 `ctx.connection.requestRejection` 把关，和内置路由一样拒绝不可信来源；探测失败也以 HTTP 200 加 `reachable: false` 加 `reason` 返回，把「没开」当数据而不是错误。

## 三份模型可见的内容怎么分工

同一件事只写一次，各自负责一段：

- **提示段**（每轮都在）：必须无条件生效的策略——何时该套 tmon、不许用 `sleep` 轮询自己盯命令、整条命令当一个字符串、不要嵌套 tmon 自身子命令、卡住了问 `tmon_tasks`、报错找不到 tmon 时让用户装。参数细节一律不写，那属于参数。
  - 触发条件刻意写成「**有没有可能**超过十秒 / 输出量说不准 / 要等外部响应」，而不是「预计超过三十秒」。差别不是数字，是判断归属：写成「预计」时，模型会先估一次时长，估完觉得「这条看起来很快」就跳过了——而那个自我估计正是最容易错的地方（本插件自己的发版流程就这么绕过一次，`sleep` 加轮询硬等 45 秒）。写成「有可能」时，判断落在命令本身的性质上，不落在模型的乐观上。
- **工具定义**：`tmon_tasks` 的描述说它返回什么、什么时候用；默认值、范围、页码语义、行数上限都写在各自的参数上。
- **技能**（按需加载）：工具覆盖不到的部分——后台运行、`tmon progress` / `tmon stage` 上报进度、原始 CLI 兜底，以及实测踩过的坑。

## `tmon_tasks`

面板要有人盯着屏幕才有用，而模型看不到屏幕，所以有了这个工具。

它给的是**一组事实**而不是一个是非：状态、`verdict`、已运行时长、距上次输出多久、最近一次 `progress` 百分比与 `stage` 名称、输出行数。之所以给「距上次输出多久」而不是直接给「卡住了没有」，是因为静默本身判断不了——下载、编译、`sleep` 都可能几十秒不打印东西，只有把静默时长和这个命令本来该不该有输出放在一起，才能区分「卡」和「慢」。

工具描述里写了两条实测出来的陷阱：`status: error` 且没有 `exitCode` 多半是 tmon 服务器重启时把运行中的任务误标了；`~/.tmon/tasks/<id>/meta.json` 不可信，要状态只能走 HTTP 接口。

列表总带上全量计数与状态分布，`status` 只影响返回哪几条、不影响计数——这样过滤结果为空时也看得到整体情况。

**只看本会话的任务。** tmon 是一台机器一个工作台，它的任务列表是这台机器上所有会话跑过的命令，所以不加限制的话模型会读到别的会话在做什么，然后对着别人的任务回答。任务归属是这样建立的：tmon 每起一个任务都会在 stderr 打一行 `tmon: task <id> started: <cmd>`，而跑这条命令的 shell 带着 `DSH_SESSION_ID`——`tools/result` 事件把两者配对写进 `~/.tmon/dsh-tmon/sessions.json`。列表和单任务查询都按这个映射过滤，被过滤掉的数量报在 `otherSessions` 里而不是悄悄丢掉。

这个映射是尽力而为：在本插件装好之前跑过的任务没有记录，会算作「别的会话的」，因此列表可能偏少。宁可让模型看不到旧任务，也不让它看到别人的任务——前者它会说「没有任务」，后者它会答错。删掉 `sessions.json` 即可重置。

## 安装

**前置条件：tmon 得先自己装好，这个插件不会替你装。** 插件不含 tmon 的任何代码，只是读它写下的文件、调它开的本地接口。没装 tmon 时插件照样装得上、面板照样打得开（显示「没有安装 tmon」并附上安装命令）；模型第一次真的去跑 `tmon "<命令>"` 会得到「找不到 tmon」，提示段教它这时停下来告诉你装什么，而不是换个办法重试。

装了但服务没在跑时，面板会自己把它拉起来（`node <tmon>/bin/tmon.js serve`，与 tmon 自己的 `ensureServer` 同一路子），大约 300 毫秒，不需要人管。之所以不经过 `tmon.cmd` 那个批处理壳：走壳就要 `shell: true`，而在 Windows 上那会弹一个黑窗口出来。

```sh
npm install -g @qiu745/tmon     # 需要 Node >= 22.18
tmon --help                     # 确认命令可用（不会留下任务记录）
```

`~/.tmon`（端口文件、`server.pid`、`token`、`tasks/`）是第一次真正用它跑命令时才建出来的，只跑 `--help` 不会建。

装好 tmon 之后，再装插件。从 npm 装：

```sh
dsh plugin --profile web add dsh-tmon
```

`--profile` 换成你实际在用的那个（桌面客户端是 `desktop`）。也可以从源码目录装，路径必须以 `./` 开头：

```sh
dsh plugin --profile desktop add ./plugins/dsh-tmon
```

装完重开 Harness，会话顶部 View 标签行出现「命令终端」，点开就是面板。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-tmon
```

这只移除插件，不动 tmon 本身。要连 tmon 一起清掉，官方给的顺序是（[tmon README](https://github.com/cy745/tmon/blob/main/README.zh-CN.md#%E5%8D%B8%E8%BD%BD)）：

```sh
tmon kill-server            # server 是 detached 长驻进程，不会随 npm 卸载退出
npm rm -g @qiu745/tmon
rm -rf ~/.tmon              # 可选：清掉任务数据与 token
```

## 配置

无。端口跟着 `~/.tmon/port` 走；tmon 换端口不需要改这里。宿主读取 `$TMON_HOME`（默认 `~/.tmon`）。

## 已知边界

- 面板就是 tmon 的网页，所以它的功能边界等于 tmon 的边界：这里没有比 tmon 网页更多的能力，只是把它放到会话里。
- 内嵌页面靠 iframe 加载 `http://127.0.0.1:<端口>`。如果哪天 Harness 给页面加了限制 iframe 的 CSP，或 tmon 改成拒绝被嵌入，这里会显示空白——那时用「在浏览器打开」仍可用。
- 端口每 10 秒才问一次，tmon 换端口后最多 10 秒才反映到面板上；「重新加载」会立刻重问一次。
- 插件不预检 tmon 装没装，也不探测它在不在：面板只读端口文件，提示段和技能无条件注入。模型第一次用会直接撞上 `tmon: command not found`，由提示段接管——告诉用户 `npm install -g @qiu745/tmon` 并等结果，不重试、不悄悄改成裸跑命令。这样既不每轮做一次文件探测，提示内容也不会随环境变长变短。
- 插件不负责安装 tmon：与它的唯一联系是 `~/.tmon` 这个目录和它开的本地端口。
- 面板继承了 tmon 的访问模型：官方对本机浏览器访问默认免认证（[安全模型](https://github.com/cy745/tmon/blob/main/README.zh-CN.md#%E5%AE%89%E5%85%A8%E6%A8%A1%E5%9E%8B)），所以能打开你这台机器浏览器的人就能看到任务输出。插件没有改变这一点，也没有额外加一层。
- `tmon_tasks` 不做判断，只报事实：`verdict` 是按静默时长分的档，命令本来该不该有输出仍要调用者结合命令本身判断。
- 直接跑 `tmon "<命令>"` 时，输出前面可能出现一大段空行。这不是插件的问题，也不是渲染 bug：`cmd.exe` 一启动就会发一串 `ESC[K\r\n`（实测 29 组）再 `ESC[H` 回左上角，真实终端里它们互相抵消、什么也看不见，而 tmon 把这些字节原样回显。同一份数据走 `tmon_tasks` 是干净的——实测任务 `9ea0ad30`：原始回显 35 行含 29 行空行，`linesOf` 渲染出 5 行、零空行。判断「是不是渲染坏了」时，用 `tmon_tasks` 读一遍即可对照。

## 实现札记

这些是写这个插件时实测出来、并且直接决定了实现的几条。

### 提示段为什么不探测 tmon 是否存在

插件启用 = 你要用 tmon，提示段就无条件注入。不做「每轮 stat 一下 `~/.tmon/port` 再决定加不加」，是因为那样提示会在会话中途变长变短，破坏前缀缓存，而收益只是在一台没装 tmon 的机器上少一句废话。

### 输出按终端语义渲染，不是剥掉控制字符

回车（`\r`）和光标回行首（`ESC[H`、`ESC[1;1H`、`ESC[1G`）不是垃圾字符，而是「回到行首重新写」的指令。

这一点是实测出来的。`git subtree split` 用进度条打印 `873/22428`，876 个输出事件里只有 29 个回车，分隔全靠 `ESC[H`；最初把这些控制序列一律当噪音删掉，876 次重绘首尾相接挤成一整行，工具报「共 1 行」——**行数上限完全失效**，因为上限按行计数，而这里只有一行。按终端语义渲染之后，同样的任务从 29697 字节变成 19 字节。

另有一道字符上限兜底：单行超过 500 字符就截断并注明还剩多少，这样即使某个程序从不换行也不发回车，一行也不会无限长。行数上限管行数，字符上限管单行，两个维度都封住才算有界。

### 为什么不让模型直接读 `tmon show --full`

`--full` 会把整份输出塞进一次工具结果，长任务能到几万行，既撑爆上下文也绕开了已经做好的 ANSI 剥离与状态误标校正。所以工具自己支持分页与 `-1` 上限（单次最多 2000 行，超了给最新的 2000 行并注明截断——实测平均每行约 70 字节，2000 行约 5.4 万 token）。CLI 那条路留在技能里当兜底，不是常规路径。

### 纯 JS 对象注册工具，不用 `defineTool`

这个插件在 profile 里是 `link:` 进来的，解析不到 `@deepseek-ai/dsh-tools`，所以直接把普通对象交给 `tools.register()`。输出 schema 用的是 Harness 支持的 JSON Schema 子集，`type` 只接受单个字符串，所以值为未知的字段一律省略而不是给 `null`。

### 技能文件的解析

`skill.md` 的 frontmatter 只读 `name` 和 `description` 两个字段，不引入 YAML 依赖；缺 `description` 时直接抛错，而不是注册一个不能被发现的技能。`source` 是必填的，标为 `bundled`——漏了它技能能进目录，但加载时会报 `source must be a string`。

## 发布

首次发布需要 2FA 验证码：

```sh
npm publish --access public --otp=<6 位验证码>
```

之后的版本走 npm Trusted Publishing（OIDC），不需要任何 token：

1. 在 npmjs.com 的包设置里加一个 Trusted Publisher：Organization 填 `wr0ld`、Repository 填 `dsh-tmon`、Workflow 填 `publish.yml`。
2. 改 `package.json` 的版本号，提交，然后打 tag 推送：

```sh
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/publish.yml` 会校验 tag 与 `package.json` 版本一致后发布，并自动生成 provenance。注意 `repository.url` 必须与 GitHub 仓库完全一致，否则 OIDC 校验会失败。

## License

[MIT](LICENSE)
