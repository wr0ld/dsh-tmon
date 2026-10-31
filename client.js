/**
 * dsh-tmon — client half.
 *
 * Registers the 「命令终端」panel under the session's `conversation.view` tab row
 * and the keyed `main` slot the tab opens. The panel polls the two host routes (`tmon/status`,
 * `tmon/tasks`) instead of calling tmon directly, because tmon rejects callers
 * whose Origin is not its own page.
 *
 * The list shows each task's status, stage, progress and command; opening a
 * task adds its recorded output, read back from tmon's own `stream.jsonl`
 * through the events route, so a finished task stays readable.
 */

window.__ModuleLoader__.load({
  id: 'dsh-tmon',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace holding this plugin's text. */
    const NS = 'tmon'

    /** Host route reporting whether tmon answers, and on which port. */
    const STATUS_ROUTE = 'tmon/status'

    /** Host route returning tmon's task records. */
    const TASKS_ROUTE = 'tmon/tasks'

    /** Host route returning one task's recorded events. */
    const EVENTS_ROUTE = 'tmon/events'

    /** A task list that updates within seconds is enough to feel live. */
    const POLL_MS = 4000

    /** An open running task is followed faster than the list is refreshed. */
    const DETAIL_POLL_MS = 1500

    /** Text for both shipped locales; the active one is registered at apply time. */
    const dictionaries = {
      zh: {
        nav: '命令终端',
        panelTitle: '命令终端',
        connectedOn: 'tmon 运行于 127.0.0.1:{port}',
        disconnected: 'tmon 没有响应',
        refresh: '刷新',
        openPage: '打开 tmon 网页',
        loading: '正在读取 tmon…',
        unavailable: '连不上 tmon',
        unavailableHint: '本机没有正在运行的 tmon 服务。在会话里执行 tmon "命令"，或先跑一次 tmon ls，tmon 会启动并写出端口。',
        portHint: '端口取自 ~/.tmon/port（当前 {port}）',
        empty: '还没有 tmon 任务',
        emptyHint: '在会话里执行 tmon "npm run build" 这样的长命令，它的状态、阶段和进度就会出现在这里。',
        stage: '阶段 {name}',
        progress: '进度 {pct}%',
        exitCode: '退出码 {code}',
        startedAt: '{time} 开始',
        runningFor: '已运行 {duration}',
        took: '用时 {duration}',
        statusRunning: '运行中',
        statusSuccess: '成功',
        statusFailed: '失败',
        statusKilled: '已取消',
        statusUnknown: '未知',
        unitMinute: ' 分 ',
        unitSecond: ' 秒',
        readError: '读取失败：{reason}',
        back: '← 返回列表',
        loadingOutput: '正在读取输出…',
        outputEmpty: '这个任务没有记录到输出',
        openHint: '点击任务查看输出',
      },
      en: {
        nav: 'Terminal',
        panelTitle: 'Terminal',
        connectedOn: 'tmon is serving 127.0.0.1:{port}',
        disconnected: 'tmon is not responding',
        refresh: 'Refresh',
        openPage: 'Open tmon page',
        loading: 'Reading tmon…',
        unavailable: 'tmon is unreachable',
        unavailableHint: 'No tmon service is running on this machine. Run tmon "command" in a session, or run tmon ls once, and tmon starts and writes its port.',
        portHint: 'Port comes from ~/.tmon/port (now {port})',
        empty: 'No tmon tasks yet',
        emptyHint: 'Run a long command such as tmon "npm run build" in a session and its status, stage and progress appear here.',
        stage: 'Stage {name}',
        progress: '{pct}%',
        exitCode: 'exit code {code}',
        startedAt: 'started {time}',
        runningFor: 'running {duration}',
        took: 'took {duration}',
        statusRunning: 'running',
        statusSuccess: 'succeeded',
        statusFailed: 'failed',
        statusKilled: 'cancelled',
        statusUnknown: 'unknown',
        unitMinute: 'm',
        unitSecond: 's',
        readError: 'Read failed: {reason}',
        back: '← Back to list',
        loadingOutput: 'Reading output…',
        outputEmpty: 'This task recorded no output',
        openHint: 'Click a task to see its output',
      },
    }

    /** @param ms - epoch milliseconds. @returns local `HH:MM:SS`. */
    const clock = ms => new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

    /**
     * @param ms - elapsed milliseconds.
     * @param t - translate function owning the unit words.
     * @returns a short, locale-correct duration.
     */
    const duration = (ms, t) => {
      const seconds = Math.max(0, Math.round(ms / 1000))
      const minutes = Math.floor(seconds / 60)
      const rest = seconds % 60
      return minutes > 0
        ? `${String(minutes)}${t('unitMinute')}${String(rest)}${t('unitSecond')}`
        : `${String(rest)}${t('unitSecond')}`
    }

    /**
     * Terminal control sequences a PTY writes around its text: CSI (cursor,
     * erase, colour), OSC (window titles), and single-character escapes.
     */
    const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

    /**
     * @param data - raw PTY output from a tmon task event.
     * @returns the same text without control sequences, with `\r` line breaks
     *   normalized; carriage-return overwrites are kept as separate lines
     *   because the panel has no cursor to move.
     */
    const plainText = data => data.replace(ANSI, '').replace(/\r\n?/g, '\n')

    /** How each tmon status reads, and what colour its dot takes. */
    const STATUS = {
      running: { key: 'statusRunning', color: 'var(--dsw-alias-brand-primary)' },
      success: { key: 'statusSuccess', color: 'var(--dsw-alias-state-success-primary)' },
      failed: { key: 'statusFailed', color: 'var(--dsw-alias-state-error-primary)' },
      killed: { key: 'statusKilled', color: 'var(--dsw-alias-label-tertiary)' },
    }

    /** Style for a status, falling back to the neutral one tmon may add later. */
    const statusOf = status => STATUS[status] ?? { key: 'statusUnknown', color: 'var(--dsw-alias-state-idle-primary)' }

    /** Panel styles; every colour is a theme token so light and dark both work. */
    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        height: '100%',
        minHeight: 0,
        padding: '16px 20px 24px',
        boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'auto',
      },
      header: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '12px',
        paddingBottom: '12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      heading: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      title: { margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: 1.4 },
      subtitle: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      subtitleDown: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 },
      button: {
        padding: '5px 12px',
        fontSize: '12px',
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      link: {
        padding: '5px 12px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        textDecoration: 'none',
      },
      notice: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '12px 14px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
      },
      noticeTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' },
      noticeBody: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      empty: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        padding: '48px 16px',
        textAlign: 'center',
      },
      emptyTitle: { fontSize: '13px', fontWeight: 600 },
      emptyBody: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', maxWidth: '46ch' },
      list: { display: 'flex', flexDirection: 'column', gap: '8px', margin: 0, padding: 0, listStyle: 'none' },
      dot: { width: '7px', height: '7px', borderRadius: '50%', marginTop: '6px', flexShrink: 0 },
      rowMain: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: 1 },
      command: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      meta: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '4px 10px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-caption)',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      stage: { color: 'var(--dsw-alias-link)' },
      rowSide: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '6px',
        flexShrink: 0,
        minWidth: '72px',
      },
      statusLabel: { fontSize: '12px', fontWeight: 600 },
      barTrack: {
        width: '72px',
        height: '4px',
        borderRadius: '2px',
        background: 'var(--dsw-alias-bg-layer-3)',
        overflow: 'hidden',
      },
      barFill: { height: '100%', background: 'var(--dsw-alias-brand-primary)' },
      pct: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)' },
      rowButton: {
        display: 'flex',
        gap: '10px',
        width: '100%',
        padding: '10px 12px',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        cursor: 'pointer',
      },
      rowButtonActive: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      detail: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, flex: 1 },
      detailBar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      detailCommand: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: 1.5,
        wordBreak: 'break-all',
        flex: 1,
        minWidth: 0,
      },
      output: {
        margin: 0,
        padding: '10px 12px',
        flex: 1,
        minHeight: '160px',
        maxHeight: '52vh',
        overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
      },
      outputStderr: { color: 'var(--dsw-alias-state-error-primary)' },
      outputNote: { color: 'var(--dsw-alias-label-caption)' },
    }

    /**
     * One tmon task: state, command tail, stage and progress.
     * @param props - `task` is tmon's own record, `t` translates this namespace.
     */
    function TaskRow(props) {
      const t = props.t
      const task = props.task
      const status = statusOf(task.status)
      const pct = typeof task.latestPct === 'number' ? Math.max(0, Math.min(100, task.latestPct)) : null
      const startedAt = typeof task.startedAt === 'number' ? task.startedAt : null
      const endedAt = typeof task.endedAt === 'number' ? task.endedAt : null
      const elapsed = startedAt === null
        ? null
        : endedAt === null ? Date.now() - startedAt : endedAt - startedAt

      const meta = [
        h('span', { key: 'id', style: styles.mono }, task.id),
        startedAt === null ? null : h('span', { key: 'start' }, t('startedAt', { time: clock(startedAt) })),
        elapsed === null
          ? null
          : h('span', { key: 'elapsed' }, endedAt === null
            ? t('runningFor', { duration: duration(elapsed, t) })
            : t('took', { duration: duration(elapsed, t) })),
        typeof task.exitCode === 'number' && endedAt !== null
          ? h('span', { key: 'exit' }, t('exitCode', { code: task.exitCode }))
          : null,
        typeof task.latestStage === 'string' && task.latestStage !== ''
          ? h('span', { key: 'stage', style: styles.stage }, t('stage', { name: task.latestStage }))
          : null,
      ].filter(Boolean)

      return h('li', null,
        h('button', {
          type: 'button',
          style: props.active === true ? { ...styles.rowButton, ...styles.rowButtonActive } : styles.rowButton,
          title: t('openHint'),
          onClick: () => { props.onSelect(task.id) },
        },
          h('span', { style: { ...styles.dot, background: status.color } }),
          h('div', { style: styles.rowMain },
            h('span', { style: styles.command, title: task.cmd ?? '' }, task.cmd ?? ''),
            h('div', { style: styles.meta }, ...meta),
          ),
          h('div', { style: styles.rowSide },
            h('span', { style: { ...styles.statusLabel, color: status.color } }, t(status.key)),
            pct === null ? null : h('div', { style: styles.barTrack },
              h('div', { style: { ...styles.barFill, width: `${String(pct)}%` } }),
            ),
            pct === null ? null : h('span', { style: styles.pct }, t('progress', { pct: Math.round(pct) })),
          ),
        ),
      )
    }

    /**
     * One task's recorded events: its output, with progress, stage and status
     * markers kept in stream order so they appear where they happened.
     * @param props - `task` is tmon's record, `t` translates, `onBack` closes it.
     */
    function TaskDetail(props) {
      const t = props.t
      const task = props.task
      const settled = task.status !== 'running'
      const status = statusOf(task.status)
      const [state, setState] = React.useState({ events: [], loading: true, reason: null })
      const lastSeq = React.useRef(0)

      React.useEffect(() => {
        lastSeq.current = 0
        setState({ events: [], loading: true, reason: null })
        let cancelled = false

        const load = async () => {
          try {
            const query = `?id=${encodeURIComponent(task.id)}&after=${String(lastSeq.current)}`
            const body = await (await fetch(`${EVENTS_ROUTE}${query}`, { headers: { accept: 'application/json' } })).json()
            if (cancelled) return
            if (body?.reachable !== true) {
              setState(current => ({
                ...current,
                loading: false,
                reason: typeof body?.reason === 'string' ? body.reason : null,
              }))
              return
            }
            const incoming = Array.isArray(body.events) ? body.events : []
            if (incoming.length === 0) {
              setState(current => (current.loading ? { ...current, loading: false } : current))
              return
            }
            for (const event of incoming) {
              if (typeof event?.seq === 'number' && event.seq > lastSeq.current) lastSeq.current = event.seq
            }
            setState(current => ({ events: [...current.events, ...incoming], loading: false, reason: null }))
          } catch (error) {
            if (cancelled) return
            setState(current => ({ ...current, loading: false, reason: String(error?.message ?? error) }))
          }
        }

        void load()
        if (settled) return () => { cancelled = true }
        const timer = setInterval(() => { void load() }, DETAIL_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [task.id, settled])

      const startedAt = typeof task.startedAt === 'number' ? task.startedAt : null
      const endedAt = typeof task.endedAt === 'number' ? task.endedAt : null
      const elapsed = startedAt === null ? null : endedAt === null ? Date.now() - startedAt : endedAt - startedAt

      const meta = [
        h('span', { key: 'id', style: styles.mono }, task.id),
        typeof task.pid === 'number' ? h('span', { key: 'pid' }, `pid ${String(task.pid)}`) : null,
        typeof task.cwd === 'string' && task.cwd !== ''
          ? h('span', { key: 'cwd', style: styles.mono, title: task.cwd }, task.cwd)
          : null,
        startedAt === null ? null : h('span', { key: 'start' }, t('startedAt', { time: clock(startedAt) })),
        elapsed === null
          ? null
          : h('span', { key: 'elapsed' }, endedAt === null
            ? t('runningFor', { duration: duration(elapsed, t) })
            : t('took', { duration: duration(elapsed, t) })),
        typeof task.exitCode === 'number' && endedAt !== null
          ? h('span', { key: 'exit' }, t('exitCode', { code: task.exitCode }))
          : null,
        typeof task.latestStage === 'string' && task.latestStage !== ''
          ? h('span', { key: 'stage', style: styles.stage }, t('stage', { name: task.latestStage }))
          : null,
      ].filter(Boolean)

      const runs = []
      for (const event of state.events) {
        if (event?.type === 'output' && typeof event.data === 'string') {
          const text = plainText(event.data)
          if (text === '') continue
          const last = runs[runs.length - 1]
          if (last !== undefined && last.kind === 'output' && last.stderr === (event.stream === 'stderr')) {
            last.text += text
          } else {
            runs.push({ kind: 'output', stderr: event.stream === 'stderr', text })
          }
        } else if (event?.type === 'stage' && typeof event.name === 'string') {
          runs.push({ kind: 'note', text: t('stage', { name: event.name }) })
        } else if (event?.type === 'progress' && typeof event.pct === 'number') {
          runs.push({ kind: 'note', text: t('progress', { pct: Math.round(event.pct) }) })
        } else if (event?.type === 'status') {
          const noted = statusOf(event.status)
          runs.push({
            kind: 'note',
            text: typeof event.exitCode === 'number'
              ? `${t(noted.key)} · ${t('exitCode', { code: event.exitCode })}`
              : t(noted.key),
          })
        }
      }

      // A PTY opens its task by clearing the screen, which survives as blank
      // lines at the head of the first output run; they push real text down.
      if (runs.length > 0 && runs[0].kind === 'output') {
        runs[0].text = runs[0].text.replace(/^\n+/, '')
        if (runs[0].text === '') runs.shift()
      }

      return h('div', { style: styles.detail },
        h('div', { style: styles.detailBar },
          h('button', { type: 'button', style: styles.button, onClick: () => { props.onBack() } }, t('back')),
          h('span', { style: { ...styles.statusLabel, color: status.color } }, t(status.key)),
        ),
        h('div', { style: styles.detailCommand }, task.cmd ?? ''),
        h('div', { style: styles.meta }, ...meta),
        runs.length === 0
          ? h('div', { style: styles.empty },
            h('span', { style: styles.emptyBody }, state.loading ? t('loadingOutput') : t('outputEmpty')))
          : h('pre', { style: styles.output },
            ...runs.map((run, index) => h('span', {
              key: String(index),
              style: run.kind === 'note' ? styles.outputNote : run.stderr ? styles.outputStderr : undefined,
            }, run.kind === 'note' ? `${run.text}\n` : run.text))),
        state.reason === null
          ? null
          : h('span', { style: styles.noticeBody }, t('readError', { reason: state.reason })),
      )
    }

    /** The panel: tmon's task list, or one task's detail, or why neither is there. */
    function TmonPanel(props) {
      const t = typeof props.t === 'function' ? props.t : () => ''
      const [snapshot, setSnapshot] = React.useState({
        loading: true,
        connected: false,
        port: null,
        tasks: [],
        reason: null,
      })
      const [tick, setTick] = React.useState(0)
      const [selected, setSelected] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false

        const load = async () => {
          try {
            const status = await (await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } })).json()
            if (cancelled) return
            if (status?.reachable !== true) {
              setSnapshot({
                loading: false,
                connected: false,
                port: typeof status?.port === 'number' ? status.port : null,
                tasks: [],
                reason: typeof status?.reason === 'string' ? status.reason : null,
              })
              return
            }
            const body = await (await fetch(TASKS_ROUTE, { headers: { accept: 'application/json' } })).json()
            if (cancelled) return
            setSnapshot({
              loading: false,
              connected: true,
              port: typeof body?.port === 'number' ? body.port : status.port ?? null,
              tasks: Array.isArray(body?.tasks) ? body.tasks : [],
              reason: null,
            })
          } catch (error) {
            if (cancelled) return
            setSnapshot(current => ({
              ...current,
              loading: false,
              connected: false,
              reason: String(error?.message ?? error),
            }))
          }
        }

        void load()
        const timer = setInterval(() => { void load() }, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [tick])

      const port = typeof snapshot.port === 'number' ? snapshot.port : null
      const portLabel = t('portHint', { port: port === null ? '—' : port })

      const header = h('div', { style: styles.header },
        h('div', { style: styles.heading },
          h('h2', { style: styles.title }, t('panelTitle')),
          h('span', { style: snapshot.connected ? styles.subtitle : styles.subtitleDown },
            snapshot.connected
              ? t('connectedOn', { port: port ?? '—' })
              : t('disconnected')),
        ),
        h('div', { style: styles.actions },
          h('button', {
            type: 'button',
            style: styles.button,
            onClick: () => { setTick(value => value + 1) },
          }, t('refresh')),
          snapshot.connected && port !== null
            ? h('a', {
              style: styles.link,
              href: `http://127.0.0.1:${String(port)}/`,
              target: '_blank',
              rel: 'noreferrer',
            }, t('openPage'))
            : null,
        ),
      )

      if (snapshot.loading) {
        return h('div', { style: styles.root }, header,
          h('div', { style: styles.empty }, h('span', { style: styles.emptyBody }, t('loading'))))
      }

      if (!snapshot.connected) {
        return h('div', { style: styles.root }, header,
          h('div', { style: styles.notice },
            h('span', { style: styles.noticeTitle }, t('unavailable')),
            h('span', { style: styles.noticeBody }, t('unavailableHint')),
            h('span', { style: styles.noticeBody }, portLabel),
            snapshot.reason === null
              ? null
              : h('span', { style: styles.noticeBody }, t('readError', { reason: snapshot.reason })),
          ))
      }

      if (snapshot.tasks.length === 0) {
        return h('div', { style: styles.root }, header,
          h('div', { style: styles.empty },
            h('span', { style: styles.emptyTitle }, t('empty')),
            h('span', { style: styles.emptyBody }, t('emptyHint')),
          ))
      }

      const openTask = selected === null
        ? undefined
        : snapshot.tasks.find(task => task.id === selected)
      if (openTask !== undefined) {
        return h('div', { style: styles.root }, header,
          h(TaskDetail, { task: openTask, t, onBack: () => { setSelected(null) } }))
      }

      return h('div', { style: styles.root }, header,
        h('ul', { style: styles.list },
          ...snapshot.tasks.map(task => h(TaskRow, {
            key: String(task.id),
            task,
            t,
            active: task.id === selected,
            onSelect: id => { setSelected(id) },
          }))),
      )
    }

    return {
      inject: ['slots', 'locale'],

      apply(ctx) {
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.locale.register(NS, 'zh', dictionaries.zh), 'tmon: dictionaries zh')
        ctx.effect(() => ctx.locale.register(NS, 'en', dictionaries.en), 'tmon: dictionaries en')

        /** Supplies this namespace's translate function when the slot projects none. */
        const Panel = props => h(TmonPanel, {
          ...props,
          t: typeof props.t === 'function' ? props.t : t,
        })

        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'tmon',
            locale: NS,
          }, Panel)),
          'tmon: panel',
        )

        ctx.effect(
          () => ctx.slots.inject('conversation.view', () => ctx.slots.register({
            name: 'conversation.view',
            id: 'tmon',
            order: 40,
            locale: NS,
            label: () => t('nav'),
          }, Panel)),
          'tmon: conversation view tab',
        )
      },
    }
  },
})
