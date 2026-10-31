---
name: tmon
description: 用 tmon 包装长耗时命令（下载、编译、批量处理、迁移、长测试），让用户能看到进度并随时取消，同时用 tmon_tasks 工具查询任务状态、判断是卡死还是只是慢、读回输出。含后台运行、进度上报的写法，原始 CLI 的兜底用法，以及实测踩过的坑（--version 会记成失败任务、bash -c 会打散引号、不能嵌套 tmon 自身子命令等）。
---

# tmon 使用指引

tmon 是命令执行追踪工具：命令包进 tmon 后行为与直接执行完全一致（输出原样、退出码透传），同时把输出、阶段、进度记录到 `~/.tmon`，用户可以在 Harness 的「命令终端」面板（会话顶部 View 标签）里看进展并一键取消。

有两条路可以拿到任务信息，**优先用工具**：

| | 怎么用 | 何时用 |
| --- | --- | --- |
| **`tmon_tasks` 工具** | 直接调用，见「查询任务」 | 默认走这条：结构化、已经处理好 ANSI 与状态误标 |
| **原始 CLI** | `tmon status/show/last` 等，见「原始 CLI 兜底」 | 工具不可用、或需要工具没暴露的字段时 |

## 何时使用 tmon

- 预计执行超过约 30 秒的命令（下载、编译、批量任务、迁移、长测试）
- 需要用户实时看到进度、或可能在执行中被取消的任务
- 任务可能长时间无输出，需要区分「卡死」与「缓慢」的场景
- 需要在任务执行中干预（中止、代答交互提示）的场景

## 启动任务

把命令字符串包进 tmon。**复杂命令（含管道、引号、重定向）必须用字符串形式**，外层引号包住整条命令：

```
tmon "curl -o big.bin https://example.com/big.bin"
tmon "npm run build"
tmon "rsync -a /data/ /backup/"
```

简单命令也可以透传参数：`tmon ls -la`。

**不要用 `bash -c` 套一层**，引号会被打散（见「踩过的坑」）。脚本请先写进文件，再 `tmon "bash /path/to/x.sh"`。

需要后台执行时，用 shell 的后台化（`&`），tmon 会在 stderr 打印任务 id：

```
tmon "npm run build" &        # tmon: task 7f2a9c3e started
```

在 `ops_bash` 这类工具里，pty 被切断可能让任务被记成 `error`，所以长任务更稳的写法是让它前台跑，或者用工具自带的后台能力起 tmon 命令。

## 查询任务：`tmon_tasks` 工具

这是首选方式。它给的是**一组事实**，不是一个布尔值，因为「卡住」本质上要看**这个命令本来该不该有输出**。

### 参数

| 参数 | 作用 |
| --- | --- |
| 不传 | 列出最近的任务（默认 10 条），并说明一共记录了多少、各状态各几个 |
| `id` | 看单个任务，8 位十六进制 |
| `limit` | 列表条数，默认 10，最多 50 |
| `status` | 只看某个状态：`running` / `success` / `failed` / `killed` / `error` |
| `tail` | 给 `id` 时附带最近 N 行输出，默认 20，最多 200，0 表示不要 |
| `offset` | 页码：`1` 是最新一页，`2`、`3`… 往回翻，`-1` 要全部（上限 2000 行）。默认等同 `1` |

### 任务太多怎么找

列表默认只给 10 条，但每次都会带上总量和各状态的分布，例如：

```
Tasks: showing 10 of 47 recorded (success 40, failed 4, killed 1, error 2)
```

看到这行就知道有什么、有多少被截掉了。要找特定的东西，用 `status` 过滤，不用一页页翻：

```
Tasks with status "failed": showing 4 of 4 matching, 47 recorded (success 40, failed 4, killed 1, error 2)
```

常见用法：刚起了一个任务想确认它还在跑，用 `status: "running"`；想复盘刚才哪一步炸了，用 `status: "failed"`。`error` 要留意——它多半是 tmon 重启把运行中的任务误标了，不代表命令失败（见下面的陷阱）。

