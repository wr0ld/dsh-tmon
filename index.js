/**
 * dsh-tmon — host half.
 *
 * The tmon CLI records its tasks under `~/.tmon` and serves them from a loopback
 * HTTP API on the port it writes to `~/.tmon/port`. That API rejects any request
 * whose Origin is not tmon's own page, so the browser half cannot call it: this
 * half answers two routes on the composition's `webServer` and reads tmon from
 * the Host process, whose `fetch` sends no Origin.
 *
 * - `GET /tmon/status` — `{ reachable, port, version }`.
 * - `GET /tmon/tasks`  — `{ reachable, port, tasks }`, tmon's own task records.
 * - `GET /tmon/events?id=<8 hex>&after=<seq>` — `{ reachable, port, events }`,
 *   the recorded output/progress/stage/status events of one task. tmon keeps
 *   them in the task's `stream.jsonl`, so a finished task stays readable.
 *
 * "tmon is not running" is an ordinary state of the panel, so every failure is
 * reported as data with `reachable: false` instead of a failed request.
 *
 * The plugin also registers tmon's own usage guide as the `tmon` skill, so a
 * composition that has the skill registry offers the agent the same guidance
 * the CLI prints.
 * @module dsh-tmon
 */

import { spawn } from 'node:child_process'
import { accessSync, readFileSync } from 'node:fs'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin name for diagnostics. */
export const name = 'tmon'

/** The web server serves the routes; the connection gates them like every other. */
export const inject = ['webServer', 'connection']

/** Route answering whether the tmon service responds, and on which port. */
export const TMON_STATUS_PATH = '/tmon/status'

/** Route reading and writing the shell tmon runs commands in. */
export const TMON_CONFIG_PATH = '/tmon/config'

/** Route that reports whether a shell value typed into settings can run at all. */
export const TMON_CHECK_PATH = '/tmon/config/check'

/** Route listing the tasks a restart would interrupt. */
export const TMON_RESTART_PATH = '/tmon/restart'

/** tmon task ids are eight lowercase hex digits. */
const TASK_ID = /^[0-9a-f]{8}$/

/**
 * Model-shell variable pointing at the bundled CLI.
 *
 * `ctx.shellEnv` only accepts `DSH_`-prefixed keys, and a fixed absolute path
 * would be wrong on every other machine, so the value is resolved at execution
 * time from this module's own location.
 */
const TMON_CLI_KEY = 'DSH_TMON_CLI'

/** How many times to look for a task's meta before giving up on stamping it. */
const STAMP_ATTEMPTS = 20

/** Wait between those looks: the server writes the meta shortly after start. */
const STAMP_INTERVAL_MS = 500

/** Name of the skill this package ships, and the guide that defines it. */
const SKILL_NAME = 'tmon'

/** Name of the system-prompt section that keeps this plugin's tooling in mind. */
const PROMPT_SECTION = 'tool:tmon'

/**
 * Prompt-section position, just after the shell and job tools it applies to.
 * Shipped packages take their slots from `SECTION_ORDERS`, whose names are a
 * closed union, so a plugin outside the repository names a number directly.
 */
const PROMPT_ORDER = 1650

/**
 * The policy that has to fire without anyone reading anything first: when to
 * wrap a command, the two constraints that break silently, and where to look
 * when a task stops talking. Parameter rules live on the parameters and the
 * measured traps live in the skill, so neither is repeated here.
 *
 * The trigger is written as "could this take a while" rather than "is this
 * long", because the failure mode is not a wrong threshold: it is the agent
 * deciding for itself that a command looks fast and skipping the wrapper.
 */
/**
 * Which shell tmon will run the next command in, for the prompt.
 *
 * The prompt has to name the shell the commands will actually meet: the agent
 * writes in whatever dialect it is told it is in, so "some configured shell" is
 * not enough — it needs `cmd` or `bash` or `pwsh` by name. Reading the config is
 * the only honest source; when it cannot be read the answer says so rather than
 * guessing at the platform default.
 * @returns a short phrase for the prompt, e.g. `bash`.
 */
async function configuredShellName() {
  let configured = ''
  try {
    const raw = await readFile(join(tmonHome(), 'config.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.shell === 'string') {
      configured = parsed.shell.trim()
    }
  } catch (_absentOrUnreadable) {
    // No config yet: tmon uses its platform default, named below.
  }

  const fallback = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  if (configured === '') return { actual: fallback }
  // A configured path may point at something that is not there any more; tmon
  // falls back in that case, and the prompt must not claim otherwise.
  const base = configured.replace(/\\/gu, '/').split('/').pop() ?? configured
  const runnable = configured.includes('/') || configured.includes('\\')
    ? await existsInPath(configured)
    : await findExecutable(configured)
  return runnable
    ? { actual: base }
    : { actual: fallback, rejected: base }
}

/**
 * Whether a path is executable.
 * @param path - absolute path to test.
 * @returns true when the file exists and can be executed.
 */
async function existsInPath(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch (_missingOrNotExecutable) {
    return false
  }
}

/**
 * Directories that hold a native `bash`, in the order a server should prefer them.
 *
 * `C:/Windows/System32/bash.exe` is WSL: it treats every path as a Linux one
 * and is unusable for the Windows paths these tasks are written with. Git for
 * Windows, then the copy DSH ships, are native builds that keep `E:/...` intact.
 * @returns candidate `bash` paths, most preferred first.
 */
function nativeBashCandidates() {
  if (process.platform !== 'win32') return ['/bin/bash', '/usr/bin/bash']
  const candidates = []
  for (const root of ['C:/Program Files/Git', 'C:/Program Files (x86)/Git', 'E:/Git', 'D:/Git']) {
    candidates.push(`${root}/bin/bash.exe`, `${root}/usr/bin/bash.exe`)
  }
  const dshBash = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'bash')
  candidates.push(dshBash)
  return candidates
}

/**
 * The first native `bash` that exists, or null when none does.
 * @returns an absolute path, or null.
 */
