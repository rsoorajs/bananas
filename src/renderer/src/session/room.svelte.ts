import type { CallChatMessage, CallPeerInfo } from '../callTypes'
import type { RemoteCursorData, SettingsData } from '../types'
import type { RTCSessionDescriptionOptions } from '../Utils'
import {
  ConnectionType,
  dropTcpIceCandidates,
  getConnectionString,
  getUUIDv4,
  mediaTrackConstraints,
} from '../Utils'
import { getRTCPeerConnectionConfig } from '../Config'
import { appState } from '../appState.svelte'
import {
  CHAT_MAX_MESSAGES,
  MAX_PEERS,
  PENDING_INVITE_TTL_MS,
  VOTE_COOLDOWN_MS,
  VOTE_TIMEOUT_MS,
  ICE_DISCONNECT_GRACE_MS,
  truncateChatText,
} from './constants'
import type { ControlMessage, RosterPeer } from './controlProtocol'
import { PROTOCOL_VERSION } from './controlProtocol'
import { CallLoopback } from './callLoopback'
import { PeerLink } from './peerLink'
import {
  answersMatchOffer,
  canStartVote,
  castVote,
  nextCoordinator,
  pickRemoteCameraAndDisplay,
  resumeVote,
  routeMeshSignal,
  sessionEndedReasonAfterDeparture,
  startVote,
  uniquePeersById,
  voteOutcome,
  type SessionEndedReason,
  type VoteState,
} from './roomLogic'
import { playSessionEndedSound } from './sessionEndedSound'
import { debugLog, summarizePc, summarizeSdp } from '../debugLog.svelte'

const errorHandler = (e: unknown): void => {
  console.error(e)
  debugLog.error('room', 'unhandled error', e)
}

export type RoomPeer = RosterPeer

export class Room {
  connectionState = $state('disconnected')
  sessionEndedReason = $state<SessionEndedReason | null>(null)
  presenterGone = $state(false)
  isLive = $state(false)
  localPeerId = $state('')
  coordinatorId = $state('')
  presenterId = $state('')
  peers = $state<RoomPeer[]>([])
  displayStreamActive = $state(false)
  microphoneActive = $state(false)
  cameraActive = $state(false)
  cursorsEnabled = $state(false)
  hasAudioInput = $state(false)
  activeVote = $state<VoteState | null>(null)
  localVoteCast = $state<boolean | null>(null)
  chatMessages = $state<CallChatMessage[]>([])

  private remoteVideo: HTMLVideoElement | null = null
  private audioStream: MediaStream | null = null
  private displayStream: MediaStream | null = null
  private pendingDisplayStream: MediaStream | null = null
  private cameraStream: MediaStream | null = null
  private cameraSendStreamId = ''
  private userSettings: SettingsData | null = null
  private username = ''
  private color = '#ffffff'
  private links = new Map<string, PeerLink>()
  private remoteVideoStreams = new Map<string, MediaStream>()
  private remoteVideoByStreamId = new Map<string, { peerId: string; stream: MediaStream }>()
  private remoteCameraState = new Map<string, { enabled: boolean; streamId: string }>()
  private remoteCameraStreams = new Map<string, MediaStream>()
  private remoteAudioElements = new Map<string, HTMLAudioElement>()
  private iceGraceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private voteTimer: ReturnType<typeof setTimeout> | null = null
  private cooldownUntil = 0
  private closing = new Set<string>()
  private quietClose = false
  private handshakeKey: string | null = null
  private lastCopiedPendingId: string | null = null
  private callIpcBound = false
  private overlayOpen = false
  private readonly loopback = new CallLoopback()

  get isCoordinator(): boolean {
    return this.localPeerId !== '' && this.localPeerId === this.coordinatorId
  }

  get isPresenter(): boolean {
    return this.localPeerId !== '' && this.localPeerId === this.presenterId
  }

  get remotePeerCount(): number {
    return this.establishedRemoteIds().length
  }

  setRemoteVideo(video: HTMLVideoElement | null): void {
    this.remoteVideo = video
    this.attachPresenterVideo()
  }

  HasAudioInput(): boolean {
    return this.audioStream !== null
  }

  GetAudioStream(): MediaStream | null {
    return this.audioStream
  }

  IsMicrophoneActive(): boolean {
    if (!this.audioStream) return false
    return this.audioStream.getAudioTracks().some((track) => track.enabled)
  }

  IsConnected(): boolean {
    return this.establishedRemoteIds().some((id) => {
      const link = this.links.get(id)
      return link?.connectionState === 'connected' || link?.iceConnectionState === 'connected'
    })
  }

  ToggleMicrophone(): void {
    if (!this.audioStream) return
    for (const track of this.audioStream.getAudioTracks()) {
      track.enabled = !track.enabled
    }
    this.microphoneActive = this.IsMicrophoneActive()
  }

  ToggleDisplayStream(): void {
    if (!this.displayStream) return
    for (const track of this.displayStream.getVideoTracks()) {
      track.enabled = !track.enabled
    }
    this.displayStreamActive = this.displayStream.getVideoTracks().some((track) => track.enabled)
    if (!this.displayStreamActive) this.ToggleRemoteCursors(false)
  }

  ToggleRemoteCursors(enabled: boolean): boolean {
    if (!this.isPresenter) return false
    this.cursorsEnabled = enabled
    if (!enabled) window.KiwiApi.toggleRemoteCursors(false)
    else window.KiwiApi.toggleRemoteCursors(true)
    return enabled
  }

  async ToggleCamera(): Promise<void> {
    if (this.cameraStream) {
      await this.disableCamera()
      return
    }
    await this.enableCamera()
  }

  sendChat(text: string): void {
    const trimmed = truncateChatText(text.trim())
    if (!trimmed) return
    const msg: CallChatMessage = {
      id: getUUIDv4(),
      from: this.localPeerId,
      name: this.username,
      text: trimmed,
      at: Date.now(),
    }
    this.appendChat(msg)
    this.broadcast({
      t: 'chat',
      v: PROTOCOL_VERSION,
      ...msg,
    })
    this.syncCallOverlay()
  }

