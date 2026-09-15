import { compact, decompact } from 'sdp-compact'

export const enum ConnectionType {
  HOST = 'host',
  PARTICIPANT = 'participant',
}

export type RTCSessionDescriptionOptions = RTCSessionDescriptionInit

const CONNECTION_PROTOCOLS = new Set(['kiwi:', 'bananas:'])
const COMPACT_OPTIONS = { compress: 'base64' as const }
const PAYLOAD_VERSION = '2'

const SHORT_TYPE: Record<ConnectionType, string> = {
  [ConnectionType.HOST]: 'h',
  [ConnectionType.PARTICIPANT]: 'p',
}

const TYPE_FROM_SHORT: Record<string, ConnectionType> = {
  h: ConnectionType.HOST,
  p: ConnectionType.PARTICIPANT,
  host: ConnectionType.HOST,
  participant: ConnectionType.PARTICIPANT,
}

const connectionRoleFromUrl = (url: URL): string => {
  if (url.hostname) return url.hostname
  return url.pathname.slice(2).split('/')[0] ?? ''
}

const toBase64Url = (b64: string): string =>
  b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

const fromBase64Url = (value: string): string => {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  return b64 + pad
}

const isTcpCandidateLine = (line: string): boolean => {
  if (!line.startsWith('a=candidate:')) return false
  const parts = line.slice('a=candidate:'.length).split(/\s+/)
  return parts[2]?.toLowerCase() === 'tcp'
}

const hasUdpCandidate = (lines: string[]): boolean =>
  lines.some((line) => {
    if (!line.startsWith('a=candidate:')) return false
    const parts = line.slice('a=candidate:'.length).split(/\s+/)
    return parts[2]?.toLowerCase() === 'udp'
  })

export const mediaTrackConstraints = (
  deviceId: string | undefined | null,
): boolean | MediaTrackConstraints => {
  if (!deviceId) return true
  return { deviceId: { ideal: deviceId } }
}

/** Native RTCSessionDescription stores type/sdp as prototype getters, so object spread drops them. */
export const cloneSessionDescription = (
  desc: RTCSessionDescriptionInit,
): RTCSessionDescriptionInit => ({
  type: desc.type,
  sdp: desc.sdp,
})

export const dropTcpIceCandidates = (
  desc: RTCSessionDescriptionInit,
): RTCSessionDescriptionInit => {
  const cloned = cloneSessionDescription(desc)
  if (!cloned.sdp) return cloned
  const newline = cloned.sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = cloned.sdp.split(/\r?\n/)
  if (!hasUdpCandidate(lines)) return cloned
  return {
    type: cloned.type,
    sdp: lines.filter((line) => !isTcpCandidateLine(line)).join(newline),
  }
}

export const externalLinkClickHandler = (root: HTMLButtonElement, url: string): void => {
  root.classList.add('btn-disabled')
  root.setAttribute('aria-busy', 'true')
  setTimeout(() => {
    root.classList.remove('btn-disabled')
    root.removeAttribute('aria-busy')
  }, 3000)
  window.open(url)
}

export const getUUIDv4 = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export const compressJson = async (data: unknown): Promise<string> => {
  const stream = new Blob([JSON.stringify(data)], {
    type: 'application/json',
  }).stream()
  const compressedStream = stream.pipeThrough(new CompressionStream('gzip'))
  const compressedResponse = new Response(compressedStream)
  const blob = await compressedResponse.blob()
  const buffer = await blob.arrayBuffer()
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
}

export const decompressJson = async (data: string): Promise<unknown> => {
  const buffer = new Uint8Array(
    atob(data)
      .split('')
      .map((c) => c.charCodeAt(0)),
  )
  const stream = new Blob([buffer], {
    type: 'application/json',
  }).stream()
  const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'))
  const res = new Response(decompressedStream)
  const blob = await res.blob()
  return JSON.parse(await blob.text())
}

const sdpTypeForConnection = (ct: ConnectionType): RTCSdpType =>
  ct === ConnectionType.HOST ? 'offer' : 'answer'

const encodeCompactPayload = (desc: RTCSessionDescriptionInit, type: RTCSdpType): string => {
  const pruned = dropTcpIceCandidates(desc)
  const compacted = compact({ type, sdp: pruned.sdp }, COMPACT_OPTIONS)
  return PAYLOAD_VERSION + compacted[0] + toBase64Url(compacted.slice(1))
}