function nativeBash() {
  for (const candidate of nativeBashCandidates()) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch (_absent) {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * Whether a shell value names an exact file this machine can run.
 * @param value - a configured shell, bare name or absolute path.
 * @returns true when the value is an absolute path that exists.
 */
function isAbsoluteShell(value) {
  const backslash = String.fromCharCode(92)
  return value.includes('/') || value.includes(backslash)
    ? nativeBashAt(value) !== null
    : false
}

/**
 * The file at a given bash path, or null when it is not there.
 * @param path - absolute candidate path.
 * @returns the path when executable, otherwise null.
 */
function nativeBashAt(path) {
  try {
    accessSync(path, constants.X_OK)
    return path
  } catch (_absent) {
    return null
  }
}

/**
 * Point tmon's own config at a native `bash` when it holds only a bare name.
 *
 * tmon resolves a bare shell name against `PATH` without appending `.exe`, so
 * `"shell": "bash"` never matches on Windows and every task fails with
 * `File not found:`. Writing the absolute path once, at start, keeps the user's
 * choice (they asked for bash) and fixes the resolution. A value that is
 * already a path, or a different shell such as `pwsh`, is left untouched.
 * @returns the shell now configured, for the log line.
 */
async function pinShellToAbsolutePath() {
  const configPath = join(tmonHome(), 'config.json')
  let config = {}
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') config = parsed
  } catch (_absentOrUnreadable) {
    // No config yet: tmon would use its platform default, nothing to pin.
    return null
  }
  const configured = typeof config.shell === 'string' ? config.shell.trim() : ''
  if (configured === '') return null
  if (isAbsoluteShell(configured)) return configured
  const bare = configured.replace(/\.exe$/iu, '')
  if (bare !== 'bash' && bare !== 'sh') return null
  const bash = nativeBash()
  if (bash === null) return null
  const updated = { ...config, shell: bash }
  const temporary = `${configPath}.${String(process.pid)}.tmp`
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(temporary, JSON.stringify(updated, null, 2), { mode: 0o600 })
  await rename(temporary, configPath)
  return bash
}

/**
 * Environment for the tmon server this plugin starts.
 *
 * The server outlives the turn and runs every command in its own shell, so the
 * shell it resolves cannot depend on the model shell's `PATH`. The native bash
 * is put first so a bare name would resolve even where WSL shadows it; the
 * absolute path written by {@link pinShellToAbsolutePath} is what actually
 * decides. Nothing outside this child changes.
 * @returns the environment to spawn with.
 */
function serverEnv() {
  const env = { ...process.env }
  const separator = process.platform === 'win32' ? ';' : ':'
  const bash = nativeBash()
  if (bash === null) return env
  const bashDir = dirname(bash)
  const current = env.PATH ?? env.Path ?? ''
  const parts = current.split(separator).filter(part => part !== '')
  env.PATH = [bashDir, ...parts].join(separator)
  return env
}

/**
 * Locate an executable on `PATH` without blocking on file I/O.
 * @param name - command name without a directory.
 * @returns the absolute path, or null when nothing on `PATH` holds it.
 */
function findExecutableSync(name) {
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32'
    ? ['.EXE', '.CMD', '.BAT', '.COM', '']
    : ['']
  for (const directory of (process.env.PATH ?? '').split(separator)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch (_absentOrNotExecutable) {
        // Not here; keep looking.
      }
    }
  }
  return null
}

/**
 * Whether a bare command name resolves on `PATH`.
 * @param name - command name without a directory.
 * @returns true when any directory on `PATH` holds it.
 */
async function findExecutable(name) {
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of (process.env.PATH ?? '').split(separator)) {
    if (directory === '') continue
    for (const extension of extensions) {
      if (await existsInPath(join(directory, `${name}${extension}`))) return true
    }
    if (await existsInPath(join(directory, name))) return true
  }
  return false
}

/** The prompt text, with the configured shell named each time it is assembled. */
async function promptText() {
  const { actual, rejected } = await configuredShellName()
  // Two whole sentences rather than one template with an aside spliced in: a
  // rejected setting has to say what was rejected, and a fragment reads as a
  // typo once the "because" lands mid-clause.
  const sentence = rejected === undefined
    ? `The commands inside tmon run under ${actual}, which may differ from the shell this session otherwise uses; write them in that dialect.`
    : `The commands inside tmon run under ${actual}: ${rejected} is configured but cannot be executed, so tmon falls back to it.`
  return PROMPT_TEXT.replace('{{shellSentence}}', sentence)
}

const PROMPT_TEXT = 'tmon records every command run through it, so the user can watch and cancel from the 「命令终端」tab in the conversation View row. '
  + 'It is bundled with this plugin and is NOT on PATH: always call it as `"$DSH_TMON_CLI" "<command>"`, never as bare `tmon`. '
  + 'Run a command through it whenever it could plausibly take more than about ten seconds, produce an unbounded amount of output, '
  + 'or wait on something outside this machine: package installs, builds, test suites, migrations, downloads, `git push`/`fetch`/`clone`, CI runs, network calls. '
  + 'Do not estimate the duration first and conclude that it looks fast — that estimate is the thing that is usually wrong. '
  + 'Never sit in a `sleep`-and-poll loop to watch your own command, and never re-run a command to find out whether the first one finished: that is what tmon and `tmon_tasks` are for. '
  + 'Any command that itself contains a delay — `sleep`, `timeout`, `ping -n`/`-c` as a pause, a retry loop with backoff, `Start-Sleep`, `timeout /t` — must run through tmon, whatever the total: '
  + 'a bare delay blocks the turn with nothing to watch and nothing to cancel. '
  + '{{shellSentence}} '
  + 'No `$VAR` or Unix quoting when it is cmd; no `/c` habits when it is bash. '
  + 'Wrapping changes neither the behaviour nor the exit code, so it costs nothing to be wrong in that direction. '
  + 'Pass the whole command as one string, and never nest tmon subcommands (ls, status, wait, show, kill, progress, stage) inside it. '
  + 'When a task looks hung, call `tmon_tasks`: it reports how long the task has been silent, which is what separates stuck from slow. '
  + 'If the shell reports that `tmon` is not found, the plugin\'s usable copy is missing or broken: report that as a plugin problem rather than retrying, '
  + 'and do not quietly fall back to running the command unwrapped. '
  + 'Read the `tmon` skill before running a long job in the background or reporting progress from inside a script.'


/**
 * Split a skill file into its YAML frontmatter fields and its body.
 * The packaged guide carries only `name` and `description`, so the two fields
 * are read literally instead of depending on a YAML parser.
 * @param raw - the whole file.
 * @returns the declared name, description and the body after the frontmatter.
 */
function parseSkill(raw) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  const block = frontmatter?.[1]
  if (block === undefined) throw new Error('dsh-tmon: skill.md has no frontmatter')
  const read = key => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(block)
    return line?.[1]?.trim() ?? ''
  }
  const description = read('description')
  if (description === '') throw new Error('dsh-tmon: skill.md has no description')
  return {
    name: read('name') === '' ? SKILL_NAME : read('name'),
    description,
    content: raw.slice(frontmatter[0].length).trim(),
  }
}

/** Port used when `~/.tmon/port` is missing: tmon's own first choice. */
const DEFAULT_PORT = 8456

/** A loopback probe that outlives this is not a running service. */
const REQUEST_TIMEOUT_MS = 1500

/**
 * @returns the tmon home directory (`$TMON_HOME` when set, else `~/.tmon`).
 */
function tmonHome() {
  const configured = process.env.TMON_HOME
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.tmon')
}

/**
 * @returns this plugin's own state directory, beside tmon's rather than inside
 * it: tmon rewrites `meta.json` on every status change, so nothing may live in
 * the task directories, but the home they share is a natural neighbour.
 */