### 返回什么

列表里每条任务带：状态、`verdict`、已运行时长、**距上次输出多久**、进度百分比、阶段名、输出行数。

| 信号 | 含义 |
| --- | --- |
| 距上次输出 < 30 秒 | `verdict: active`，正常在跑 |
| 30 秒 – 2 分钟没输出 | `verdict: silent`，可能慢也可能卡，再观察一个窗口 |
| 超过 2 分钟没输出 | `verdict: silent-long`，高度可疑；先确认这个命令本来就该不该打印东西 |
| `progress` / `stage` 有更新 | 最可靠的进度证据，比输出更准 |
| `status` 是 `error` 但没有 `exitCode` | **多半不是失败**，见下面的陷阱 |

`verdict: finished` 表示任务已经结束（`settled: true`），此时 `exitCode` 才是可信的成败依据。

### 读长输出要翻页

**100 行以内不用管**：不管传什么页码都整份返回，标题直接写「全部 N 行」。

超过 100 行才分页。`tail` 是每页大小（默认 20，最多 200），`offset` 是页码：

| 页码 | 拿到什么 |
| --- | --- |
| `1`（默认） | 最新一页 |
| `2`、`3`… | 一路往回翻，最后一页正好结束在第一行 |
| `-1` | 全部行（单次最多 2000 行，超了只给最新的 2000 行并注明截断） |

每页都朝同一个方向走，所以不会重复也不会漏。返回里 `totalLines` 是总共多少行，`pageCount` 是分几页，`page` 是这次第几页，底部提示只列出真正存在的下一页和 `-1`。

**页码越界会报错**，报错里写明实际有几页。之所以不返回空页：读到空意味着「没有了」，页码写错意味着「那页不存在」，混淆这两件事会让人以为读完了。

先看 `totalLines` 再决定要不要继续翻——如果只有几百行而且你只需要确认某一步有没有执行，翻一两页往往就够了，不必用 `-1` 把整份灌进来。

### 进度条只有一行

带进度条的命令（`git subtree split`、`curl`、`wget`、`tar` 之类）反复用回车或光标回行首重写同一行。工具按终端语义渲染，所以这种输出只有**一行**，内容是**最新状态**，和用户在网页上看到的一样。不要因为只有一行就以为输出丢了——它本来就是一行动态刷新。

反过来，如果某个任务的 `outputLines` 是 1 而命令显然打印了很多东西，先看那一行是不是进度条。单行超过 500 字符会被截断并注明还剩多少字符。

### 判断卡死 vs 缓慢的完整流程

1. 起任务，拿到 id。
2. 过一段时间调 `tmon_tasks({ id })`。
3. 看 `verdict` 和 `silenceMs`：`active` 就继续等；`silent`/`silent-long` 时结合命令本身判断——下载无进度条、编译单个大文件、`sleep` 都可能长时间静默。
4. 有 `progress`/`stage` 就以前者为准，那是命令主动上报的证据。
5. 确实可疑时，用 `tail` 读最后几行；需要更多上下文就用 `offset` 往回翻。
6. **不要用自己的超时去推断卡死**，也不要只看 `status`。

## 进度上报

在由 tmon 启动的脚本里，可以直接调用 tmon 子命令上报进度（tmon 会自动注入所需环境变量）：

```
tmon progress 45 "解压中"     # 百分比 + 阶段消息
tmon stage "编译"             # 仅阶段名
```

用户能在面板里看到进度条和当前阶段，模型也能从 `tmon_tasks` 的 `lastPct` / `lastStage` 读到同样的数字。**写长脚本时主动加这两条，比让使用者盯着日志猜要可靠得多。**

## 原始 CLI 兜底

工具不可用时（比如在别的 harness 里、或 `tmon_tasks` 报连不上），用 CLI：

```
tmon last                     # 最近一个任务 id
tmon status 7f2a9c3e          # running / success / failed / killed / error
tmon show 7f2a9c3e --tail 20  # 输出快照（已剥离 ANSI）
tmon show 7f2a9c3e --full     # 全部输出
tmon wait 7f2a9c3e            # 阻塞等待完成，退出码透传
tmon kill 7f2a9c3e            # 取消任务
```

