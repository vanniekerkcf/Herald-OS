import type { ApprovalChoice } from '@herald-os/client'
import type { SystemStats } from '../../../shared/ipc.ts'
import { type PetAction, type PetDropSuggestionId, type PetFollow, type PetMood, type PetNote, type PetSnapshot, petShown } from '../../../shared/pet.ts'
import { approvalFacts } from '../../lib/approval-choices.ts'
import type { ChatState } from '../../lib/chat-model.ts'
import { $backend, $env } from '../../store/backend.ts'
import { $activeChatId, $chats } from '../../store/chat.ts'
import { $connection, onGatewayEvent } from '../../store/gateway.ts'
import { $commandLog, runCommand } from '../../store/os-commands.ts'
import { $pendingRequests, resolveRequest } from '../../store/requests.ts'
import { isPanels, openSurface } from '../../store/shell.ts'
import { $switches } from '../../store/switches.ts'
import { $voice, $voiceActive, $voiceSessionId } from '../../store/voice.ts'
import { $page, $windows } from '../../store/windows.ts'
import { cronApi } from '../automations/api.ts'
import { approvalOf, chatSignals, derivePetActivity, FOLLOW_MS, FOLLOW_WORKING_MS, followAlive, followFrom, nextBeatEnd, type PetSignals, stepOf, turnEndOf, turnStart } from '../petdex/activity.ts'
import { $petPrefs } from './actions.ts'
import { $petChat, $petSessionId, askPet, newPetChat, openInHermesWindow, openPetChatInHermes, setPetError, stopPet } from './chat.ts'
import { dropAction } from './drops.ts'
import { autoHideReason } from './hide.ts'
import { $petInfo } from './info.ts'
import { jobNote, nextMood, NoteGate, updateNote } from './moods.ts'
import { handlePetActions, publishPetSnapshot } from './transport.ts'

export { approvalOf, chatSignals, type ChatSignals, followAlive, followFrom, turnStart } from '../petdex/activity.ts'

/*
 * The pet's brain, in the Hermes window: what Hermes is doing (its sessions, the approval it waits
 * for, the voice conversation), where it works, the machine's moods and the notes worth bringing,
 * folded into one snapshot for the pet; and the pet's requests acted on here, where the sessions and
 * the approvals live. It never answers an approval by itself: only an `answer` action does, for a
 * request that is still pending and with a choice the card offers.
 */

const UPDATE_KEY = 'herald-os.update-available'
const MOOD_EVERY_MS = 3 * 60_000
const UPDATE_EVERY_MS = 5 * 60_000
const AUTOMATIONS_EVERY_MS = 2 * 60_000
/** Snapshots go out at most this often while text streams in. */
const PUBLISH_MS = 120

