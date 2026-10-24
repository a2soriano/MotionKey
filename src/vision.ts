import { FaceLandmarker, FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'

export type GestureId =
  | 'open_palm'
  | 'closed_fist'
  | 'victory'
  | 'thumbs_up'
  | 'pointing_up'
  | 'pinch'
  | 'swipe_left'
  | 'swipe_right'
  | 'smile'
  | 'head_left'
  | 'head_right'
  | 'blink'

export interface Landmark { x: number; y: number; z: number }
export interface HandSnapshot {
  landmarks: Landmark[]
  handedness: string
  label: string
}
export interface GestureCandidate {
  id: GestureId | string
  confidence: number
  /** Motion events are brief; consume once without a sustained-pose dwell. */
  transient?: boolean
}
export interface VisionFrame {
  hands: HandSnapshot[]
  face: { present: boolean; landmarks: Landmark[]; expression: string } | null
  candidates: GestureCandidate[]
  fps: number
}
export interface VisionOptions {
  faceEnabled: boolean
  onError?: (error: Error) => void
}
export interface VisionTracker { stop(): void }

const distance = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const subtract = (a: Landmark, b: Landmark): Landmark => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Landmark, b: Landmark) => a.x * b.x + a.y * b.y + a.z * b.z
const scaleVector = (a: Landmark, n: number): Landmark => ({ x: a.x * n, y: a.y * n, z: a.z * n })
const normalize = (a: Landmark): Landmark => scaleVector(a, 1 / Math.max(0.00001, Math.hypot(a.x, a.y, a.z)))
const cross = (a: Landmark, b: Landmark): Landmark => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

/** Wrist-relative, palm-scale and rotation-normalized coordinates for custom poses. */
export function getPoseSignature(landmarks: Landmark[]): number[] {
  if (landmarks.length !== 21) return []
  const origin = landmarks[0]
  const palm = Math.max(distance(origin, landmarks[9]), 0.00001)
  const yAxis = normalize(subtract(landmarks[9], origin))
  const across = subtract(landmarks[5], landmarks[17])
  const xAxis = normalize(subtract(across, scaleVector(yAxis, dot(across, yAxis))))
  const zAxis = normalize(cross(xAxis, yAxis))
  return landmarks.flatMap(point => {
    const relative = subtract(point, origin)
    return [dot(relative, xAxis) / palm, dot(relative, yAxis) / palm, dot(relative, zAxis) / palm]
  })
}

/** Root mean square difference. Typical matching poses fall below 0.18–0.25. */
export function signatureDistance(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length || a.some(n => !Number.isFinite(n)) || b.some(n => !Number.isFinite(n))) return Infinity
  return Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0) / a.length)
}

function angle(a: Landmark, joint: Landmark, b: Landmark): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(normalize(subtract(a, joint)), normalize(subtract(b, joint)))))) * 180 / Math.PI
}

export function classifyHand(points: Landmark[]): { id: GestureId; confidence: number } | null {
  if (points.length !== 21 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z))) return null
  const palm = distance(points[0], points[9])
  if (palm < 0.015) return null
  const extended = [5, 9, 13, 17].map(mcp => (
    angle(points[mcp], points[mcp + 1], points[mcp + 3]) > 154 &&
    distance(points[0], points[mcp + 3]) > distance(points[0], points[mcp + 1]) * 1.1
  ))
  const [index, middle, ring, pinky] = extended
  const thumb = angle(points[1], points[2], points[4]) > 145 && distance(points[4], points[5]) > palm * 0.55
  const pinch = distance(points[4], points[8]) / palm
  if (pinch < 0.28 && (middle || ring || pinky)) return { id: 'pinch', confidence: Math.min(0.99, 0.84 + (0.28 - pinch) * 0.5) }
  if (index && middle && ring && pinky) return { id: 'open_palm', confidence: thumb ? 0.97 : 0.89 }
  if (index && middle && !ring && !pinky && distance(points[8], points[12]) > palm * 0.3) return { id: 'victory', confidence: 0.94 }
  if (index && !middle && !ring && !pinky && pinch > 0.35) return { id: 'pointing_up', confidence: 0.93 }
  if (!index && !middle && !ring && !pinky) {
    if (thumb && points[4].y < points[2].y - palm * 0.22) return { id: 'thumbs_up', confidence: 0.94 }
    return { id: 'closed_fist', confidence: 0.91 }
  }
  return null
}

/**
 * Runs real MediaPipe inference against an already-playing video. The caller owns
 * camera permissions and MediaStream cleanup. stop() cancels inference and closes
 * both models. Models and WASM are served by the app; frames never leave the device.
 */
