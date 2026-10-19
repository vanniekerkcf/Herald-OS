import type { RoomArea } from './types.ts'

/*
 * Where a tool call puts a pet and what its bubble says, from fixed tables. A call is first cut
 * down to names (`roomToolCall`, on arrival): a file's or document's last path segment, a web
 * host, a folder name, an app, an action word. Never a command, a query, file content or any
 * other argument; those are dropped with the rest of the frame.
 */

/** What a tool call is about, by name only. */
export interface RoomToolCall {
  /** The tool the call runs: for a call bridged through `tool_search`, the inner tool Hermes's labels name. */
  name: string
  /** A file or document name, a web host or a folder name, from the call's target arguments. */
  target: string | null
  /** The folder a command runs in (`workdir`, `cwd`), by name. */
  folder: string | null
  /** The call's action word (`read`, `list`; what `system_open` opens) and the Herald command it runs (`docs.open`), when they are plain identifiers. */
  action: string | null
  command: string | null
  /** The app a connector or MCP call runs on, from Hermes's labels. */
  app: string | null
}

export interface RoomToolStep {
  /** Where the call works; null leaves the pet where it is. */
  area: RoomArea | null
  target: string | null
  step: string
  /** The call works on the document in front of its app, which it does not name. */
  front?: boolean
}

/** What the agent already shows, for calls that name less than the one before them. */
export interface RoomToolContext {
  cwd: string | null
  area: RoomArea | null
  target: string | null
}

/** Hermes's own target keys (`delegate_tool_results._TOOL_INPUT_TARGET_KEYS`), files before folders before addresses. */
const TARGET_KEYS = ['file_path', 'path', 'target_path', 'destination_path', 'new_path', 'old_path', 'source_path', 'src', 'dst', 'directory', 'cwd', 'url', 'urls', 'endpoint'] as const
const URL_KEYS = new Set(['url', 'urls', 'endpoint'])
const MAX_NAME = 40
const IDENTIFIER = /^[a-z][a-z0-9_.:-]{0,47}$/i
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

const OFFICE: Record<string, { area: RoomArea; key: string; app: string; front: string }> = {
  docs: { area: 'docs', key: 'document', app: 'Herald Docs', front: 'the document in front' },
  sheets: { area: 'sheets', key: 'workbook', app: 'Herald Sheets', front: 'the workbook in front' },
  slides: { area: 'slides', key: 'presentation', app: 'Herald Slides', front: 'the presentation in front' }
}
const OFFICE_LOOKS = new Set(['list', 'list_all', 'list_templates'])
const OFFICE_READS = new Set(['read', 'find', 'statistics', 'read_master', 'describe_chart', 'get_validation'])

/** Herald's own commands (`os_ui`), by the app their id starts with. */
const HERALD_APPS: Record<string, { area: RoomArea; app: string }> = {
  docs: { area: 'docs', app: 'Herald Docs' },
  sheets: { area: 'sheets', app: 'Herald Sheets' },
  slides: { area: 'slides', app: 'Herald Slides' },
  canvas: { area: 'canvas', app: 'Herald Canvas' },
  studio: { area: 'studio', app: 'Studio' },
  web: { area: 'browser', app: 'the browser' },
  browser: { area: 'browser', app: 'the browser' },
  files: { area: 'files', app: 'Files' },
  file: { area: 'files', app: 'Files' },
  memory: { area: 'memory', app: 'Memory' },
  terminal: { area: 'terminal', app: 'the terminal' },
  chat: { area: 'messages', app: 'Chat' },
  connections: { area: 'messages', app: 'Connections' }
}

