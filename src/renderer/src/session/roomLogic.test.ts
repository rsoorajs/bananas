import { describe, expect, it } from 'vitest'
import {
  answersMatchOffer,
  canStartVote,
  castVote,
  electCoordinator,
  nextCoordinator,
  pickRemoteCameraAndDisplay,
  routeMeshSignal,
  sessionEndedReasonAfterDeparture,
  startVote,
  uniquePeersById,
  voteOutcome,
} from './roomLogic'
import { VOTE_COOLDOWN_MS, VOTE_TIMEOUT_MS, truncateChatText } from './constants'

describe('vote', () => {
  it('approves when every other peer votes yes', () => {
    const vote = startVote({
      voteId: 'v1',
      candidateId: 'a',
      now: 0,
      timeoutMs: VOTE_TIMEOUT_MS,
      peerIds: ['a', 'b', 'c'],
    })
    const afterB = castVote(vote, 'b', true)
    expect(voteOutcome(afterB, 1)).toBe('pending')
    const afterC = castVote(afterB, 'c', true)
    expect(voteOutcome(afterC, 1)).toBe('approved')
  })

  it('rejects on any no, timeout, or duplicate ignore', () => {
    const vote = startVote({
      voteId: 'v1',
      candidateId: 'a',
      now: 0,
      timeoutMs: 1000,
      peerIds: ['a', 'b'],
    })
    expect(voteOutcome(vote, 1000)).toBe('rejected')
    const denied = castVote(vote, 'b', false)
    expect(voteOutcome(denied, 1)).toBe('rejected')
    expect(castVote(denied, 'b', true)).toEqual(denied)
  })

  it('auto-approves when the candidate is alone', () => {
    const vote = startVote({
      voteId: 'v1',
      candidateId: 'a',
      now: 0,
      timeoutMs: 1000,
      peerIds: ['a'],
    })
    expect(voteOutcome(vote, 0)).toBe('approved')
  })

  it('blocks a new vote while one is active or cooling down', () => {
    const vote = startVote({
      voteId: 'v1',
      candidateId: 'a',
      now: 0,
      timeoutMs: VOTE_TIMEOUT_MS,
      peerIds: ['a', 'b'],
    })
    expect(
      canStartVote({
        now: 1,
        cooldownUntil: 0,
        activeVote: vote,
        requesterId: 'b',
        presenterId: 'a',
      }),
    ).toBe(false)
    expect(
      canStartVote({
        now: 10,
        cooldownUntil: 10 + VOTE_COOLDOWN_MS,
        activeVote: null,
        requesterId: 'b',
        presenterId: 'a',
      }),
    ).toBe(false)
    expect(
      canStartVote({
        now: 1,
        cooldownUntil: 0,
        activeVote: null,
        requesterId: 'a',
        presenterId: 'a',
      }),
    ).toBe(false)
    expect(
      canStartVote({
        now: 1,
        cooldownUntil: 0,
        activeVote: null,
        requesterId: 'b',
        presenterId: 'a',
      }),
    ).toBe(true)
  })
})

describe('election', () => {
  it('elects the smallest peer id', () => {
    expect(electCoordinator(['c', 'a', 'b'])).toBe('a')
    expect(electCoordinator([])).toBeNull()
  })

  it('prefers an explicit handoff when that peer remains', () => {
    expect(
      nextCoordinator({
        remainingPeerIds: ['a', 'b'],
        handoffId: 'b',
      }),
    ).toBe('b')
    expect(
      nextCoordinator({
        remainingPeerIds: ['a'],
        handoffId: 'gone',
      }),
    ).toBe('a')
  })
})

describe('session ended reason', () => {
  it('uses host-ended when the coordinator broadcast it', () => {
    expect(
      sessionEndedReasonAfterDeparture({
        sessionEndedBroadcast: true,
        remainingRemoteCount: 2,
      }),
    ).toBe('host-ended')
  })

  it('uses everyone-left when no remotes remain', () => {
    expect(
      sessionEndedReasonAfterDeparture({
        sessionEndedBroadcast: false,
        remainingRemoteCount: 0,
      }),
    ).toBe('everyone-left')
  })

  it('keeps the room up when peers remain', () => {
    expect(
      sessionEndedReasonAfterDeparture({
        sessionEndedBroadcast: false,
        remainingRemoteCount: 1,
      }),
    ).toBeNull()
  })
})

describe('mesh routing', () => {
  it('delivers to self, forwards from coordinator, and drops otherwise', () => {
    expect(
      routeMeshSignal({
        localPeerId: 'b',
        coordinatorId: 'a',
        from: 'c',
        to: 'b',
        connectedPeerIds: ['a'],
      }),
    ).toBe('deliver-local')
    expect(
      routeMeshSignal({
        localPeerId: 'a',
        coordinatorId: 'a',
        from: 'c',
        to: 'b',
        connectedPeerIds: ['b', 'c'],
      }),
    ).toBe('forward')
    expect(
      routeMeshSignal({
        localPeerId: 'a',
        coordinatorId: 'a',
        from: 'c',
        to: 'b',
        connectedPeerIds: ['c'],
      }),
    ).toBe('drop')
    expect(
      routeMeshSignal({
        localPeerId: 'b',
        coordinatorId: 'a',
        from: 'c',
        to: 'c',
        connectedPeerIds: ['a'],
      }),
    ).toBe('drop')
  })
})

describe('sdp origin matching', () => {
  it('matches offer and answer session ids', () => {
    const offer = 'v=0\r\no=- 123 2 IN IP4 0.0.0.0\r\n'
    const answer = 'v=0\r\no=- 123 3 IN IP4 0.0.0.0\r\n'
    expect(answersMatchOffer(offer, answer)).toBe(true)
    expect(answersMatchOffer(offer, 'v=0\r\no=- 999 3 IN IP4 0.0.0.0\r\n')).toBe(false)
  })
})

describe('chat text', () => {
  it('truncates oversize text', () => {
    expect(truncateChatText('hello')).toBe('hello')
    expect(truncateChatText('x'.repeat(2001)).length).toBe(2000)
  })
})

describe('uniquePeersById', () => {
  it('keeps the first entry for a repeated id', () => {
    expect(
      uniquePeersById([
        { id: 'host', username: 'Kiwi' },
        { id: 'guest', username: 'Joiner' },
        { id: 'host', username: 'Kiwi-dup' },
      ]),
    ).toEqual([
      { id: 'host', username: 'Kiwi' },
      { id: 'guest', username: 'Joiner' },
    ])
  })
})

describe('pickRemoteCameraAndDisplay', () => {
  it('uses the announced stream id when it is present', () => {
    expect(
      pickRemoteCameraAndDisplay({
        streamIds: ['display', 'camera'],
        camera: { enabled: true, streamId: 'camera' },
        isPresenter: true,
      }),
    ).toEqual({ cameraStreamId: 'camera', displayStreamId: 'display' })
  })

  it('treats a non-presenter video as the camera when ids do not match', () => {
    expect(
      pickRemoteCameraAndDisplay({
        streamIds: ['recv-1'],
        camera: { enabled: true, streamId: 'sender-id' },
        isPresenter: false,
      }),
    ).toEqual({ cameraStreamId: 'recv-1', displayStreamId: null })
  })

  it('picks the non-display video as camera for a presenter', () => {
    expect(
      pickRemoteCameraAndDisplay({
        streamIds: ['screen', 'webcam'],
        camera: { enabled: true, streamId: 'missing' },
        isPresenter: true,
        existingDisplayStreamId: 'screen',
      }),
    ).toEqual({ cameraStreamId: 'webcam', displayStreamId: 'screen' })
  })
})
