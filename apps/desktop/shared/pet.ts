/*
 * The desktop pet: Hermes's petdex mascot as the face of Hermes on the desktop. Shared by Electron
 * main (which reads Hermes's `display.pet` and the installed pets), the Hermes window (which works
 * out what the pet shows and acts on what the person asks of it) and the pet itself, which is a
 * window of its own in panels mode. Which pet, its size and on or off are Hermes's settings, so the
 * pet is the same in the Hermes CLI, the TUI, Hermes's desktop app and Herald.
 */

/** One frame of a petdex spritesheet, in pixels. */
export const PET_FRAME_WIDTH = 192
export const PET_FRAME_HEIGHT = 208

/** Hermes's `display.pet.scale`: its default and the bounds every Hermes surface holds it to. */
export const PET_DEFAULT_SCALE = 0.33
export const PET_MIN_SCALE = 0.1
export const PET_MAX_SCALE = 3

export function clampPetScale(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN

  return Number.isFinite(number) && number > 0 ? Math.min(PET_MAX_SCALE, Math.max(PET_MIN_SCALE, number)) : PET_DEFAULT_SCALE
}

/** Hermes's `display.pet` block of config.yaml. */
export interface PetDisplayConfig {
  enabled: boolean
  /** The chosen pet; empty means the first one installed. */
  slug: string
  scale: number
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/** `display.pet` out of a parsed config.yaml, the way Hermes reads it (off unless it says on). */
export function petDisplayConfig(config: unknown): PetDisplayConfig {
  const display = record(record(config).display)
  const pet = record(display.pet)
  const enabled = typeof pet.enabled === 'boolean' ? pet.enabled : TRUTHY.has(String(pet.enabled ?? '').trim().toLowerCase())

  return { enabled, slug: typeof pet.slug === 'string' ? pet.slug.trim() : '', scale: clampPetScale(pet.scale) }
}

/** A pet's folder name made safe: one path segment, never `.` or `..`; empty when it cannot be one. */
export function safePetSlug(slug: unknown): string {
  if (typeof slug !== 'string') {
    return ''
  }

  const segment = slug.trim().split(/[\\/]/).pop() ?? ''

  return segment === '.' || segment === '..' ? '' : segment
}

export interface InstalledPet {
  slug: string
  displayName: string
  /** Changes whenever its spritesheet does, like the shown pet's `revision`. */
  revision?: string | null
  mime?: 'image/png' | 'image/webp' | null
}

/** The pet Hermes shows, as main resolves it from config.yaml and the pets folder. */
export interface PetInfo {
  /** `display.pet.enabled` is on. */
  enabled: boolean
  /** The configured pet when it is installed, else the first installed one (as Hermes picks); null when none is. */
  slug: string | null
  displayName: string | null
  scale: number
  /** Changes whenever the spritesheet does (its modification time and size). */
  revision: string | null
  mime: 'image/png' | 'image/webp' | null
  /** Every pet in the pets folder with a spritesheet, by folder name. */
  installed: InstalledPet[]
}

export const PET_OFF: PetInfo = { enabled: false, slug: null, displayName: null, scale: PET_DEFAULT_SCALE, revision: null, mime: null, installed: [] }

/** Whether the pet has something to show: switched on in Hermes, with a pet installed. */
export const petShown = (info: PetInfo): boolean => info.enabled && Boolean(info.slug && info.revision)

/** What the pet shows, from what Hermes is doing; the order between them is `features/pet/state.ts`. */
export type PetActivity = 'idle' | 'thinking' | 'running' | 'cheering' | 'drooping' | 'listening' | 'waiting'

/** Reactions the person can turn off one by one; the pet stays idle instead. */
export type PetReaction = 'thinking' | 'running' | 'cheering' | 'drooping' | 'listening'
export const PET_REACTIONS: readonly PetReaction[] = ['thinking', 'running', 'cheering', 'drooping', 'listening']

/** Moods from the machine: worried when the disk is nearly full or the battery is low. */
export type PetMoodKind = 'disk' | 'battery'
export const PET_MOOD_KINDS: readonly PetMoodKind[] = ['disk', 'battery']

/** Quiet notifications the pet brings: an update ready (a box), a long job done (a note). */
export type PetNoteKind = 'update' | 'job'
export const PET_NOTE_KINDS: readonly PetNoteKind[] = ['update', 'job']

/** Herald's own pet preferences in prefs.json. */
export interface PetPrefs {
  /** Put away for now (the shortcut, the menu bar, `pet.hide`), until shown again. */
  hidden: boolean
  /** Where the person left it: its top-left corner as fractions of the area it moves in; null until dragged. */
  spot: { x: number; y: number } | null
  reactions: Record<PetReaction, boolean>
  moods: Record<PetMoodKind, boolean>
  notes: Record<PetNoteKind, boolean>
  /** Walk to the Herald Docs, Sheets, Slides or Canvas window Hermes is working in. */
  followWindows: boolean
}

export const PET_PREFS_DEFAULTS: PetPrefs = {
  hidden: false,
  spot: null,
  reactions: { thinking: true, running: true, cheering: true, drooping: true, listening: true },
  moods: { disk: true, battery: true },
  notes: { update: true, job: true },
  followWindows: true
}

/** A stored value made whole: unknown keys dropped, missing ones from the defaults. */
export function normalizePetPrefs(raw: unknown): PetPrefs {
  const source = record(raw)
  const spot = record(source.spot)
  const fraction = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null)
  const x = fraction(spot.x)
  const y = fraction(spot.y)

