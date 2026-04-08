import './style.css'
import * as THREE from 'three'
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ChromaticAberrationEffect, VignetteEffect } from 'postprocessing'

// ============================================
// RENDERER
// ============================================
const canvas = document.getElementById('c')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.2

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x000000)

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100)
camera.position.z = 3.5

// ============================================
// AUDIO ANALYZER
// ============================================
let audioCtx, analyser, freqData, audioLevel = 0, bassLevel = 0, trebleLevel = 0

function initAudio(useMic = false) {
  if (audioCtx) return
  audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  analyser = audioCtx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.8
  freqData = new Uint8Array(analyser.frequencyBinCount)

  if (useMic) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const src = audioCtx.createMediaStreamSource(stream)
      src.connect(analyser)
      document.getElementById('btn-mic').classList.add('active')
    })
  } else {
    // Generate procedural ambient drone
    const osc1 = audioCtx.createOscillator()
    osc1.type = 'sine'
    osc1.frequency.value = 60
    const osc2 = audioCtx.createOscillator()
    osc2.type = 'triangle'
    osc2.frequency.value = 90
    const osc3 = audioCtx.createOscillator()
    osc3.type = 'sawtooth'
    osc3.frequency.value = 45

    const lfo = audioCtx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 0.2
    const lfoGain = audioCtx.createGain()
    lfoGain.gain.value = 15
    lfo.connect(lfoGain).connect(osc1.frequency)
    lfo.connect(lfoGain).connect(osc2.frequency)
    lfo.start()

    const filter = audioCtx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 200
    filter.Q.value = 8

    const gain = audioCtx.createGain()
    gain.gain.value = 0.3

    ;[osc1, osc2, osc3].forEach((o) => {
      o.connect(filter)
      o.start()
    })
    filter.connect(gain).connect(analyser)
    analyser.connect(audioCtx.destination)

    document.getElementById('btn-audio').classList.add('active')
  }
}

function updateAudio() {
  if (!analyser) return
  analyser.getByteFrequencyData(freqData)

  let sum = 0, bass = 0, treble = 0
  const len = freqData.length
  for (let i = 0; i < len; i++) {
    sum += freqData[i]
    if (i < len * 0.25) bass += freqData[i]
    if (i > len * 0.75) treble += freqData[i]
  }
  audioLevel = (sum / len) / 255
  bassLevel = (bass / (len * 0.25)) / 255
  trebleLevel = (treble / (len * 0.25)) / 255
}

// Buttons
document.getElementById('btn-mic').addEventListener('click', () => initAudio(true))
document.getElementById('btn-audio').addEventListener('click', () => initAudio(false))

// ============================================
// FLUID SIMULATION (GPU via render targets)
// ============================================
const FLUID_SIZE = 256
const fluidScene = new THREE.Scene()
const fluidCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

