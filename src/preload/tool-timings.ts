import { ipcRenderer } from 'electron'
import type { ToolTimingsBridge } from '../shared/tool-timings'

export const toolTimingsBridge: ToolTimingsBridge = {
  report: query => ipcRenderer.invoke('tool-timings:report', query ?? {})
}