/** Calls with one fixed label: the area (null stays put) and the words. */
const FIXED: Record<string, [RoomArea | null, string]> = {
  search_files: ['files', 'searching files'],
  system_files: ['files', 'organising files'],
  system_find_files: ['files', 'searching for files'],
  system_documents: ['files', 'looking through documents'],
  vision_analyze: ['files', 'looking at an image'],
  video_analyze: ['files', 'looking at a video'],
  process: ['terminal', 'managing a process'],
  process_manage: ['terminal', 'managing a process'],
  system_info: ['terminal', 'checking the system'],
  system_processes: ['terminal', 'checking the system'],
  system_disk_usage: ['terminal', 'checking the system'],
  system_network: ['terminal', 'checking the system'],
  system_logs: ['terminal', 'checking the system'],
  system_os: ['terminal', 'checking the system'],
  system_control: ['terminal', 'checking the system'],
  system_kill_process: ['terminal', 'stopping a process'],
  read_terminal: ['terminal', 'reading the terminal'],
  close_terminal: ['terminal', 'closing a terminal'],
  execute_code: ['studio', 'running code'],
  web_search: ['browser', 'searching the web'],
  x_search: ['browser', 'searching X'],
  image_generate: ['canvas', 'making an image'],
  video_generate: ['canvas', 'making a video'],
  memory: ['memory', 'updating memory'],
  session_search: ['memory', 'searching past conversations'],
  skill_view: ['memory', 'reading a skill'],
  skills_list: ['memory', 'looking at skills'],
  skill_manage: ['memory', 'updating a skill'],
  send_message: ['messages', 'sending a message'],
  react_to_message: ['messages', 'reacting to a message'],
  manage_connections: ['messages', 'managing connections'],
  todo: [null, 'updating the plan'],
  todo_list: [null, 'updating the plan'],
  delegate_task: [null, 'handing work to a helper'],
  cronjob: [null, 'scheduling an automation'],
  cronjob_manage: [null, 'scheduling an automation'],
  computer_use: [null, 'using the computer'],
  system_apps: [null, 'looking at apps'],
  text_to_speech: [null, 'turning text into speech'],
  clarify: ['bench', 'waiting for you in Hermes']
}

/** Cut a name to a tag's width, on one line. */
export function shortName(value: string, max = MAX_NAME): string | null {
  const text = value.replace(/\s+/g, ' ').trim()

  if (!text) {
    return null
  }

  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** A path's last segment: `~/Work/Budget.xlsx` names `Budget.xlsx`. */
export function nameOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  let text = value.trim()

  if (SCHEME.test(text)) {
    if (!/^file:/i.test(text)) {
      return hostOf(text)
    }

    text = text.replace(/^file:\/\/[^/]*/i, '').replace(/[?#].*$/, '')
  }

  const last = text.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

  return last === '.' || last === '..' || last === '~' ? null : shortName(last)
}

/** A web address's host and port, without its credentials, path or query. */
export function hostOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim())) {
    return null
  }

  const text = value.trim()

  for (const candidate of SCHEME.test(text) ? [text] : [`http://${text}`]) {
    try {
      const host = new URL(candidate).host.toLowerCase()

      return host ? shortName(host) : null
    } catch {
      // Not an address: no host to name.
    }
  }

  return null
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : null
}

function firstTarget(args: Record<string, unknown>): string | null {
  for (const key of TARGET_KEYS) {
    const raw = args[key]
    const value = Array.isArray(raw) ? raw.find(item => typeof item === 'string') : raw

    if (typeof value === 'string' && value.trim()) {
      return URL_KEYS.has(key) ? hostOf(value) : nameOf(value)
    }
  }

  return null
}

function targetOf(name: string, args: Record<string, unknown>): string | null {
  const office = OFFICE[name]

  if (office) {
    return nameOf(args[office.key]) ?? nameOf(args.path) ?? nameOf(args.name)
  }

  if (name === 'canvas') {
    return nameOf(args.project) ?? nameOf(args.path) ?? nameOf(args.name)
  }

  if (name === 'terminal') {
    return null
  }

  if (name === 'system_open') {
    switch (args.target) {
      case 'url':
        return hostOf(args.url)
      case 'app':
        return typeof args.app === 'string' ? shortName(args.app) : null
      case 'settings':
        return null
      default:
        return nameOf(args.path)
    }
  }

  return firstTarget(args)
}

interface LabelLike {
  kind?: unknown
  app?: unknown
  name?: unknown
}