// Ping-pong render targets
const rtOpts = { format: THREE.RGBAFormat, type: THREE.FloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
let rtA = new THREE.WebGLRenderTarget(FLUID_SIZE, FLUID_SIZE, rtOpts)
let rtB = new THREE.WebGLRenderTarget(FLUID_SIZE, FLUID_SIZE, rtOpts)

const fluidMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPrev: { value: null },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uMousePrev: { value: new THREE.Vector2(0.5, 0.5) },
    uMouseDown: { value: 0.0 },
    uDt: { value: 0.016 },
    uDissipation: { value: 0.97 },
    uAudioLevel: { value: 0.0 },
    uBassLevel: { value: 0.0 },
    uResolution: { value: new THREE.Vector2(FLUID_SIZE, FLUID_SIZE) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
  `,
  fragmentShader: `
    precision highp float;
    uniform sampler2D uPrev;
    uniform vec2 uMouse;
    uniform vec2 uMousePrev;
    uniform float uMouseDown;
    uniform float uDt;
    uniform float uDissipation;
    uniform float uAudioLevel;
    uniform float uBassLevel;
    uniform vec2 uResolution;
    varying vec2 vUv;

    vec2 hash(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
    }

    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(dot(hash(i), f), dot(hash(i + vec2(1,0)), f - vec2(1,0)), u.x),
                 mix(dot(hash(i + vec2(0,1)), f - vec2(0,1)), dot(hash(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
    }

    void main() {
      vec2 texel = 1.0 / uResolution;

      // Sample neighbors for advection
      vec4 prev = texture2D(uPrev, vUv);
      vec4 left = texture2D(uPrev, vUv - vec2(texel.x, 0.0));
      vec4 right = texture2D(uPrev, vUv + vec2(texel.x, 0.0));
      vec4 up = texture2D(uPrev, vUv + vec2(0.0, texel.y));
      vec4 down = texture2D(uPrev, vUv - vec2(0.0, texel.y));

      // Velocity from pressure differences
      vec2 velocity = vec2(right.x - left.x, up.x - down.x) * 0.5;

      // Advect: sample from where the fluid came from
      vec2 advectedUv = vUv - velocity * uDt * 8.0;
      vec4 advected = texture2D(uPrev, advectedUv);

      // Mouse force — splat
      vec2 mouseDelta = uMouse - uMousePrev;
      float mouseForce = length(mouseDelta) * 20.0;
      float dist = distance(vUv, uMouse);
      float splatRadius = 0.05 + uBassLevel * 0.03;
      float splat = exp(-dist * dist / (splatRadius * splatRadius)) * mouseForce;
      splat += exp(-dist * dist / (0.02 * 0.02)) * uMouseDown * 2.0; // click impulse

      // Audio-reactive turbulence
      float turb = noise(vUv * 8.0 + prev.xy * 2.0) * uAudioLevel * 0.3;

      // Combine
      vec4 result = advected * uDissipation;
      result.xy += mouseDelta * splat * 3.0;
      result.z += splat * 0.5 + turb;
      result.w = max(result.z, result.w * 0.98); // peak tracker

      gl_FragColor = result;
    }
  `,
})

const fluidQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fluidMaterial)
fluidScene.add(fluidQuad)

// ============================================
// MAIN GEOMETRY — Icosahedron with displacement
// ============================================
const icoGeo = new THREE.IcosahedronGeometry(1.5, 64)

const icoMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uFluid: { value: null },
    uAudioLevel: { value: 0 },
    uBassLevel: { value: 0 },
    uTrebleLevel: { value: 0 },
    uColor1: { value: new THREE.Color(0x00ffcc) },
    uColor2: { value: new THREE.Color(0x6600ff) },
    uColor3: { value: new THREE.Color(0xff0066) },
  },
  vertexShader: `
    uniform float uTime;
    uniform sampler2D uFluid;
    uniform float uAudioLevel;
    uniform float uBassLevel;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying float vDisplacement;

    // Simplex-ish noise
    vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

    float snoise(vec3 v) {
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4(0.0, i1.y, i2.y, 1.0))
        + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0)*2.0 + 1.0;
      vec4 s1 = floor(b1)*2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }

    void main() {
      vUv = uv;
      vNormal = normal;

      // Multi-octave noise displacement
      float t = uTime * 0.3;
      vec3 noisePos = position * 1.5 + t;
      float n1 = snoise(noisePos) * 0.4;
      float n2 = snoise(noisePos * 2.0 + 100.0) * 0.2;
      float n3 = snoise(noisePos * 4.0 + 200.0) * 0.1;

      float displacement = (n1 + n2 + n3);

      // Audio boost
      displacement *= 1.0 + uBassLevel * 1.5;
      displacement += uAudioLevel * 0.15;

      // Sample fluid for extra displacement
      vec2 fluidUv = uv;
      vec4 fluid = texture2D(uFluid, fluidUv);
      displacement += fluid.z * 0.3;

      vDisplacement = displacement;
      vec3 newPos = position + normal * displacement;
      vPosition = newPos;

      gl_Position = projectionMatrix * modelViewMatrix * vec4(newPos, 1.0);
    }
  `,
  fragmentShader: `
    precision highp float;
    uniform float uTime;
    uniform float uAudioLevel;
    uniform float uTrebleLevel;
    uniform vec3 uColor1;
    uniform vec3 uColor2;
    uniform vec3 uColor3;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying float vDisplacement;

    // Bayer 4x4 dithering matrix
    float bayer4(vec2 pos) {
      int x = int(mod(pos.x, 4.0));
      int y = int(mod(pos.y, 4.0));
      int index = x + y * 4;
      // Bayer matrix values
      if (index == 0) return 0.0/16.0;
      if (index == 1) return 8.0/16.0;
      if (index == 2) return 2.0/16.0;
      if (index == 3) return 10.0/16.0;
      if (index == 4) return 12.0/16.0;
      if (index == 5) return 4.0/16.0;
      if (index == 6) return 14.0/16.0;
      if (index == 7) return 6.0/16.0;
      if (index == 8) return 3.0/16.0;
      if (index == 9) return 11.0/16.0;
      if (index == 10) return 1.0/16.0;
      if (index == 11) return 9.0/16.0;
      if (index == 12) return 15.0/16.0;
      if (index == 13) return 7.0/16.0;
      if (index == 14) return 13.0/16.0;
      if (index == 15) return 5.0/16.0;
      return 0.0;
    }

    void main() {
      // Fresnel
      vec3 viewDir = normalize(cameraPosition - vPosition);
      float fresnel = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 3.0);

      // Color based on displacement + fresnel
      float t = vDisplacement * 2.0 + 0.5;
      vec3 col = mix(uColor1, uColor2, smoothstep(0.0, 0.5, t));
      col = mix(col, uColor3, smoothstep(0.5, 1.0, t));

      // Audio color shift
      col += vec3(uTrebleLevel * 0.3, 0.0, uAudioLevel * 0.2);

      // Emissive glow from displacement peaks
      float emission = smoothstep(0.2, 0.5, abs(vDisplacement)) * 1.5;
      col *= 1.0 + emission;

      // Fresnel rim
      col += vec3(0.3, 0.5, 1.0) * fresnel * 0.8;

      // === BAYER DITHERING ===
      vec2 screenPos = gl_FragCoord.xy;
      float ditherGrid = 3.0 + uAudioLevel * 3.0; // audio-reactive grid size
      float bayerValue = bayer4(floor(screenPos / ditherGrid));

      // Apply dithering per channel
      float ditherStrength = 0.15 + uAudioLevel * 0.1;
      col.r = step(bayerValue, col.r + ditherStrength * (col.r - 0.5));
      col.g = step(bayerValue, col.g + ditherStrength * (col.g - 0.5));
      col.b = step(bayerValue, col.b + ditherStrength * (col.b - 0.5));

      // Keep some smooth areas (selective dither)
      float smoothMask = smoothstep(0.6, 0.8, fresnel);
      vec3 smoothCol = mix(uColor1, uColor2, t) * (1.0 + emission);
      col = mix(col, smoothCol, smoothMask * 0.5);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
  transparent: false,
  side: THREE.FrontSide,
})