要注意：

- `tmon show` 只有 `--tail N` 和 `--full` 两种，没有偏移参数，读中间一段要比对 `--full` 自己切。
- `tmon wait` 会一直阻塞，别在不确定任务是否活跃时直接等。
- 判断卡死时，CLI 组合是 `status` + `show --tail` + 自己比较最后一条输出的时间戳；**仍然不要只看 `status`**，因为 `error` 可能只是服务器重启导致的误标。

## 踩过的坑（都是实测复现过的）

**查版本会把面板弄脏。** `tmon --version` 不被当成查询，而是被记成一条命令任务：`cmd: "--version"`、`status: failed`、`exitCode: 1`。同理，任何不是 tmon 已知子命令的参数，都会被当成要执行的命令。已知子命令只有这几个：
`last` `ls` `status` `show` `wait` `kill` `progress` `stage` `skill` `kill-server` `serve`。
核查「装没装」用 `command -v tmon`，不要用 `--version`。

**`tmon bash -c '...'` 会把引号打散。** 实测记录下来的 `cmd` 是 `bash -c for i in 1 2 3 4 5 6 7 8; do echo "step $i ..."; sleep 1.2; do`：外层引号、分号、`done` 全被拆没了，任务 `failed`、`exitCode 2`。原因是 tmon 把参数重新拼成一条命令字符串再交给 shell，这一来一回把嵌套引号吃掉了。
正确做法：把脚本写进文件，再 `tmon "bash /path/to/x.sh"`（实测 `success`、`exitCode 0`）；或者把整条命令当一个字符串传，不要用 `bash -c` 套一层。

**不要嵌套 tmon 自己的子命令。** `tmon "tmon ls"`、`tmon "tmon wait <id>"` 都会被当成一条普通命令再跑一遍，白白多一层任务。这些直接在命令行上调。`tmon skill` 也是子命令。

**`status: error` 不等于命令失败。** tmon 的 server 重启时，会把内存里所有 `running` 的任务强制改写成 `error`（它重启后没法再控制原来的执行器）。所以看到 `error` 且没有 `exitCode`，应当理解为「状态未知」。真正的失败会有非 0 的 `exitCode`。`tmon_tasks` 已经替你处理了这一条，会附注说明。

**`~/.tmon/tasks/<id>/meta.json` 不可信。** 实测：任务运行中读不到这个文件，任务成功结束后仍然读不到，而 HTTP 接口一直给出正确的状态。要拿状态就用 `tmon_tasks` 或 `/api/tasks`，不要自己解析磁盘。

**tmon 网页没有「打开某个任务」的 URL 参数。** 没有 `?task=<id>` 这种东西，只有根页面。想直达某个任务的内容，用 `tmon show <id> --full`，或者在「命令终端」面板里点开那一行。

**`~/.tmon` 不是 `--help` 建出来的。** 只跑 `tmon --help` 不会创建它；`port`、`server.pid`、`token`、`tasks/` 都是第一次真正执行任务才出现的。所以不要靠 `~/.tmon` 是否存在来判断装没装。

## 注意事项

- **不要包装 tmon 自身命令**：`ls` / `status` / `wait` / `show` / `progress` / `stage` / `last` / `kill` 直接调用。
- 命令输出含 ANSI 控制字符是正常现象：`tmon_tasks` 会剥掉控制序列并按终端语义渲染（进度条只留最新一行），面板里是 tmon 网页本身，显示的就是终端效果。
- 交互式提示（密码、Y/N 确认）：优先给命令加非交互参数（`--batch`、`-y`、`< /dev/null`）；必须交互时，用户可以在 tmon 网页的终端窗口里代答。
- 命令失败时 tmon 透传退出码，用退出码做流程判断，不要用 tmon 的 `status` 字段推断成功与否（见上面的 `error` 陷阱）。
