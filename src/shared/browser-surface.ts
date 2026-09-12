export type BrowserPresentation = 'pane' | 'expanded' | 'background' | 'detached'

export interface BrowserSurfaceBounds { x: number; y: number; width: number; height: number }

export interface BrowserSurfaceRequest {
  projectId: string
  surfaceId: string
  initialUrl: string
  bounds: BrowserSurfaceBounds
  /** CSS-pixel viewport selected in the responsive toolbar. Bounds are the scaled native host
   * rectangle; Chromium emulation keeps innerWidth/innerHeight truthful to this logical size. */
  viewport?: { width: number; height: number }
  visible: boolean
}

export interface BrowserSurfaceState {
  projectId: string
  webContentsId: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  presentation: BrowserPresentation
  failure?: string
}

export type BrowserSurfaceCommand =
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'devtools' }