  PingRemoteCursor(cursorId: string): void {
    this.broadcast({
      t: 'cursor-ping',
      v: PROTOCOL_VERSION,
      cursorId,
    })
  }

  UpdateRemoteCursor(cursorData: RemoteCursorData): void {
    this.broadcast({
      t: 'cursor',
      v: PROTOCOL_VERSION,
      id: cursorData.id,
      name: cursorData.name,
      color: cursorData.color,
      x: cursorData.x,
      y: cursorData.y,
    })
  }

  async Setup(v: HTMLVideoElement | null = null): Promise<'ok' | 'cancelled' | 'failed'> {
    debugLog.info('room', 'Setup start', { hasVideoEl: Boolean(v), role: v ? 'joiner' : 'host' })
    this.bindCallIpc()
    await this.teardown(true)
    this.userSettings = await window.KiwiApi.getSettings()
    this.username = this.userSettings.username
    this.color = this.userSettings.color
    this.remoteVideo = v
    this.localPeerId = getUUIDv4()
    this.microphoneActive = this.userSettings.isMicrophoneEnabledOnConnect
    this.sessionEndedReason = null
    this.presenterGone = false
    this.quietClose = false

    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: mediaTrackConstraints(this.userSettings.microphoneDeviceId),
      })
      for (const track of this.audioStream.getAudioTracks()) {
        track.enabled = this.userSettings.isMicrophoneEnabledOnConnect
      }
    } catch (e) {
      errorHandler(e)
      this.audioStream = null
      debugLog.warn('room', 'getUserMedia audio failed', e)
    }
    this.hasAudioInput = this.audioStream !== null
    debugLog.info('room', `audio input ${this.hasAudioInput ? 'available' : 'unavailable'}`)

    if (!v) {
      this.coordinatorId = this.localPeerId
      this.presenterId = this.localPeerId
      appState.isCoordinator = true
      try {
        this.displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        })
        if (!this.displayStream.getVideoTracks().length) {
          return 'failed'
        }
        for (const track of this.displayStream.getVideoTracks()) {
          track.addEventListener('ended', () => {
            this.displayStreamActive = false
          })
        }
        this.displayStreamActive = true
      } catch (e) {
        if (e && typeof e === 'object' && 'name' in e && e.name === 'NotAllowedError') {
          return 'cancelled'
        }
        errorHandler(e)
        return 'failed'
      }
    } else {
      appState.isCoordinator = false
      const link = await this.createLink(false)
      this.handshakeKey = link.pendingId
      this.links.set(link.pendingId, link)
      debugLog.info('room', 'joiner handshake link created', {
        pendingId: link.pendingId,
        pc: summarizePc(link.pc),
      })
    }
    this.syncLocalPeer()
    debugLog.info('room', 'Setup ok', {
      localPeerId: this.localPeerId,
      coordinatorId: this.coordinatorId,
      presenterId: this.presenterId,
    })
    return 'ok'
  }

  async CreateHostUrl(data: { username: string }): Promise<string | null> {
    this.gcPendingInvites()
    if (this.occupiedSlots() >= MAX_PEERS) {
      debugLog.warn('room', 'CreateHostUrl blocked: room full', { slots: this.occupiedSlots() })
      return null
    }
    const link = await this.createLink(true)
    this.addLocalMediaToLink(link)
    debugLog.info('room', 'CreateHostUrl adding local media', summarizePc(link.pc))
    const offer = await link.createLocalOffer()
    debugLog.info('room', 'CreateHostUrl local offer', summarizeSdp(offer))
    await link.waitForIceGatheringComplete()
    debugLog.info('room', 'CreateHostUrl ICE gathered', {
      pc: summarizePc(link.pc),
      local: summarizeSdp(link.localDescription),
    })
    this.links.set(link.pendingId, link)
    this.lastCopiedPendingId = link.pendingId
    this.username = data.username || this.username
    const url = await getConnectionString(
      ConnectionType.HOST,
      dropTcpIceCandidates(link.localDescription ?? offer),
      { username: this.username },
    )
    debugLog.info('room', 'CreateHostUrl copied host string', {
      pendingId: link.pendingId,
      urlChars: url.length,
    })
    return url
  }

  async CreateParticipantUrl(
    c: RTCSessionDescriptionOptions,
    data: { username: string },
  ): Promise<string> {
    this.username = data.username || this.username
    const link = this.handshakeLink()
    if (!link) {
      debugLog.error('room', 'CreateParticipantUrl: handshake missing')
      throw new Error('viewer handshake is not ready')
    }
    debugLog.info('room', 'CreateParticipantUrl start', {
      incoming: summarizeSdp(c),
      pc: summarizePc(link.pc),
      hasRemote: Boolean(link.pc.remoteDescription),
      localType: link.pc.localDescription?.type ?? 'none',
    })
    if (!link.pc.remoteDescription) {
      await link.setRemoteDescription(c)
      debugLog.info('room', 'CreateParticipantUrl setRemote', summarizePc(link.pc))
    }
    this.addLocalMediaToLink(link)
    if (link.pc.localDescription?.type !== 'answer') {
      const answer = await link.createLocalAnswer()
      debugLog.info('room', 'CreateParticipantUrl created answer', summarizeSdp(answer))
    }
    await link.waitForIceGatheringComplete()
    const local = link.localDescription
    if (!local?.sdp) {
      debugLog.error('room', 'CreateParticipantUrl: no local SDP', summarizePc(link.pc))
      throw new Error('participant answer is not ready')
    }
    debugLog.info('room', 'CreateParticipantUrl ICE gathered', {
      pc: summarizePc(link.pc),
      local: summarizeSdp(local),
    })
    const url = await getConnectionString(ConnectionType.PARTICIPANT, dropTcpIceCandidates(local), {
      username: this.username,
    })
    debugLog.info('room', 'CreateParticipantUrl copied answer string', { urlChars: url.length })
    return url
  }

  async Connect(c: RTCSessionDescriptionOptions): Promise<void> {
    debugLog.info('room', 'Connect start', summarizeSdp(c))
    try {
      const handshake = this.handshakeLink()
      if (handshake) {
        const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: c.sdp }
        debugLog.info('room', 'Connect joiner applying offer', {
          incomingType: c.type,
          pc: summarizePc(handshake.pc),
        })
        await handshake.setRemoteDescription(offer)
        debugLog.info('room', 'Connect joiner after setRemote', summarizePc(handshake.pc))
        this.addLocalMediaToLink(handshake)
        debugLog.info('room', 'Connect joiner after addLocalMedia', summarizePc(handshake.pc))
        if (handshake.pc.localDescription?.type !== 'answer') {
          const answer = await handshake.createLocalAnswer()
          debugLog.info('room', 'Connect joiner created answer', {
            pc: summarizePc(handshake.pc),
            answer: summarizeSdp(answer),
          })
        }
        return
      }
      const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: c.sdp }
      const pending = this.findPendingForAnswer(answer)
      if (!pending) {
        debugLog.error('room', 'Connect: no pending invite matches answer', {
          answer: summarizeSdp(answer),
          pendingIds: [...this.links.keys()],
        })
        throw new Error('no pending invite matches this answer')
      }
      debugLog.info('room', 'Connect applying answer to pending invite', {
        pendingId: pending.pendingId,
        incomingType: c.type,
        before: summarizePc(pending.pc),
      })
      await pending.setRemoteDescription(answer)
      this.isLive = true
      this.setConnectionState('connected')
      debugLog.info('room', 'Connect host applied answer', summarizePc(pending.pc))
    } catch (e) {
      debugLog.error('room', 'Connect failed', e)
      errorHandler(e)
      throw e
    }
  }

  async Disconnect(): Promise<void> {
    await this.leave()
  }

  async leave(): Promise<void> {
    if (this.isCoordinator) {
      const successor = nextCoordinator({
        remainingPeerIds: this.establishedRemoteIds(),
      })
      if (successor) {
        this.broadcast({
          t: 'coordinator-handoff',
          v: PROTOCOL_VERSION,
          coordinatorId: successor,
        })
      }
    }
    this.broadcast({
      t: 'peer-left',
      v: PROTOCOL_VERSION,
      peerId: this.localPeerId,
    })
    await this.teardown(true)
  }

  async endSession(): Promise<void> {
    this.broadcast({
      t: 'session-ended',
      v: PROTOCOL_VERSION,
      byPeerId: this.localPeerId,
    })
    await this.teardown(true)
  }

  async requestToPresent(): Promise<'ok' | 'blocked' | 'cancelled' | 'failed'> {
    const now = Date.now()
    if (
      !canStartVote({
        now,
        cooldownUntil: this.cooldownUntil,
        activeVote: this.activeVote,
        requesterId: this.localPeerId,
        presenterId: this.presenterId,
      })
    ) {
      return 'blocked'
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
      if (!stream.getVideoTracks().length) return 'failed'
      this.stopStream(this.pendingDisplayStream)
      this.pendingDisplayStream = stream
    } catch (e) {
      if (e && typeof e === 'object' && 'name' in e && e.name === 'NotAllowedError') {
        return 'cancelled'
      }
      errorHandler(e)
      return 'failed'
    }

    const vote = startVote({
      voteId: getUUIDv4(),
      candidateId: this.localPeerId,
      now,
      timeoutMs: VOTE_TIMEOUT_MS,
      peerIds: this.allPeerIds(),
    })
    this.activeVote = vote
    this.localVoteCast = true
    this.broadcast({
      t: 'vote-start',
      v: PROTOCOL_VERSION,
      voteId: vote.voteId,
      candidateId: vote.candidateId,
      expiresAt: vote.expiresAt,
    })
    this.armVoteTimer(vote)
    if (voteOutcome(vote, Date.now()) === 'approved') {
      await this.concludeVote(vote, true)
    }
    return 'ok'
  }

  async castLocalVote(approve: boolean): Promise<void> {
    const vote = this.activeVote
    if (!vote || this.localVoteCast !== null) return
    this.localVoteCast = approve
    const next = castVote(vote, this.localPeerId, approve)
    this.activeVote = next
    this.broadcast({
      t: 'vote-cast',
      v: PROTOCOL_VERSION,
      voteId: vote.voteId,
      peerId: this.localPeerId,
      approve,
    })
    await this.checkVoteOutcome(next)
  }

  async changeScreen(): Promise<'ok' | 'cancelled' | 'failed'> {
    if (!this.isPresenter) return 'failed'
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
      const track = stream.getVideoTracks()[0]
      if (!track) return 'failed'
      track.addEventListener('ended', () => {
        this.displayStreamActive = false
      })
      this.stopStream(this.displayStream)
      this.displayStream = stream
      this.displayStreamActive = true
      await this.pushVideoToAll(track, stream)
      return 'ok'
    } catch (e) {
      if (e && typeof e === 'object' && 'name' in e && e.name === 'NotAllowedError') {
        return 'cancelled'
      }
      errorHandler(e)
      return 'failed'
    }
  }

  occupiedSlots(): number {
    return 1 + this.establishedRemoteIds().length + this.pendingInviteCount()
  }

  dismissSessionEnded(): void {
    if (this.remoteVideo) this.remoteVideo.srcObject = null
    this.sessionEndedReason = null
  }

  private handshakeLink(): PeerLink | null {
    if (!this.handshakeKey) return null
    return this.links.get(this.handshakeKey) ?? null
  }

  private pendingInviteCount(): number {
    let count = 0
    for (const [key, link] of this.links) {
      if (key === this.handshakeKey) continue
      if (!link.remotePeerId) count += 1
    }
    return count
  }

  private gcPendingInvites(): void {
    const now = Date.now()
    const stale: string[] = []
    for (const [key, link] of this.links) {
      if (link.remotePeerId) continue
      if (key === this.handshakeKey) continue
      if (now - link.createdAt > PENDING_INVITE_TTL_MS) stale.push(key)
    }
    for (const key of stale) {
      this.links.get(key)?.close()
      this.links.delete(key)
    }
  }

  private async createLink(isOfferer: boolean, remotePeerId?: string): Promise<PeerLink> {
    const rtcConfig = await getRTCPeerConnectionConfig()
    const pendingId = getUUIDv4()
    const link = new PeerLink({
      rtcConfig,
      localPeerId: this.localPeerId,
      pendingId,
      isOfferer,
      remotePeerId: remotePeerId ?? null,
      events: {
        onControl: (msg) => {
          void this.onControl(link, msg)
        },
        onTrack: (event) => {
          this.onTrack(link, event)
        },
        onIceConnectionStateChange: (state) => {
          debugLog.info('room', `ICE ${state}`, {
            pendingId: link.pendingId,
            remotePeerId: link.remotePeerId,
            pc: summarizePc(link.pc),
          })
          this.onIceState(link, state)
        },
        onConnectionStateChange: (state) => {
          debugLog.info('room', `PC ${state}`, {
            pendingId: link.pendingId,
            remotePeerId: link.remotePeerId,
            pc: summarizePc(link.pc),
          })
          if (state === 'connected') this.markLive(link)
          if (state === 'failed' || state === 'closed') {
            void this.handleRemoteDeparted(link, false)
          }
        },
        onControlOpen: () => {
          this.sendHello(link)
        },
        onNegotiationOffer: (sdp) => {
          if (!link.remotePeerId) return
          this.sendRouted(
            link.remotePeerId,
            {
              t: 'mesh-offer',
              v: PROTOCOL_VERSION,
              from: this.localPeerId,
              to: link.remotePeerId,
              sdp,
            },
            link,
          )
        },
      },
    })
    return link
  }

  private addLocalMediaToLink(link: PeerLink): void {
    if (this.audioStream) {
      for (const track of this.audioStream.getAudioTracks()) {
        link.addTrack(track, this.audioStream)
      }
    }
    if (this.isPresenter && this.displayStream) {
      for (const track of this.displayStream.getVideoTracks()) {
        void link.setDisplayTrack(track, this.displayStream)
      }
    }
    if (this.cameraStream) {
      const track = this.cameraStream.getVideoTracks()[0]
      if (track) void link.setCameraTrack(track, this.cameraStream)
    }
  }

  private sendHello(link: PeerLink): void {
    link.sendControl({
      t: 'hello',
      v: PROTOCOL_VERSION,
      peerId: this.localPeerId,
      username: this.username,
      color: this.color,
    })
  }

  private async onControl(link: PeerLink, msg: ControlMessage): Promise<void> {
    switch (msg.t) {
      case 'hello':
        await this.onHello(link, msg)
        break
      case 'roster':
        await this.onRoster(msg)
        break
      case 'mesh-offer':
        await this.onMeshOffer(link, msg)
        break
      case 'mesh-answer':
        await this.onMeshAnswer(link, msg)
        break
      case 'vote-start':
        this.onVoteStart(msg)
        break
      case 'vote-cast':
        await this.onVoteCast(msg)
        break
      case 'vote-result':
        await this.onVoteResult(msg)
        break
      case 'presenter-changed':
        await this.onPresenterChanged(msg.presenterId)
        break
      case 'peer-left':
        await this.onPeerLeftMessage(msg.peerId)
        break
      case 'coordinator-handoff':
        this.onCoordinatorHandoff(msg.coordinatorId)
        break
      case 'session-ended':
        this.onSessionEnded()
        break
      case 'cursor':
        this.onCursor(msg)
        break
      case 'cursor-ping':
        this.onCursorPing(msg.cursorId)
        break
      case 'chat':
        this.onChat(msg)
        break
      case 'camera-state':
        this.onCameraState(msg)
        break
    }
  }

  private async onHello(
    link: PeerLink,
    msg: Extract<ControlMessage, { t: 'hello' }>,
  ): Promise<void> {
    this.rekeyLink(link, msg.peerId)
    this.upsertPeer({ id: msg.peerId, username: msg.username, color: msg.color })
    if (!this.coordinatorId) this.coordinatorId = msg.peerId
    if (!this.presenterId) this.presenterId = msg.peerId
    appState.isCoordinator = this.isCoordinator
    this.markLive(link)
    if (this.isCoordinator) this.broadcastRoster()
    this.sendCameraStateTo(link)
  }

  private async onRoster(msg: Extract<ControlMessage, { t: 'roster' }>): Promise<void> {
    this.coordinatorId = msg.coordinatorId
    this.presenterId = msg.presenterId
    this.peers = uniquePeersById(msg.peers)
    appState.isCoordinator = this.isCoordinator
    const handshake = this.handshakeLink()
    const handshakePending = Boolean(handshake && !handshake.remotePeerId)
    for (const peer of this.peers) {
      if (peer.id === this.localPeerId) continue
      if (this.findLinkByRemote(peer.id)) continue
      if (handshakePending) continue
      await this.startMeshTo(peer.id)
    }
    this.attachPresenterVideo()
    this.syncCallOverlay()
  }

  private async startMeshTo(targetId: string): Promise<void> {
    if (this.findLinkByRemote(targetId)) return
    const link = await this.createLink(true, targetId)
    this.links.set(targetId, link)
    this.addLocalMediaToLink(link)
    const offer = await link.createLocalOffer()
    await link.waitForIceGatheringComplete()
    this.sendRouted(
      targetId,
      {
        t: 'mesh-offer',
        v: PROTOCOL_VERSION,
        from: this.localPeerId,
        to: targetId,
        sdp: dropTcpIceCandidates(link.localDescription ?? offer),
      },
      link,
    )
  }

  private async onMeshOffer(
    fromLink: PeerLink,
    msg: Extract<ControlMessage, { t: 'mesh-offer' }>,
  ): Promise<void> {
    const route = routeMeshSignal({
      localPeerId: this.localPeerId,
      coordinatorId: this.coordinatorId,
      to: msg.to,
      from: msg.from,
      connectedPeerIds: this.routablePeerIds(),
    })
    if (route === 'drop') return
    if (route === 'forward') {
      this.sendTo(msg.to, msg)
      return
    }
    const existing = this.findLinkByRemote(msg.from)
    if (existing) {
      const answer = await existing.handleRemoteSdp(msg.sdp)
      if (answer) {
        this.sendRouted(
          msg.from,
          {
            t: 'mesh-answer',
            v: PROTOCOL_VERSION,
            from: this.localPeerId,
            to: msg.from,
            sdp: dropTcpIceCandidates(answer),
          },
          fromLink,
        )
      }
      return
    }
    const link = await this.createLink(false, msg.from)
    this.links.set(msg.from, link)
    await link.setRemoteDescription(msg.sdp)
    this.addLocalMediaToLink(link)
    const answer = await link.createLocalAnswer()
    await link.waitForIceGatheringComplete()
    link.markEstablished()
    this.sendRouted(
      msg.from,
      {
        t: 'mesh-answer',
        v: PROTOCOL_VERSION,
        from: this.localPeerId,
        to: msg.from,
        sdp: dropTcpIceCandidates(link.localDescription ?? answer),
      },
      fromLink,
    )
  }

  private async onMeshAnswer(
    fromLink: PeerLink,
    msg: Extract<ControlMessage, { t: 'mesh-answer' }>,
  ): Promise<void> {
    const route = routeMeshSignal({
      localPeerId: this.localPeerId,
      coordinatorId: this.coordinatorId,
      to: msg.to,
      from: msg.from,
      connectedPeerIds: this.routablePeerIds(),
    })
    if (route === 'drop') return
    if (route === 'forward') {
      this.sendTo(msg.to, msg)
      return
    }
    const link = this.findLinkByRemote(msg.from)
    if (!link) return
    await link.setRemoteDescription(msg.sdp)
    link.markEstablished()
    this.markLive(link)
    void fromLink
  }

  private onVoteStart(msg: Extract<ControlMessage, { t: 'vote-start' }>): void {
    if (this.activeVote && this.activeVote.voteId === msg.voteId) return
    const vote = resumeVote({
      voteId: msg.voteId,
      candidateId: msg.candidateId,
      expiresAt: msg.expiresAt,
      peerIds: this.allPeerIds(),
    })
    this.activeVote = vote
    this.localVoteCast = msg.candidateId === this.localPeerId ? true : null
    this.armVoteTimer(vote)
  }

  private async onVoteCast(msg: Extract<ControlMessage, { t: 'vote-cast' }>): Promise<void> {
    if (!this.activeVote || this.activeVote.voteId !== msg.voteId) return
    const next = castVote(this.activeVote, msg.peerId, msg.approve)
    this.activeVote = next
    await this.checkVoteOutcome(next)
  }

  private async onVoteResult(msg: Extract<ControlMessage, { t: 'vote-result' }>): Promise<void> {
    this.clearVoteTimer()
    this.cooldownUntil = Date.now() + VOTE_COOLDOWN_MS
    this.activeVote = null
    this.localVoteCast = null
    if (msg.approved) await this.onPresenterChanged(msg.presenterId)
    else this.stopStream(this.pendingDisplayStream)
    this.pendingDisplayStream = null
  }

  private async checkVoteOutcome(vote: VoteState): Promise<void> {
    const outcome = voteOutcome(vote, Date.now())
    if (outcome === 'pending') return
    if (vote.candidateId === this.localPeerId) {
      await this.concludeVote(vote, outcome === 'approved')
    }
  }

  private async concludeVote(vote: VoteState, approved: boolean): Promise<void> {
    this.clearVoteTimer()
    this.cooldownUntil = Date.now() + VOTE_COOLDOWN_MS
    this.activeVote = null
    this.localVoteCast = null
    if (approved) {
      await this.becomePresenter()
    } else {
      this.stopStream(this.pendingDisplayStream)
      this.pendingDisplayStream = null
    }
    this.broadcast({
      t: 'vote-result',
      v: PROTOCOL_VERSION,
      voteId: vote.voteId,
      approved,
      presenterId: this.presenterId,
    })
  }

  private async becomePresenter(): Promise<void> {
    const stream = this.pendingDisplayStream
    this.pendingDisplayStream = null
    if (!stream) return
    const track = stream.getVideoTracks()[0]
    if (!track) return
    track.addEventListener('ended', () => {
      this.displayStreamActive = false
    })
    this.stopStream(this.displayStream)
    this.displayStream = stream
    this.displayStreamActive = true
    this.presenterId = this.localPeerId
    this.presenterGone = false
    await this.pushVideoToAll(track, stream)
    this.broadcast({
      t: 'presenter-changed',
      v: PROTOCOL_VERSION,
      presenterId: this.localPeerId,
    })
    this.broadcastRoster()
  }

  private async onPresenterChanged(presenterId: string): Promise<void> {
    const wasPresenter = this.isPresenter
    this.presenterId = presenterId
    this.presenterGone = presenterId === ''
    if (wasPresenter && !this.isPresenter) {
      await this.stopPresenting()
    }
    this.attachPresenterVideo()
  }

  private async stopPresenting(): Promise<void> {
    this.ToggleRemoteCursors(false)
    for (const link of this.links.values()) {
      await link.setDisplayTrack(null, null)
    }
    this.stopStream(this.displayStream)
    this.displayStream = null
    this.displayStreamActive = false
  }

  private async onPeerLeftMessage(peerId: string): Promise<void> {
    const link = this.findLinkByRemote(peerId)
    if (link) await this.handleRemoteDeparted(link, false)
    else this.removePeerById(peerId)
  }

  private onCoordinatorHandoff(coordinatorId: string): void {
    this.coordinatorId = coordinatorId
    appState.isCoordinator = this.isCoordinator
  }

  private onSessionEnded(): void {
    this.sessionEndedReason = 'host-ended'
    playSessionEndedSound()
    void this.teardown(true)
  }

  private onCursor(msg: Extract<ControlMessage, { t: 'cursor' }>): void {
    if (!this.isPresenter || !this.cursorsEnabled) return
    window.KiwiApi.updateRemoteCursor({
      id: msg.id,
      name: msg.name,
      color: msg.color,
      x: msg.x,
      y: msg.y,
    })
  }

  private onCursorPing(cursorId: string): void {
    if (!this.isPresenter || !this.cursorsEnabled) return
    window.KiwiApi.remoteCursorPing(cursorId)
  }

  private onChat(msg: Extract<ControlMessage, { t: 'chat' }>): void {
    this.appendChat({
      id: msg.id,
      from: msg.from,
      name: msg.name,
      text: msg.text,
      at: msg.at,
    })
    this.syncCallOverlay()
  }

  private onCameraState(msg: Extract<ControlMessage, { t: 'camera-state' }>): void {
    this.remoteCameraState.set(msg.peerId, { enabled: msg.enabled, streamId: msg.streamId })
    if (!msg.enabled) this.remoteCameraStreams.delete(msg.peerId)
    this.classifyRemoteVideos(msg.peerId)
  }

  private onTrack(link: PeerLink, event: RTCTrackEvent): void {
    const peerId = link.remotePeerId ?? link.pendingId
    const stream = event.streams[0] ?? new MediaStream([event.track])
    if (event.track.kind === 'video') {
      this.remoteVideoByStreamId.set(stream.id, { peerId, stream })
      this.classifyRemoteVideos(peerId)
    }
    if (event.track.kind === 'audio') {
      this.attachRemoteAudio(peerId, stream)
    }
  }

  private classifyRemoteVideos(peerId: string): void {
    const cam = this.remoteCameraState.get(peerId)
    const entries = [...this.remoteVideoByStreamId.entries()].filter(
      ([, entry]) => entry.peerId === peerId,
    )
    const picked = pickRemoteCameraAndDisplay({
      streamIds: entries.map(([streamId]) => streamId),
      camera: cam,
      isPresenter: peerId === this.presenterId,
      existingDisplayStreamId: this.remoteVideoStreams.get(peerId)?.id ?? null,
    })
    const cameraEntry = entries.find(([streamId]) => streamId === picked.cameraStreamId)
    const displayEntry = entries.find(([streamId]) => streamId === picked.displayStreamId)
    if (cameraEntry) this.remoteCameraStreams.set(peerId, cameraEntry[1].stream)
    else this.remoteCameraStreams.delete(peerId)
    if (displayEntry) this.remoteVideoStreams.set(peerId, displayEntry[1].stream)
    else this.remoteVideoStreams.delete(peerId)
    this.attachPresenterVideo()
    this.syncCallOverlay()
  }

  private attachPresenterVideo(): void {
    if (!this.remoteVideo || this.isPresenter) return
    const stream =
      this.remoteVideoStreams.get(this.presenterId) ?? [...this.remoteVideoStreams.values()].at(-1)
    if (stream && this.remoteVideo.srcObject !== stream) {
      this.remoteVideo.srcObject = stream
    }
  }

  private attachRemoteAudio(peerId: string, stream: MediaStream): void {
    let audio = this.remoteAudioElements.get(peerId)
    if (!audio) {
      audio = document.createElement('audio')
      audio.autoplay = true
      this.remoteAudioElements.set(peerId, audio)
    }
    audio.srcObject = stream
  }

  private onIceState(link: PeerLink, state: RTCIceConnectionState): void {
    const key = link.remotePeerId ?? link.pendingId
    const existing = this.iceGraceTimers.get(key)
    if (existing) {
      clearTimeout(existing)
      this.iceGraceTimers.delete(key)
    }
    if (state === 'connected' || state === 'completed') {
      this.markLive(link)
      this.setConnectionState('connected')
      return
    }
    if (state === 'failed' || state === 'closed') {
      void this.handleRemoteDeparted(link, false)
      return
    }
    if (state === 'disconnected') {
      const timer = setTimeout(() => {
        this.iceGraceTimers.delete(key)
        void this.handleRemoteDeparted(link, false)
      }, ICE_DISCONNECT_GRACE_MS)
      this.iceGraceTimers.set(key, timer)
    }
  }

  private markLive(link: PeerLink): void {
    link.markEstablished()
    this.isLive = this.remotePeerCount > 0 || link.iceConnectionState === 'connected'
    if (link.connectionState === 'connected' || link.iceConnectionState === 'connected') {
      this.setConnectionState('connected')
      this.isLive = true
    }
    this.syncLocalPeer()
  }

  private async handleRemoteDeparted(
    link: PeerLink,
    sessionEndedBroadcast: boolean,
  ): Promise<void> {
    const key = link.remotePeerId ?? link.pendingId
    if (this.quietClose || this.closing.has(key)) return
    this.closing.add(key)
    const peerId = link.remotePeerId
    this.clearIceGrace(key)
    link.close()
    this.deleteLink(link)
    if (peerId) {
      this.removePeerById(peerId)
      this.remoteVideoStreams.delete(peerId)
      this.remoteCameraStreams.delete(peerId)
      this.remoteCameraState.delete(peerId)
      for (const [streamId, entry] of this.remoteVideoByStreamId) {
        if (entry.peerId === peerId) this.remoteVideoByStreamId.delete(streamId)
      }
      const audio = this.remoteAudioElements.get(peerId)
      if (audio) {
        audio.srcObject = null
        this.remoteAudioElements.delete(peerId)
      }
    }
    const remaining = this.establishedRemoteIds().length
    const reason = sessionEndedReasonAfterDeparture({
      sessionEndedBroadcast,
      remainingRemoteCount: remaining,
    })
    if (reason) {
      this.sessionEndedReason = reason
      this.isLive = false
      this.setConnectionState('closed')
      playSessionEndedSound()
      return
    }
    this.isLive = remaining > 0
    if (peerId && peerId === this.presenterId) {
      this.presenterId = ''
      this.presenterGone = true
    }
    if (peerId && peerId === this.coordinatorId) {
      const next = nextCoordinator({
        remainingPeerIds: [this.localPeerId, ...this.establishedRemoteIds()],
      })
      if (next) {
        this.coordinatorId = next
        appState.isCoordinator = this.isCoordinator
      }
    }
    if (this.isCoordinator) this.broadcastRoster()
    this.syncLocalPeer()
    this.syncCallOverlay()
  }

  private findPendingForAnswer(answer: RTCSessionDescriptionInit): PeerLink | null {
    for (const link of this.links.values()) {
      if (link.remotePeerId) continue
      if (answersMatchOffer(link.localDescription?.sdp, answer.sdp)) return link
    }
    if (this.lastCopiedPendingId) {
      const last = this.links.get(this.lastCopiedPendingId)
      if (last && !last.remotePeerId) return last
    }
    for (const [key, link] of this.links) {
      if (key === this.handshakeKey) continue
      if (!link.remotePeerId) return link
    }
    return null
  }

  private rekeyLink(link: PeerLink, remotePeerId: string): void {
    link.remotePeerId = remotePeerId
    const oldKey = [...this.links.entries()].find(([, value]) => value === link)?.[0]
    if (oldKey && oldKey !== remotePeerId) this.links.delete(oldKey)
    this.links.set(remotePeerId, link)
    const pendingStream = this.remoteVideoStreams.get(link.pendingId)
    if (pendingStream) {
      this.remoteVideoStreams.delete(link.pendingId)
      this.remoteVideoStreams.set(remotePeerId, pendingStream)
      this.attachPresenterVideo()
    }
    const pendingCamera = this.remoteCameraStreams.get(link.pendingId)
    if (pendingCamera) {
      this.remoteCameraStreams.delete(link.pendingId)
      this.remoteCameraStreams.set(remotePeerId, pendingCamera)
    }
    const pendingCamState = this.remoteCameraState.get(link.pendingId)
    if (pendingCamState) {
      this.remoteCameraState.delete(link.pendingId)
      this.remoteCameraState.set(remotePeerId, pendingCamState)
    }
    for (const entry of this.remoteVideoByStreamId.values()) {
      if (entry.peerId === link.pendingId) entry.peerId = remotePeerId
    }
    const pendingAudio = this.remoteAudioElements.get(link.pendingId)
    if (pendingAudio) {
      this.remoteAudioElements.delete(link.pendingId)
      this.remoteAudioElements.set(remotePeerId, pendingAudio)
    }
    if (this.handshakeKey === oldKey) this.handshakeKey = remotePeerId
  }

  private findLinkByRemote(peerId: string): PeerLink | undefined {
    return this.links.get(peerId)
  }

  private deleteLink(link: PeerLink): void {
    for (const [key, value] of this.links) {
      if (value === link) this.links.delete(key)
    }
  }

  private upsertPeer(peer: RoomPeer): void {
    const others = this.peers.filter((item) => item.id !== peer.id)
    this.peers = uniquePeersById([...others, peer])
  }

  private removePeerById(peerId: string): void {
    this.peers = this.peers.filter((peer) => peer.id !== peerId)
  }

  private syncLocalPeer(): void {
    this.upsertPeer({
      id: this.localPeerId,
      username: this.username,
      color: this.color,
    })
    this.syncCallOverlay()
  }

  private allPeerIds(): string[] {
    const ids = new Set<string>([this.localPeerId, ...this.establishedRemoteIds()])
    return [...ids]
  }

  private establishedRemoteIds(): string[] {
    const ids: string[] = []
    for (const [key, link] of this.links) {
      if (key === this.handshakeKey && !link.remotePeerId) continue
      if (link.remotePeerId) ids.push(link.remotePeerId)
    }
    return ids
  }

  private routablePeerIds(): string[] {
    return this.establishedRemoteIds()
  }

  private broadcastRoster(): void {
    const withLocal = this.peers.some((peer) => peer.id === this.localPeerId)
      ? this.peers
      : [...this.peers, { id: this.localPeerId, username: this.username, color: this.color }]
    this.peers = uniquePeersById(withLocal)
    this.broadcast({
      t: 'roster',
      v: PROTOCOL_VERSION,
      peers: this.peers,
      coordinatorId: this.coordinatorId,
      presenterId: this.presenterId,
    })
    this.syncCallOverlay()
  }

  private broadcast(msg: ControlMessage): void {
    for (const link of this.links.values()) {
      link.sendControl(msg)
    }
  }

  private sendTo(peerId: string, msg: ControlMessage): boolean {
    const link = this.findLinkByRemote(peerId)
    if (!link) return false
    return link.sendControl(msg)
  }

  private sendRouted(to: string, msg: ControlMessage, fallback: PeerLink): void {
    if (this.sendTo(to, msg)) return
    fallback.sendControl(msg)
    if (this.coordinatorId && this.coordinatorId !== this.localPeerId) {
      this.sendTo(this.coordinatorId, msg)
    }
  }

  private async pushVideoToAll(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    for (const link of this.links.values()) {
      await link.setDisplayTrack(track, stream)
    }
  }

  private armVoteTimer(vote: VoteState): void {
    this.clearVoteTimer()
    const delay = Math.max(0, vote.expiresAt - Date.now())
    this.voteTimer = setTimeout(() => {
      if (!this.activeVote || this.activeVote.voteId !== vote.voteId) return
      void this.checkVoteOutcome(this.activeVote)
    }, delay)
  }

  private clearVoteTimer(): void {
    if (this.voteTimer) {
      clearTimeout(this.voteTimer)
      this.voteTimer = null
    }
  }

  private clearIceGrace(key: string): void {
    const timer = this.iceGraceTimers.get(key)
    if (timer) clearTimeout(timer)
    this.iceGraceTimers.delete(key)
  }

  private stopStream(stream: MediaStream | null): void {
    if (!stream) return
    for (const track of stream.getTracks()) track.stop()
  }

  private async teardown(quiet: boolean): Promise<void> {
    this.quietClose = quiet
    this.clearVoteTimer()
    for (const timer of this.iceGraceTimers.values()) clearTimeout(timer)
    this.iceGraceTimers.clear()
    for (const link of this.links.values()) link.close()
    this.links.clear()
    this.stopStream(this.displayStream)
    this.stopStream(this.pendingDisplayStream)
    this.stopStream(this.audioStream)
    this.stopStream(this.cameraStream)
    this.displayStream = null
    this.pendingDisplayStream = null
    this.audioStream = null
    this.cameraStream = null
    this.cameraSendStreamId = ''
    this.cameraActive = false
    this.chatMessages = []
    this.remoteVideoStreams.clear()
    this.remoteVideoByStreamId.clear()
    this.remoteCameraStreams.clear()
    this.remoteCameraState.clear()
    this.overlayOpen = false
    this.loopback.close()
    window.KiwiApi.toggleCallOverlay?.(false)
    for (const audio of this.remoteAudioElements.values()) {
      audio.srcObject = null
    }
    this.remoteAudioElements.clear()
    this.hasAudioInput = false
    this.isLive = false
    this.activeVote = null
    this.localVoteCast = null
    this.displayStreamActive = false
    this.cursorsEnabled = false
    this.peers = []
    this.handshakeKey = null
    this.lastCopiedPendingId = null
    this.localPeerId = ''
    this.coordinatorId = ''
    this.presenterId = ''
    this.closing.clear()
    window.KiwiApi.toggleRemoteCursors(false)
    appState.isCoordinator = false
    this.setConnectionState('disconnected')
  }

  private bindCallIpc(): void {
    if (this.callIpcBound) return
    this.callIpcBound = true
    window.KiwiApi.onCallOverlayClosed?.(() => {
      this.overlayOpen = false
      this.loopback.close()
    })
    window.KiwiApi.onCallOverlayReady?.(() => {
      void this.onCallOverlayReady()
    })
    window.KiwiApi.onCallChatSend?.((text) => {
      this.sendChat(text)
    })
    window.KiwiApi.onCallToggleCamera?.(() => {
      void this.ToggleCamera()
    })
    window.KiwiApi.onCallLoopAnswer?.((sdp) => {
      void this.loopback.handleAnswer(sdp)
    })
    window.KiwiApi.onCallLoopIce?.((candidate) => {
      void this.loopback.addIce(candidate)
    })
  }

  private async onCallOverlayReady(): Promise<void> {
    this.overlayOpen = true
    await this.loopback.start()
    this.syncCallOverlay()
  }

  private async enableCamera(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: mediaTrackConstraints(this.userSettings?.cameraDeviceId),
        audio: false,
      })
      const track = stream.getVideoTracks()[0]
      if (!track) {
        this.stopStream(stream)
        return
      }
      track.addEventListener('ended', () => {
        if (this.cameraStream === stream) void this.disableCamera()
      })
      this.stopStream(this.cameraStream)
      this.cameraStream = stream
      this.cameraActive = true
      this.cameraSendStreamId = stream.id
      debugLog.info('room', 'camera enabled', {
        streamId: stream.id,
        deviceId: track.getSettings().deviceId ?? '',
        links: this.links.size,
      })
      for (const link of this.links.values()) {
        await link.setCameraTrack(track, stream)
      }
      this.broadcastCameraState()
      this.syncCallOverlay()
    } catch (e) {
      errorHandler(e)
    }
  }

  private async disableCamera(): Promise<void> {
    if (!this.cameraStream && !this.cameraActive) return
    for (const link of this.links.values()) {
      await link.setCameraTrack(null, null)
    }
    this.stopStream(this.cameraStream)
    this.cameraStream = null
    this.cameraActive = false
    this.cameraSendStreamId = ''
    this.broadcastCameraState()
    this.syncCallOverlay()
  }

  private broadcastCameraState(): void {
    const msg = {
      t: 'camera-state' as const,
      v: PROTOCOL_VERSION,
      peerId: this.localPeerId,
      enabled: this.cameraActive,
      streamId: this.cameraActive ? this.cameraSendStreamId : '',
    }
    this.broadcast(msg)
  }

  private sendCameraStateTo(link: PeerLink): void {
    if (!this.cameraActive) return
    link.sendControl({
      t: 'camera-state',
      v: PROTOCOL_VERSION,
      peerId: this.localPeerId,
      enabled: true,
      streamId: this.cameraSendStreamId,
    })
  }

  private appendChat(msg: CallChatMessage): void {
    if (this.chatMessages.some((item) => item.id === msg.id)) return
    const next = [...this.chatMessages, msg]
    this.chatMessages = next.length > CHAT_MAX_MESSAGES ? next.slice(-CHAT_MAX_MESSAGES) : next
  }

  private cameraSources(): Array<{ peerId: string; stream: MediaStream }> {
    const sources: Array<{ peerId: string; stream: MediaStream }> = []
    if (this.cameraStream) {
      sources.push({ peerId: this.localPeerId, stream: this.cameraStream })
    }
    for (const [peerId, stream] of this.remoteCameraStreams) {
      sources.push({ peerId, stream })
    }
    return sources
  }

  private callPeerInfos(): CallPeerInfo[] {
    return uniquePeersById(this.peers).map((peer) => ({
      id: peer.id,
      name: peer.username,
      color: peer.color,
      cameraEnabled:
        peer.id === this.localPeerId
          ? this.cameraActive
          : Boolean(this.remoteCameraState.get(peer.id)?.enabled),
      isLocal: peer.id === this.localPeerId,
    }))
  }

  private syncCallOverlay(): void {
    if (!this.overlayOpen) return
    window.KiwiApi.sendCallPeers?.(this.callPeerInfos())
    window.KiwiApi.sendCallChat?.(this.chatMessages)
    void this.loopback.setVideoSources(this.cameraSources())
  }

  private setConnectionState(state: string): void {
    if (this.connectionState === state) return
    this.connectionState = state
  }
}
