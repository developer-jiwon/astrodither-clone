import './style.css'
import * as THREE from 'three'
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ChromaticAberrationEffect, VignetteEffect } from 'postprocessing'

// ============================================
// RENDERER — dark, moody
// ============================================
const canvas = document.getElementById('c')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.8

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x020202)

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100)
camera.position.z = 3.5

// ============================================
// DITHER MODE — bread / flower / pixel
// ============================================
let ditherMode = 'bread' // 'bread' | 'flower' | 'pixel'

// Generate dither pattern textures procedurally
function createDitherTexture(mode) {
  const size = 64
  const c = document.createElement('canvas')
  c.width = size; c.height = size
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#fff'

  if (mode === 'bread') {
    // Tiny bread shapes in a grid
    for (let y = 0; y < size; y += 8) {
      for (let x = 0; x < size; x += 8) {
        ctx.beginPath()
        // Bread loaf shape
        ctx.ellipse(x + 4, y + 5, 3, 2, 0, 0, Math.PI * 2)
        ctx.fill()
        // Top bump
        ctx.beginPath()
        ctx.ellipse(x + 4, y + 3, 2, 1.5, 0, Math.PI, Math.PI * 2)
        ctx.fill()
      }
    }
  } else if (mode === 'flower') {
    // Tiny flower shapes
    for (let y = 0; y < size; y += 8) {
      for (let x = 0; x < size; x += 8) {
        const cx = x + 4, cy = y + 4
        // Petals
        for (let p = 0; p < 5; p++) {
          const angle = (p / 5) * Math.PI * 2
          ctx.beginPath()
          ctx.ellipse(cx + Math.cos(angle) * 2, cy + Math.sin(angle) * 2, 1.5, 1, angle, 0, Math.PI * 2)
          ctx.fill()
        }
        // Center
        ctx.beginPath()
        ctx.arc(cx, cy, 1, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  } else {
    // Standard pixel dither (Bayer-like dots)
    for (let y = 0; y < size; y += 4) {
      for (let x = 0; x < size; x += 4) {
        ctx.fillRect(x + 1, y + 1, 2, 2)
      }
    }
  }

  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  return tex
}

let ditherTexture = createDitherTexture('bread')

// Mode buttons
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    ditherMode = btn.id.replace('btn-', '')
    ditherTexture = createDitherTexture(ditherMode)
    icoMaterial.uniforms.uDitherTex.value = ditherTexture
  })
})

// ============================================
// AUDIO — ambient musical drone (not annoying)
// ============================================
let audioCtx, analyser, freqData
let audioLevel = 0, bassLevel = 0, trebleLevel = 0

function initAudio() {
  if (audioCtx) return
  audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  if (audioCtx.state === 'suspended') audioCtx.resume()

  analyser = audioCtx.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.85
  freqData = new Uint8Array(analyser.frequencyBinCount)

  const master = audioCtx.createGain()
  master.gain.value = 0.25
  master.connect(audioCtx.destination)

  // Musical pad: Am chord (A2-C3-E3-A3) — dark, moody
  const notes = [110, 130.81, 164.81, 220]
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator()
    osc.type = i === 0 ? 'sine' : i === 1 ? 'triangle' : 'sine'
    osc.frequency.value = freq

    // Slow detune for richness
    const lfo = audioCtx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 0.1 + i * 0.05
    const lfoGain = audioCtx.createGain()
    lfoGain.gain.value = 1.5
    lfo.connect(lfoGain).connect(osc.detune)
    lfo.start()

    const gain = audioCtx.createGain()
    gain.gain.value = i === 0 ? 0.15 : 0.08

    const filter = audioCtx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 300 + i * 50
    filter.Q.value = 2

    osc.connect(filter).connect(gain).connect(analyser)
    gain.connect(master)
    osc.start()
  })

  // Sub bass pulse
  const sub = audioCtx.createOscillator()
  sub.type = 'sine'
  sub.frequency.value = 55
  const subGain = audioCtx.createGain()
  subGain.gain.value = 0.12
  const subLfo = audioCtx.createOscillator()
  subLfo.type = 'sine'
  subLfo.frequency.value = 0.3
  const subLfoGain = audioCtx.createGain()
  subLfoGain.gain.value = 0.08
  subLfo.connect(subLfoGain).connect(subGain.gain)
  subLfo.start()
  sub.connect(subGain).connect(analyser)
  subGain.connect(master)
  sub.start()

  // Filtered noise texture
  const bufSize = audioCtx.sampleRate * 4
  const nBuf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate)
  const d = nBuf.getChannelData(0)
  for (let i = 0; i < bufSize; i++) d[i] = Math.random() * 2 - 1
  const noise = audioCtx.createBufferSource()
  noise.buffer = nBuf; noise.loop = true
  const nBP = audioCtx.createBiquadFilter()
  nBP.type = 'bandpass'; nBP.frequency.value = 400; nBP.Q.value = 8
  const nGain = audioCtx.createGain()
  nGain.gain.value = 0.03
  noise.connect(nBP).connect(nGain).connect(analyser)
  nGain.connect(master)
  noise.start()
}