/** Answer an approval from the pet: only a pending approval, only with an answer its card offers. */
export function answerApproval(id: unknown, choice: unknown): boolean {
  const entry = $pendingRequests.get().find(item => item.request.id === id)

  if (!entry || entry.kind !== 'approval' || typeof choice !== 'string' || !approvalFacts(entry.request.params).choices.includes(choice as ApprovalChoice)) {
    return false
  }

  resolveRequest(entry.request.id, { choice })

  return true
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

const turns = new Map<string, { at: number; from: number }>()
const gate = new NoteGate()
let cheerAt: number | null = null
let errorAt: number | null = null
let wakeAt: number | null = null
let follow: PetFollow | null = null
let mood: PetMood | null = null
let note: PetNote | null = null
let automations = 0
let fullscreen = false
let presenting = false

/** Turns that started and ended since the last look: clean ends cheer, failures droop, long ones bring a note. */
function watchTurns(chats: Record<string, ChatState>, now: number): void {
  for (const chat of Object.values(chats)) {
    const known = turns.get(chat.sessionId)

    if (chat.streaming && !known) {
      turns.set(chat.sessionId, { at: now, from: turnStart(chat.messages) })
    } else if (!chat.streaming && known) {
      turns.delete(chat.sessionId)
      const end = turnEndOf(chat.messages.slice(known.from))

      if (end === 'ok') {
        cheerAt = now
        bringJobNote(chat, known.at, now)
      } else if (end === 'error') {
        errorAt = now
      }
    }
  }

  for (const id of [...turns.keys()]) {
    if (!chats[id]) {
      turns.delete(id)
    }
  }
}

function bringJobNote(chat: ChatState, startedAt: number, endedAt: number): void {
  const watching = $activeChatId.get() === chat.sessionId && $page.get() === 'hermes' && typeof document !== 'undefined' && document.hasFocus()

  if (watching || chat.sessionId === $petSessionId.get()) {
    return
  }

  const next = jobNote({ sessionId: chat.storedSessionId || chat.sessionId, title: chat.title || 'a Hermes task', startedAt, endedAt }, $petPrefs.get().notes.job)

  if (next && gate.allow(next, endedAt)) {
    note = next
  }
}

/** The snapshot from the stores as they are now. */
export function composePetSnapshot(now: number): PetSnapshot {
  const prefs = $petPrefs.get()
  const sessionId = $petSessionId.get()
  const signals = chatSignals(Object.values($chats.get()), [sessionId, $activeChatId.get()])
  const { approval, waiting } = approvalOf($pendingRequests.get(), { active: $voiceActive.get(), sessionId: $voiceSessionId.get() })
  const petSignals: PetSignals = {
    approval: approval !== null,
    working: signals.working,
    toolRunning: signals.toolRunning,
    reasoning: signals.reasoning,
    listening: $voiceActive.get() && $voice.get().state === 'listening',
    cheerAt,
    errorAt,
    wakeAt
  }
  const focus = signals.focus
  const step = approval ? 'Waiting for your answer' : focus ? stepOf(focus.messages.slice(turns.get(focus.sessionId)?.from ?? turnStart(focus.messages)), true) : null
  const moodShown = mood && prefs.moods[mood.kind] ? mood : null
  const noteShown = note && prefs.notes[note.kind] ? note : null

  return {
    activity: derivePetActivity(petSignals, prefs.reactions, now),
    step,
    badge: signals.background + automations,
    approval,
    approvalsWaiting: waiting,
    chat: $petChat.get(),
    follow: prefs.followWindows && followAlive(follow, now, signals.working) ? follow : null,
    mood: moodShown,
    note: noteShown,
    hiddenBy: autoHideReason({ fullscreen, presenting, doNotDisturb: $switches.get().doNotDisturb })
  }
}

let lastSent = ''
let publishTimer: ReturnType<typeof setTimeout> | null = null
let wakeTimer: ReturnType<typeof setTimeout> | null = null
let lastPublish = 0

function publish(): void {
  publishTimer = null
  lastPublish = Date.now()
  const now = lastPublish
  const snapshot = composePetSnapshot(now)
  const text = JSON.stringify(snapshot)

  if (text !== lastSent) {
    lastSent = text
    publishPetSnapshot(snapshot)
  }

  // A beat ending or a follow running out changes the snapshot with no store change: look again then.
  const working = Object.values($chats.get()).some(chat => chat.streaming)
  const beat = nextBeatEnd({ approval: false, working, toolRunning: false, reasoning: false, listening: false, cheerAt, errorAt, wakeAt }, now)
  const followEnd = follow && followAlive(follow, now, working) ? follow.at + (working ? FOLLOW_WORKING_MS : FOLLOW_MS) - now : null
  const wait = [beat, followEnd].filter((ms): ms is number => ms !== null && ms >= 0)

  if (wakeTimer) {
    clearTimeout(wakeTimer)
    wakeTimer = null
  }

  if (wait.length) {
    wakeTimer = setTimeout(schedule, Math.min(...wait) + 20)
  }
}

function schedule(): void {
  if (!publishTimer) {
    publishTimer = setTimeout(publish, Math.max(0, PUBLISH_MS - (Date.now() - lastPublish)))
  }
}

async function runDrop(suggestion: PetDropSuggestionId, paths: string[], text?: string): Promise<void> {
  const plan = dropAction(suggestion, paths, text)

  if (!plan) {
    setPetError('That does not fit these files')

    return
  }

  if (plan.kind === 'prompt') {
    await askPet(plan.prompt)

    return
  }

  setPetError(null)
  const result = await runCommand(plan.command, plan.args, { source: 'ui' })

  if (!result.ok) {
    setPetError(result.error ?? result.summary)
  }
}

function openNote(): void {
  const current = note

  if (!current) {
    return
  }

  note = null
  gate.dismiss(current)
  schedule()

  if (current.kind === 'job') {
    openInHermesWindow(current.sessionId)
  } else if (isPanels) {
    openSurface('command', { type: 'menu', args: ['update-herald-os'] })
  } else {
    void runCommand('settings.open', { section: 'about' }, { source: 'ui' })
  }
}

function dismissNote(): void {
  if (note) {
    gate.dismiss(note)
    note = null
    schedule()
  }
}

/** Act on what the person did with the pet; anything malformed (it may come from another window) is ignored. */
export function handlePetAction(action: PetAction): void {
  switch (action?.type) {
    case 'answer':
      answerApproval(action.id, action.choice)
      break
    case 'ask':
      if (typeof action.text === 'string') {
        void askPet(action.text)
      }
      break
    case 'drop':
      if (isStrings(action.paths) && typeof action.suggestion === 'string') {
        void runDrop(action.suggestion, action.paths, typeof action.text === 'string' ? action.text : undefined)
      }
      break
    case 'openInHermes':
      openPetChatInHermes()
      break
    case 'stop':
      void stopPet()
      break
    case 'newChat':
      newPetChat()
      break
    case 'openNote':
      openNote()
      break
    case 'dismissNote':
      dismissNote()
      break
  }
}

const shownNow = (): boolean => petShown($petInfo.get()) && !$petPrefs.get().hidden
const gatewayReady = (): boolean => $backend.get().phase === 'ready' && $connection.get() === 'open'

function readUpdateNote(): void {
  let raw: string | null = null

  try {
    raw = localStorage.getItem(UPDATE_KEY)
  } catch {
    raw = null
  }

  const next = updateNote(raw, $petPrefs.get().notes.update)

  if (!next) {
    if (note?.kind === 'update') {
      note = null
      schedule()
    }

    return
  }

  if (note?.id !== next.id && gate.allow(next, Date.now())) {
    note = next
    schedule()
  }
}

/** Work out the mood from a sample of the system's status (the development hook passes its own). */
export function applyPetStats(stats: SystemStats | null): void {
  mood = nextMood(mood, stats, $petPrefs.get().moods, $env.get()?.homeDir)
  schedule()
}

/** A reaction beat as if a turn had just ended or the wake word had heard the person (development hook). */
export function pulsePet(kind: 'cheer' | 'error' | 'wake'): void {
  const now = Date.now()

  if (kind === 'cheer') {
    cheerAt = now
  } else if (kind === 'error') {
    errorAt = now
  } else {
    wakeAt = now
  }

  schedule()
}

function sampleMood(): void {
  if (!shownNow()) {
    return
  }

  void window.heraldOS.system
    .stats()
    .then(applyPetStats)
    .catch(() => undefined)
}

let automationsInFlight = false

/** Automations running now: the latest run of the jobs most likely to be running is still active. */
async function sampleAutomations(): Promise<void> {
  if (automationsInFlight || !shownNow() || !gatewayReady()) {
    return
  }

  automationsInFlight = true

  try {
    const listed = await cronApi.list()
    const jobs = (Array.isArray(listed) ? listed : []).filter(job => job.enabled !== false)
    const recent = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) || 0 : 0)
    jobs.sort((a, b) => recent(b.last_run_at) - recent(a.last_run_at))
    const runs = await Promise.allSettled(jobs.slice(0, 6).map(job => cronApi.runs(job, 1)))
    const next = runs.filter(run => run.status === 'fulfilled' && run.value[0]?.is_active === true).length

    if (next !== automations) {
      automations = next
      schedule()
    }
  } catch {
    // The next sample tries again.
  } finally {
    automationsInFlight = false
  }
}

