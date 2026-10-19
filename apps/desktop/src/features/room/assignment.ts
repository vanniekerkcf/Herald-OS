import { useStore } from '@nanostores/react'
import { useMemo, useRef } from 'react'
import { $petInfo } from '../pet/info.ts'
import { assignPets, type PetAssignment, ROOM_SHEET_CAP } from '../petdex/assign.ts'
import type { RoomAgent } from './model/types.ts'
import { $roomPrefs } from './prefs.ts'

/** Each agent's pet and tint, kept steady while others come and go. */
export function useRoomAssignment(agents: readonly RoomAgent[]): Record<string, PetAssignment> {
  const prefs = useStore($roomPrefs)
  const info = useStore($petInfo)
  const previous = useRef<Record<string, PetAssignment>>({})

  return useMemo(() => {
    const next = assignPets(agents, info.installed, prefs, previous.current, ROOM_SHEET_CAP)
    previous.current = next

    return next
  }, [agents, info.installed, prefs])
}