const decodeCompactPayload = (payload: string, type: RTCSdpType): RTCSessionDescriptionInit => {
  if (!payload.startsWith(PAYLOAD_VERSION) || payload.length < 3) {
    throw new Error('unsupported connection payload')
  }
  const letter = type === 'offer' ? 'O' : 'A'
  const compacted = letter + fromBase64Url(payload.slice(2))
  return decompact(compacted, COMPACT_OPTIONS)
}

const parseConnectionUrl = (
  str: string,
): {
  type: ConnectionType
  username: string
  payload: string | null
  token: string | null
} => {
  const url = new URL(str)
  if (!CONNECTION_PROTOCOLS.has(url.protocol)) {
    throw new Error('unsupported protocol')
  }
  const type = TYPE_FROM_SHORT[connectionRoleFromUrl(url)]
  if (!type) throw new Error('unsupported connection type')

  const token = url.searchParams.get('token')
  if (token) {
    const username = url.searchParams.get('username')
    if (!username) throw new Error('missing username')
    return { type, username, payload: null, token }
  }

  const path = url.pathname.replace(/^\//, '')
  const slash = path.indexOf('/')
  if (slash <= 0 || slash === path.length - 1) {
    throw new Error('invalid compact connection string')
  }
  return {
    type,
    username: decodeURIComponent(path.slice(0, slash)),
    payload: path.slice(slash + 1),
    token: null,
  }
}

export const mayBeConnectionString = (ct: ConnectionType, str: string): boolean => {
  try {
    const parsed = parseConnectionUrl(str)
    if (parsed.type !== ct) return false
    if (parsed.token) {
      if (!parsed.username) return false
      decompressJson(parsed.token)
      return true
    }
    decodeCompactPayload(parsed.payload ?? '', sdpTypeForConnection(parsed.type))
    return parsed.username.length > 0
  } catch {
    return false
  }
}

export const getConnectionString = async (
  ct: ConnectionType,
  offer: RTCSessionDescriptionInit,
  data: {
    username: string
  },
): Promise<string> => {
  const { username } = data
  const payload = encodeCompactPayload(offer, sdpTypeForConnection(ct))
  return `kiwi://${SHORT_TYPE[ct]}/${encodeURIComponent(username)}/${payload}`
}

export const getDataFromKiwiUrl = async (
  url: string,
): Promise<{
  type: ConnectionType
  data: { username: string }
  rtcSessionDescription: RTCSessionDescriptionInit
}> => {
  const parsed = parseConnectionUrl(url)
  const expectedType = sdpTypeForConnection(parsed.type)
  const rtcSessionDescription = parsed.token
    ? ((await decompressJson(parsed.token)) as RTCSessionDescriptionInit)
    : decodeCompactPayload(parsed.payload ?? '', expectedType)
  if (!parsed.token) rtcSessionDescription.type = expectedType
  return {
    type: parsed.type,
    data: {
      username: parsed.username,
    },
    rtcSessionDescription,
  }
}

export const makeVideoDraggable = (video: HTMLVideoElement): void => {
  let startX: number
  let startY: number
  let initialX: number
  let initialY: number
  let isDragging = false
  video.addEventListener('mousedown', (e) => {
    isDragging = true
    startX = e.clientX
    startY = e.clientY
    const transform = getComputedStyle(video).transform

    if (transform !== 'none') {
      const values = transform.split('(')[1].split(')')[0].split(',')
      initialX = parseFloat(values[4])
      initialY = parseFloat(values[5])
    } else {
      initialX = 0
      initialY = 0
    }
    video.style.cursor = 'grabbing'
  })
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return

    const deltaX = e.clientX - startX
    const deltaY = e.clientY - startY

    const moveX = initialX + deltaX
    const moveY = initialY + deltaY

    video.style.transform = `translate(${moveX}px, ${moveY}px)`
  })

  document.addEventListener('mouseup', () => {
    if (!isDragging) return
    isDragging = false
    video.style.cursor = 'default'
  })
}

export const debounce = <T extends (...args: unknown[]) => void>(
  func: T,
  wait: number,
): ((...args: Parameters<T>) => void) => {
  let timeout: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>): void => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      func(...args)
    }, wait)
  }
}

export const throttle = <T extends (...args: unknown[]) => void>(
  func: T,
  wait: number,
): ((...args: Parameters<T>) => void) => {
  let lastCalled = 0
  return (...args: Parameters<T>): void => {
    const now = Date.now()
    if (now - lastCalled < wait) return
    lastCalled = now
    func(...args)
  }
}
