---
name: tmon
description: 用 tmon 包装长耗时命令（下载、编译、批量处理、迁移、长测试），让用户能看到进度并随时取消；用 tmon_tasks 工具查任务状态、判断是卡死还是只是慢、读回输出。含后台运行、进度上报、原始 CLI 兜底，以及实测踩过的坑（--version 会记成失败任务、bash -c 会打散引号等）。
---

# tmon 使用指引

tmon 是命令执行追踪工具：命令包进 tmon 后行为与直接执行完全一致（输出原样、退出码透传），同时把输出、阶段、进度记录到 `~/.tmon`，用户可以在 Harness 的「命令终端」标签（会话顶部 View 行）里看进展并一键取消。

**前提**：tmon 由用户自己安装（`npm install -g @qiu745/tmon`，需要 Node 22.18+），`tmon` 不在 `PATH` 上就别往下走——告诉用户装一次，然后等他就位。

查任务优先用 `tmon_tasks` 工具，它的参数与返回字段在工具定义里。下面只讲工具覆盖不到的部分：怎么起任务、怎么上报进度、工具不可用时怎么办、以及实测踩过的坑。

## 起任务

把整条命令当一个字符串传进去，外层引号包住全部：

```
tmon "curl -o big.bin https://example.com/big.bin"
tmon "npm run build"
tmon "rsync -a /data/ /backup/"
```

`tmon` 由你自己安装（`npm install -g @qiu745/tmon`，需要 Node 22.18+），在 PATH 上直接可用。

这是一条命令的入口：`tmon "<命令>"`。要把参数给 tmon 自己，写成 `tmon ls -la`。

**不要用 `bash -c` 套一层**（原因见下面的坑）。脚本先写进文件，再 `tmon "bash /path/to/x.sh"`。

**不要自己用 `sleep` 轮询盯命令。** 想看进度就用 `tmon_tasks`，想等结束就用 `tmon wait <id>`（退出码透传）；`sleep 20; 再看一眼` 这种写法既看不见中间过程，又浪费一轮往返，还可能把一次正常的长任务误判成卡死。

**命令本身带延时，一律走 tmon，不估总时长。** `sleep`、`timeout`、`ping -n`/`-c` 当停顿用、退避重试循环、`Start-Sleep`、`timeout /t` —— 只要命令里有等待，就 `tmon "<命令>"`。裸跑这类命令会把整轮卡住，用户既看不到进度也没法取消，哪怕总时长只有几秒。

**tmon 用的是平台默认 shell，可能和当前会话的不同。** Windows 上是 `cmd.exe`，其它平台是 `/bin/sh`，没有配置项可改。写命令前先想清楚它在哪个 shell 里展开：`cmd` 里没有 `$VAR`、没有 `&&` 之外的 Unix 习惯，`bash` 里才能用单引号嵌套与管道组合。要用 bash 的特性就写成脚本文件再 `tmon "bash /path/to/x.sh"`，让方言只出现在文件里。

需要后台执行时用 shell 的后台化，tmon 会在 stderr 打印任务 id：

```
tmon "npm run build" &        # tmon: task 7f2a9c3e started
```

在 `ops_bash` 这类工具里 pty 会被切断，可能让任务被记成 `error`；长任务更稳的写法是用工具自带的后台能力起 tmon 命令。

## 上报进度

在由 tmon 启动的脚本里可以用这两个子命令（tmon 会注入 `TMON_TASK_ID`，它们靠它找到任务）：

```
tmon progress 45 "解压中"     # 百分比 + 阶段消息
tmon stage "编译"             # 仅阶段名
```

在 tmon 之外调用会直接报错 `未在 tmon 任务环境中运行（缺少 TMON_TASK_ID）`——所以只能写在被 `tmon "..."` 包起来的那条命令里，不能在外面补报。

用户能在面板里看到进度条和当前阶段，模型能从 `tmon_tasks` 的 `lastPct` / `lastStage` 读到同样的数字。**写长脚本时主动加这两条，比让人盯着日志猜要可靠得多。**

## 读结果时的几个信号

`tmon_tasks` 给的是事实，判断要自己做：

