import { beforeEach, describe, expect, it, vi } from 'vitest'

class MockDataChannel {
  label: string
  readyState = 'open'
  onmessage: ((e: MessageEvent) => void) | null = null
  send = vi.fn()
  constructor(label: string) {
    this.label = label
  }
}

class MockRTCPeerConnection {
  localDescription: RTCSessionDescriptionInit | null = null
  iceGatheringState = 'complete'
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  ondatachannel: ((e: RTCDataChannelEvent) => void) | null = null
  ontrack: ((e: RTCTrackEvent) => void) | null = null
  onicecandidate: ((e: RTCPeerConnectionIceEvent) => void) | null = null
  oniceconnectionstatechange: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  onnegotiationneeded: (() => void) | null = null
  private senders: RTCRtpSender[] = []

  createDataChannel = vi.fn((label: string) => new MockDataChannel(label))
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'v=0' }))
  createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: 'v=0' }))
  setLocalDescription = vi.fn(async (desc?: RTCSessionDescriptionInit) => {
    if (desc) this.localDescription = desc
  })
  setRemoteDescription = vi.fn(async () => undefined)
  addTrack = vi.fn((track: MediaStreamTrack, _stream: MediaStream) => {
    const sender = {
      track,
      replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
        sender.track = next
      }),
    }
    this.senders.push(sender as unknown as RTCRtpSender)
    return sender as unknown as RTCRtpSender
  })
  getSenders = vi.fn(() => this.senders)
  getTransceivers = vi.fn(() => [])
  removeTrack = vi.fn()
  addIceCandidate = vi.fn(async () => undefined)
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  close = vi.fn()
}

class MockRTCSessionDescription {
  type: RTCSdpType
  sdp: string
  constructor(init: RTCSessionDescriptionInit) {
    this.type = init.type ?? 'offer'
    this.sdp = init.sdp ?? ''
  }
}

const getSettings = vi.fn(async () => ({
  username: 'Kiwi',
  color: '#ffffff',
  language: 'en',
  isMicrophoneEnabledOnConnect: true,
  hardwareVideoAcceleration: true,
  debugLogsEnabled: false,
  cameraDeviceId: '',
  microphoneDeviceId: '',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}))

beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection)
  vi.stubGlobal('RTCSessionDescription', MockRTCSessionDescription)
  vi.stubGlobal('window', {
    KiwiApi: {
      getSettings,
      updateRemoteCursor: vi.fn(),
      remoteCursorPing: vi.fn(),
      toggleRemoteCursors: vi.fn(),
      toggleCallOverlay: vi.fn(),
      onCallOverlayClosed: vi.fn(),
      onCallOverlayReady: vi.fn(),
      onCallChatSend: vi.fn(),
      onCallToggleCamera: vi.fn(),
      onCallLoopAnswer: vi.fn(),
      onCallLoopIce: vi.fn(),
      sendCallLoopOffer: vi.fn(),
      sendCallLoopIce: vi.fn(),
      sendCallCameraMids: vi.fn(),
      sendCallChat: vi.fn(),
      sendCallPeers: vi.fn(),
    },
  })
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: vi.fn(async () => ({
        getVideoTracks: () => [{ enabled: true, stop: vi.fn(), addEventListener: vi.fn() }],
        getTracks: () => [{ enabled: true, stop: vi.fn(), addEventListener: vi.fn() }],
      })),
      getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [
          { enabled: true, stop: vi.fn(), id: 'audio', addEventListener: vi.fn() },
        ],
        getVideoTracks: () => [],
        getTracks: () => [{ enabled: true, stop: vi.fn(), id: 'audio', addEventListener: vi.fn() }],
      })),
    },
  })
  vi.stubGlobal('document', {
    createElement: vi.fn(() => ({
      controls: false,
      autoplay: false,
      srcObject: null,
    })),
  })
})

describe('WebRTCSession', () => {
  it('CreateHostUrl produces a valid kiwi host URL after Setup', async () => {
    const { WebRTCSession } = await import('./webrtc.svelte')
    const { mayBeConnectionString, ConnectionType } = await import('./Utils')
    const session = new WebRTCSession()
    const result = await session.Setup()
    expect(result).toBe('ok')
    const url = await session.CreateHostUrl({ username: 'Kiwi' })
    expect(url).toBeTruthy()
    expect(mayBeConnectionString(ConnectionType.HOST, url ?? '')).toBe(true)
    expect(url?.startsWith('kiwi://h/')).toBe(true)
  })

  it('Disconnect resets the peer connection', async () => {
    const { WebRTCSession } = await import('./webrtc.svelte')
    const session = new WebRTCSession()
    await session.Setup()
    await session.Disconnect()
    expect(session.IsConnected()).toBe(false)
  })
})
