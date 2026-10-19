import { computed } from 'nanostores'
import { normalizeRoomPrefs, type RoomPrefsPatch } from '../../../shared/room.ts'
import { $prefs, updatePrefs } from '../../store/backend.ts'

/** Herald's own Room preferences (prefs.json `room`). */
export const $roomPrefs = computed($prefs, prefs => normalizeRoomPrefs(prefs.room))

/** Change only the fields `patch` names, the pets kind by kind: this window's copy of the rest may be stale. */
export function setRoomPrefs(patch: RoomPrefsPatch): Promise<void> {
  return updatePrefs({ room: patch })
}
