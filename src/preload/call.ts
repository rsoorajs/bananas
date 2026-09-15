/// <reference types="vite/client" />
import { ipcRenderer } from 'electron'
import { contextBridge } from 'electron'

type IceServer = {
  urls: string
  username?: string
  credential?: string
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

const KiwiApi = {
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
}

const CallApi = {
  ready: (): void => {
    ipcRenderer.send('call-overlay-ready')
  },
  sendChat: (text: string): void => {
    ipcRenderer.send('call-chat-send', text)
  },
  sendAnswer: (sdp: SdpPayload): void => {
    ipcRenderer.send('call-loop-answer', sdp)
  },
  sendIce: (candidate: IcePayload): void => {
    ipcRenderer.send('call-loop-ice', candidate)
  },
  toggleCamera: (): void => {
    ipcRenderer.send('call-toggle-camera')
  },
  onChat: (handler: (messages: CallChatMessage[]) => void): void => {
    ipcRenderer.removeAllListeners('call-chat')
    ipcRenderer.on('call-chat', (_, messages: CallChatMessage[]) => handler(messages))
  },
  onPeers: (handler: (peers: CallPeerInfo[]) => void): void => {
    ipcRenderer.removeAllListeners('call-peers')
    ipcRenderer.on('call-peers', (_, peers: CallPeerInfo[]) => handler(peers))
  },
  onOffer: (handler: (sdp: SdpPayload) => void): void => {
    ipcRenderer.removeAllListeners('call-loop-offer')
    ipcRenderer.on('call-loop-offer', (_, sdp: SdpPayload) => handler(sdp))
  },
  onIce: (handler: (candidate: IcePayload) => void): void => {
    ipcRenderer.removeAllListeners('call-loop-ice')
    ipcRenderer.on('call-loop-ice', (_, candidate: IcePayload) => handler(candidate))
  },
  onCameraMids: (handler: (mids: CallCameraMid[]) => void): void => {
    ipcRenderer.removeAllListeners('call-camera-mids')
    ipcRenderer.on('call-camera-mids', (_, mids: CallCameraMid[]) => handler(mids))
  },
  onRequestSync: (handler: () => void): void => {
    ipcRenderer.removeAllListeners('call-request-sync')
    ipcRenderer.on('call-request-sync', () => handler())
  },
}

try {
  contextBridge.exposeInMainWorld('KiwiApi', KiwiApi)
  contextBridge.exposeInMainWorld('CallApi', CallApi)
} catch (error) {
  console.error(error)
}