export async function createVisionTracker(
  video: HTMLVideoElement,
  onFrame: (frame: VisionFrame) => void,
  options: VisionOptions,
): Promise<VisionTracker> {
  const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
  let hands: HandLandmarker | undefined
  let face: FaceLandmarker | undefined
  try {
    // CPU delegate avoids depending on GPU/WebGL availability in browser sessions.
    hands = await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    })
    if (options.faceEnabled) {
      face = await FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.6,
        minFacePresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      })
    }
  } catch (error) {
    hands?.close()
    face?.close()
    throw error
  }

  let stopped = false
  let animationFrame = 0
  let lastVideoTime = -1
  let lastInference = 0
  let fps = 0
  let lastFace: VisionFrame['face'] = null
  let lastFaceCandidates: GestureCandidate[] = []
  let lastFaceTime = 0
  let lastSwipeTime = 0
  let swipe: { id: GestureId; until: number } | null = null
  const history = new Map<string, { x: number; y: number; time: number }[]>()

  const stop = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(animationFrame)
    hands?.close()
    face?.close()
    history.clear()
  }

  const tick = (now: number) => {
    if (stopped) return
    animationFrame = requestAnimationFrame(tick)
    // Cap at 24fps; avoid running the face model more than ~10fps.
    if (video.readyState < 2 || video.currentTime === lastVideoTime || now - lastInference < 1000 / 24) return
    const elapsed = now - lastInference
    fps = lastInference ? fps * 0.8 + 1000 / elapsed * 0.2 : 0
    lastInference = now
    lastVideoTime = video.currentTime
    try {
      const result = hands!.detectForVideo(video, now)
      const candidates: GestureCandidate[] = []
      const activeHands = new Set<string>()
      const handFrames: HandSnapshot[] = result.landmarks.map((landmarks, index) => {
        const handedness = result.handedness[index]?.[0]?.categoryName ?? `Hand ${index + 1}`
        const pose = classifyHand(landmarks)
        if (pose) candidates.push(pose)
        activeHands.add(handedness)
        const center = landmarks[9]
        const trail = history.get(handedness) ?? []
        trail.push({ x: center.x, y: center.y, time: now })
        while (trail.length && now - trail[0].time > 350) trail.shift()
        history.set(handedness, trail)
        const first = trail[0]
        const dx = center.x - first.x
        const dy = center.y - first.y
        if (trail.length >= 3 && now - first.time >= 100 && now - lastSwipeTime > 900 && Math.abs(dx) > 0.2 && Math.abs(dx) > Math.abs(dy) * 1.7) {
          // Camera preview is mirrored, so screen-space left is increasing x.
          swipe = { id: dx > 0 ? 'swipe_left' : 'swipe_right', until: now + 280 }
          lastSwipeTime = now
          trail.length = 0
        }
        return { landmarks, handedness, label: pose?.id ?? 'Hand detected' }
      })
      for (const key of history.keys()) if (!activeHands.has(key)) history.delete(key)
      if (swipe && swipe.until > now) candidates.unshift({ id: swipe.id, confidence: 0.94, transient: true })

      if (face && now - lastFaceTime > 100) {
        lastFaceTime = now
        const faceResult = face.detectForVideo(video, now)
        const landmarks = faceResult.faceLandmarks[0]
        lastFaceCandidates = []
        if (landmarks) {
          const blendshapes = faceResult.faceBlendshapes[0]?.categories ?? []
          const score = (name: string) => blendshapes.find(item => item.categoryName === name)?.score ?? 0
          const smile = (score('mouthSmileLeft') + score('mouthSmileRight')) / 2
          const blink = Math.min(score('eyeBlinkLeft'), score('eyeBlinkRight'))
          let expression = 'Neutral'
          if (smile > 0.5) {
            lastFaceCandidates.push({ id: 'smile', confidence: 0.85 + (smile - 0.5) * 0.28 })
            expression = 'Smiling'
          }
          if (blink > 0.55) {
            lastFaceCandidates.push({ id: 'blink', confidence: 0.85 + (blink - 0.55) * 0.3, transient: true })
            expression = 'Eyes closed'
          }
          // Nose position between cheeks gives a size-independent head-turn ratio.
          const cheekLeft = landmarks[234]
          const cheekRight = landmarks[454]
          const nose = landmarks[1]
          const faceWidth = Math.abs(cheekRight.x - cheekLeft.x)
          if (faceWidth > 0.03) {
            const turn = (nose.x - (cheekLeft.x + cheekRight.x) / 2) / faceWidth
            if (Math.abs(turn) > 0.13) {
              const id = turn > 0 ? 'head_left' : 'head_right'
              lastFaceCandidates.push({ id, confidence: Math.min(0.99, 0.86 + (Math.abs(turn) - 0.13) * 0.4) })
              expression = id === 'head_left' ? 'Looking left' : 'Looking right'
            }
          }
          lastFace = { present: true, landmarks, expression }
        } else lastFace = { present: false, landmarks: [], expression: 'No face detected' }
      }
      onFrame({ hands: handFrames, face: lastFace, candidates: [...candidates, ...lastFaceCandidates], fps: Math.round(fps) })
    } catch (error) {
      stop()
      options.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
  animationFrame = requestAnimationFrame(tick)
  return { stop }
}
