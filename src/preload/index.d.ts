import type { ElectronAPI } from '@electron-toolkit/preload'

type IceServer = {
  urls: string
  username?: string
  credential?: string
}

type ScreenShareSource = {
  id: string
  name: string
  thumbnail: string
  appIcon: string | null
  isScreen: boolean
}

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

type KiwiApi = {
  toggleRemoteCursors: (state: boolean) => Promise<void>
  remoteCursorPing: (cursorId: string) => Promise<void>
  updateRemoteCursor: (state: {
    id: string
    name: string
    color: string
    x: number
    y: number
  }) => Promise<void>
  updateSettings: (settings: {
    username: string
    language: string
    color: string
    isMicrophoneEnabledOnConnect: boolean
    hardwareVideoAcceleration: boolean
    debugLogsEnabled: boolean
    cameraDeviceId: string
    microphoneDeviceId: string
    iceServers: IceServer[]
  }) => Promise<void>
  getSettings: () => Promise<{
    username: string
    color: string
    language: string
    isMicrophoneEnabledOnConnect: boolean
    hardwareVideoAcceleration: boolean
    debugLogsEnabled: boolean
    cameraDeviceId: string
    microphoneDeviceId: string
    iceServers: IceServer[]
  }>
  getAppVersion: () => Promise<string>
  onSelectScreenShareSource: (
    handler: (sources: ScreenShareSource[]) => Promise<string | null>,
  ) => void
  toggleCallOverlay: (open: boolean) => Promise<void>
  onCallOverlayClosed: (handler: () => void) => void
  onCallOverlayReady: (handler: () => void) => void
  onCallChatSend: (handler: (text: string) => void) => void
  onCallToggleCamera: (handler: () => void) => void
  onCallLoopAnswer: (handler: (sdp: RTCSessionDescriptionInit) => void) => void
  onCallLoopIce: (handler: (candidate: RTCIceCandidateInit) => void) => void
  sendCallLoopOffer: (sdp: RTCSessionDescriptionInit) => void
  sendCallLoopIce: (candidate: RTCIceCandidateInit) => void
  sendCallCameraMids: (mids: CallCameraMid[]) => void
  sendCallChat: (messages: CallChatMessage[]) => void
  sendCallPeers: (peers: CallPeerInfo[]) => void
}

type CallApi = {
  ready: () => void
  sendChat: (text: string) => void
  sendAnswer: (sdp: RTCSessionDescriptionInit) => void
  sendIce: (candidate: RTCIceCandidateInit) => void
  toggleCamera: () => void
  onChat: (handler: (messages: CallChatMessage[]) => void) => void
  onPeers: (handler: (peers: CallPeerInfo[]) => void) => void
  onOffer: (handler: (sdp: RTCSessionDescriptionInit) => void) => void
  onIce: (handler: (candidate: RTCIceCandidateInit) => void) => void
  onCameraMids: (handler: (mids: CallCameraMid[]) => void) => void
  onRequestSync: (handler: () => void) => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    KiwiApi: KiwiApi
    CallApi: CallApi
  }
}

export {}