function stateHome() {
  return join(tmonHome(), 'dsh-tmon')
}

/**
 * The file mapping a task id to the session that started it.
 *
 * tmon records `{ cmd, cwd, pid, mode }` and knows nothing about sessions, so
 * without this a `tmon_tasks` call reports every task on the machine — the
 * other conversations' work included. The map is written by the shell the
 * model runs through tmon, which is the only place both ids are known.
 * @returns the absolute path of the map.
 */
function sessionMapPath() {
  return join(stateHome(), 'sessions.json')
}

/**
 * Read the task-to-session map.
 * @returns the map, or an empty object when it has not been written yet.
 */
async function readSessionMap() {
  try {
    const raw = await readFile(sessionMapPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_absentOrUnreadable) {
    // No map yet, or a half-written one: every task reads as belonging to no
    // session, which is the honest answer rather than a guess.
    return {}
  }
}

/**
 * Record which session started a task.
 *
 * Two places need the answer and they read different sources: `tmon_tasks`
 * reads this map, while the panel shows tmon's own web page, which reads the
 * `session` field inside the task's `meta.json`. Writing only the map left the
 * panel unable to see a task the tool could report, so the field is copied into
 * the meta as well. tmon reads the meta on demand, so the panel picks the
 * change up on its next poll without anything restarting.
 * @param taskId - the task's eight-hex-digit id.
 * @param sessionId - the session that ran the command.
 */
async function rememberTask(taskId, sessionId) {
  const map = await readSessionMap()
  map[taskId] = { session: sessionId, at: Date.now() }
  await mkdir(stateHome(), { recursive: true })
  const target = sessionMapPath()
  const temporary = `${target}.${String(process.pid)}.tmp`
  await writeFile(temporary, JSON.stringify(map, null, 2), { mode: 0o600 })
  await rename(temporary, target)
  await stampWithRetry(taskId, sessionId)
}

/**
 * Write the owning session into a task's own metadata.
 *
 * This is the copy the panel reads. A task tmon never recorded a session for
 * (one started outside DSH) stays unowned: the field is added, not invented.
 *
 * The meta is written by the tmon server, not by the command, so a short task
 * can finish — and report its id — before the file exists. One read is
 * therefore not evidence that the task has no meta; the caller retries.
 * @param taskId - the task's eight-hex-digit id.
 * @param sessionId - the session that ran the command.
 * @returns whether the meta was found and carries the session.
 */
async function stampTaskSession(taskId, sessionId) {
  if (!TASK_ID.test(taskId)) return false
  const file = join(tmonHome(), 'tasks', taskId, 'meta.json')
  let meta
  try {
    meta = JSON.parse(await readFile(file, 'utf8'))
  } catch (_absentOrUnreadable) {
    // Not flushed yet: report the miss so the caller can try again.
    return false
  }
  if (meta === null || typeof meta !== 'object') return false
  if (meta.session === sessionId) return true
  meta.session = sessionId
  const temporary = `${file}.${String(process.pid)}.tmp`
  await writeFile(temporary, JSON.stringify(meta, null, 2), { mode: 0o600 })
  await rename(temporary, file)
  return true
}

/**
 * Keep trying to stamp the session until the meta appears or the budget runs out.
 *
 * The map above is written first and is what `tmon_tasks` reads, so a failure
 * here costs the panel its filter, never the record.
 * @param taskId - the task's eight-hex-digit id.
 * @param sessionId - the session that ran the command.
 */
async function stampWithRetry(taskId, sessionId) {
  for (let attempt = 0; attempt < STAMP_ATTEMPTS; attempt += 1) {
    if (await stampTaskSession(taskId, sessionId)) return
    await new Promise(resolve => { setTimeout(resolve, STAMP_INTERVAL_MS) })
  }
}

/**
 * Read the port tmon recorded for its current run.
 * @returns the port, or the default when the file is absent or unreadable.
 */
async function readPort() {
  try {
    const raw = await readFile(join(tmonHome(), 'port'), 'utf8')
    const parsed = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT
  } catch (_missingPortFile) {
    // The CLI writes the port when its server starts; no file means no server.
    return DEFAULT_PORT
  }
}

/**
 * Call one tmon JSON endpoint.
 * @param port - the loopback port tmon listens on.
 * @param path - the endpoint path, beginning with a slash.
 * @returns the decoded body.
 */
async function request(port, path) {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.json()
}

/**
 * POST a JSON body to tmon and return its answer.
 *
 * tmon reads configuration through its own server so that the process that
 * acts on a setting is the one that reports it applied: writing the file here
 * would leave the running server on the old value until it happened to restart.
 * @param port - the port tmon answers on.
 * @param path - tmon's route.
 * @param body - value serialized as the request body.
 * @returns the parsed answer.
 * @throws when tmon answers with a status other than 200.
 */
async function postJson(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.json()
}

/**
 * Every task tmon is still running, for warning before a restart interrupts them.
 * @param port - the port tmon answers on.
 * @returns the running tasks, each with at least an id and a command.
 */
async function runningTasks(port) {
  const body = await request(port, '/api/tasks')
  const tasks = Array.isArray(body?.tasks) ? body.tasks : []
  return tasks.filter(task => task?.status === 'running')
}

/**
 * Stop the running tmon server and start a fresh one.
 *
 * tmon reads its shell setting when a task starts, so a saved setting reaches
 * the next task only after the server that owns the port is replaced. The port
 * is read before the stop because the stop removes the port file.
 * @param port - the port the old server answers on.
 * @returns the port the new server answers on.
 * @throws when the old server refuses to stop or the new one never answers.
 */
async function restartServer(port) {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (_alreadyStopped) {
    // Nothing to stop; starting one is still the right outcome.
  }

  // `kill-server` is the CLI's own stop path: it signals the pid in server.pid
  // and removes the port file, so a later start cannot see a stale port.
  const stop = await tmonCliPath()
  if (stop !== null) {
    await new Promise(resolve => {
      const child = spawn(process.execPath, [stop, 'kill-server'], { stdio: 'ignore', windowsHide: true })
      child.on('exit', () => { resolve() })
      child.on('error', () => { resolve() })
    })
  }

  const health = await startServer(port)
  return { port, version: health?.version ?? null }
}

/**
 * The tmon entry script this plugin ships, falling back to the global install.
 * @returns the script path, or null when neither exists.
 */
async function tmonCliPath() {
  const bundled = bundledEntry()
  if (await exists(bundled)) return bundled
  const cli = await findCli()
  return cli === null ? null : await cliEntry(cli)
}

/**
 * Read a request body as text, capped so a stuck upload cannot grow without bound.
 * @param req - the incoming request.
 * @returns the body text, empty when there is none.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error(`request body over ${String(MAX_BODY_BYTES)} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Largest request body the settings routes accept. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * How long a freshly started server may take to answer. tmon's own launcher
 * waits five seconds; a cold Node start on a slow disk needs more headroom than
 * that, and the panel is waiting on exactly one request.
 */
const STARTUP_TIMEOUT_MS = 10_000

/** How often to ask the starting server whether it is up yet. */
const STARTUP_POLL_MS = 250

/** Whether a path exists, for locating the CLI before trying to launch it. */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch (_absent) {
    // Absence is the answer, not a failure: it means "the CLI is not here".
    return false
  }
}