  return {
    hidden: source.hidden === true,
    spot: x !== null && y !== null ? { x, y } : null,
    reactions: flags(PET_REACTIONS, source.reactions),
    moods: flags(PET_MOOD_KINDS, source.moods),
    notes: flags(PET_NOTE_KINDS, source.notes),
    followWindows: source.followWindows !== false
  }
}

export interface PetRect {
  x: number
  y: number
  width: number
  height: number
}

/** The approval Hermes waits for, carrying only what Herald's approval card shows. */
export interface PetApprovalParams {
  description?: string | null
  command?: string | null
  tool_name?: string | null
  choices?: string[] | null
  allow_permanent?: boolean | null
  allow_session?: boolean | null
}

export interface PetApproval {
  /** The pending request's id, which the answer names. */
  id: string
  params: PetApprovalParams
  /** A spoken "yes" or "no" answers it too (a voice conversation runs on its session). */
  voice: boolean
}

export interface PetChatMessage {
  id: string
  role: 'user' | 'hermes'
  text: string
}

/** The pet's own conversation with Hermes: a background Herald session, like an Office window's Ask Hermes bar. */
export interface PetChat {
  sessionId: string | null
  /** The last few messages, oldest first. */
  messages: PetChatMessage[]
  working: boolean
  /** What Hermes is doing for it, while it works. */
  step: string | null
  error: string | null
}

export type PetFollowApp = 'docs' | 'sheets' | 'slides' | 'canvas'

/** Where Hermes is working: the app, and the document when the command named one. */
export interface PetFollow {
  app: PetFollowApp
  document: string | null
  at: number
}

export interface PetMood {
  kind: PetMoodKind
  text: string
}

export interface PetNote {
  id: string
  kind: PetNoteKind
  text: string
  /** The conversation a finished job belongs to (opens on a click). */
  sessionId: string | null
}

/** Why the pet steps out of the way by itself. */
export type PetHideReason = 'fullscreen' | 'presenting' | 'doNotDisturb'

/** Everything the pet shows, worked out in the Hermes window (it holds the sessions and the approvals). */
export interface PetSnapshot {
  activity: PetActivity
  /** What Hermes is doing now in a few words ("Editing Q3 report"), or null when it is free. */
  step: string | null
  /** Background missions and automations running. */
  badge: number
  approval: PetApproval | null
  /** Approvals waiting behind the one shown. */
  approvalsWaiting: number
  chat: PetChat
  follow: PetFollow | null
  mood: PetMood | null
  note: PetNote | null
  hiddenBy: PetHideReason | null
}

export const PET_EMPTY_CHAT: PetChat = { sessionId: null, messages: [], working: false, step: null, error: null }

export const PET_IDLE_SNAPSHOT: PetSnapshot = { activity: 'idle', step: null, badge: 0, approval: null, approvalsWaiting: 0, chat: PET_EMPTY_CHAT, follow: null, mood: null, note: null, hiddenBy: null }

export type PetAnswer = 'once' | 'session' | 'always' | 'deny'

/** What a file dropped on the pet can become; `features/pet/drops.ts` picks the ones that fit. */
export type PetDropSuggestionId = 'summarize' | 'fileInvoice' | 'slides' | 'canvas' | 'describe' | 'openDocs' | 'openSheets' | 'openSlides' | 'ask'

/** What the pet asks of the Hermes window. */
export type PetAction =
  | { type: 'answer'; id: string; choice: PetAnswer }
  | { type: 'ask'; text: string }
  | { type: 'drop'; paths: string[]; suggestion: PetDropSuggestionId; text?: string }
  | { type: 'openInHermes' }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'openNote' }
  | { type: 'dismissNote' }

/** Where the pet window goes and how big it is (panels mode), in the output's logical pixels. */
export interface PetWindowPlacement {
  x: number
  y: number
  width: number
  height: number
}

/** What main sees of Herald's own windows (panels mode): one in full screen, Herald Slides presenting. */
export interface PetCover {
  fullscreen: boolean
  presenting: boolean
}

/** `window.heraldOS.pet`. */
export interface PetBridge {
  info(): Promise<PetInfo>
  /** Read config.yaml and the pets folder again now (after Herald asked Hermes to change them). */
  refresh(): Promise<PetInfo>
  onInfo(listener: (info: PetInfo) => void): () => void
  /** An installed pet's spritesheet; null when it is not there. */
  sheet(slug: string): Promise<Uint8Array | null>
  /** The Hermes window hands over what the pet shows; main keeps the last one for the pet window. */
  publish(snapshot: PetSnapshot): void
  onSnapshot(listener: (snapshot: PetSnapshot) => void): () => void
  /** The pet window asks the Hermes window to act. */
  act(action: PetAction): void
  onAction(listener: (action: PetAction) => void): () => void
  /** Panels mode: where the pet window goes and its size. */
  place(placement: PetWindowPlacement): Promise<void>
  /** Panels mode: whether the pet window may take the keys (only while its chat box is open). */
  setInteractive(on: boolean): Promise<void>
  /** Panels mode: show or put away the pet window. */
  setVisible(on: boolean): Promise<void>
  /** Panels mode: the area the pet moves in, in the output's logical pixels. */
  workArea(): Promise<PetRect>
  onCover(listener: (cover: PetCover) => void): () => void
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function flags<K extends string>(keys: readonly K[], raw: unknown): Record<K, boolean> {
  const source = record(raw)

  return Object.fromEntries(keys.map(key => [key, source[key] !== false])) as Record<K, boolean>
}
