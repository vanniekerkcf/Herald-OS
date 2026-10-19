import { PET_MAX_SCALE, PET_MIN_SCALE, type PetActivity, type PetHideReason, petShown } from '../../shared/pet.ts'
import { $petPrefs, findInstalledPet, hidePet, selectPet, setPetEnabled, setPetScale, showPet } from '../features/pet/actions.ts'
import { $petInfo } from '../features/pet/info.ts'
import { $petChatRequest, $petSnapshot } from '../features/pet/transport.ts'
import { type CommandResult, fail, ok, type OsCommand } from '../store/os-commands.ts'
import { isPanels } from '../store/shell.ts'

/* Hermes's desktop pet: showing and putting it away, which pet, its size, and what it is doing. */

const DOING: Record<PetActivity, string> = {
  idle: 'resting',
  thinking: 'thinking',
  running: 'running a tool',
  cheering: 'cheering a finished task',
  drooping: 'drooping after an error',
  listening: 'listening',
  waiting: 'holding up an approval for you'
}

const AWAY: Record<PetHideReason, string> = {
  fullscreen: 'out of the way of a full-screen app',
  presenting: 'out of the way while Herald Slides presents',
  doNotDisturb: 'out of the way during Do Not Disturb'
}

const SLUG = /^[a-z0-9][a-z0-9_-]*$/i
/** One step of "bigger" or "smaller": a quarter of the size. */
const SIZE_STEP = 1.25

const petName = (): string => $petInfo.get().displayName ?? 'The pet'

