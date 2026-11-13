import { describe, it, expect } from 'vitest'
import { PeerMetricsTracker, computeFailureCooldownMs } from './peer-metrics.js'

describe('computeFailureCooldownMs', () => {
  it('returns 0 while the streak is within tolerance', () => {
    expect(computeFailureCooldownMs(0)).toBe(0)
    expect(computeFailureCooldownMs(1)).toBe(0)
    expect(computeFailureCooldownMs(2)).toBe(0)
  })

  it('doubles the cooldown for each failure past the threshold', () => {
    expect(computeFailureCooldownMs(3)).toBe(30_000)
    expect(computeFailureCooldownMs(4)).toBe(60_000)
    expect(computeFailureCooldownMs(5)).toBe(120_000)
    expect(computeFailureCooldownMs(6)).toBe(240_000)
    expect(computeFailureCooldownMs(7)).toBe(480_000)
  })

  it('caps the doubling at 8 minutes no matter how long the streak runs', () => {
    expect(computeFailureCooldownMs(8)).toBe(480_000)
    expect(computeFailureCooldownMs(20)).toBe(480_000)
    expect(computeFailureCooldownMs(1_000)).toBe(480_000)
  })

  it('honours custom thresholds', () => {
    expect(computeFailureCooldownMs(2, { maxFailures: 2, baseCooldownMs: 500 })).toBe(500)
    expect(computeFailureCooldownMs(3, { maxFailures: 2, baseCooldownMs: 500 })).toBe(1_000)
    expect(computeFailureCooldownMs(9, { maxFailures: 2, baseCooldownMs: 500, maxDoublings: 1 })).toBe(1_000)
  })

  it('treats a non-finite streak as no cooldown', () => {
    expect(computeFailureCooldownMs(Number.NaN)).toBe(0)
    expect(computeFailureCooldownMs(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('PeerMetricsTracker', () => {
  describe('latency EMA calculation', () => {
    it('initializes EMA to the first latency value', () => {
      const tracker = new PeerMetricsTracker()
      tracker.recordResult('peer1', { success: true, latencyMs: 100 })

      const metrics = tracker.getMetrics('peer1')
      // First call: prev = 100 (default to result), EMA = 100 * 0.7 + 100 * 0.3 = 100
      expect(metrics.latencyEma).toBe(100)
    })

    it('applies exponential moving average on subsequent results', () => {
      const tracker = new PeerMetricsTracker({ latencyAlpha: 0.3 })
      tracker.recordResult('peer1', { success: true, latencyMs: 100 })
      tracker.recordResult('peer1', { success: true, latencyMs: 200 })

      const metrics = tracker.getMetrics('peer1')
      // After first: EMA = 100
      // After second: EMA = 100 * 0.7 + 200 * 0.3 = 70 + 60 = 130
      expect(metrics.latencyEma).toBe(130)
    })

    it('respects custom latencyAlpha', () => {
      const tracker = new PeerMetricsTracker({ latencyAlpha: 0.5 })
      tracker.recordResult('peer1', { success: true, latencyMs: 100 })
      tracker.recordResult('peer1', { success: true, latencyMs: 200 })

      const metrics = tracker.getMetrics('peer1')
      // After first: EMA = 100
      // After second: EMA = 100 * 0.5 + 200 * 0.5 = 150
      expect(metrics.latencyEma).toBe(150)
    })
  })

  describe('failure streak tracking', () => {
    it('increments failure streak on consecutive failures', () => {
      const tracker = new PeerMetricsTracker()
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })

      const metrics = tracker.getMetrics('peer1')
      expect(metrics.failureStreak).toBe(2)
      expect(metrics.totalFailures).toBe(2)
      expect(metrics.totalAttempts).toBe(2)
    })

    it('success resets failure streak', () => {
      const tracker = new PeerMetricsTracker()
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      tracker.recordResult('peer1', { success: true, latencyMs: 100 })

      const metrics = tracker.getMetrics('peer1')
      expect(metrics.failureStreak).toBe(0)
      // Total failures and attempts remain
      expect(metrics.totalFailures).toBe(2)
      expect(metrics.totalAttempts).toBe(3)
    })

    it('tracks total failures independently from streak', () => {
      const tracker = new PeerMetricsTracker()
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      tracker.recordResult('peer1', { success: true, latencyMs: 100 })
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })

      const metrics = tracker.getMetrics('peer1')
      expect(metrics.failureStreak).toBe(1)
      expect(metrics.totalFailures).toBe(2)
      expect(metrics.totalAttempts).toBe(3)
    })
  })

  describe('cooldown timing', () => {
    it('enters cooldown after maxFailures consecutive failures', () => {
      let now = 1_000_000
      const tracker = new PeerMetricsTracker({
        maxFailures: 2,
        failureCooldownMs: 500,
        now: () => now,
      })

      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      expect(tracker.isCoolingDown('peer1')).toBe(false)

      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      expect(tracker.isCoolingDown('peer1')).toBe(true)
    })

    it('cooldown expires after failureCooldownMs', () => {
      let now = 1_000_000
      const tracker = new PeerMetricsTracker({
        maxFailures: 2,
        failureCooldownMs: 500,
        now: () => now,
      })

      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      expect(tracker.isCoolingDown('peer1')).toBe(true)

      now += 501
      expect(tracker.isCoolingDown('peer1')).toBe(false)
    })

    it('success clears cooldown', () => {
      let now = 1_000_000
      const tracker = new PeerMetricsTracker({
        maxFailures: 2,
        failureCooldownMs: 500,
        now: () => now,
      })

      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      expect(tracker.isCoolingDown('peer1')).toBe(true)

      tracker.recordResult('peer1', { success: true, latencyMs: 100 })
      expect(tracker.isCoolingDown('peer1')).toBe(false)
    })

    it('applies exponential backoff for repeated failure streaks beyond threshold', () => {
      let now = 1_000_000
      const tracker = new PeerMetricsTracker({
        maxFailures: 2,
        failureCooldownMs: 500,
        now: () => now,
      })

      // 2 failures: cooldown = 500 * 2^0 = 500
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })

      const metrics2 = tracker.getMetrics('peer1')
      expect(metrics2.cooldownUntil).toBe(now + 500)

      // 3rd failure: cooldown = 500 * 2^1 = 1000
      now += 501 // past first cooldown
      tracker.recordResult('peer1', { success: false, latencyMs: 100 })

      const metrics3 = tracker.getMetrics('peer1')
      expect(metrics3.cooldownUntil).toBe(now + 1000)
    })
  })

  describe('median latency', () => {
    it('returns 500 when no latencies recorded', () => {
      const tracker = new PeerMetricsTracker()
      expect(tracker.getMedianLatency()).toBe(500)
    })

    it('returns single value when only one peer has latency', () => {
      const tracker = new PeerMetricsTracker()
      tracker.recordResult('peer1', { success: true, latencyMs: 200 })
      expect(tracker.getMedianLatency()).toBe(200)
    })

    it('returns median of odd number of values', () => {
      const tracker = new PeerMetricsTracker()
      tracker.recordResult('peer1', { success: true, latencyMs: 100 })
      tracker.recordResult('peer2', { success: true, latencyMs: 300 })
      tracker.recordResult('peer3', { success: true, latencyMs: 200 })

      expect(tracker.getMedianLatency()).toBe(200)
    })

    it('returns average of two middle values for even count', () => {
      const tracker = new PeerMetricsTracker()
      tracker.recordResult('peer1', { success: true, latencyMs: 100 })
      tracker.recordResult('peer2', { success: true, latencyMs: 200 })
      tracker.recordResult('peer3', { success: true, latencyMs: 300 })
      tracker.recordResult('peer4', { success: true, latencyMs: 400 })

      expect(tracker.getMedianLatency()).toBe(250)
    })
  })

  describe('getMetrics', () => {
    it('returns zeroed metrics for unknown peer', () => {
      const tracker = new PeerMetricsTracker()
      const metrics = tracker.getMetrics('unknown')

      expect(metrics.latencyEma).toBeUndefined()
      expect(metrics.failureStreak).toBe(0)
      expect(metrics.totalFailures).toBe(0)
      expect(metrics.totalAttempts).toBe(0)
      expect(metrics.cooldownUntil).toBeUndefined()
    })
  })
})
