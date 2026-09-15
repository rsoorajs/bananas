import { ipcRenderer } from 'electron'
import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

let HANDLE_URL_CLICKS = true

const onDocumentReady = (callback: () => void): void => {
  if (document.readyState !== 'complete') {
    document.addEventListener('DOMContentLoaded', callback)
  } else {
    callback()
  }
}

ipcRenderer.on('openKiwiURL', (_, url) => {
  if (!HANDLE_URL_CLICKS) return
  onDocumentReady(() => {
    window.postMessage({ type: 'openKiwiURL', url }, '*')
  })
})

type IceServer = {
  urls: string
  username?: string
  credential?: string
}

export type ScreenShareSource = {
  id: string
  name: string
  thumbnail: string
  appIcon: string | null
  isScreen: boolean
}

type SelectScreenShareSourceHandler = (sources: ScreenShareSource[]) => Promise<string | null>

let selectScreenShareSourceHandler: SelectScreenShareSourceHandler | null = null

type CallChatMessage = {
  id: string
  from: string
  name: string
  text: string
  at: number
}

type CallPeerInfo = {
  id: string
  name: string
  color: string
  cameraEnabled: boolean
  isLocal: boolean
}

type CallCameraMid = {
  mid: string
  peerId: string
}

type SdpPayload = {
  type?: 'offer' | 'answer' | 'pranswer' | 'rollback'
  sdp?: string
}

type IcePayload = {
  candidate?: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
}

const onIpc = (channel: string, listener: (...args: unknown[]) => void): void => {
  ipcRenderer.removeAllListeners(channel)
  ipcRenderer.on(channel, (...eventArgs) => listener(...eventArgs.slice(1)))
}

ipcRenderer.on(
  'selectScreenShareSource',
  async (_, payload: { requestId: number; sources: ScreenShareSource[] }) => {
    const sourceId = selectScreenShareSourceHandler
      ? await selectScreenShareSourceHandler(payload.sources)
      : (payload.sources.find((source) => source.isScreen)?.id ?? payload.sources[0]?.id ?? null)
    ipcRenderer.send('screenShareSourceSelected', { requestId: payload.requestId, sourceId })
  },
)

const KiwiApi = {
  getAppVersion: async (): Promise<string> => {
    return await ipcRenderer.invoke('getAppVersion')
  },
  handleUrlClicks: (state: boolean | undefined): boolean => {
    if (state) HANDLE_URL_CLICKS = state
    return HANDLE_URL_CLICKS
  },
  getSettings: async (): Promise<{
    username: string
    color: string
    language: string
    isMicrophoneEnabledOnConnect: boolean
    hardwareVideoAcceleration: boolean
    debugLogsEnabled: boolean
    cameraDeviceId: string
    microphoneDeviceId: string
    iceServers: IceServer[]
  }> => {
    return await ipcRenderer.invoke('getSettings')
  },
  updateSettings: async (settings: {
    username: string
    language: string
    color: string
    isMicrophoneEnabledOnConnect: boolean
    hardwareVideoAcceleration: boolean
    debugLogsEnabled: boolean
    cameraDeviceId: string
    microphoneDeviceId: string
    iceServers: IceServer[]
  }): Promise<void> => {
    ipcRenderer.invoke('updateSettings', settings)
  },
  toggleRemoteCursors: async (state: boolean): Promise<void> => {
    ipcRenderer.invoke('toggleRemoteCursors', state)
  },
  remoteCursorPing: async (cursorId: string): Promise<void> => {
    ipcRenderer.invoke('remoteCursorPing', cursorId)
  },
  updateRemoteCursor: async (state: {
    id: string
    name: string
    color: string
    x: number
    y: number
  }): Promise<void> => {
    ipcRenderer.invoke('updateRemoteCursor', state)
  },
  onSelectScreenShareSource: (handler: SelectScreenShareSourceHandler): void => {
    selectScreenShareSourceHandler = handler
  },
  toggleCallOverlay: async (open: boolean): Promise<void> => {
    await ipcRenderer.invoke('toggleCallOverlay', open)
  },
  onCallOverlayClosed: (handler: () => void): void => {
    onIpc('callOverlayClosed', () => handler())
  },
  onCallOverlayReady: (handler: () => void): void => {
    onIpc('call-overlay-ready', () => handler())
  },
  onCallChatSend: (handler: (text: string) => void): void => {
    onIpc('call-chat-send', (text) => handler(String(text)))
  },
  onCallToggleCamera: (handler: () => void): void => {
    onIpc('call-toggle-camera', () => handler())
  },
  onCallLoopAnswer: (handler: (sdp: SdpPayload) => void): void => {
    onIpc('call-loop-answer', (sdp) => handler(sdp as SdpPayload))
  },
  onCallLoopIce: (handler: (candidate: IcePayload) => void): void => {
    onIpc('call-loop-ice', (candidate) => handler(candidate as IcePayload))
  },
  sendCallLoopOffer: (sdp: SdpPayload): void => {
    ipcRenderer.send('call-loop-offer', sdp)
  },
  sendCallLoopIce: (candidate: IcePayload): void => {
    ipcRenderer.send('call-loop-ice', candidate)
  },
  sendCallCameraMids: (mids: CallCameraMid[]): void => {
    ipcRenderer.send('call-camera-mids', mids)
  },
  sendCallChat: (messages: CallChatMessage[]): void => {
    ipcRenderer.send('call-chat', messages)
  },
  sendCallPeers: (peers: CallPeerInfo[]): void => {
    ipcRenderer.send('call-peers', peers)
  },
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('KiwiApi', KiwiApi)
} catch (error) {
  console.error(error)
}
