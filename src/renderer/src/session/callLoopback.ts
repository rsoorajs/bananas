import type { CallCameraMid } from '../callTypes'

export type LoopbackTrackSource = {
  peerId: string
  stream: MediaStream
}

const LOOPBACK_RTC_CONFIG: RTCConfiguration = { iceServers: [] }

export class CallLoopback {
  private pc: RTCPeerConnection | null = null
  private trackPeerIds = new Map<string, string>()
  private pendingIce: RTCIceCandidateInit[] = []
  private makingOffer = false
  private needsOffer = false

  async start(): Promise<void> {
    if (this.pc) return
    const pc = new RTCPeerConnection(LOOPBACK_RTC_CONFIG)
    this.pc = pc
    pc.onicecandidate = (event): void => {
      if (event.candidate) {
        window.KiwiApi.sendCallLoopIce?.(event.candidate.toJSON())
      }
    }
    pc.onnegotiationneeded = (): void => {
      void this.createAndSendOffer()
    }
  }

  async setVideoSources(sources: LoopbackTrackSource[]): Promise<void> {
    const pc = this.pc
    if (!pc) return
    const wanted = new Set<string>()
    let changed = false
    for (const source of sources) {
      for (const track of source.stream.getVideoTracks()) {
        wanted.add(track.id)
        this.trackPeerIds.set(track.id, source.peerId)
        const already = pc.getSenders().some((sender) => sender.track?.id === track.id)
        if (!already) {
          pc.addTrack(track, source.stream)
          changed = true
        }
      }
    }
    for (const sender of pc.getSenders()) {
      const track = sender.track
      if (!track || track.kind !== 'video') continue
      if (wanted.has(track.id)) continue
      pc.removeTrack(sender)
      this.trackPeerIds.delete(track.id)
      changed = true
    }
    this.publishMids()
    if (changed) void this.createAndSendOffer()
  }

  async handleAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.pc
    if (!pc) return
    await pc.setRemoteDescription(sdp)
    await this.flushIce()
    if (this.needsOffer) {
      this.needsOffer = false
      void this.createAndSendOffer()
    }
  }

  async addIce(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc?.remoteDescription) {
      this.pendingIce.push(candidate)
      return
    }
    await this.pc.addIceCandidate(candidate)
  }

  close(): void {
    this.pc?.close()
    this.pc = null
    this.trackPeerIds.clear()
    this.pendingIce = []
    this.makingOffer = false
    this.needsOffer = false
  }

  private async createAndSendOffer(): Promise<void> {
    const pc = this.pc
    if (!pc) return
    if (this.makingOffer || pc.signalingState !== 'stable') {
      this.needsOffer = true
      return
    }
    try {
      this.makingOffer = true
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.publishMids()
      window.KiwiApi.sendCallLoopOffer?.(pc.localDescription ?? offer)
    } catch (error) {
      console.error(error)
    } finally {
      this.makingOffer = false
      if (this.needsOffer && pc.signalingState === 'stable') {
        this.needsOffer = false
        void this.createAndSendOffer()
      }
    }
  }

  private publishMids(): void {
    const pc = this.pc
    if (!pc) return
    const mids: CallCameraMid[] = []
    for (const transceiver of pc.getTransceivers()) {
      const track = transceiver.sender.track
      if (!track || track.kind !== 'video' || !transceiver.mid) continue
      const peerId = this.trackPeerIds.get(track.id)
      if (!peerId) continue
      mids.push({ mid: transceiver.mid, peerId })
    }
    window.KiwiApi.sendCallCameraMids?.(mids)
  }

  private async flushIce(): Promise<void> {
    const pc = this.pc
    if (!pc) return
    const queued = this.pendingIce
    this.pendingIce = []
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate)
    }
  }
}