function nothingInstalled(): CommandResult | null {
  return $petInfo.get().installed.length ? null : fail('No pet is installed yet: Settings, Pet has the petdex gallery to pick one from')
}

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const petCommands: readonly OsCommand[] = [
  {
    id: 'pet.show',
    title: 'Show the pet',
    description: 'Bring Hermes’s desktop pet back after it was put away; switches it on in Hermes when it is off.',
    tier: 'act',
    args: [],
    phrases: ['show the pet', 'show pet', 'bring back the pet', 'bring the pet back', 'show the mascot'],
    run: async () => {
      const missing = nothingInstalled()

      if (missing) {
        return missing
      }

      try {
        if (!$petInfo.get().enabled) {
          await setPetEnabled(true)
        }

        await showPet()
      } catch (error) {
        return fail(errorOf(error))
      }

      return ok(`Showing ${petName()}`, { spoken: 'Here it is.' })
    }
  },
  {
    id: 'pet.hide',
    title: 'Put the pet away',
    description: 'Hide the desktop pet for now (for screen sharing, say) until it is shown again; Hermes keeps its pet setting.',
    tier: 'act',
    args: [],
    phrases: ['hide the pet', 'hide pet', 'put the pet away', 'put away the pet', 'hide the mascot'],
    run: async () => {
      await hidePet()

      return ok('Put the pet away', { spoken: 'Hidden. Say show the pet to bring it back.' })
    }
  },
  {
    id: 'pet.toggle',
    title: 'Hide or show the pet',
    description: 'Put the pet away, or bring it back, as the shortcut and the menu bar do.',
    tier: 'act',
    args: [],
    phrases: ['toggle the pet'],
    run: async () => {
      if ($petPrefs.get().hidden) {
        await showPet()

        return ok(`Showing ${petName()}`)
      }

      await hidePet()

      return ok('Put the pet away')
    }
  },
  {
    id: 'pet.select',
    title: 'Choose a pet',
    description:
      'Make a pet the one Hermes shows everywhere (the Hermes CLI, the TUI, Hermes’s desktop app and Herald), by its name or folder name. A pet that is not installed is installed from the petdex gallery by its slug first.',
    tier: 'mutate',
    args: [{ name: 'name', type: 'string', description: 'The pet’s name, or its petdex slug', required: true }],
    phrases: ['use the {name} pet', 'switch the pet to {name}', 'pick the {name} pet', 'choose the {name} pet'],
    run: async ({ name }) => {
      const wanted = String(name)
      const installed = findInstalledPet(wanted)
      const slug = installed?.slug ?? (SLUG.test(wanted.trim()) ? wanted.trim().toLowerCase() : null)

      if (!slug) {
        return fail(`No installed pet is called "${wanted}". Installed: ${$petInfo.get().installed.map(pet => pet.displayName).join(', ') || 'none'}.`)
      }

      try {
        const info = await selectPet(slug)

        return ok(`Hermes's pet is now ${info.displayName ?? slug}`, { data: { slug: info.slug, installed: info.installed.map(pet => pet.slug) } })
      } catch (error) {
        return fail(`Could not choose ${slug}: ${errorOf(error)}`)
      }
    }
  },
  {
    id: 'pet.status',
    title: 'What the pet is doing',
    description: 'Which pet Hermes shows, whether it is on screen (or put away, and why), what it is doing and the background work it counts.',
    tier: 'read',
    args: [],
    phrases: ['what is the pet doing', 'pet status'],
    run: () => {
      const info = $petInfo.get()
      const prefs = $petPrefs.get()
      const snapshot = $petSnapshot.get()
      const data = { slug: info.slug, enabled: info.enabled, hidden: prefs.hidden, scale: info.scale, activity: snapshot.activity, step: snapshot.step, background: snapshot.badge, installed: info.installed.map(pet => pet.slug) }

      if (!info.installed.length) {
        return ok('No pet is installed yet: Settings, Pet has the petdex gallery', { data })
      }

      if (!info.enabled) {
        return ok(`${petName()} is switched off in Hermes`, { data })
      }

      if (prefs.hidden) {
        return ok(`${petName()} is put away; the shortcut, the menu bar or "show the pet" brings it back`, { data })
      }

      if (snapshot.hiddenBy) {
        return ok(`${petName()} is ${AWAY[snapshot.hiddenBy]}`, { data })
      }

      const work = snapshot.badge ? `, with ${snapshot.badge} running in the background` : ''

      return ok(`${petName()} is ${DOING[snapshot.activity]}${snapshot.step ? `: ${snapshot.step}` : ''}${work}`, { data })
    }
  },
  {
    id: 'pet.enable',
    title: 'Turn the pet on or off',
    description: 'Switch Hermes’s pet on or off for every Hermes surface (its display.pet setting).',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to switch the pet on, false to switch it off', required: true }],
    phrases: [
      { phrase: 'turn off the pet', args: { enabled: false } },
      { phrase: 'turn the pet off', args: { enabled: false } },
      { phrase: 'turn on the pet', args: { enabled: true } },
      { phrase: 'turn the pet on', args: { enabled: true } }
    ],
    run: async ({ enabled }) => {
      const on = enabled === true

      if (on) {
        const missing = nothingInstalled()

        if (missing) {
          return missing
        }
      }

      try {
        await setPetEnabled(on)

        if (on) {
          await showPet()
        }
      } catch (error) {
        return fail(errorOf(error))
      }

      return ok(on ? `Switched ${petName()} on` : 'Switched the pet off')
    }
  },
  {
    id: 'pet.size',
    title: 'Resize the pet',
    description: `Set the pet’s size for every Hermes surface (display.pet.scale, from ${PET_MIN_SCALE} to ${PET_MAX_SCALE}; 1 is the sprite’s own 192 by 208 pixels, and Hermes starts at 0.33).`,
    tier: 'mutate',
    args: [
      { name: 'scale', type: 'number', description: `The size, from ${PET_MIN_SCALE} to ${PET_MAX_SCALE}` },
      { name: 'step', type: 'number', description: 'Instead of a size: 1 makes it a step bigger, -1 a step smaller' }
    ],
    phrases: ['set the pet size to {scale}', 'make the pet size {scale}', { phrase: 'make the pet bigger', args: { step: 1 } }, { phrase: 'make the pet smaller', args: { step: -1 } }],
    run: async ({ scale, step }) => {
      if (scale === undefined && step === undefined) {
        return fail('pet.size needs a scale or a step')
      }

      try {
        const info = await setPetScale(scale !== undefined ? Number(scale) : Math.round($petInfo.get().scale * SIZE_STEP ** Math.sign(Number(step)) * 100) / 100)

        return ok(`The pet's size is now ${info.scale}`)
      } catch (error) {
        return fail(errorOf(error))
      }
    }
  },
  {
    id: 'pet.list',
    title: 'List the pets',
    description: 'The pets installed for Hermes (name and folder name), and which one it shows.',
    tier: 'read',
    args: [],
    phrases: ['list the pets', 'which pets are installed'],
    run: () => {
      const info = $petInfo.get()

      if (!info.installed.length) {
        return ok('No pet is installed yet: Settings, Pet has the petdex gallery', { items: [] })
      }

      return ok(`Installed pets: ${info.installed.map(pet => pet.displayName).join(', ')}`, { items: info.installed.map(pet => ({ slug: pet.slug, displayName: pet.displayName, active: pet.slug === info.slug })) })
    }
  },
  {
    id: 'pet.chat',
    title: 'Talk to the pet',
    description: 'Open the pet’s chat bubble to ask Hermes something from the desktop.',
    tier: 'act',
    args: [],
    phrases: ['talk to the pet', 'open the pet chat'],
    run: () => {
      const info = $petInfo.get()

      if (!petShown(info) || $petPrefs.get().hidden || $petSnapshot.get().hiddenBy) {
        return fail('The pet is not on screen now: "show the pet" brings it back')
      }

      if (isPanels) {
        void window.heraldOS.shell.relay('pet', { type: 'pet-chat' }).catch(() => undefined)
      } else {
        $petChatRequest.set($petChatRequest.get() + 1)
      }

      return ok('Opened the pet’s chat')
    }
  }
]
