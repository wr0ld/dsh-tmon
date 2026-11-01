/**
 * dsh-tmon — client half.
 *
 * Registers the 「命令终端」panel under the session's `conversation.view` tab row
 * and the keyed `main` slot the tab opens. The panel embeds tmon's own web
 * page: it is the workbench that already renders live output, accepts input and
 * stops a task, and rebuilding that here would only trail behind it.
 *
 * The page is reached through a host route (`tmon/status`) for one reason:
 * tmon answers only callers whose Origin is its own page, so the port and the
 * reachability check come from the host half, and the iframe itself loads
 * `127.0.0.1:<port>` directly — its own requests then carry the right Origin.
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

    /** Host routes for the shell setting the settings section owns. */
    const CONFIG_ROUTE = 'tmon/config'
    const CHECK_ROUTE = 'tmon/config/check'
    const RESTART_ROUTE = 'tmon/restart'

    /** Reachability only changes when tmon starts or stops; this is often enough. */
    const POLL_MS = 10000

    /** Text for both shipped locales; the active one is registered at apply time. */
    const dictionaries = {
      zh: {
        nav: '命令终端',
        panelTitle: '命令终端',
        connectedOn: 'tmon 运行于 127.0.0.1:{port}',
        disconnected: 'tmon 没有响应',
        reload: '重新加载',
        restartButton: '重启服务',
        openPage: '在浏览器打开',
        loading: '正在读取 tmon…',
        starting: 'tmon 没有在运行，正在启动它…',
        unavailable: '没有安装 tmon',
        unavailableHint: '插件自带的 tmon 没有找到，通常是安装不完整，重新安装插件即可。',
        failed: 'tmon 启动失败',
        failedHint: 'tmon 已经安装，但服务没有起来。在会话里跑一次 tmon "命令" 可以看它报了什错。',
        portHint: '端口读自 ~/.tmon/port（当前 {port}）',
        readError: '读取失败：{reason}',
        settingsNav: 'tmon',
        settingsIntro: 'tmon 用它启动每条命令。留空就用系统默认的 cmd（Windows）或 /bin/sh。',
        shellLabel: 'Shell',
        shellPlaceholder: 'bash，或 C:\\Program Files\\Git\\bin\\bash.exe',
        shellDetect: '检测',
        shellSave: '保存',
        shellDetecting: '正在检测…',
        shellSaving: '正在保存…',
        shellEmpty: '留空：使用系统默认 {shell}',
        shellUsable: '可以执行：{shell}',
        shellUnusable: '找不到或不可执行：{shell}',
        shellSaved: '已保存，下次启动任务生效',
        shellSavedRestart: '已保存，服务已重启',
        restartNeeded: '设置只在 tmon 重启后生效，重启会中断正在运行的任务。',
        restartConfirm: '现在有 {count} 个任务在运行，重启会中断它们。仍然重启？',
        restartNone: '现在没有任务在运行。',
        restartDo: '重启并应用',
        restartCancel: '取消',
        restarting: '正在重启…',
        restartDone: '已重启，新设置已生效',
        restartFailed: '重启失败：{reason}',
      },
      en: {
        nav: 'Terminal',
        panelTitle: 'Terminal',
        connectedOn: 'tmon is serving 127.0.0.1:{port}',
        disconnected: 'tmon is not responding',
        starting: 'tmon is not running; starting it…',
        reload: 'Reload',
        restartButton: 'Restart',
        openPage: 'Open in browser',
        loading: 'Reading tmon…',
        unavailable: 'the bundled tmon is missing',
        unavailableHint: 'The copy of tmon this plugin ships is missing, which usually means an incomplete install; reinstalling the plugin fixes it.',
        failed: 'tmon failed to start',
        failedHint: 'tmon is installed but its service did not come up. Run tmon "command" once in a session to see what it reports.',
        portHint: 'Port comes from ~/.tmon/port (now {port})',
        readError: 'Read failed: {reason}',
        settingsNav: 'tmon',
        settingsIntro: 'tmon runs every command through this shell. Leave it empty for the platform default: cmd on Windows, /bin/sh elsewhere.',
        shellLabel: 'Shell',
        shellPlaceholder: 'bash, or C:\\Program Files\\Git\\bin\\bash.exe',
        shellDetect: 'Check',
        shellSave: 'Save',
        shellDetecting: 'Checking…',
        shellSaving: 'Saving…',
        shellEmpty: 'Empty: uses the platform default {shell}',
        shellUsable: 'Runs: {shell}',
        shellUnusable: 'Not found or not executable: {shell}',
        shellSaved: 'Saved; the next task uses it',
        shellSavedRestart: 'Saved, and the service restarted',
        restartNeeded: 'The setting applies only after tmon restarts, and a restart interrupts running tasks.',
        restartConfirm: '{count} task(s) are running; restarting interrupts them. Restart anyway?',
        restartNone: 'No tasks are running.',
        restartDo: 'Restart and apply',
        restartCancel: 'Cancel',
        restarting: 'Restarting…',
        restartDone: 'Restarted; the new setting is in effect',
        restartFailed: 'Restart failed: {reason}',
      },
    }

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
      },
      header: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '12px',
        paddingBottom: '12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        flexShrink: 0,
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
      emptyBody: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', maxWidth: '46ch' },
      frame: {
        flex: 1,
        width: '100%',
        minHeight: '320px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '4px 2px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
      },
      sectionIntro: {
        fontSize: '12px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { fontSize: '12px', fontWeight: 600 },
      input: {
        padding: '6px 10px',
        fontSize: '13px',
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        outline: 'none',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      hint: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      hintGood: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-state-success-primary)' },
      hintBad: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-state-error-primary)' },
      dialog: {
        padding: '12px 14px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
    }

    /**
     * The settings section: which shell tmon runs commands in.
     *
     * The section never writes the config file itself — the host relays to the
     * running tmon, so what the page reports is what the process will act on.
     * A save is followed by a restart question rather than a silent restart:
     * tmon reads the shell when a task starts, so the setting only reaches the
     * next task once the server is replaced, and replacing it kills whatever
     * is running.
     */
    function TmonSettings(props) {
      const t = typeof props.t === 'function' ? props.t : () => ''
      const [value, setValue] = React.useState('')
      const [resolved, setResolved] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(null)
      const [probe, setProbe] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [restart, setRestart] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const answer = await (await fetch(CONFIG_ROUTE, { headers: { accept: 'application/json' } })).json()
            if (cancelled) return
            const shell = typeof answer?.config?.shell === 'string' ? answer.config.shell : ''
            setValue(shell)
            setResolved(answer?.resolved ?? null)
          } catch (error) {
            if (!cancelled) setNotice({ kind: 'bad', text: String(error?.message ?? error) })
          } finally {
            if (!cancelled) setLoading(false)
          }
        })()
        return () => { cancelled = true }
      }, [])

      const detect = async () => {
        setBusy('detect')
        setProbe(null)
        try {
          const answer = await (await fetch(CHECK_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ shell: value }),
          })).json()
          setProbe(answer)
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy(null)
        }
      }

      const save = async () => {
        setBusy('save')
        setNotice(null)
        try {
          const answer = await (await fetch(CONFIG_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ shell: value }),
          })).json()
          setResolved(answer?.resolved ?? null)
          setNotice({ kind: 'good', text: t('shellSaved') })
          const state = await (await fetch(RESTART_ROUTE, { headers: { accept: 'application/json' } })).json()
          setRestart({ running: Array.isArray(state?.running) ? state.running : [] })
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy(null)
        }
      }

      const doRestart = async () => {
        setBusy('restart')
        try {
          const answer = await (await fetch(RESTART_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true }),
          })).json()
          setRestart(null)
          setNotice({ kind: 'good', text: t('restartDone') })
          setResolved(current => current === null ? current : { ...current, port: answer?.port ?? current.port })
        } catch (error) {
          setNotice({ kind: 'bad', text: t('restartFailed', { reason: String(error?.message ?? error) }) })
        } finally {
          setBusy(null)
        }
      }

      if (loading) {
        return h('div', { style: styles.section }, h('div', { style: styles.hint }, t('loading')))
      }

      const runningCount = restart?.running?.length ?? 0

      return h('div', { style: styles.section },
        h('div', { style: styles.sectionIntro }, t('settingsIntro')),
        h('div', { style: styles.field },
          h('label', { style: styles.label }, t('shellLabel')),
          h('input', {
            style: styles.input,
            value,
            placeholder: t('shellPlaceholder'),
            spellCheck: false,
            onChange: event => {
              setValue(event.target.value)
              setProbe(null)
            },
          }),
          resolved !== null && value === ''
            ? h('div', { style: styles.hint }, t('shellEmpty', { shell: resolved.shell }))
            : null,
          probe === null
            ? null
            : h('div', { style: probe.ok === true ? styles.hintGood : styles.hintBad },
              probe.ok === true
                ? t('shellUsable', { shell: probe.shell ?? value })
                : t('shellUnusable', { shell: probe.shell ?? value })),
        ),
        h('div', { style: styles.row },
          h('button', {
            style: styles.button,
            disabled: busy !== null,
            onClick: detect,
          }, busy === 'detect' ? t('shellDetecting') : t('shellDetect')),
          h('button', {
            style: styles.link,
            disabled: busy !== null,
            onClick: save,
          }, busy === 'save' ? t('shellSaving') : t('shellSave')),
        ),
        notice === null
          ? null
          : h('div', { style: notice.kind === 'good' ? styles.hintGood : styles.hintBad }, notice.text),
        restart === null
          ? null
          : h('div', { style: styles.dialog },
            h('div', { style: styles.hint }, t('restartNeeded')),
            h('div', { style: runningCount > 0 ? styles.hintBad : styles.hint },
              runningCount > 0 ? t('restartConfirm', { count: String(runningCount) }) : t('restartNone')),
            h('div', { style: styles.row },
              h('button', { style: styles.link, disabled: busy !== null, onClick: doRestart },
                busy === 'restart' ? t('restarting') : t('restartDo')),
              h('button', { style: styles.button, disabled: busy !== null, onClick: () => setRestart(null) },
                t('restartCancel')),
            ),
          ),
      )
    }

    /** The panel: tmon's own page, or why it is not there. */
    function TmonPanel(props) {
      const t = typeof props.t === 'function' ? props.t : () => ''
      const [snapshot, setSnapshot] = React.useState({
        loading: true,
        connected: false,
        port: null,
        reason: null,
        installed: true,
        starting: false,
      })
      const [tick, setTick] = React.useState(0)
      const [frameKey, setFrameKey] = React.useState(0)
      const [restarting, setRestarting] = React.useState(false)
      const [restartNote, setRestartNote] = React.useState(null)

      /**
       * Restart the tmon service from the panel.
       *
       * A running task would be killed by this, so the count comes first and a
       * confirmation stands between the click and the restart. The page is
       * reloaded afterwards because the port and the server it talks to change.
       */
      const restartHere = async () => {
        try {
          const state = await (await fetch(RESTART_ROUTE, { headers: { accept: 'application/json' } })).json()
          const running = Array.isArray(state?.running) ? state.running.length : 0
          if (running > 0 && !window.confirm(t('restartConfirm', { count: String(running) }))) return
          setRestarting(true)
          setRestartNote(null)
          await (await fetch(RESTART_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true }),
          })).json()
          setRestartNote({ kind: 'good', text: t('restartDone') })
          setFrameKey(value => value + 1)
          setTick(value => value + 1)
        } catch (error) {
          setRestartNote({ kind: 'bad', text: t('restartFailed', { reason: String(error?.message ?? error) }) })
        } finally {
          setRestarting(false)
        }
      }

      React.useEffect(() => {
        let cancelled = false

        const load = async () => {
          try {
            const status = await (await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } })).json()
            if (cancelled) return
            setSnapshot({
              loading: false,
              connected: status?.reachable === true,
              port: typeof status?.port === 'number' ? status.port : null,
              reason: typeof status?.reason === 'string' ? status.reason : null,
              installed: status?.installed !== false,
              starting: status?.reachable !== true && status?.installed !== false,
            })
          } catch (error) {
            if (cancelled) return
            setSnapshot(current => ({
              ...current,
              loading: false,
              connected: false,
              starting: false,
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
      // tmon is one workbench per machine, so the page opens as a list of every
      // session's tasks unless told which session is asking. The slot supplies
      // `sessionId` because `conversation.view` is a session-scoped slot.
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
      const pageUrl = port === null
        ? null
        : `http://127.0.0.1:${String(port)}/${sessionId === null ? '' : `?session=${encodeURIComponent(sessionId)}`}`
      const subtitle = snapshot.connected
        ? t('connectedOn', { port: port ?? '—' })
        : snapshot.starting ? t('starting') : t('disconnected')

      const header = h('div', { style: styles.header },
        h('div', { style: styles.heading },
          h('h2', { style: styles.title }, t('panelTitle')),
          h('span', { style: snapshot.connected ? styles.subtitle : styles.subtitleDown }, subtitle),
        ),
        h('div', { style: styles.actions },
          h('button', {
            type: 'button',
            style: styles.button,
            onClick: () => {
              setFrameKey(value => value + 1)
              setTick(value => value + 1)
            },
          }, t('reload')),
          h('button', {
            type: 'button',
            style: styles.button,
            disabled: restarting,
            onClick: restartHere,
          }, restarting ? t('restarting') : t('restartButton')),
          pageUrl === null
            ? null
            : h('a', { style: styles.link, href: pageUrl, target: '_blank', rel: 'noreferrer' }, t('openPage')),
        ),
      )

      // A failed restart is the one outcome the panel must not swallow: the
      // buttons return to their normal state either way, so without this line
      // a click that changed nothing would look identical to one that worked.
      const restartNotice = restartNote === null
        ? null
        : h('div', { style: restartNote.kind === 'good' ? styles.hintGood : styles.hintBad }, restartNote.text)

      if (snapshot.loading) {
        return h('div', { style: styles.root }, header,
          h('div', { style: styles.empty }, h('span', { style: styles.emptyBody }, t('loading'))))
      }

      if (!snapshot.connected || pageUrl === null) {
        // Three states, three different things to do about them: no CLI means
        // install it, a CLI that failed to start means look at why, and a
        // server this panel is still bringing up means wait.
        const title = snapshot.installed ? (snapshot.starting ? t('starting') : t('failed')) : t('unavailable')
        const body = snapshot.installed ? (snapshot.starting ? null : t('failedHint')) : t('unavailableHint')
        return h('div', { style: styles.root }, header,
          h('div', { style: styles.notice },
            h('span', { style: styles.noticeTitle }, title),
            body === null ? null : h('span', { style: styles.noticeBody }, body),
            h('span', { style: styles.noticeBody }, t('portHint', { port: port === null ? '—' : port })),
            snapshot.reason === null
              ? null
              : h('span', { style: styles.noticeBody }, t('readError', { reason: snapshot.reason })),
          ))
      }

      return h('div', { style: styles.root }, header, restartNotice,
        h('iframe', {
          key: `web-${String(frameKey)}`,
          title: t('panelTitle'),
          src: pageUrl,
          style: styles.frame,
          allow: 'clipboard-write',
        }))
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

        /** The settings section, with the same translate fallback the panel uses. */
        const Settings = props => h(TmonSettings, {
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

        // Its own section rather than a page inside Plugins: the only setting
        // worth a screen here is the shell, and one section reads better than a
        // tab strip with one tab in it.
        ctx.effect(
          () => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'tmon',
            order: 60,
            locale: NS,
            label: () => t('settingsNav'),
          }, Settings)),
          'tmon: settings section',
        )
      },
    }
  },
})