/** Cut a `tool.start` down to names; its arguments and labels go no further than this. */
export function roomToolCall(name: string, args: unknown, labels: unknown): RoomToolCall {
  const label = Array.isArray(labels) ? (labels.find(item => item && typeof item === 'object') as LabelLike | undefined) : undefined
  const bridgedTool = label?.kind === 'tool' ? identifier(label.name) : null
  const app = (label?.kind === 'connector' || label?.kind === 'mcp') && typeof label.app === 'string' ? shortName(label.app) : null

  if (bridgedTool) {
    return { name: bridgedTool, target: null, folder: null, action: null, command: null, app: null }
  }

  const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}

  return {
    name,
    target: targetOf(name, input),
    folder: name === 'terminal' ? (nameOf(input.workdir) ?? nameOf(input.cwd)) : null,
    action: identifier(name === 'system_open' ? input.target : input.action),
    command: identifier(input.command),
    app
  }
}

const withTarget = (target: string | null, named: (target: string) => string, plain: string): string => (target ? named(target) : plain)

function heraldStep(call: RoomToolCall): RoomToolStep {
  if (call.action === 'list' || call.action === 'state') {
    return { area: null, target: null, step: 'looking at Herald' }
  }

  const [prefix, verb] = (call.command ?? '').split('.')
  const app = HERALD_APPS[prefix]

  if (!app) {
    return { area: null, target: null, step: 'using Herald' }
  }

  return { area: app.area, target: null, step: verb === 'open' ? `opening ${app.app}` : 'using Herald' }
}

function officeStep(call: RoomToolCall, office: (typeof OFFICE)[string]): RoomToolStep {
  const action = call.action ?? ''

  if (OFFICE_LOOKS.has(action)) {
    return { area: office.area, target: null, step: `looking at ${office.app}` }
  }

  const name = call.target ?? office.front
  const reads = OFFICE_READS.has(action) || action.startsWith('list_')

  return { area: office.area, target: call.target, step: reads ? `reading ${name}` : `working on ${name}`, front: !call.target }
}

function openStep(call: RoomToolCall): RoomToolStep {
  if (call.action === 'settings') {
    return { area: null, target: null, step: 'opening Settings' }
  }

  const area: RoomArea | null = call.action === 'url' ? 'browser' : call.action === 'app' ? null : 'files'

  return { area, target: call.target, step: withTarget(call.target, t => `opening ${t}`, 'opening something') }
}

/** The area, target and bubble for a call. Calls that name no host keep the browser's last one. */
export function describeTool(call: RoomToolCall, context: RoomToolContext = { cwd: null, area: null, target: null }): RoomToolStep {
  const { name, target } = call

  if (call.app) {
    return { area: 'messages', target: call.app, step: `using ${call.app}` }
  }

  const office = OFFICE[name]

  if (office) {
    return officeStep(call, office)
  }

  switch (name) {
    case 'read_file':
      return { area: 'files', target, step: withTarget(target, t => `reading ${t}`, 'reading a file') }
    case 'write_file':
      return { area: 'files', target, step: withTarget(target, t => `writing ${t}`, 'writing a file') }
    case 'patch':
      return { area: 'files', target, step: withTarget(target, t => `editing ${t}`, 'editing a file') }
    case 'terminal':
      return { area: 'terminal', target: call.folder ?? context.cwd, step: 'running a command' }
    case 'web_extract':
      return { area: 'browser', target, step: withTarget(target, t => `reading ${t}`, 'reading a web page') }
    case 'canvas':
      return { area: 'canvas', target, step: `working on ${target ?? 'the image in front'}`, front: !target }
    case 'os_ui':
      return heraldStep(call)
    case 'system_open':
      return openStep(call)
  }

  if (name.startsWith('browser_')) {
    const host = target ?? (context.area === 'browser' ? context.target : null)

    return { area: 'browser', target: host, step: withTarget(host, t => `browsing ${t}`, 'browsing the web') }
  }

  if (name.startsWith('ha_')) {
    return { area: null, target: null, step: 'using Home Assistant' }
  }

  const fixed = FIXED[name]

  if (fixed) {
    return { area: fixed[0], target: fixed[0] ? target : null, step: fixed[1] }
  }

  return { area: null, target: null, step: `using ${shortName(name.replace(/_+/g, ' ')) ?? 'a tool'}` }
}