/**
 * The entry script of the tmon this plugin ships, if it is there.
 *
 * The plugin carries its own copy under `vendor/tmon` so that installing the
 * plugin is the whole installation: no separate `npm install -g`, and no
 * chance of running against a version whose task record lacks the session
 * field the panel filters on. That copy is a patched tmon — the upstream one
 * does not record which caller started a task.
 * @returns the entry script path, or null when the copy is missing.
 */
function bundledEntry() {
  const entry = fileURLToPath(new URL('./vendor/tmon/bin/tmon.js', import.meta.url))
  return entry
}

/**
 * Whether the plugin's own tmon copy is present.
 * @returns true when the bundle can start its own server.
 */
async function hasBundledTmon() {
  return await exists(bundledEntry())
}

/**
 * Where the `tmon` executable is, without running a shell to find out.
 *
 * `where`/`which` would answer this, but running one to decide whether to run
 * another is two processes deep from a panel poll. npm puts global binaries
 * where it says it does, so the search is the directories that can hold one
 * plus `PATH` itself for every other way tmon gets installed.
 * @returns the executable path, or null when the CLI is not installed.
 */
async function findCli() {
  const names = process.platform === 'win32' ? ['tmon.cmd', 'tmon.exe'] : ['tmon']
  const directories = []

  const prefix = process.env.npm_config_prefix ?? process.env.NPM_CONFIG_PREFIX
  if (prefix !== undefined && prefix !== '') directories.push(join(prefix, 'bin'))
  const appData = process.env.APPDATA
  if (appData !== undefined && appData !== '') directories.push(join(appData, 'npm'))
  for (const entry of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (entry !== '') directories.push(entry)
  }

  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (await exists(candidate)) return candidate
    }
  }
  return null
}

/**
 * Start tmon's server, detached, and wait until it answers.
 *
 * The CLI keeps the service alive across invocations — that is how a task
 * outlives the command that started it — so this launches it exactly the way
 * the CLI's own `ensureServer` does: `tmon serve`, no stdio, unref'd, which
 * leaves nothing for the Host to reap.
 * @param cli - the executable returned by `findCli`.
 * @param port - the port to expect it on.
 * @returns the health body once it answers.
 * @throws when the server does not come up within `STARTUP_TIMEOUT_MS`.
 */
/**
 * Where the tmon CLI's entry script is, given the executable that runs it.
 *
 * The npm shim sits beside the package it installs: `npm/tmon.cmd` next to
 * `npm/node_modules/@qiu745/tmon/bin/tmon.js`. Launching that script with this
 * process's own Node is what the CLI does to start its server, and it is the
 * only way to do it without a shell: a `.cmd` shim is a batch file, so running
 * it spawns cmd.exe, and `windowsHide` does not suppress a console that a
 * shell was asked to create.
 * @param cli - the executable returned by `findCli`.
 * @returns the script path, or null when the layout is not npm's.
 */
async function cliEntry(cli) {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  const prefix = cli.endsWith(suffix) ? cli.slice(0, -suffix.length) : cli
  const entry = join(dirname(prefix), 'node_modules', '@qiu745', 'tmon', 'bin', 'tmon.js')
  return await exists(entry) ? entry : null
}

/**
 * Start tmon's server, detached, and wait until it answers.
 *
 * The CLI keeps the service alive across invocations — that is how a task
 * outlives the command that started it — so this launches it exactly the way
 * the CLI's own `ensureServer` does: this Node, the CLI script, `serve`, no
 * stdio, unref'd, which leaves nothing for the Host to reap and no window to
 * close.
 * @param cli - the executable returned by `findCli`.
 * @param port - the port to expect it on.
 * @returns the health body once it answers.
 * @throws when the server does not come up within `STARTUP_TIMEOUT_MS`.
 */
/**
 * Start tmon's server, detached, and wait until it answers.
 *
 * Three sources, in order of preference: the copy this plugin ships, the npm
 * layout of a global install, and finally the shim itself. The first needs no
 * shell and no console; the second needs no shell; only the last does, because
 * a batch file cannot be executed any other way.
 * @param port - the port to expect it on.
 * @returns the health body once it answers.
 * @throws when no tmon can be started, or it does not answer in time.
 */
async function startServer(port) {
  // A bare `bash` never resolves on Windows (tmon looks for the name without
  // `.exe`), so the user's choice is pinned to a real file before spawning.
  try {
    await pinShellToAbsolutePath()
  } catch (_unwritableConfig) {
    // A read-only home is not a reason to refuse to start: tmon then falls
    // back to its platform default, which the status route reports.
  }
  const bundled = bundledEntry()
  let command = null
  let args = null
  if (await exists(bundled)) {
    command = process.execPath
    args = [bundled, 'serve']
  } else {
    const cli = await findCli()
    if (cli === null) throw new Error('tmon is not installed and the bundled copy is missing')
    const entry = await cliEntry(cli)
    if (entry !== null) {
      command = process.execPath
      args = [entry, 'serve']
    } else {
      command = cli
      args = ['serve']
    }
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: serverEnv(),
  })
  child.unref()

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      return await request(port, '/api/health')
    } catch (_notUpYet) {
      // The server is still binding its port; keep asking until the deadline.
      await new Promise(resolve => setTimeout(resolve, STARTUP_POLL_MS))
    }
  }
  throw new Error(`tmon serve did not answer on port ${String(port)} within ${String(STARTUP_TIMEOUT_MS)} ms`)
}

/**
 * Staleness thresholds. A task whose last output is older than `quiet` may be
 * stuck, but "may be" is the point: a download with no progress bar prints
 * nothing for minutes and is perfectly healthy. The bands only decide how the
 * facts are labelled, never what is reported.
 */
const QUIET_MS = 30_000
const STALE_MS = 120_000

/** Page number asking for every line. */
const ALL_PAGES = -1

/** Output at or below this many lines is always returned whole, however it was asked for. */
const WHOLE_OUTPUT_LINES = 100

/**
 * Most lines one response may carry, whatever was asked for. Output averages
 * around 70 bytes a line, so this ceiling holds a single answer near 55K
 * tokens: a build log of hundreds of thousands of lines must not be able to
 * fill a quarter of the context in one call, and a truncated answer that says
 * how to read the rest is worth more than a complete one nobody can keep.
 */
const MAX_OUTPUT_LINES = 2000

/**
 * Most characters one line may carry. A line count alone does not bound an
 * answer: a program that redraws a progress bar writes megabytes without ever
 * emitting a newline, and a single such line would walk past the line ceiling
 * unnoticed. Clipped lines say how much was cut so the reader knows the text
 * continues.
 */
