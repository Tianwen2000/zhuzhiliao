(() => {
  'use strict';

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d', { alpha: false });
  const speedValue = document.getElementById('speedValue');
  const wahCount = document.getElementById('wahCount');
  const soundButton = document.getElementById('soundButton');
  const autoButton = document.getElementById('autoButton');
  const audioGate = document.getElementById('audioGate');
  const gesture = document.getElementById('gesture');

  const TAU = Math.PI * 2;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const mix = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, value) => {
    const t = clamp((value - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

  function readStoredWahs() {
    try {
      return Number.parseInt(localStorage.getItem('bamboo-wahs') || '0', 10) || 0;
    } catch {
      return 0;
    }
  }

  function storeWahs(value) {
    try {
      localStorage.setItem('bamboo-wahs', String(value));
    } catch {
      // The interaction still works when storage is blocked or unavailable.
    }
  }

  let width = 0;
  let height = 0;
  let dpr = 1;
  let ropeLength = 220;
  let backgroundLayer = null;
  let lastFrame = performance.now();
  let accumulator = 0;
  let hudElapsed = 0;
  let interacted = false;
  let totalWahs = readStoredWahs();

  const pointer = {
    down: false,
    id: null,
    x: 0,
    y: 0,
    previousX: 0,
    previousY: 0,
    velocityX: 0,
    velocityY: 0,
    lastTime: 0,
  };

  const handle = {
    x: 0,
    y: 0,
    previousX: 0,
    previousY: 0,
    velocityX: 0,
    velocityY: 0,
  };

  const toy = {
    x: 0,
    y: 0,
    velocityX: 0,
    velocityY: 0,
    angle: 0,
    previousAngle: 0,
    angularVelocity: 0,
    rps: 0,
    tension: 0,
    intensity: 0,
    pulse: 0,
    rotationDistance: 0,
  };

  const auto = {
    enabled: false,
    phase: 0,
  };

  class BambooVoice {
    constructor() {
      this.context = null;
      this.source = null;
      this.master = null;
      this.analyser = null;
      this.panner = null;
      this.filters = [];
      this.enabled = true;
      this.ready = false;
    }

    createExciterBuffer(context) {
      const duration = 2.08;
      const length = Math.floor(context.sampleRate * duration);
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const data = buffer.getChannelData(0);
      let phase = 0;
      let filteredNoise = 0;
      let seed = 0x24f2a1;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0xffffffff;
      };

      for (let index = 0; index < length; index += 1) {
        const time = index / context.sampleRate;
        const local = (time % 0.52) / 0.52;
        const attack = smoothstep(0, 0.12, local);
        const release = 1 - smoothstep(0.58, 1, local);
        const breath = attack * release;
        const vowel = 0.58 + 0.42 * Math.sin(Math.PI * clamp(local, 0, 1));
        const frequency = 64 + 19 * vowel + 3.5 * Math.sin(TAU * 27 * time);
        phase += TAU * frequency / context.sampleRate;

        let reed = 0;
        for (let harmonic = 1; harmonic <= 10; harmonic += 1) {
          reed += Math.sin(phase * harmonic + harmonic * 0.07) / harmonic;
        }

        const rawNoise = random() * 2 - 1;
        filteredNoise += (rawNoise - filteredNoise) * 0.16;
        const scrape = rawNoise - filteredNoise;
        const stickSlip = Math.tanh((reed * 0.82 + scrape * 0.34) * 2.4);
        const onset = Math.exp(-local * 34) * (random() * 2 - 1) * 0.7;
        data[index] = (stickSlip * breath * 0.44 + onset) * 0.72;
      }

      const edge = Math.floor(context.sampleRate * 0.025);
      for (let index = 0; index < edge; index += 1) {
        const gain = Math.sin((index / edge) * Math.PI * 0.5) ** 2;
        data[index] *= gain;
        data[length - 1 - index] *= gain;
      }

      return buffer;
    }

    createImpulse(context) {
      const length = Math.floor(context.sampleRate * 0.16);
      const impulse = context.createBuffer(2, length, context.sampleRate);
      for (let channel = 0; channel < 2; channel += 1) {
        const data = impulse.getChannelData(channel);
        let seed = 8401 + channel * 97;
        for (let index = 0; index < length; index += 1) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const noise = seed / 0x7fffffff * 2 - 1;
          const decay = Math.exp(-index / (context.sampleRate * 0.034));
          data[index] = noise * decay * 0.22;
        }
      }
      return impulse;
    }

    async unlock() {
      if (!this.context) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return false;
        this.context = new AudioContextClass({ latencyHint: 'interactive' });

        this.source = this.context.createBufferSource();
        this.source.buffer = this.createExciterBuffer(this.context);
        this.source.loop = true;

        const dry = this.context.createGain();
        dry.gain.value = 0.16;

        const resonances = [
          { frequency: 780, q: 7.5, gain: 0.9 },
          { frequency: 1640, q: 9, gain: 0.62 },
          { frequency: 2880, q: 11, gain: 0.4 },
        ];

        this.filters = resonances.map((resonance) => {
          const filter = this.context.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.value = resonance.frequency;
          filter.Q.value = resonance.q;
          const gain = this.context.createGain();
          gain.gain.value = resonance.gain;
          this.source.connect(filter).connect(gain);
          return { filter, gain, base: resonance.frequency };
        });

        const lowpass = this.context.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = 680;
        lowpass.Q.value = 1.1;
        this.source.connect(lowpass).connect(dry);

        const resonantBus = this.context.createGain();
        resonantBus.gain.value = 0.5;
        this.filters.forEach(({ gain }) => gain.connect(resonantBus));

        const convolver = this.context.createConvolver();
        convolver.buffer = this.createImpulse(this.context);
        const wet = this.context.createGain();
        wet.gain.value = 0.18;
        resonantBus.connect(convolver).connect(wet);

        this.panner = this.context.createStereoPanner();
        this.master = this.context.createGain();
        this.master.gain.value = 0;
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 1024;
        const compressor = this.context.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 15;
        compressor.ratio.value = 5;
        compressor.attack.value = 0.008;
        compressor.release.value = 0.18;

        dry.connect(this.panner);
        resonantBus.connect(this.panner);
        wet.connect(this.panner);
        this.panner.connect(this.master).connect(compressor).connect(this.analyser).connect(this.context.destination);
        this.source.start();
        this.ready = true;
      }

      if (this.context.state !== 'running') {
        await this.context.resume();
      }
      audioGate.classList.add('is-hidden');
      return this.context.state === 'running';
    }

    setEnabled(enabled) {
      this.enabled = enabled;
      if (!this.context || !this.master) return;
      const now = this.context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(enabled ? 0.0001 : 0, now, 0.025);
    }

    update(intensity, rps, phase, horizontal) {
      if (!this.ready || !this.context) return;
      const now = this.context.currentTime;
      const amount = this.enabled ? clamp(intensity, 0, 1) : 0;
      const targetGain = amount ** 1.35 * 0.7;
      this.master.gain.setTargetAtTime(targetGain, now, amount > 0.05 ? 0.045 : 0.16);
      this.source.playbackRate.setTargetAtTime(clamp(0.66 + rps * 0.24, 0.64, 1.58), now, 0.08);
      this.filters.forEach(({ filter, base }, index) => {
        const sweep = 1 + Math.sin(phase + index * 0.74) * (0.08 + amount * 0.09);
        filter.frequency.setTargetAtTime(base * sweep * (0.94 + amount * 0.12), now, 0.045);
      });
      this.panner.pan.setTargetAtTime(clamp(horizontal, -0.42, 0.42), now, 0.08);
    }

    rms() {
      if (!this.analyser) return 0;
      const values = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(values);
      let sum = 0;
      for (const value of values) sum += value * value;
      return Math.sqrt(sum / values.length);
    }
  }

  const voice = new BambooVoice();

  function createBackground() {
    backgroundLayer = document.createElement('canvas');
    backgroundLayer.width = canvas.width;
    backgroundLayer.height = canvas.height;
    const layer = backgroundLayer.getContext('2d');
    layer.setTransform(dpr, 0, 0, dpr, 0, 0);

    const wash = layer.createLinearGradient(0, 0, width, height);
    wash.addColorStop(0, '#111820');
    wash.addColorStop(0.52, '#17242a');
    wash.addColorStop(1, '#202a25');
    layer.fillStyle = wash;
    layer.fillRect(0, 0, width, height);

    layer.save();
    layer.globalAlpha = 0.16;
    layer.strokeStyle = '#f4eddb';
    layer.lineWidth = 0.5;
    let seed = 0x9e3779b9;
    for (let index = 0; index < Math.floor((width * height) / 5800); index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = seed / 0xffffffff * width;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const y = seed / 0xffffffff * height;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const length = 8 + seed / 0xffffffff * 24;
      layer.beginPath();
      layer.moveTo(x, y);
      layer.lineTo(x + length, y + length * 0.08);
      layer.stroke();
    }
    layer.restore();

    drawBamboo(layer, width * 0.04, height + 30, -0.07, height * 0.9, '#344a3c', 0.82);
    drawBamboo(layer, width * 0.14, height + 60, 0.04, height * 0.74, '#263c34', 0.58);
    drawBamboo(layer, width * 0.94, height + 20, 0.05, height * 0.82, '#536947', 0.54);
    drawBamboo(layer, width * 0.84, height + 80, -0.04, height * 0.63, '#2d4539', 0.42);

    layer.fillStyle = 'rgba(6, 13, 16, 0.28)';
    layer.fillRect(0, height * 0.72, width, height * 0.28);
  }

  function drawBamboo(layer, x, bottom, tilt, stalkHeight, color, alpha) {
    layer.save();
    layer.globalAlpha = alpha;
    layer.translate(x, bottom);
    layer.rotate(tilt);
    const stalkWidth = clamp(stalkHeight * 0.026, 12, 24);
    layer.fillStyle = color;
    layer.fillRect(-stalkWidth / 2, -stalkHeight, stalkWidth, stalkHeight + 30);

    layer.fillStyle = 'rgba(192, 204, 132, 0.2)';
    for (let y = -stalkHeight + 50; y < -30; y += stalkHeight * 0.22) {
      layer.fillRect(-stalkWidth / 2 - 2, y, stalkWidth + 4, 4);
      const side = Math.sin(y * 0.03) > 0 ? 1 : -1;
      drawLeafBranch(layer, side * stalkWidth * 0.3, y - 4, side, color);
    }
    layer.restore();
  }

  function drawLeafBranch(layer, x, y, side, color) {
    layer.save();
    layer.translate(x, y);
    layer.strokeStyle = color;
    layer.lineWidth = 3;
    layer.beginPath();
    layer.moveTo(0, 0);
    layer.quadraticCurveTo(side * 38, -18, side * 76, -8);
    layer.stroke();
    layer.fillStyle = color;
    for (let index = 1; index <= 4; index += 1) {
      const px = side * index * 17;
      const py = -index * 3;
      layer.save();
      layer.translate(px, py);
      layer.rotate(side * (index % 2 ? -0.42 : 0.35));
      layer.beginPath();
      layer.moveTo(0, 0);
      layer.quadraticCurveTo(side * 18, -8, side * 31, 0);
      layer.quadraticCurveTo(side * 18, 8, 0, 0);
      layer.fill();
      layer.restore();
    }
    layer.restore();
  }

  function resetPositions() {
    handle.x = width * 0.5;
    handle.y = height * 0.48;
    handle.previousX = handle.x;
    handle.previousY = handle.y;
    toy.x = handle.x + ropeLength * 0.45;
    toy.y = handle.y + ropeLength * 0.83;
    toy.velocityX = 0;
    toy.velocityY = 0;
    toy.angle = Math.atan2(toy.y - handle.y, toy.x - handle.x);
    toy.previousAngle = toy.angle;
  }

  function resize() {
    const nextWidth = window.innerWidth;
    const nextHeight = window.innerHeight;
    if (!nextWidth || !nextHeight) return;
    const first = width === 0;
    width = nextWidth;
    height = nextHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ropeLength = clamp(Math.min(width, height) * 0.31, 150, 265);
    createBackground();
    if (first) resetPositions();
    else {
      handle.x = width * 0.5;
      handle.y = height * 0.48;
      handle.previousX = handle.x;
      handle.previousY = handle.y;
      toy.x = clamp(toy.x, 30, width - 30);
      toy.y = clamp(toy.y, 40, height - 30);
    }
  }

  function setAuto(enabled) {
    auto.enabled = enabled;
    autoButton.classList.toggle('is-active', enabled);
    autoButton.setAttribute('aria-pressed', String(enabled));
    autoButton.setAttribute('aria-label', enabled ? '停止自动演示' : '开始自动演示');
    if (enabled) {
      interacted = true;
      gesture.classList.add('is-hidden');
      auto.phase = toy.angle;
      voice.unlock();
    }
  }

  function setSound(enabled) {
    voice.setEnabled(enabled);
    soundButton.classList.toggle('is-active', enabled);
    soundButton.setAttribute('aria-pressed', String(enabled));
    soundButton.setAttribute('aria-label', enabled ? '关闭声音' : '开启声音');
  }

  function updateHandle(dt) {
    handle.previousX = handle.x;
    handle.previousY = handle.y;
    handle.velocityX = 0;
    handle.velocityY = 0;

    if (auto.enabled) {
      auto.phase += dt * 10.8;
    }
    pointer.velocityX *= Math.exp(-dt * 4.5);
    pointer.velocityY *= Math.exp(-dt * 4.5);
  }

  function simulate(dt) {
    updateHandle(dt);

    let dx = toy.x - handle.x;
    let dy = toy.y - handle.y;
    let distance = Math.hypot(dx, dy) || 1;
    let stretch = 0;
    const pointerSpeed = Math.hypot(pointer.velocityX, pointer.velocityY);
    const manualDrive = pointer.down && pointerSpeed > 70;

    if (auto.enabled) {
      const previousX = toy.x;
      const previousY = toy.y;
      toy.x = handle.x + Math.cos(auto.phase) * ropeLength;
      toy.y = handle.y + Math.sin(auto.phase) * ropeLength;
      toy.velocityX = (toy.x - previousX) / dt;
      toy.velocityY = (toy.y - previousY) / dt;
    } else if (manualDrive) {
      const previousX = toy.x;
      const previousY = toy.y;
      toy.x = handle.x - pointer.velocityX / pointerSpeed * ropeLength;
      toy.y = handle.y - pointer.velocityY / pointerSpeed * ropeLength;
      toy.velocityX = (toy.x - previousX) / dt;
      toy.velocityY = (toy.y - previousY) / dt;
    } else {
      toy.velocityY += 570 * dt;
      toy.velocityX *= Math.exp(-dt * 0.72);
      toy.velocityY *= Math.exp(-dt * 0.72);
      toy.x += toy.velocityX * dt;
      toy.y += toy.velocityY * dt;

      dx = toy.x - handle.x;
      dy = toy.y - handle.y;
      distance = Math.hypot(dx, dy) || 1;
      const nx = dx / distance;
      const ny = dy / distance;
      stretch = Math.max(0, distance - ropeLength);

      if (distance > ropeLength) {
        toy.x = handle.x + nx * ropeLength;
        toy.y = handle.y + ny * ropeLength;
        const relativeX = toy.velocityX - handle.velocityX;
        const relativeY = toy.velocityY - handle.velocityY;
        const outward = relativeX * nx + relativeY * ny;
        if (outward > 0) {
          toy.velocityX -= outward * nx * 1.03;
          toy.velocityY -= outward * ny * 1.03;
        }
        toy.velocityX += handle.velocityX * dt * 3.4;
        toy.velocityY += handle.velocityY * dt * 3.4;
      }
    }

    dx = toy.x - handle.x;
    dy = toy.y - handle.y;
    distance = Math.hypot(dx, dy) || 1;
    const tensionTarget = auto.enabled || manualDrive
      ? 1
      : smoothstep(ropeLength * 0.82, ropeLength, distance + stretch);
    toy.tension = mix(toy.tension, tensionTarget, auto.enabled || manualDrive ? 0.24 : 0.15);
    toy.previousAngle = toy.angle;
    toy.angle = Math.atan2(dy, dx);
    const angleDelta = wrapAngle(toy.angle - toy.previousAngle);
    const instantAngular = angleDelta / dt;
    toy.angularVelocity = mix(toy.angularVelocity, instantAngular, 0.12);
    const instantRps = Math.abs(toy.angularVelocity) / TAU;
    toy.rps = mix(toy.rps, instantRps, 0.1);

    const drive = smoothstep(0.36, 1.72, toy.rps) * smoothstep(0.4, 0.92, toy.tension);
    toy.intensity = mix(toy.intensity, drive, 1 - Math.exp(-dt * (drive > toy.intensity ? 8 : 2.5)));
    toy.pulse *= Math.exp(-dt * 7);

    if (toy.rps > 0.55 && toy.tension > 0.65) {
      toy.rotationDistance += Math.abs(angleDelta);
      while (toy.rotationDistance >= TAU) {
        toy.rotationDistance -= TAU;
        totalWahs += 1;
        toy.pulse = 1;
        storeWahs(totalWahs);
      }
    } else {
      toy.rotationDistance = 0;
    }

    voice.update(toy.intensity, toy.rps, toy.angle, (toy.x / width - 0.5) * 0.8);
  }

  function drawWind(time) {
    if (toy.intensity < 0.08) return;
    ctx.save();
    ctx.globalAlpha = toy.intensity * 0.28;
    ctx.strokeStyle = '#f2bd72';
    ctx.lineWidth = 1;
    const radius = ropeLength * 0.78;
    for (let index = 0; index < 3; index += 1) {
      const offset = (time * (0.8 + index * 0.15) + index * 0.29) % 1;
      const start = toy.angle - 0.9 - offset * 0.5;
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, radius + index * 15, start, start + 0.42);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRope() {
    const dx = toy.x - handle.x;
    const dy = toy.y - handle.y;
    const distance = Math.hypot(dx, dy) || 1;
    const normalX = -dy / distance;
    const normalY = dx / distance;
    const sag = (1 - toy.tension) * 24;
    const midX = (handle.x + toy.x) * 0.5 + normalX * sag;
    const midY = (handle.y + toy.y) * 0.5 + normalY * sag + (1 - toy.tension) * 18;

    ctx.save();
    ctx.strokeStyle = 'rgba(245, 226, 183, 0.82)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(handle.x, handle.y);
    ctx.quadraticCurveTo(midX, midY, toy.x, toy.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawHandle() {
    const speed = Math.hypot(handle.velocityX, handle.velocityY);
    const tilt = Math.atan2(handle.velocityY, handle.velocityX) + Math.PI * 0.5;
    ctx.save();
    ctx.translate(handle.x, handle.y);
    ctx.rotate(Number.isFinite(tilt) && speed > 12 ? tilt : -0.55);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#5a3428';
    ctx.beginPath();
    ctx.roundRect(-6, -42, 12, 84, 5);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#d65b42';
    ctx.fillRect(-7, 23, 14, 7);
    ctx.restore();
  }

  function drawWing(side, activity, time) {
    const flutter = Math.sin(time * (21 + toy.rps * 14) + side) * activity * 0.12;
    ctx.save();
    ctx.translate(side * 11, -4);
    ctx.rotate(side * (0.32 + activity * 0.26) + flutter);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(side * 25, -16, side * 44, 2, side * 34, 33);
    ctx.bezierCurveTo(side * 17, 29, side * 5, 14, 0, 0);
    ctx.fillStyle = 'rgba(244, 237, 219, 0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(83, 105, 71, 0.74)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(side * 3, 2);
    ctx.quadraticCurveTo(side * 19, 9, side * 31, 28);
    ctx.moveTo(side * 4, 5);
    ctx.quadraticCurveTo(side * 12, 17, side * 17, 26);
    ctx.stroke();
    ctx.restore();
  }

  function drawToy(time) {
    const orientation = toy.angle - Math.PI * 0.5;
    const pulseScale = 1 + toy.pulse * 0.05;
    ctx.save();
    ctx.translate(toy.x, toy.y);
    ctx.rotate(orientation);
    ctx.scale(pulseScale, pulseScale);

    drawWing(-1, toy.intensity, time);
    drawWing(1, toy.intensity, time);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 18;
    const body = ctx.createLinearGradient(-18, 0, 18, 0);
    body.addColorStop(0, '#68794b');
    body.addColorStop(0.35, '#c4c78a');
    body.addColorStop(0.67, '#a8b56f');
    body.addColorStop(1, '#4c613f');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.roundRect(-17, -7, 34, 68, 8);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = 'rgba(53, 70, 46, 0.62)';
    ctx.lineWidth = 2;
    for (let y = 10; y <= 48; y += 19) {
      ctx.beginPath();
      ctx.moveTo(-16, y);
      ctx.lineTo(16, y);
      ctx.stroke();
    }

    ctx.fillStyle = '#203028';
    ctx.beginPath();
    ctx.ellipse(0, 60, 15, 5, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(244, 237, 219, 0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 59, 14, 4, 0, Math.PI, TAU);
    ctx.stroke();

    ctx.fillStyle = '#d65b42';
    ctx.beginPath();
    ctx.roundRect(-18, -11, 36, 15, 5);
    ctx.fill();

    ctx.shadowColor = `rgba(242, 189, 114, ${toy.intensity * 0.72})`;
    ctx.shadowBlur = 24 * toy.intensity;
    ctx.fillStyle = mixColor('#f4eddb', '#f2bd72', toy.intensity * 0.42);
    ctx.beginPath();
    ctx.ellipse(0, -9, 14.5, 6, 0, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#111820';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(side * 12, -1, 3.2, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#f4eddb';
      ctx.beginPath();
      ctx.arc(side * 11.2, -2, 0.8, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#111820';
    }

    ctx.fillStyle = '#b64032';
    ctx.beginPath();
    ctx.arc(0, -9, 2.2, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function mixColor(from, to, amount) {
    const parse = (hex) => [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
    const a = parse(from);
    const b = parse(to);
    return `rgb(${Math.round(mix(a[0], b[0], amount))}, ${Math.round(mix(a[1], b[1], amount))}, ${Math.round(mix(a[2], b[2], amount))})`;
  }

  function draw(time) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(backgroundLayer, 0, 0, width, height);
    drawWind(time);
    drawRope();
    drawHandle();
    drawToy(time);
  }

  function frame(now) {
    const elapsed = Math.min((now - lastFrame) / 1000, 0.05) || 0.016;
    lastFrame = now;
    accumulator += elapsed;
    hudElapsed += elapsed;

    const step = 1 / 180;
    let loops = 0;
    while (accumulator >= step && loops < 12) {
      simulate(step);
      accumulator -= step;
      loops += 1;
    }

    draw(now / 1000);
    if (hudElapsed >= 0.1) {
      hudElapsed = 0;
      speedValue.textContent = toy.rps.toFixed(1);
      wahCount.textContent = totalWahs.toLocaleString('zh-CN');
    }
    requestAnimationFrame(frame);
  }

  canvas.addEventListener('pointerdown', async (event) => {
    if (pointer.down) return;
    pointer.down = true;
    pointer.id = event.pointerId;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.previousX = pointer.x;
    pointer.previousY = pointer.y;
    pointer.velocityX = 0;
    pointer.velocityY = 0;
    pointer.lastTime = event.timeStamp;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-dragging');
    gesture.classList.add('is-hidden');
    interacted = true;
    if (auto.enabled) setAuto(false);
    await voice.unlock();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!pointer.down || event.pointerId !== pointer.id) return;
    const elapsed = clamp((event.timeStamp - pointer.lastTime) / 1000, 1 / 240, 0.08);
    const velocityX = (event.clientX - pointer.previousX) / elapsed;
    const velocityY = (event.clientY - pointer.previousY) / elapsed;
    pointer.velocityX = mix(pointer.velocityX, velocityX, 0.58);
    pointer.velocityY = mix(pointer.velocityY, velocityY, 0.58);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.previousX = pointer.x;
    pointer.previousY = pointer.y;
    pointer.lastTime = event.timeStamp;
  });

  const releasePointer = (event) => {
    if (!pointer.down || (event && event.pointerId !== pointer.id)) return;
    pointer.down = false;
    pointer.id = null;
    pointer.velocityX = 0;
    pointer.velocityY = 0;
    canvas.classList.remove('is-dragging');
  };

  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  soundButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    await voice.unlock();
    setSound(!voice.enabled);
  });

  autoButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    await voice.unlock();
    setAuto(!auto.enabled);
  });

  audioGate.addEventListener('click', async (event) => {
    event.stopPropagation();
    const unlocked = await voice.unlock();
    if (unlocked) setSound(true);
  });

  window.addEventListener('keydown', async (event) => {
    if (event.code === 'Space' && !event.repeat) {
      event.preventDefault();
      await voice.unlock();
      setAuto(!auto.enabled);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!voice.context) return;
    if (document.hidden) voice.context.suspend().catch(() => {});
    else voice.context.resume().catch(() => {});
  });

  window.addEventListener('resize', resize);
  resize();
  wahCount.textContent = totalWahs.toLocaleString('zh-CN');

  window.__bambooCicada = {
    get state() {
      return {
        width,
        height,
        rps: toy.rps,
        intensity: toy.intensity,
        tension: toy.tension,
        auto: auto.enabled,
        sound: voice.enabled,
        audioState: voice.context ? voice.context.state : 'none',
        interacted,
        handle: { x: handle.x, y: handle.y },
        toy: { x: toy.x, y: toy.y },
      };
    },
    setAuto,
    rms: () => voice.rms(),
  };

  requestAnimationFrame(frame);
})();
