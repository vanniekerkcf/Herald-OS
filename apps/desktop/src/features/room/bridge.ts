import type { RoomBridge } from '../../../shared/room.ts'

/** Main's side of the Room (live activity from Hermes outside Herald, the activity log); null outside Electron. */
export const roomBridge = (): RoomBridge | null => (window.heraldOS as { room?: RoomBridge } | undefined)?.room ?? null