const MAX_LINE_CHARS = 500

/**
 * The states tmon records for a task. Listing can be narrowed to one of them,
 * and every listing reports how many tasks sit in each, so a reader learns what
 * is there without paging through all of it.
 */
const TASK_STATUSES = ['running', 'success', 'failed', 'killed', 'error']

/**
 * Read every one of a task's events, so the last timestamp is known.
 * `stream.jsonl` is append-only and survives the task, so this works for a
 * task that already ended.
 * @param port - the loopback port tmon listens on.
 * @param id - the eight-hex-digit task id.
 * @returns the task's events in sequence order.
 */
async function readEvents(port, id) {
  const body = await request(port, `/api/tasks/${id}/events?after=0`)
  return Array.isArray(body?.events) ? body.events : []
}

/**
 * Turn one task's records into the few facts that answer "is it stuck, or just
 * slow, and how far along is it".
 *
 * Two tmon behaviours make the raw `status` field unsafe on its own, and this
 * function exists to keep a caller from being misled by them:
 * - tmon rewrites a persisted `running` task to `error` when its server
 *   restarts, because it can no longer control the original executor. A task
 *   can therefore read `error` while never having failed.
 * - The record on disk is not authoritative at all: measured here, `meta.json`
 *   was absent both while the task ran and after it succeeded, while the HTTP
 *   API reported `running` and then `success`. The API is the only live source.
 * @param port - the loopback port tmon listens on.
 * @param task - the task record from `/api/tasks`.
 * @returns the facts plus a verdict band, never a bare boolean.
 */
async function summarise(port, task) {
  const now = Date.now()
  const events = await readEvents(port, task.id)
  const outputs = events.filter(event => event?.type === 'output')
  const last = outputs[outputs.length - 1]
  const lastOutputAt = typeof last?.ts === 'number' ? last.ts : null
  const silenceMs = lastOutputAt === null ? null : Math.max(0, now - lastOutputAt)
  const progress = events.filter(event => event?.type === 'progress').pop()
  const stage = events.filter(event => event?.type === 'stage').pop()
  const running = task.status === 'running'
  // Only a finished task can be settled; a restart-mislabelled `error` with an
  // open-ended elapsed time is not evidence either way, so it stays unsettled.
  const settled = !running && task.endedAt !== null
  let verdict
  if (!running) verdict = 'finished'
  else if (silenceMs !== null && silenceMs >= STALE_MS) verdict = 'silent-long'
  else if (silenceMs !== null && silenceMs >= QUIET_MS) verdict = 'silent'
  else verdict = 'active'
  // The tool's output schema takes one type per field, so an unknown value is
  // left out rather than sent as `null`. renderReport already tests for absence
  // and prints "unknown" where a key is missing.
  const facts = {
    id: task.id,
    cmd: task.cmd,
    status: task.status,
    verdict,
    settled,
    elapsedMs: Math.max(0, (task.endedAt ?? now) - task.startedAt),
    // Lines, not events: one event can carry several lines, and this number has
    // to agree with the line count the output heading reports.
    outputLines: linesOf(outputs).length,
  }
  if (typeof task.exitCode === 'number') facts.exitCode = task.exitCode
  if (silenceMs !== null) facts.silenceMs = silenceMs
  if (lastOutputAt !== null) facts.lastOutputAt = lastOutputAt
  const lastStage = stage?.name ?? task.latestStage
  if (typeof lastStage === 'string') facts.lastStage = lastStage
  const lastPct = typeof progress?.pct === 'number' ? progress.pct : task.latestPct
  if (typeof lastPct === 'number') facts.lastPct = lastPct
  if (typeof progress?.msg === 'string') facts.lastMessage = progress.msg
  return facts
}

/**
 * @param res - the response.
 * @param status - HTTP status.
 * @param payload - value serialized as JSON.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Marks where the cursor went back to column 0, so the text after it overwrites
 * the line instead of extending it. `\r` is a carriage return; `ESC[H`,
 * `ESC[1;1H` and `ESC[1G` move the cursor home. A carriage return followed by a
 * newline is a line break, not an overwrite, and is left for the newline pass.
 */
