import { useStore } from '@nanostores/react'
import { useMemo } from 'react'
import { useDocumentVisible, useReducedMotion } from '../pet/hooks.ts'
import { $petInfo } from '../pet/info.ts'
import type { RoomFact } from './model/types.ts'
import { $roomPrefs } from './prefs.ts'
import { useRoomAssignment } from './assignment.ts'
import { RoomScene } from './scene/RoomScene.tsx'
import { screensaverView } from './screensaver.ts'
import { $room, useRoomFeed } from './store.ts'

const NO_FACTS: Readonly<Record<string, readonly RoomFact[]>> = {}
const nothing = () => undefined

/** The Room as the screensaver: the scene alone, with no names, document names or facts, and nothing in it answers or opens. */
export function RoomScreensaver() {
  const live = useDocumentVisible()
  useRoomFeed(live)
  const state = useStore($room)
  const prefs = useStore($roomPrefs)
  const info = useStore($petInfo)
  const reduced = useReducedMotion()
  const agents = useMemo(() => Object.values(state.agents), [state.agents])
  const desks = useMemo(() => Object.values(state.desks ?? {}), [state.desks])
  const assignment = useRoomAssignment(agents)

  return (
    <>
      <div className="absolute inset-0 bg-black/30" />
      <RoomScene
        agents={agents}
        handoffs={state.handoffs}
        assignment={assignment}
        installed={info.installed}
        motion={reduced ? 'still' : prefs.motion}
        active={live}
        settled={state.updatedAt > 0}
        facts={NO_FACTS}
        desks={desks}
        lane={prefs.elsewhere}
        chrome={false}
        {...screensaverView(prefs)}
        onOpen={nothing}
        onAnswer={nothing}
        className="absolute inset-0"
      />
    </>
  )
}
