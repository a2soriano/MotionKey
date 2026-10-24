import { describe, expect, it } from 'vitest'
import { classifyHand, getPoseSignature, signatureDistance, type Landmark } from './vision'

const openHand: Landmark[] = [
  [0.5, 0.9], [0.4, 0.85], [0.3, 0.7], [0.25, 0.6], [0.2, 0.5],
  [0.4, 0.6], [0.4, 0.4], [0.4, 0.25], [0.4, 0.1],
  [0.5, 0.57], [0.5, 0.35], [0.5, 0.2], [0.5, 0.05],
  [0.6, 0.6], [0.6, 0.4], [0.6, 0.25], [0.6, 0.1],
  [0.7, 0.65], [0.7, 0.45], [0.7, 0.3], [0.7, 0.2],
].map(([x, y]) => ({ x, y, z: 0 }))

function foldedHand(extended: number[] = []) {
  const points = openHand.map(point => ({ ...point }))
  for (const mcp of [5, 9, 13, 17]) {
    if (extended.includes(mcp)) continue
    points[mcp + 1] = { ...points[mcp], y: points[mcp].y - 0.13 }
    points[mcp + 2] = { ...points[mcp], y: points[mcp].y - 0.04, z: -0.04 }
    points[mcp + 3] = { ...points[mcp], y: points[mcp].y + 0.035, z: -0.025 }
  }
  points[4] = { x: 0.45, y: 0.62, z: 0 }
  return points
}

describe('custom pose signatures', () => {
  it('matches the same hand after translation, scale, and in-plane rotation', () => {
    const rotation = 0.8
    const moved = openHand.map(({ x, y, z }) => ({
      x: 2 * (x * Math.cos(rotation) - y * Math.sin(rotation)) + 5,
      y: 2 * (x * Math.sin(rotation) + y * Math.cos(rotation)) - 3,
      z: z * 2 + 1,
    }))
    expect(signatureDistance(getPoseSignature(openHand), getPoseSignature(moved))).toBeLessThan(1e-10)
  })

  it('separates an open hand from a closed fist', () => {
    expect(signatureDistance(getPoseSignature(openHand), getPoseSignature(foldedHand()))).toBeGreaterThan(0.25)
  })

  it('rejects missing, incompatible, and non-finite signatures', () => {
    expect(getPoseSignature([])).toEqual([])
    expect(signatureDistance([], [])).toBe(Infinity)
    expect(signatureDistance([1], [1, 2])).toBe(Infinity)
    expect(signatureDistance([NaN], [1])).toBe(Infinity)
    expect(signatureDistance([1], [Infinity])).toBe(Infinity)
  })
})

describe('hand pose classification', () => {
  it('recognizes an open palm and closed fist from landmark geometry', () => {
    expect(classifyHand(openHand)?.id).toBe('open_palm')
    expect(classifyHand(foldedHand())?.id).toBe('closed_fist')
  })

  it('distinguishes a pointing finger, victory sign, and pinch', () => {
    const point = foldedHand([5])
    point[4] = { x: 0.2, y: 0.5, z: 0 }
    expect(classifyHand(point)?.id).toBe('pointing_up')
    expect(classifyHand(foldedHand([5, 9]))?.id).toBe('victory')
    const pinch = openHand.map(point => ({ ...point }))
    pinch[4] = { ...pinch[8] }
    expect(classifyHand(pinch)?.id).toBe('pinch')
  })

  it('recognizes an extended upward thumb on a closed hand', () => {
    const thumb = foldedHand()
    thumb[1] = { x: 0.4, y: 0.82, z: 0 }
    thumb[2] = { x: 0.35, y: 0.7, z: 0 }
    thumb[3] = { x: 0.35, y: 0.5, z: 0 }
    thumb[4] = { x: 0.35, y: 0.35, z: 0 }
    expect(classifyHand(thumb)?.id).toBe('thumbs_up')
  })

  it('ignores incomplete and collapsed landmarks', () => {
    expect(classifyHand(openHand.slice(0, 10))).toBe(null)
    expect(classifyHand(Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })))).toBe(null)
  })
})