const icoMesh = new THREE.Mesh(icoGeo, icoMaterial)
scene.add(icoMesh)

// ============================================
// POST-PROCESSING
// ============================================
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))

const bloom = new BloomEffect({
  intensity: 1.5,
  luminanceThreshold: 0.2,
  luminanceSmoothing: 0.5,
  mipmapBlur: true,
})

const chromatic = new ChromaticAberrationEffect({
  offset: new THREE.Vector2(0.001, 0.001),
  radialModulation: true,
  modulationOffset: 0.3,
})

const vignette = new VignetteEffect({ darkness: 0.6, offset: 0.3 })

composer.addPass(new EffectPass(camera, bloom, chromatic, vignette))

// ============================================
// DITHER POST-PROCESSING PASS
// ============================================
// Additional dithering on final output
const ditherPostMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    uDitherScale: { value: 2.0 },
    uAudioLevel: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
  fragmentShader: `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uDitherScale;
    uniform float uAudioLevel;
    varying vec2 vUv;

    float bayer8(vec2 pos) {
      vec2 p = mod(pos, 8.0);
      float x = p.x, y = p.y;
      // 8x8 Bayer pattern approximation
      return fract(
        (floor(x/4.0) + floor(y/2.0)) * 0.5 +
        (floor(x/2.0) + floor(y)) * 0.25 +
        (x + floor(y/4.0)) * 0.125
      );
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec2 screenPos = vUv * uResolution;

      float scale = uDitherScale + uAudioLevel * 2.0;
      float bayer = bayer8(floor(screenPos / scale));

      // Subtle post-dithering (don't overdo it)
      float strength = 0.08 + uAudioLevel * 0.05;
      color.rgb += (bayer - 0.5) * strength;

      gl_FragColor = color;
    }
  `,
})

