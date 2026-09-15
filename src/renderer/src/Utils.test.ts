import { describe, expect, it } from 'vitest'
import {
  compressJson,
  decompressJson,
  dropTcpIceCandidates,
  getConnectionString,
  getDataFromKiwiUrl,
  mayBeConnectionString,
  mediaTrackConstraints,
  ConnectionType,
  debounce,
} from './Utils'

/** Chromium-like Unified Plan offer with UDP, TCP, and mDNS candidates. */
const REALISTIC_OFFER: RTCSessionDescriptionInit = {
  type: 'offer',
  sdp: [
    'v=0',
    'o=- 4109260023080860376 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1 2',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 103 104 9 0 8 106 105 13 110 112 113 126',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:4hdU',
    'a=ice-pwd:b9q3v1k0s2icepwdabcdefghijk',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    'a=rtcp-fb:111 transport-cc',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host',
    'a=candidate:2 1 udp 1686052607 203.0.113.10 54321 typ srflx raddr 192.168.1.20 rport 54321',
    'a=candidate:3 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active',
    'a=candidate:4 1 tcp 1488510463 192.168.1.20 9 typ host tcptype passive',
    'a=candidate:5 1 udp 2122194687 2600-abc.local 54322 typ host',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 127 123 125',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:4hdU',
    'a=ice-pwd:b9q3v1k0s2icepwdabcdefghijk',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    'a=setup:actpass',
    'a=mid:1',
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtpmap:96 VP8/90000',
    'a=rtcp-fb:96 goog-remb',
    'a=rtcp-fb:96 transport-cc',
    'a=rtcp-fb:96 ccm fir',
    'a=rtcp-fb:96 nack',
    'a=rtcp-fb:96 nack pli',
    'a=candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host',
    'a=candidate:3 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:4hdU',
    'a=ice-pwd:b9q3v1k0s2icepwdabcdefghijk',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    'a=setup:actpass',
    'a=mid:2',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    'a=candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host',
    'a=candidate:3 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active',
    '',
  ].join('\r\n'),
}

const MINIMAL_OFFER: RTCSessionDescriptionInit = {
  type: 'offer',
  sdp: [
    'v=0',
    'o=- 1 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    '',
  ].join('\r\n'),
}

describe('compressJson / decompressJson', () => {
  it('round-trips JSON payloads', async () => {
    const payload = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1' }
    const compressed = await compressJson(payload)
    expect(compressed.length).toBeGreaterThan(0)
    await expect(decompressJson(compressed)).resolves.toEqual(payload)
  })
})

describe('dropTcpIceCandidates', () => {
  it('removes TCP candidates when UDP candidates exist', () => {
    const pruned = dropTcpIceCandidates(REALISTIC_OFFER)
    expect(pruned.sdp).not.toMatch(/a=candidate:\S+\s+\d+\s+tcp\s/i)
    expect(pruned.sdp).toMatch(/a=candidate:\S+\s+\d+\s+udp\s/i)
    expect(pruned.type).toBe('offer')
  })

  it('keeps SDP type from native-like descriptions whose fields are not enumerable', () => {
    const nativeLike = {} as RTCSessionDescriptionInit
    Object.defineProperty(nativeLike, 'type', { get: () => 'offer', enumerable: false })
    Object.defineProperty(nativeLike, 'sdp', {
      get: () => REALISTIC_OFFER.sdp,
      enumerable: false,
    })
    expect({ ...nativeLike }).toEqual({})
    const pruned = dropTcpIceCandidates(nativeLike)
    expect(pruned.type).toBe('offer')
    expect(pruned.sdp).toMatch(/a=candidate:\S+\s+\d+\s+udp\s/i)
  })
})