const OVERWRITE_MARK = '\u0000'
const OVERWRITE = /\r(?!\n)|\u001b\[H|\u001b\[1;1H|\u001b\[1?G/g

/** Every other terminal control sequence, removed so a model reads text. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

/**
 * One output chunk as text, control sequences removed and every cursor-home
 * sequence left as an overwrite marker.
 * @param raw - one output chunk.
 * @returns the visible text, with `OVERWRITE_MARK` where the line restarts.
 */
function chunkText(raw) {
  return String(raw ?? '')
    .replace(OVERWRITE, OVERWRITE_MARK)
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
}

/**
 * Clip a line to the character ceiling, saying how much was dropped.
 * @param line - one rendered line.
 * @returns the line, clipped if it was too long.
 */
function clipLine(line) {
  if (line.length <= MAX_LINE_CHARS) return line
  const dropped = line.length - MAX_LINE_CHARS
  return `${line.slice(0, MAX_LINE_CHARS)} … (${dropped} more characters)`
}

/**
 * Every non-empty output line of a task, control sequences removed.
 *
 * The renderer follows the terminal rules the tmon web view follows, so a model
 * reads the same text a person does. A carriage return or a cursor-home
 * sequence sends the cursor back to column 0, so the next text replaces the
 * line being built rather than extending it: a progress bar redrawn a thousand
 * times is one line holding its latest state, not a thousand concatenated
 * frames. A newline ends the line. The line being built is kept until it is
 * replaced, so a task whose last act was a redraw still reports that redraw.
 * @param events - the task's events.
 * @returns the lines in order.
 */
function linesOf(events) {
  const lines = []
  let buffer = ''
  let overwritten = false

  const flush = () => {
    if (buffer.trim() !== '') lines.push(clipLine(buffer))
    buffer = ''
  }

  for (const event of events) {
    if (event?.type !== 'output') continue
    const parts = chunkText(event.data).split(OVERWRITE_MARK)
    for (let index = 0; index < parts.length; index += 1) {
      const segments = parts[index].split('\n')
      for (let position = 0; position < segments.length; position += 1) {
        const segment = segments[position]
        if (position > 0) {
          flush()
          overwritten = false
        }
        if (segment === '') continue
        if (overwritten) {
          buffer = ''
          overwritten = false
        }
        buffer += segment
      }
      if (index < parts.length - 1) overwritten = true
    }
  }

  flush()
  return lines
}

/**
 * A window of a task's output addressed by page number, so a reader never has
 * to compute its own position. Pages count backwards from the newest output:
 * page 1 is the newest page, page 2 the page before it, and the last page ends
 * at the first line. Numbering from the newest end means page 1 is what a
 * reader wants first, and each page number after it continues the same
 * backwards walk without repeating or skipping a line.
 *
 * A page number past the last page is a mistake in the request, not the signal
 * that the output ran out, so it throws instead of returning an empty window.
 * @param events - the task's events.
 * @param count - how many lines one page holds.
 * @param page - page number: 1 is the newest page, n goes back, -1 is everything.
 * @returns the window, its zero-based start line, the total line count, and the page layout.
 */
function outputWindow(events, count, page) {
  const lines = linesOf(events)
  const total = lines.length
  const perPage = Math.max(count, 1)
  const pageCount = Math.max(Math.ceil(total / perPage), 1)

  if (page === ALL_PAGES) {
    // Everything that fits: the newest lines when the output is longer than
    // the ceiling, because the end is what a reader wants first.
    const start = Math.max(total - MAX_OUTPUT_LINES, 0)
    const kept = lines.slice(start)
    return { lines: kept, start, total, page: ALL_PAGES, pageCount, truncated: total > kept.length }
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(
      `page must be 1 (the newest page) through ${String(pageCount)}, or -1 for everything`,
    )
  }
  if (page > pageCount) {
    throw new Error(
      `this task has ${String(total)} output lines and ${String(pageCount)} pages of ${String(perPage)}; `
      + `page ${String(page)} does not exist (use 1–${String(pageCount)}, or -1 for everything)`,
    )
  }

  // Pages count back from the newest output, so page 1 ends at the last line
  // and each page back ends where the previous one began. Anchoring at the end
  // rather than at the start keeps page 1 full: a reader asking for the newest
  // page wants the newest `perPage` lines, not the remainder left over when the
  // line count is not a multiple of the page size.
  const end = total - (page - 1) * perPage
  const start = Math.max(end - perPage, 0)
  return { lines: lines.slice(start, end), start, total, page, pageCount }
}

/**
 * Format a duration the way a person reads it.
 * @param ms - milliseconds, or null when unknown.
 * @returns a short human duration.
 */
function human(ms) {
  if (ms === null) return 'unknown'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60)}s`
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`
}

/**
 * The model-facing report. Staleness is stated as a fact with its measurement,
 * never as a verdict: a quiet task is often a healthy one, and only the caller
 * knows whether the command was supposed to print anything.
 * @param args - the arguments the model passed.
 * @param value - the canonical result.
 * @returns the rendered text.
 */
function renderReport(args, value) {
  if (!value.reachable) {
    return `tmon is not reachable on port ${String(value.port)}: ${String(value.reason)}`
  }
  if (typeof args?.id === 'string' && args.id.trim() !== '' && value.tasks.length === 0) {
    return `No task ${String(args.id)}. ${String(value.reason ?? '')}`.trim()
  }
  const header = []
  if (value.counts) {
    const distribution = TASK_STATUSES
      .filter(status => (value.counts[status] ?? 0) > 0)
      .map(status => `${status} ${String(value.counts[status])}`)
      .join(', ')
    const total = value.total ?? value.tasks.length
    const filtered = typeof args?.status === 'string' ? args.status.trim() : ''
    if (total === 0) {
      header.push('No tasks recorded yet.')
    } else if (filtered !== '') {
      header.push(
        `Tasks with status "${filtered}": showing ${String(value.tasks.length)} of `
        + `${String(value.matched ?? value.tasks.length)} matching, ${String(total)} recorded `
        + `(${distribution === '' ? 'none' : distribution})`,
      )
    } else {
      header.push(
        `Tasks: showing ${String(value.tasks.length)} of ${String(total)} recorded `
        + `(${distribution === '' ? 'none' : distribution})`,
      )
    }
  }
  const lines = value.tasks.map(task => {
    const quiet = task.silenceMs === undefined
      ? (task.settled ? '  (no output recorded)' : '  no output yet')
      : `  last output ${human(task.silenceMs)} ago`
    const bits = [
      `${task.id}  ${task.status}${task.exitCode === undefined ? '' : ` (exit ${String(task.exitCode)})`}`,
      `  ${task.cmd}`,
      `  elapsed ${human(task.elapsedMs)}`,
      quiet,
    ]
    if (task.lastPct !== undefined) bits.push(`  ${String(task.lastPct)}%`)
    if (task.lastStage !== undefined) bits.push(`  stage "${task.lastStage}"`)
    if (task.lastMessage !== undefined) bits.push(`  "${task.lastMessage}"`)
    bits.push(`  [${task.verdict}]`)
    return bits.join('')
  })
  const notes = []
  // A reason beside a task is the answer to the request (an impossible page
  // number, for example), so it is reported even though the task line printed.
  if (typeof value.reason === 'string' && value.reason !== '') notes.push(value.reason)
  if (value.tasks.some(task => task.verdict === 'silent' || task.verdict === 'silent-long')) {
    notes.push('A quiet task is not necessarily stuck: commands that print nothing for long stretches (downloads without a progress bar, compiles, sleep) look identical to a hang. Check whether the command was expected to print, or wait one more interval before concluding anything.')
  }
  if (value.tasks.some(task => task.status === 'error' && task.exitCode === undefined)) {
    notes.push('Status `error` with no exit code usually means tmon restarted its server while the task was running, not that the command failed; treat it as unknown rather than failed.')
  }
  if (Array.isArray(value.tail) && value.tail.length > 0) {
    const total = value.totalLines ?? value.tail.length
    const start = value.tailOffset ?? 0
    const first = start + 1
    const last = start + value.tail.length
    const pages = value.pageCount ?? 1
    const heading = value.whole === true
      ? `Output: all ${String(total)} lines (control sequences removed):`
      : value.truncated === true
        // Say what was left out before the lines, so a reader cannot mistake a
        // ceiling for the end of the output.
        ? `Output lines ${String(first)}–${String(last)} of ${String(total)} (control sequences removed; `
          + `${String(total)} lines exceed the ${String(MAX_OUTPUT_LINES)}-line limit of one response, the newest `
          + `${String(value.tail.length)} are shown — read earlier lines by page):`
        : `Output lines ${String(first)}–${String(last)} of ${String(total)} (control sequences removed):`
    notes.push(heading, ...value.tail.map(line => `  ${line}`))
    if (value.whole !== true) {
      // Each hint names only a page that exists and is not the current one:
      // page numbering runs backwards from the newest output, so page 1 holds
      // the newest lines and the last page is the one ending at line 1.
      const current = value.page ?? 1
      const hints = []
      if (value.truncated === true) {
        hints.push(`page 1 holds the newest ${String(value.tail.length)} lines`, `the last page is ${String(pages)}`)
      } else if (value.page !== ALL_PAGES) {
        if (current < pages) hints.push(`page ${String(current + 1)} goes back one page`)
        if (current > 1) hints.push('page 1 is the newest page')
        hints.push(`-1 reads all ${String(total)} lines`)
      }
      // Asking for everything has no page to navigate to, so the hint line
      // would only restate what the output already shows.
      if (hints.length > 0) {
        notes.push(
          `  ... ${String(pages)} ${pages === 1 ? 'page' : 'pages'} of up to ${String(value.tail.length)} lines; ${hints.join(', ')}.`,
        )
      }
    }
  }
  const blocks = [header, lines, notes].filter(block => block.length > 0)
  return blocks.map(block => block.join('\n')).join('\n\n')
}

/** @param ctx - plugin context. */
export function apply(ctx) {
  /**
   * Reject untrusted callers exactly like the shipped routes do.
   * @param req - the incoming request.
   * @param res - the response.
   * @returns whether the request was rejected and answered.
   */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** @param res - the response. */
  const methodNotAllowed = res => {
    res.statusCode = 405
    res.setHeader('allow', 'GET')
    res.end()
  }

  // The bundled tmon is not on PATH — installing one there would mean writing
  // into the user's global npm prefix — so the model reaches it through this
  // variable instead. The path is resolved per machine, never baked in.
  // `inject` waits for the service: this plugin's fiber may be mounted before
  // `shellEnv` exists, and a plain `ctx.shellEnv` read would then be undefined,
  // silently skipping the contribution.
  if (hasBundledTmon()) {
    ctx.inject(['shellEnv'], envCtx => {
      envCtx.effect(() => envCtx.shellEnv.register({
        name: 'dsh-tmon',
        variables: {
          [TMON_CLI_KEY]: { description: 'Absolute path to the tmon CLI bundled with this plugin.' },
        },
        resolve: () => ({ [TMON_CLI_KEY]: bundledEntry() }),
      }), 'tmon: model shell variable')
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TMON_STATUS_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        methodNotAllowed(res)
        return
      }
      const port = await readPort()
      let health = null
      let reason = null
      try {
        health = await request(port, '/api/health')
      } catch (error) {
        reason = String(error?.message ?? error)
      }

      // A stopped server is the plugin's problem to solve, not the user's. The
      // bundled copy means "installed" is normally already true, so the only
      // case left to report is a distribution that shipped without it.
      if (health === null) {
        const available = await hasBundledTmon() || await findCli() !== null
        if (!available) {
          sendJson(res, 200, { reachable: false, port, version: null, installed: false, reason })
          return
        }
        try {
          health = await startServer(port)
          sendJson(res, 200, { reachable: true, port, version: health?.version ?? null, installed: true, started: true })
        } catch (error) {
          sendJson(res, 200, {
            reachable: false,
            port,
            version: null,
            installed: true,
            started: false,
            reason: `${String(error?.message ?? error)} (${String(reason)})`,
          })
        }
        return
      }

      sendJson(res, 200, { reachable: true, port, version: health?.version ?? null, installed: true, started: false })
    },
  }), `tmon: GET ${TMON_STATUS_PATH}`)

  // The shell setting lives in tmon's own config file, and only the running
  // tmon decides which shell it uses — so these routes relay to tmon rather
  // than writing the file here. Restarting is separate and deliberate: a
  // setting reaches the next task only after the server is replaced, and the
  // panel asks what that would interrupt before it asks for one.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TMON_CONFIG_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      const port = await readPort()
      try {
        if (req.method === 'GET') {
          const config = await request(port, '/api/config')
          sendJson(res, 200, config)
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          const parsed = body === '' ? {} : JSON.parse(body)
          const result = await postJson(port, '/api/config', { shell: parsed.shell })
          sendJson(res, 200, result)
          return
        }
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end()
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    },
  }), `tmon: ${TMON_CONFIG_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TMON_CHECK_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const port = await readPort()
      try {
        const parsed = JSON.parse(await readBody(req))
        const result = await postJson(port, '/api/config/check', { shell: parsed.shell })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    },
  }), `tmon: POST ${TMON_CHECK_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TMON_RESTART_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      const port = await readPort()
      // Asking never restarts: the panel first learns what would be interrupted
      // and only then posts `confirm`. A restart kills every running task, and
      // that must be a decision the user made, not a side effect of saving.
      try {
        const running = await runningTasks(port)
        if (req.method === 'GET') {
          sendJson(res, 200, { running })
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'GET, POST')
          res.end()
          return
        }
        const parsed = JSON.parse((await readBody(req)) || '{}')
        if (parsed.confirm !== true) {
          sendJson(res, 409, { running, error: 'restart needs confirm: true' })
          return
        }
        const restarted = await restartServer(port)
        sendJson(res, 200, { running, ...restarted })
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    },
  }), `tmon: ${TMON_RESTART_PATH}`)

  // Compositions without a prompt registry or a skill registry still get the
  // panel; only these two contributions are optional, so the dependencies are
  // declared at the call instead of in the plugin's own `inject`.
  ctx.inject(['systemPrompt'], promptCtx => {
    // `text` may be a provider evaluated at each assembly, which is what lets
    // the section name the shell the user has configured right now. A static
    // string would have to hedge ("some configured shell"), and the agent would
    // then write for the wrong dialect the moment someone switched to bash.
    promptCtx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      text: () => promptText(),
      // The text is prose about commands; `{{shell}}` is ours, not a prompt
      // variable, so the framework must not try to interpolate it.
      interpolate: false,
    })
  })

  // tmon prints `tmon: task <id> started: <cmd>` on stderr for every task it
  // runs, and the shell that ran it carried `DSH_SESSION_ID`. Reading the pair
  // off a finished tool result is how a task acquires an owner: nothing else on
  // the way knows both ids at once.
  ctx.on('tools/result', (exec, result) => {
    const sessionId = exec?.agent?.session?.header?.id
    if (sessionId === undefined) return
    const text = JSON.stringify(result ?? '')
    const found = new Set()
    for (const match of text.matchAll(/(?:^|[^0-9a-z])tmon: task ([0-9a-f]{8}) started/gu)) {
      found.add(match[1])
    }
    for (const taskId of found) {
      void rememberTask(taskId, sessionId).catch(_unwritten => {
        // Ownership is an optimisation for the next `tmon_tasks` call: losing a
        // record makes a task read as another session's, never as a wrong owner.
      })
    }
  })

  ctx.inject(['skills'], skillsCtx => {
    const guide = parseSkill(readFileSync(new URL('./skill.md', import.meta.url), 'utf8'))
    const skill = { ...guide, source: 'bundled' }
    skillsCtx.effect(() => skillsCtx.skills.register(skill), 'tmon: usage guide skill')
  })

  // The panel answers a person watching a screen; this answers an agent that
  // cannot see it. Without it a model has no way to tell a stuck task from a
  // slow one except by waiting for its own timeout.
  ctx.inject(['tools'], toolsCtx => {
    toolsCtx.effect(() => toolsCtx.tools.register({
      name: 'tmon_tasks',
      description: 'Report what tmon is running and whether each task is progressing. '
        + 'Use it instead of guessing when a tmon command seems to hang, when you need a progress percentage or stage, '
        + 'or before deciding whether to wait or intervene. '
        + 'Each task gets the facts that separate "stuck" from "slow": its status, how long since the last output, '
        + 'elapsed time, and the last progress/stage report tmon received.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Task id, eight lowercase hex digits. Omit to list the most recent tasks.',
          },
          limit: {
            type: 'number',
            description: 'How many tasks to list when `id` is omitted (default 10, max 50). The result always says how many tasks are recorded in total and how they split across statuses, so a filter plus this count is enough to find anything.',
          },
          status: {
            type: 'string',
            enum: ['running', 'success', 'failed', 'killed', 'error'],
            description: 'When `id` is omitted, list only tasks in this state. Use it to find what failed or what is still running without reading the whole list.',
          },
          tail: {
            type: 'number',
            description: 'When `id` is given, how many output lines to return (default 20, max 200, 0 for none).',
          },
          offset: {
            type: 'number',
            description: 'Page number of the output: 1 for the newest page, 2, 3… back through the output, or -1 for every line. The result states how long the output is and how many pages it has, so read that before asking for more; output of 100 lines or fewer is always returned whole, and one answer carries at most 2000 lines however it was asked for.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            reachable: { type: 'boolean' },
            port: { type: 'integer' },
            reason: { type: 'string' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  cmd: { type: 'string' },
                  status: { type: 'string' },
                  verdict: { type: 'string', enum: ['active', 'silent', 'silent-long', 'finished', 'unknown'] },
                  settled: { type: 'boolean' },
                  exitCode: { type: 'integer' },
                  elapsedMs: { type: 'number' },
                  silenceMs: { type: 'number' },
                  lastOutputAt: { type: 'number' },
                  lastStage: { type: 'string' },
                  lastPct: { type: 'number' },
                  lastMessage: { type: 'string' },
                  outputLines: { type: 'number' },
                },
                required: ['id', 'cmd', 'status', 'verdict', 'settled', 'elapsedMs', 'outputLines'],
                additionalProperties: false,
              },
            },
            tail: { type: 'array', items: { type: 'string' } },
            tailOffset: { type: 'number' },
            totalLines: { type: 'number' },
            page: { type: 'number' },
            pageCount: { type: 'number' },
            whole: { type: 'boolean' },
            truncated: { type: 'boolean' },
            total: { type: 'number' },
            matched: { type: 'number' },
            counts: {
              type: 'object',
              properties: {
                running: { type: 'number' },
                success: { type: 'number' },
                failed: { type: 'number' },
                killed: { type: 'number' },
                error: { type: 'number' },
              },
              required: ['running', 'success', 'failed', 'killed', 'error'],
              additionalProperties: false,
            },
            otherSessions: { type: 'number' },
          },
          required: ['reachable', 'tasks'],
          additionalProperties: false,
        },
        render: (args, value) => [{
          type: 'text',
          text: renderReport(args, value),
        }],
      },
      execute: async (args, execution) => {
        const port = await readPort()
        // tmon is one workbench per machine, so its task list is everything
        // every conversation ever ran. A model that sees another session's work
        // will answer about it, so the list is narrowed to this session and the
        // count of what was left out is reported rather than silently dropped.
        const sessionId = execution?.agent?.session?.header?.id
        const mine = async tasks => {
          if (sessionId === undefined) return { kept: tasks, others: 0 }
          const map = await readSessionMap()
          const kept = tasks.filter(task => map[String(task?.id)]?.session === sessionId)
          return { kept, others: tasks.length - kept.length }
        }
        const clamp = (raw, fallback, max) => {
          const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : fallback
          return Math.min(Math.max(n, 0), max)
        }
        try {
          const wanted = typeof args?.id === 'string' ? args.id.trim() : ''
          if (wanted !== '') {
            if (!TASK_ID.test(wanted)) {
              return { reachable: true, port, tasks: [], reason: 'id must be eight lowercase hex digits' }
            }
            const body = await request(port, `/api/tasks/${wanted}`)
            if (!body?.task) return { reachable: true, port, tasks: [], reason: 'no such task' }
            const ownership = await mine([body.task])
            if (ownership.kept.length === 0) {
              return {
                reachable: true,
                port,
                tasks: [],
                reason: `task ${wanted} belongs to another session, so it is not reported here`,
              }
            }
            const facts = await summarise(port, body.task)
            const perPage = Math.min(clamp(args?.tail, 20, 200), MAX_OUTPUT_LINES)
            const events = await readEvents(port, wanted)
            // Short output is returned whole whatever page was asked for: paging
            // a handful of lines costs a second call and tells the reader nothing.
            const lines = linesOf(events)
            const whole = lines.length <= WHOLE_OUTPUT_LINES
            // An absent page means the newest page; only -1 asks for everything.
            const wantedPage = args?.offset ?? 1
            let window
            if (whole) {
              window = { lines, start: 0, total: lines.length, page: 1, pageCount: 1 }
            } else {
              try {
                window = outputWindow(events, perPage, wantedPage)
              } catch (error) {
                return { reachable: true, port, tasks: [facts], reason: String(error?.message ?? error) }
              }
            }
            return {
              reachable: true,
              port,
              tasks: [facts],
              tail: window.lines,
              tailOffset: window.start,
              totalLines: window.total,
              page: window.page,
              pageCount: window.pageCount,
              whole,
              truncated: window.truncated === true,
            }
          }
          const body = await request(port, '/api/tasks')
          const all = Array.isArray(body?.tasks) ? body.tasks : []
          const ownership = await mine(all)
          const own = ownership.kept
          const wantedStatus = typeof args?.status === 'string' ? args.status.trim() : ''
          if (wantedStatus !== '' && !TASK_STATUSES.includes(wantedStatus)) {
            return {
              reachable: true,
              port,
              tasks: [],
              reason: `status must be one of ${TASK_STATUSES.join(', ')}`,
            }
          }
          // Counted over every task of this session, not over the page being
          // returned: the counts are what tells a reader the list is longer than
          // it looks.
          const counts = { running: 0, success: 0, failed: 0, killed: 0, error: 0 }
          for (const task of own) {
            if (TASK_STATUSES.includes(task?.status)) counts[task.status] += 1
          }
          const matching = wantedStatus === '' ? own : own.filter(task => task?.status === wantedStatus)
          const limit = clamp(args?.limit, 10, 50)
          const slice = matching.slice(0, Math.max(limit, 1))
          const facts = await Promise.all(slice.map(task => summarise(port, task)))
          return {
            reachable: true,
            port,
            tasks: facts,
            counts,
            total: own.length,
            matched: matching.length,
            otherSessions: ownership.others,
          }
        } catch (error) {
          return {
            reachable: false,
            port,
            tasks: [],
            reason: `${String(error?.message ?? error)} (is tmon running? start one task with \`"$DSH_TMON_CLI" "<command>"\`)`,
          }
        }
      },
    }), 'tmon: tmon_tasks tool')
  })
}