// ============================================
// MOUSE
// ============================================
const mouse = new THREE.Vector2(0.5, 0.5)
const prevMouse = new THREE.Vector2(0.5, 0.5)
let mouseDown = 0

document.addEventListener('mousemove', (e) => {
  prevMouse.copy(mouse)
  mouse.set(e.clientX / window.innerWidth, 1.0 - e.clientY / window.innerHeight)
})

document.addEventListener('mousedown', () => { mouseDown = 1.0 })
document.addEventListener('mouseup', () => { mouseDown = 0.0 })

// Click = impulse
document.addEventListener('click', () => {
  if (!audioCtx) initAudio(false)
})

// ============================================
// ANIMATION
// ============================================
const clock = new THREE.Clock()

function animate() {
  requestAnimationFrame(animate)
  const t = clock.getElapsedTime()
  const dt = Math.min(clock.getDelta(), 0.05)

  updateAudio()

  // --- FLUID SIMULATION (ping-pong) ---
  fluidMaterial.uniforms.uPrev.value = rtA.texture
  fluidMaterial.uniforms.uMouse.value.copy(mouse)
  fluidMaterial.uniforms.uMousePrev.value.copy(prevMouse)
  fluidMaterial.uniforms.uMouseDown.value = mouseDown
  fluidMaterial.uniforms.uDt.value = dt
  fluidMaterial.uniforms.uAudioLevel.value = audioLevel
  fluidMaterial.uniforms.uBassLevel.value = bassLevel

  renderer.setRenderTarget(rtB)
  renderer.render(fluidScene, fluidCamera)
  renderer.setRenderTarget(null)

  // Swap
  ;[rtA, rtB] = [rtB, rtA]

  // --- UPDATE MAIN MATERIAL ---
  icoMaterial.uniforms.uTime.value = t
  icoMaterial.uniforms.uFluid.value = rtA.texture
  icoMaterial.uniforms.uAudioLevel.value = audioLevel
  icoMaterial.uniforms.uBassLevel.value = bassLevel
  icoMaterial.uniforms.uTrebleLevel.value = trebleLevel

  // Slow rotation
  icoMesh.rotation.y = t * 0.15 + audioLevel * 0.5
  icoMesh.rotation.x = Math.sin(t * 0.1) * 0.3

  // Audio-reactive bloom + chromatic
  bloom.intensity = 1.2 + bassLevel * 2.0
  chromatic.offset.set(0.001 + trebleLevel * 0.004, 0.001 + trebleLevel * 0.004)

  // Color shift over time
  const hue = (t * 0.02) % 1
  icoMaterial.uniforms.uColor1.value.setHSL(hue, 0.8, 0.5)
  icoMaterial.uniforms.uColor2.value.setHSL((hue + 0.33) % 1, 0.7, 0.4)
  icoMaterial.uniforms.uColor3.value.setHSL((hue + 0.66) % 1, 0.9, 0.6)

  // --- RENDER ---
  composer.render()
}

// ============================================
// RESIZE
// ============================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  composer.setSize(window.innerWidth, window.innerHeight)
  ditherPostMaterial.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight)
})

animate()