let slidesWatched = false

/** Herald Slides is presenting in this window (desktop mode; panels mode asks the compositor). */
export const heraldPresenting = (): boolean => presenting

/** Herald Slides presenting, in this window: its store loads with the app, so only look once a Slides window is open. */
function watchSlides(): void {
  $windows.subscribe(windows => {
    if (slidesWatched || !Object.values(windows).some(win => win.appId === 'slides')) {
      return
    }

    slidesWatched = true
    void import('../office/slides/store.ts')
      .then(({ $presentation }) =>
        $presentation.subscribe(state => {
          presenting = state !== null
          schedule()
        })
      )
      .catch(() => {
        slidesWatched = false
      })
  })
}

let bound = false

/** Start the brain once, in the Hermes window. */
export function bindPetBrain(): void {
  if (bound) {
    return
  }

  bound = true
  handlePetActions(handlePetAction)

  $chats.subscribe(chats => {
    watchTurns(chats, Date.now())
    schedule()
  })

  let voiceWasActive = false
  $voice.subscribe(voice => {
    const active = voice.state !== 'off' && voice.state !== 'armed'

    if (active && !voiceWasActive && voice.startedBy === 'wake') {
      wakeAt = Date.now()
    }

    voiceWasActive = active
    schedule()
  })

  $commandLog.subscribe(log => {
    const next = followFrom(log[0])

    if (next && next.at !== follow?.at) {
      follow = next
      schedule()
    }
  })

  for (const store of [$pendingRequests, $petChat, $petPrefs, $switches, $voiceSessionId, $activeChatId]) {
    store.listen(schedule)
  }

  let wasShown = shownNow()
  const onShown = () => {
    const shown = shownNow()

    if (shown && !wasShown) {
      sampleMood()
      void sampleAutomations()
    }

    wasShown = shown
    schedule()
  }

  $petInfo.listen(onShown)
  $petPrefs.listen(onShown)
  $connection.listen(state => {
    if (state === 'open') {
      void sampleAutomations()
    }
  })

  let cronTimer: ReturnType<typeof setTimeout> | null = null
  onGatewayEvent('cron.changed', () => {
    if (!cronTimer) {
      cronTimer = setTimeout(() => {
        cronTimer = null
        void sampleAutomations()
      }, 3000)
    }
  })

  setInterval(sampleMood, MOOD_EVERY_MS)
  setInterval(() => void sampleAutomations(), AUTOMATIONS_EVERY_MS)
  setInterval(readUpdateNote, UPDATE_EVERY_MS)
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === UPDATE_KEY) {
      readUpdateNote()
    }
  })

  if (!isPanels) {
    document.addEventListener('fullscreenchange', () => {
      fullscreen = Boolean(document.fullscreenElement)
      schedule()
    })
    watchSlides()
  }

  sampleMood()
  readUpdateNote()
  schedule()
}