function updateAudio() {
  if (!analyser) return
  analyser.getByteFrequencyData(freqData)
  let sum = 0, bass = 0, treb = 0
  const len = freqData.length
  for (let i = 0; i < len; i++) {
    sum += freqData[i]
    if (i < len * 0.25) bass += freqData[i]
    if (i > len * 0.75) treb += freqData[i]
  }
  audioLevel = (sum / len) / 255
  bassLevel = (bass / (len * 0.25)) / 255
  trebleLevel = (treb / (len * 0.25)) / 255
}

// ============================================
// ENTER OVERLAY
// ============================================
const overlay = document.getElementById('enter-overlay')
overlay.addEventListener('click', () => {
  overlay.classList.add('hidden')
  initAudio()
})

// ============================================
// FLUID SIMULATION
// ============================================
const FS = 256
const fluidScene = new THREE.Scene()
const fluidCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const rtOpts = { format: THREE.RGBAFormat, type: THREE.FloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
let rtA = new THREE.WebGLRenderTarget(FS, FS, rtOpts)
let rtB = new THREE.WebGLRenderTarget(FS, FS, rtOpts)

const fluidMat = new THREE.ShaderMaterial({
  uniforms: {
    uPrev: { value: null },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uMousePrev: { value: new THREE.Vector2(0.5, 0.5) },
    uClick: { value: 0 },
    uDt: { value: 0.016 },
    uAudio: { value: 0 },
    uBass: { value: 0 },
    uRes: { value: new THREE.Vector2(FS, FS) },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
  fragmentShader: `
    precision highp float;
    uniform sampler2D uPrev;
    uniform vec2 uMouse, uMousePrev, uRes;
    uniform float uClick, uDt, uAudio, uBass;
    varying vec2 vUv;

    vec2 hash(vec2 p) {
      p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
      return -1.0+2.0*fract(sin(p)*43758.5453);
    }
    float noise(vec2 p) {
      vec2 i=floor(p), f=fract(p), u=f*f*(3.0-2.0*f);
      return mix(mix(dot(hash(i),f),dot(hash(i+vec2(1,0)),f-vec2(1,0)),u.x),
                 mix(dot(hash(i+vec2(0,1)),f-vec2(0,1)),dot(hash(i+vec2(1,1)),f-vec2(1,1)),u.x),u.y);
    }

    void main() {
      vec2 tx = 1.0/uRes;
      vec4 c = texture2D(uPrev, vUv);
      vec4 l = texture2D(uPrev, vUv-vec2(tx.x,0));
      vec4 r = texture2D(uPrev, vUv+vec2(tx.x,0));
      vec4 u = texture2D(uPrev, vUv+vec2(0,tx.y));
      vec4 d = texture2D(uPrev, vUv-vec2(0,tx.y));

      vec2 vel = vec2(r.x-l.x, u.x-d.x)*0.5;
      vec2 advUv = vUv - vel*uDt*6.0;
      vec4 adv = texture2D(uPrev, advUv);

      vec2 mDelta = uMouse - uMousePrev;
      float mForce = length(mDelta)*15.0;
      float dist = distance(vUv, uMouse);
      float splat = exp(-dist*dist/(0.003+uBass*0.002))*mForce;
      splat += exp(-dist*dist/0.001)*uClick*3.0;

      float turb = noise(vUv*6.0+c.xy*2.0)*uAudio*0.2;

      vec4 res = adv*0.965;
      res.xy += mDelta*splat*2.0;
      res.z += splat*0.4 + turb;
      res.w = max(res.z, res.w*0.97);

      gl_FragColor = res;
    }
  `,
})
fluidScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fluidMat))

// ============================================
// MAIN SPHERE — dark moody with custom dither
// ============================================
const geo = new THREE.IcosahedronGeometry(1.4, 80)

const icoMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uFluid: { value: null },
    uDitherTex: { value: ditherTexture },
    uAudio: { value: 0 },
    uBass: { value: 0 },
    uTreble: { value: 0 },
  },
  vertexShader: `
    uniform float uTime, uAudio, uBass;
    uniform sampler2D uFluid;
    varying vec2 vUv;
    varying vec3 vNorm, vPos;
    varying float vDisp;

    vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
    float snoise(vec3 v){
      const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0,0.5,1,2);
      vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
      vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;
      vec3 i1=min(g,l.zxy);vec3 i2=max(g,l.zxy);
      vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
      i=mod289(i);
      vec4 p=permute(permute(permute(i.z+vec4(0,i1.z,i2.z,1))+i.y+vec4(0,i1.y,i2.y,1))+i.x+vec4(0,i1.x,i2.x,1));
      float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
      vec4 j=p-49.0*floor(p*ns.z*ns.z);
      vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
      vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;
      vec4 h=1.0-abs(x)-abs(y);
      vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
      vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;
      vec4 sh=-step(h,vec4(0));
      vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
      vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);
      vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
      vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
      vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
      m=m*m;return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }

    void main(){
      vUv=uv; vNorm=normal;
      float t=uTime*0.25;
      vec3 np=position*1.2+t;
      float d=snoise(np)*0.35+snoise(np*2.0+100.0)*0.18+snoise(np*4.0+200.0)*0.09;
      d*=1.0+uBass*1.8;
      d+=uAudio*0.12;
      vec4 fl=texture2D(uFluid,uv);
      d+=fl.z*0.25;
      vDisp=d;
      vec3 p=position+normal*d;
      vPos=p;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
    }
  `,
  fragmentShader: `
    precision highp float;
    uniform float uTime, uAudio, uTreble;
    uniform sampler2D uDitherTex;
    varying vec2 vUv;
    varying vec3 vNorm, vPos;
    varying float vDisp;

    void main(){
      vec3 viewDir=normalize(cameraPosition-vPos);
      float fresnel=pow(1.0-max(dot(viewDir,vNorm),0.0),3.0);

      // Monochrome color from displacement
      float brightness=0.15+abs(vDisp)*1.8;
      brightness+=fresnel*0.4;
      brightness+=uAudio*0.15;

      // Clamp to dark range
      brightness=clamp(brightness, 0.0, 1.0);

      // === CUSTOM SHAPE DITHERING ===
      vec2 screenUv=gl_FragCoord.xy/8.0; // tile size
      float ditherSample=texture2D(uDitherTex, screenUv).r;

      // Threshold with dither pattern
      float dithered=step(ditherSample*0.8, brightness);

      // Tint: subtle cool/warm based on displacement
      vec3 coolColor=vec3(0.6, 0.7, 0.9); // blue-white
      vec3 warmColor=vec3(0.9, 0.75, 0.6); // warm cream
      vec3 tint=mix(coolColor, warmColor, smoothstep(-0.2, 0.3, vDisp));

      vec3 col=tint*dithered;

      // Emission for bright peaks
      float emission=smoothstep(0.3, 0.6, abs(vDisp));
      col+=tint*emission*0.3;

      // Fresnel rim glow
      col+=vec3(0.4, 0.5, 0.8)*fresnel*0.5*dithered;

      gl_FragColor=vec4(col, 1.0);
    }
  `,
})

const mesh = new THREE.Mesh(geo, icoMaterial)
scene.add(mesh)

// ============================================
// POST-PROCESSING
// ============================================
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))

const bloom = new BloomEffect({
  intensity: 1.8,
  luminanceThreshold: 0.15,
  luminanceSmoothing: 0.4,
  mipmapBlur: true,
})
const chromatic = new ChromaticAberrationEffect({
  offset: new THREE.Vector2(0.001, 0.001),
  radialModulation: true,
  modulationOffset: 0.3,
})
const vignette = new VignetteEffect({ darkness: 0.7, offset: 0.25 })

composer.addPass(new EffectPass(camera, bloom, chromatic, vignette))

// ============================================
// MOUSE
// ============================================
const mouse = new THREE.Vector2(0.5, 0.5)
const prevMouse = new THREE.Vector2(0.5, 0.5)
let clickImpulse = 0

document.addEventListener('mousemove', (e) => {
  prevMouse.copy(mouse)
  mouse.set(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight)
})
document.addEventListener('mousedown', () => { clickImpulse = 1 })
document.addEventListener('mouseup', () => { clickImpulse = 0 })

// ============================================
// RENDER
// ============================================
const clock = new THREE.Clock()

function animate() {
  requestAnimationFrame(animate)
  const t = clock.getElapsedTime()
  const dt = Math.min(clock.getDelta(), 0.05)

  updateAudio()

  // Fluid
  fluidMat.uniforms.uPrev.value = rtA.texture
  fluidMat.uniforms.uMouse.value.copy(mouse)
  fluidMat.uniforms.uMousePrev.value.copy(prevMouse)
  fluidMat.uniforms.uClick.value = clickImpulse
  fluidMat.uniforms.uDt.value = dt
  fluidMat.uniforms.uAudio.value = audioLevel
  fluidMat.uniforms.uBass.value = bassLevel
  renderer.setRenderTarget(rtB)
  renderer.render(fluidScene, fluidCam)
  renderer.setRenderTarget(null)
  ;[rtA, rtB] = [rtB, rtA]

  // Main material
  icoMaterial.uniforms.uTime.value = t
  icoMaterial.uniforms.uFluid.value = rtA.texture
  icoMaterial.uniforms.uAudio.value = audioLevel
  icoMaterial.uniforms.uBass.value = bassLevel
  icoMaterial.uniforms.uTreble.value = trebleLevel

  // Rotation
  mesh.rotation.y = t * 0.12 + bassLevel * 0.3
  mesh.rotation.x = Math.sin(t * 0.08) * 0.2

  // Audio-reactive post
  bloom.intensity = 1.5 + bassLevel * 2.5
  chromatic.offset.set(0.0008 + trebleLevel * 0.005, 0.0008 + trebleLevel * 0.005)

  composer.render()
  clickImpulse *= 0.9 // decay
}

// ============================================
// RESIZE
// ============================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  composer.setSize(window.innerWidth, window.innerHeight)
})

animate()
