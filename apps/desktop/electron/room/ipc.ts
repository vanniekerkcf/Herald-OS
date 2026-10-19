import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import type { ActivityHub } from './activity.ts'
import type { RoomLog } from './log.ts'

export interface RoomIpcOptions {
  activity: ActivityHub
  log: RoomLog
}

/** The Room's side of main (shared/room.ts RoomBridge): live activity for the windows that watch it, and the activity log. */
export function registerRoomIpc({ activity, log }: RoomIpcOptions): void {
  ipcMain.on(IPC.roomActivityWatch, (event, on: unknown) => activity.watch(event.sender, on === true))
  ipcMain.on(IPC.roomLogAppend, (_event, entries: unknown) => void log.append(entries))
  ipcMain.handle(IPC.roomLogDays, () => log.days())
  ipcMain.handle(IPC.roomLogRead, (_event, day: unknown) => log.read(day))
  ipcMain.handle(IPC.roomLogDelete, () => log.remove())
}