| 信号 | 含义 |
| --- | --- |
| `verdict: active` | 最近 30 秒内有输出，正常在跑 |
| `verdict: silent` / `silent-long` | 30 秒 / 2 分钟没输出。可能慢也可能卡，要看这个命令本来该不该打印东西 |
| `lastPct` / `lastStage` 有更新 | 最可靠的进度证据，比输出更准 |
| `status: error` 且无 `exitCode` | 多半不是失败，见下面的坑 |
| `verdict: finished` | 已结束，此时 `exitCode` 才是成败依据 |

**进度条只有一行是正常的**：带进度条的命令反复用回车重写同一行，工具按终端语义渲染，所以只留最新状态。别因为 `outputLines` 是 1 就以为输出丢了。

**不要用自己的超时去推断卡死**，也不要只看 `status`：静默时长要和「这个命令本来该不该有输出」放在一起看。

## 原始 CLI 兜底

`tmon_tasks` 不可用时（别的 harness、或连不上）用 CLI：

```
tmon last                     # 最近一个任务 id
tmon status 7f2a9c3e          # running / success / failed / killed / error
tmon show 7f2a9c3e --tail 20  # 输出快照（已剥离 ANSI）
tmon show 7f2a9c3e --full     # 全部输出
tmon wait 7f2a9c3e            # 阻塞等待完成，退出码透传
tmon wait 7f2a9c3e --timeout=600   # 最多等 600 秒
tmon kill 7f2a9c3e            # 取消任务
```

`tmon show` 只有 `--tail N` 和 `--full` 两种，没有偏移参数，读中间一段要拿 `--full` 自己切。

**`tmon wait` 的退出码不全是命令的退出码**，别把等待本身的结果当成命令失败：

| 退出码 | 含义 |
| --- | --- |
| 命令自己的退出码 | 任务结束，成功时是 `0` |
| `124` | **等待超时**（`--timeout` 到点），命令可能还在跑 |
| `130` | 任务被取消（SIGINT） |
| `1` | 任务 id 不存在 |

不带 `--timeout` 会一直阻塞，所以在不确定任务是否活跃时给它一个超时。

## 踩过的坑（都是实测复现过的）

**`tmon --version` 会被记成一条失败任务。** 任何不是已知子命令的参数都会被当成要执行的命令：`cmd: "--version"`、`status: failed`、`exitCode: 1`。已知子命令只有 `last` `ls` `status` `show` `wait` `kill` `progress` `stage` `skill` `kill-server` `serve`。不要为了查装没装去跑 `tmon --version`：直接用 `tmon "<cmd>"`；shell 报找不到 tmon 时，说明用户还没装，告诉他 `npm install -g @qiu745/tmon` 再等他就位，不要换别的办法重跑。

**`tmon bash -c '...'` 会把引号打散。** 实测记下的 `cmd` 是 `bash -c for i in 1 2 3 4 5 6 7 8; do echo "step $i ..."; sleep 1.2; do`：外层引号、分号、`done` 全被拆没，任务 `failed`、`exitCode 2`。tmon 会把参数重新拼成一条命令字符串再交给 shell，这一来一回吃掉了嵌套引号。正确做法是脚本写进文件再 `tmon "bash /path/to/x.sh"`。

**不要嵌套 tmon 自己的子命令。** `tmon "tmon ls"` 会被当成普通命令再跑一遍，白白多一层任务。这些直接在命令行上调。

**`status: error` 不等于命令失败。** tmon 的 server 重启时会把内存里所有 `running` 的任务强制改写成 `error`（重启后没法再控制原来的执行器）。看到 `error` 且没有 `exitCode` 应当理解为「状态未知」；真正的失败有非 0 的 `exitCode`。`tmon_tasks` 已经替你处理这一条，会附注说明。

**`~/.tmon/tasks/<id>/meta.json` 不可信。** 实测：运行中读不到，成功后仍然读不到，而 HTTP 接口一直正确。要状态就用 `tmon_tasks` 或 `/api/tasks`，别自己解析磁盘。`~/.tmon` 本身也是第一次真正跑命令才建出来的，`--help` 不会建它。

## 注意

- 交互式提示（密码、Y/N 确认）：优先给命令加非交互参数（`--batch`、`-y`、`< /dev/null`）；必须交互时，用户可以在 tmon 网页的终端窗口里代答。
- 命令输出含 ANSI 控制字符是正常现象：`tmon_tasks` 会剥掉控制序列并按终端语义渲染；面板里是 tmon 网页本身，显示的就是终端效果。