describe('connection strings', () => {
  it('builds a compact kiwi:// host URL and parses it back', async () => {
    const url = await getConnectionString(ConnectionType.HOST, MINIMAL_OFFER, { username: 'Kiwi' })
    expect(url.startsWith('kiwi://h/Kiwi/2')).toBe(true)
    expect(mayBeConnectionString(ConnectionType.HOST, url)).toBe(true)
    expect(mayBeConnectionString(ConnectionType.PARTICIPANT, url)).toBe(false)

    const parsed = await getDataFromKiwiUrl(url)
    expect(parsed.type).toBe(ConnectionType.HOST)
    expect(parsed.data.username).toBe('Kiwi')
    expect(parsed.rtcSessionDescription.type).toBe('offer')
    expect(parsed.rtcSessionDescription.sdp).toContain('a=ice-ufrag:abcd')
  })

  it('builds a compact kiwi:// participant URL', async () => {
    const url = await getConnectionString(ConnectionType.PARTICIPANT, MINIMAL_OFFER, {
      username: 'Guest',
    })
    expect(url.startsWith('kiwi://p/Guest/2')).toBe(true)
    expect(mayBeConnectionString(ConnectionType.PARTICIPANT, url)).toBe(true)
  })

  it('encodes host URLs as offers even when the native description type is missing', async () => {
    const nativeLike = {} as RTCSessionDescriptionInit
    Object.defineProperty(nativeLike, 'type', { get: () => 'offer', enumerable: false })
    Object.defineProperty(nativeLike, 'sdp', {
      get: () => MINIMAL_OFFER.sdp,
      enumerable: false,
    })
    const url = await getConnectionString(ConnectionType.HOST, nativeLike, { username: 'Kiwi' })
    expect(url.startsWith('kiwi://h/Kiwi/2O')).toBe(true)
    const parsed = await getDataFromKiwiUrl(url)
    expect(parsed.rtcSessionDescription.type).toBe('offer')
  })

  it('treats kiwi://h compact payloads as offers even if the type letter is A', async () => {
    const url = await getConnectionString(ConnectionType.HOST, MINIMAL_OFFER, { username: 'Kiwi' })
    const broken = url.replace('/2O', '/2A')
    expect(broken.includes('/2A')).toBe(true)
    const parsed = await getDataFromKiwiUrl(broken)
    expect(parsed.type).toBe(ConnectionType.HOST)
    expect(parsed.rtcSessionDescription.type).toBe('offer')
    expect(parsed.rtcSessionDescription.sdp).toContain('a=setup:actpass')
  })

  it('round-trips a realistic offer well under Discord length', async () => {
    const legacyToken = encodeURIComponent(await compressJson(REALISTIC_OFFER))
    const legacyUrl = `kiwi://host?username=Kiwi&token=${legacyToken}`
    const compactUrl = await getConnectionString(ConnectionType.HOST, REALISTIC_OFFER, {
      username: 'Kiwi',
    })

    expect(compactUrl.length).toBeLessThan(2000)
    expect(compactUrl.length).toBeLessThan(legacyUrl.length)

    const parsed = await getDataFromKiwiUrl(compactUrl)
    expect(parsed.rtcSessionDescription.type).toBe('offer')
    expect(parsed.rtcSessionDescription.sdp).toContain('a=ice-ufrag:4hdU')
    expect(parsed.rtcSessionDescription.sdp).toContain('a=ice-pwd:b9q3v1k0s2icepwdabcdefghijk')
    expect(parsed.rtcSessionDescription.sdp).toMatch(/a=fingerprint:sha-256/i)
    expect(parsed.rtcSessionDescription.sdp).toMatch(/203\.0\.113\.10/)
    expect(parsed.rtcSessionDescription.sdp).not.toMatch(/a=candidate:\S+\s+\d+\s+tcp\s/i)
  })

  it('still accepts legacy kiwi:// gzip JSON URLs', async () => {
    const token = encodeURIComponent(await compressJson(MINIMAL_OFFER))
    const legacyUrl = `kiwi://host?username=Kiwi&token=${token}`
    expect(mayBeConnectionString(ConnectionType.HOST, legacyUrl)).toBe(true)
    const parsed = await getDataFromKiwiUrl(legacyUrl)
    expect(parsed.data.username).toBe('Kiwi')
    expect(parsed.rtcSessionDescription).toEqual(MINIMAL_OFFER)
  })

  it('still accepts legacy bananas:// gzip JSON URLs', async () => {
    const token = encodeURIComponent(await compressJson(MINIMAL_OFFER))
    const bananasUrl = `bananas://host?username=Kiwi&token=${token}`
    expect(mayBeConnectionString(ConnectionType.HOST, bananasUrl)).toBe(true)
    const parsed = await getDataFromKiwiUrl(bananasUrl)
    expect(parsed.data.username).toBe('Kiwi')
    expect(parsed.rtcSessionDescription).toEqual(MINIMAL_OFFER)
  })

  it('rejects missing token, missing username, and unknown protocols', () => {
    expect(
      mayBeConnectionString(ConnectionType.HOST, 'https://example.com/host?username=a&token=b'),
    ).toBe(false)
    expect(mayBeConnectionString(ConnectionType.HOST, 'kiwi://host?username=Kiwi')).toBe(false)
    expect(mayBeConnectionString(ConnectionType.HOST, 'kiwi://host?token=abc')).toBe(false)
    expect(mayBeConnectionString(ConnectionType.HOST, 'kiwi://h/Kiwi/')).toBe(false)
    expect(mayBeConnectionString(ConnectionType.HOST, 'kiwi://h/Kiwi/not-valid')).toBe(false)
    expect(mayBeConnectionString(ConnectionType.HOST, 'not a url')).toBe(false)
  })
})

describe('mediaTrackConstraints', () => {
  it('uses the system default when no device is selected', () => {
    expect(mediaTrackConstraints('')).toBe(true)
    expect(mediaTrackConstraints(undefined)).toBe(true)
  })

  it('prefers the selected device id', () => {
    expect(mediaTrackConstraints('cam-1')).toEqual({ deviceId: { ideal: 'cam-1' } })
  })
})

describe('debounce', () => {
  it('calls the function once after the wait', async () => {
    let calls = 0
    const fn = debounce(() => {
      calls += 1
    }, 20)
    fn()
    fn()
    fn()
    expect(calls).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(calls).toBe(1)
  })
})
