export type VoteState = {
  voteId: string
  candidateId: string
  expiresAt: number
  requiredVoterIds: string[]
  votes: Record<string, boolean>
}

export type VoteOutcome = 'pending' | 'approved' | 'rejected'

export type SessionEndedReason = 'host-ended' | 'everyone-left'

export type MeshRoute = 'deliver-local' | 'forward' | 'drop'

export const sdpOriginSessionId = (sdp?: string | null): string | null => {
  if (!sdp) return null
  const line = sdp.split(/\r?\n/).find((entry) => entry.startsWith('o='))
  if (!line) return null
  return line.slice(2).trim().split(/\s+/)[1] ?? null
}

export const answersMatchOffer = (offerSdp?: string | null, answerSdp?: string | null): boolean => {
  const offerId = sdpOriginSessionId(offerSdp)
  const answerId = sdpOriginSessionId(answerSdp)
  return Boolean(offerId && answerId && offerId === answerId)
}

export const startVote = (params: {
  voteId: string
  candidateId: string
  now: number
  timeoutMs: number
  peerIds: string[]
}): VoteState => ({
  voteId: params.voteId,
  candidateId: params.candidateId,
  expiresAt: params.now + params.timeoutMs,
  requiredVoterIds: params.peerIds.filter((id) => id !== params.candidateId),
  votes: {},
})

export const resumeVote = (params: {
  voteId: string
  candidateId: string
  expiresAt: number
  peerIds: string[]
}): VoteState => ({
  voteId: params.voteId,
  candidateId: params.candidateId,
  expiresAt: params.expiresAt,
  requiredVoterIds: params.peerIds.filter((id) => id !== params.candidateId),
  votes: {},
})

export const canStartVote = (params: {
  now: number
  cooldownUntil: number
  activeVote: VoteState | null
  requesterId: string
  presenterId: string
}): boolean => {
  if (params.requesterId === params.presenterId) return false
  if (params.activeVote) return false
  if (params.now < params.cooldownUntil) return false
  return true
}

export const castVote = (vote: VoteState, peerId: string, approve: boolean): VoteState => {
  if (vote.votes[peerId] !== undefined) return vote
  if (!vote.requiredVoterIds.includes(peerId)) return vote
  return {
    ...vote,
    votes: {
      ...vote.votes,
      [peerId]: approve,
    },
  }
}

export const voteOutcome = (vote: VoteState, now: number): VoteOutcome => {
  if (vote.requiredVoterIds.some((id) => vote.votes[id] === false)) return 'rejected'
  const allYes =
    vote.requiredVoterIds.length === 0 ||
    vote.requiredVoterIds.every((id) => vote.votes[id] === true)
  if (allYes) return 'approved'
  if (now >= vote.expiresAt) return 'rejected'
  return 'pending'
}

export const electCoordinator = (peerIds: string[]): string | null => {
  if (peerIds.length === 0) return null
  return [...peerIds].sort()[0]
}

export const nextCoordinator = (params: {
  remainingPeerIds: string[]
  handoffId?: string | null
}): string | null => {
  if (params.handoffId && params.remainingPeerIds.includes(params.handoffId)) {
    return params.handoffId
  }
  return electCoordinator(params.remainingPeerIds)
}

export const sessionEndedReasonAfterDeparture = (params: {
  sessionEndedBroadcast: boolean
  remainingRemoteCount: number
}): SessionEndedReason | null => {
  if (params.sessionEndedBroadcast) return 'host-ended'
  if (params.remainingRemoteCount <= 0) return 'everyone-left'
  return null
}

export const uniquePeersById = <T extends { id: string }>(peers: T[]): T[] => {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const peer of peers) {
    if (seen.has(peer.id)) continue
    seen.add(peer.id)
    unique.push(peer)
  }
  return unique
}

export const pickRemoteCameraAndDisplay = (params: {
  streamIds: string[]
  camera?: { enabled: boolean; streamId: string } | null
  isPresenter: boolean
  existingDisplayStreamId?: string | null
}): { cameraStreamId: string | null; displayStreamId: string | null } => {
  const { streamIds, camera, isPresenter, existingDisplayStreamId } = params
  let cameraStreamId: string | null = null
  if (camera?.enabled) {
    if (camera.streamId && streamIds.includes(camera.streamId)) {
      cameraStreamId = camera.streamId
    } else if (!isPresenter) {
      cameraStreamId = streamIds[0] ?? null
    } else if (existingDisplayStreamId) {
      cameraStreamId = streamIds.find((id) => id !== existingDisplayStreamId) ?? null
    } else if (streamIds.length > 1) {
      cameraStreamId = streamIds.at(-1) ?? null
    }
  }
  const displayStreamId =
    streamIds.find((id) => id !== cameraStreamId) ??
    (isPresenter && !cameraStreamId ? (streamIds[0] ?? null) : null)
  return { cameraStreamId, displayStreamId }
}

export const routeMeshSignal = (params: {
  localPeerId: string
  coordinatorId: string
  to: string
  from: string
  connectedPeerIds: string[]
}): MeshRoute => {
  if (params.to === params.from) return 'drop'
  if (params.to === params.localPeerId) return 'deliver-local'
  if (
    params.localPeerId === params.coordinatorId &&
    params.connectedPeerIds.includes(params.to) &&
    params.to !== params.localPeerId
  ) {
    return 'forward'
  }
  return 'drop'
}
