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
        openPage: '在浏览器打开',
        loading: '正在读取 tmon…',
        unavailable: '连不上 tmon',
        unavailableHint: '这台机器上没有正在运行的 tmon。如果命令提示 tmon 不存在，先装它：npm install -g @qiu745/tmon（需要 Node 22.18+）；装好之后在会话里跑一次 tmon "命令"，tmon 就会启动并写下端口。',
        portHint: '端口读自 ~/.tmon/port（当前 {port}）',
        readError: '读取失败：{reason}',
      },
      en: {
        nav: 'Terminal',
        panelTitle: 'Terminal',
        connectedOn: 'tmon is serving 127.0.0.1:{port}',
        disconnected: 'tmon is not responding',
        reload: 'Reload',
        openPage: 'Open in browser',
        loading: 'Reading tmon…',
        unavailable: 'tmon is unreachable',
        unavailableHint: 'No tmon service is running on this machine. If the shell says tmon is not found, install it first: npm install -g @qiu745/tmon (needs Node 22.18+). Once installed, run tmon "command" once in a session and tmon starts and writes its port.',
        portHint: 'Port comes from ~/.tmon/port (now {port})',
        readError: 'Read failed: {reason}',
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
    }

    /** The panel: tmon's own page, or why it is not there. */
    function TmonPanel(props) {
      const t = typeof props.t === 'function' ? props.t : () => ''
      const [snapshot, setSnapshot] = React.useState({
        loading: true,
        connected: false,
        port: null,
        reason: null,
      })
      const [tick, setTick] = React.useState(0)
      const [frameKey, setFrameKey] = React.useState(0)

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
      const pageUrl = port === null ? null : `http://127.0.0.1:${String(port)}/`

      const header = h('div', { style: styles.header },
        h('div', { style: styles.heading },
          h('h2', { style: styles.title }, t('panelTitle')),
          h('span', { style: snapshot.connected ? styles.subtitle : styles.subtitleDown },
            snapshot.connected ? t('connectedOn', { port: port ?? '—' }) : t('disconnected')),
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
          pageUrl === null
            ? null
            : h('a', { style: styles.link, href: pageUrl, target: '_blank', rel: 'noreferrer' }, t('openPage')),
        ),
      )

      if (snapshot.loading) {
        return h('div', { style: styles.root }, header,
          h('div', { style: styles.empty }, h('span', { style: styles.emptyBody }, t('loading'))))
      }

      if (!snapshot.connected || pageUrl === null) {
        return h('div', { style: styles.root }, header,
          h('div', { style: styles.notice },
            h('span', { style: styles.noticeTitle }, t('unavailable')),
            h('span', { style: styles.noticeBody }, t('unavailableHint')),
            h('span', { style: styles.noticeBody }, t('portHint', { port: port === null ? '—' : port })),
            snapshot.reason === null
              ? null
              : h('span', { style: styles.noticeBody }, t('readError', { reason: snapshot.reason })),
          ))
      }

      return h('div', { style: styles.root }, header,
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
