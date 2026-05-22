class RealtimeVocoder {
  constructor() {
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.masterGain = null;
    this.dryGain = null;
    this.monitorGain = null;
    this.envBoostGains = [];
    this.analyser = null;
    this.oscillators = [];
    this.nodes = [];
    this.meterTimer = null;
    this.isRunning = false;
    this.testOsc = null;
    this.testGain = null;
    this.wetGate = null;        // wet全体のマスターノイズゲート
    this.wetGateOpen = false;
    this.noiseFloor = 0.012;    // 適応的なノイズフロア推定値
    this.hfDamp = null;         // 高音ハウリング抑制用ゲイン
    this.outputDeviceId = "";   // 出力先デバイス("" = 既定の出力)

    // キャリア音程まわり
    this.carrierVoices = [];   // [{osc, ratio}] 基準周波数に対する倍率を保持
    this.carrierFreq = 110;    // 現在のキャリア基準周波数(Hz)
    this.pitchMode = "fixed";  // fixed | pitch | midi
    this.smoothedPitch = 0;    // ピッチ追従用の平滑化値
    this.pitchReference = 0;   // 追従開始時の入力ピッチ(相対変化の基準)
    this.pitchOutlierPending = 0; // オクターブ誤検出の様子見用
    this.midiAccess = null;
    this.midiNotes = [];       // 押下中のMIDIノート番号(後着優先)
    this.tone = "saw";         // 現在のキャリア波形
    this.r2Timer = null;       // R2-D2モードの音程シーケンサ
  }

  getSettings() {
    const num = (id, fallback) => {
      const el = document.getElementById(id);
      if (!el) return fallback;
      const v = Number(el.value);
      return Number.isFinite(v) ? v : fallback;
    };
    const toneEl = document.getElementById("rtTone");
    const pitchModeEl = document.getElementById("rtPitchMode");
    return {
      baseFreq: num("rtBaseFreq", 110),
      bands: num("rtBands", 25),
      tone: toneEl ? toneEl.value : "saw",
      dryMix: num("rtDryMix", 0),
      output: num("rtOutput", 0.8),
      envBoost: num("rtEnvBoost", 14),
      monitor: num("rtMonitor", 0),
      pitchMode: pitchModeEl ? pitchModeEl.value : "fixed",
    };
  }

  createWaveShaperAbs(audioContext) {
    const curve = new Float32Array(65536);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.abs(x);
    }
    const shaper = audioContext.createWaveShaper();
    shaper.curve = curve;
    shaper.oversample = "none";
    return shaper;
  }

  createNoiseGate(audioContext) {
    // 包絡のソフトノイズゲート。発話より十分小さい値(無音時のマイクノイズ)を
    // 急峻に潰し、無音時の「ブー」や残留ノイズを抑える。
    // g(y) = y^5 / (y^4 + k^4): 4次のニーで、kより大きい入力はほぼ素通し、
    // kより小さい入力は2次カーブよりずっと強力に減衰する。
    const curve = new Float32Array(65536);
    const k4 = Math.pow(0.07, 4);
    for (let i = 0; i < curve.length; i++) {
      const y = (i / (curve.length - 1)) * 2 - 1;
      if (y > 0) {
        const y4 = y * y * y * y;
        curve[i] = (y4 * y) / (y4 + k4);
      } else {
        curve[i] = 0;
      }
    }
    const shaper = audioContext.createWaveShaper();
    shaper.curve = curve;
    shaper.oversample = "none";
    return shaper;
  }

  createSoftClipper(audioContext) {
    const curve = new Float32Array(65536);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.9);
    }
    const shaper = audioContext.createWaveShaper();
    shaper.curve = curve;
    shaper.oversample = "2x";
    return shaper;
  }

  makeBandEdges(bands, sampleRate) {
    const low = 90;
    const high = Math.min(7000, sampleRate * 0.5 - 500);
    const edges = [];
    const logLow = Math.log(low);
    const logHigh = Math.log(high);
    for (let i = 0; i <= bands; i++) {
      const t = i / bands;
      edges.push(Math.exp(logLow + (logHigh - logLow) * t));
    }
    return edges;
  }

  // 同種のBiquadを stages 段カスケードしてフィルタを急峻にする。
  // 戻り値の first を入力、last を出力として配線する。
  makeCascade(audioContext, type, freq, q, stages) {
    const all = [];
    for (let s = 0; s < stages; s++) {
      const f = audioContext.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      if (s > 0) all[s - 1].connect(f);
      all.push(f);
    }
    return { first: all[0], last: all[all.length - 1], all };
  }

  createCarrierMix(audioContext, baseFreq, tone) {
    const carrierMix = audioContext.createGain();
    carrierMix.gain.value = 0.9;
    this.carrierVoices = [];
    this.carrierFreq = baseFreq;

    // ratio は基準周波数に対する倍率。setCarrierPitch() で全声部をまとめて動かす。
    const addOsc = (type, ratio, gainValue, detune = 0) => {
      const osc = audioContext.createOscillator();
      const g = audioContext.createGain();
      osc.type = type;
      osc.frequency.value = baseFreq * ratio;
      osc.detune.value = detune;
      g.gain.value = gainValue;
      osc.connect(g).connect(carrierMix);
      osc.start();
      this.oscillators.push(osc);
      this.nodes.push(g);
      this.carrierVoices.push({ osc, ratio });
    };

    if (tone === "square") {
      addOsc("square", 1.0, 0.85);
      addOsc("square", 1.5, 0.38);
      addOsc("square", 2.0, 0.22);
    } else if (tone === "robot_sine") {
      addOsc("sine", 1.0, 0.85);
      addOsc("sine", 2.0, 0.45);
      addOsc("sine", 3.0, 0.26);
    } else if (tone === "r2d2") {
      // R2-D2風: 細いホイッスル。音程はシーケンサ(startR2Sequencer)が細かく動かす。
      addOsc("sine", 1.0, 0.92);
      addOsc("sine", 2.0, 0.24);          // 倍音を少し足して電子的に
      addOsc("triangle", 1.0, 0.16, 7);   // 薄く重ねて厚みとうねり

      // ビブラートLFO → 各声部の detune(セント)。R2らしいうねりを与える。
      const lfo = audioContext.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 6.2;
      const lfoGain = audioContext.createGain();
      lfoGain.gain.value = 22;            // ±22セントのビブラート
      lfo.connect(lfoGain);
      for (const v of this.carrierVoices) {
        lfoGain.connect(v.osc.detune);
      }
      lfo.start();
      this.oscillators.push(lfo);
      this.nodes.push(lfoGain);
    } else {
      addOsc("sawtooth", 1.0, 0.82);
      addOsc("sawtooth", 1.0, 0.52, 8);
      addOsc("sawtooth", 1.5, 0.34);
      addOsc("sawtooth", 2.0, 0.22);
    }

    this.nodes.push(carrierMix);
    return carrierMix;
  }

  // キャリア全声部の音程をまとめて freq(Hz) に設定する。少しグライドさせる。
  setCarrierPitch(freq, glide = 0.025) {
    if (!this.audioContext || !this.carrierVoices.length) return;
    freq = Math.max(40, Math.min(2000, freq));
    this.carrierFreq = freq;
    const now = this.audioContext.currentTime;
    for (const v of this.carrierVoices) {
      v.osc.frequency.setTargetAtTime(freq * v.ratio, now, glide);
    }
  }

  // R2-D2モード: キャリア音程をランダムに細かく動かし、ピヨピヨ/ピュイーンを作る。
  startR2Sequencer() {
    this.stopR2Sequencer();
    const ratios = [2.5, 3.2, 4, 5, 6.3, 8, 10, 12.5, 16];
    const step = () => {
      if (!this.isRunning || this.tone !== "r2d2") {
        this.r2Timer = null;
        return;
      }
      const base = this.getSettings().baseFreq;
      const target = base * ratios[Math.floor(Math.random() * ratios.length)];
      const roll = Math.random();
      // ピッ(素早いステップ)/ ピュイーン(スウィープ)/ 短いブリップ を混ぜる。
      const glide = roll < 0.5 ? 0.012 : (roll < 0.82 ? 0.05 + Math.random() * 0.13 : 0.005);
      this.setCarrierPitch(target, glide);
      this.r2Timer = setTimeout(step, 70 + Math.random() * 200);
    };
    step();
  }

  stopR2Sequencer() {
    if (this.r2Timer) {
      clearTimeout(this.r2Timer);
      this.r2Timer = null;
    }
  }

  // ピッチ追従/MIDIモードでは基準音程スライダーを110Hz基準の移調倍率として使う。
  transposeRatio() {
    return this.getSettings().baseFreq / 110;
  }

  // 自己相関による単音ピッチ検出。歌など単音のメロディ向け。
  detectPitch(buf, sampleRate) {
    const SIZE = buf.length;
    let sumSq = 0;
    for (let i = 0; i < SIZE; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / SIZE);
    if (rms < 0.01) return -1;                       // 無音は検出しない

    const minLag = Math.max(2, Math.floor(sampleRate / 700));
    const maxLag = Math.min(SIZE - 2, Math.floor(sampleRate / 70));
    if (maxLag <= minLag) return -1;

    const corr = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let i = 0; i < SIZE - lag; i++) s += buf[i] * buf[i + lag];
      corr[lag] = s / (SIZE - lag);
    }

    // lag=0付近の自己相関ピークから下る区間を飛ばし、最初の谷まで進む。
    let lag = minLag;
    while (lag < maxLag && corr[lag] > corr[lag + 1]) lag++;

    // 最初の谷以降で最初の有意なピークを採用(オクターブ下げ誤検出を抑える)。
    const threshold = 0.3 * rms * rms;
    let bestLag = -1;
    for (; lag <= maxLag; lag++) {
      if (corr[lag] > threshold && corr[lag] >= corr[lag - 1] && corr[lag] > corr[lag + 1]) {
        bestLag = lag;
        break;
      }
    }
    if (bestLag < 1) return -1;

    // 放物線補間でピーク位置(=周期)を微調整して滑らかにする。
    const c0 = corr[bestLag - 1];
    const c1 = corr[bestLag];
    const c2 = corr[bestLag + 1];
    const denom = c0 - 2 * c1 + c2;
    const shift = denom !== 0 ? (0.5 * (c0 - c2)) / denom : 0;
    const freq = sampleRate / (bestLag + shift);
    return (freq >= 65 && freq <= 1000) ? freq : -1;
  }

  // ---- MIDI入力 ----
  async setupMidi() {
    if (!navigator.requestMIDIAccess) {
      throw new Error("このブラウザはWeb MIDI APIに非対応です。Chrome/Edge系を使ってください。");
    }
    if (!this.midiAccess) {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      this.midiAccess.onstatechange = () => this.attachMidiInputs();
    }
    return this.attachMidiInputs();
  }

  attachMidiInputs() {
    if (!this.midiAccess) return 0;
    let count = 0;
    this.midiAccess.inputs.forEach((input) => {
      input.onmidimessage = (e) => this.onMidiMessage(e);
      count++;
    });
    return count;
  }

  onMidiMessage(e) {
    const d = e.data;
    if (!d || d.length < 3) return;
    const cmd = d[0] & 0xf0;
    const note = d[1];
    const vel = d[2];
    if (cmd === 0x90 && vel > 0) {
      // ノートオン: 後着優先で積む
      this.midiNotes = this.midiNotes.filter((n) => n !== note);
      this.midiNotes.push(note);
      this.applyMidiPitch();
    } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
      // ノートオフ
      this.midiNotes = this.midiNotes.filter((n) => n !== note);
      this.applyMidiPitch();
    }
  }

  applyMidiPitch() {
    if (this.tone === "r2d2") return;
    if (this.pitchMode !== "midi" || !this.midiNotes.length) return;
    const note = this.midiNotes[this.midiNotes.length - 1];
    const freq = 440 * Math.pow(2, (note - 69) / 12);
    this.setCarrierPitch(freq * this.transposeRatio());
  }

  // モード切替。fixed/midi はその場で反映、pitch はメーターループが処理する。
  setPitchMode(mode) {
    this.pitchMode = mode;
    this.smoothedPitch = 0;
    this.pitchReference = 0;
    this.pitchOutlierPending = 0;
    if (!this.isRunning || this.tone === "r2d2") return;
    if (mode === "fixed") {
      this.setCarrierPitch(this.getSettings().baseFreq);
    } else if (mode === "midi") {
      this.applyMidiPitch();
    }
  }

  async ensureAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("このブラウザはWeb Audio APIに対応していません。");
    // 既存のcontextが生きていれば再利用する。毎回newするとブラウザの
    // AudioContext上限に達し、設定反映が数回で失敗するため。
    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = new AudioContextClass({ latencyHint: "interactive" });
    }
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    // 出力先デバイスが指定されていれば適用(Web会議用の仮想オーディオケーブル等)。
    if (this.outputDeviceId && typeof this.audioContext.setSinkId === "function") {
      try {
        await this.audioContext.setSinkId(this.outputDeviceId);
      } catch (err) {
        console.warn("setSinkId失敗:", err);
      }
    }
  }

  // 出力先デバイスを切り替える。実行中ならその場で反映する。
  async setOutputDevice(deviceId) {
    this.outputDeviceId = deviceId || "";
    if (this.audioContext && typeof this.audioContext.setSinkId === "function") {
      await this.audioContext.setSinkId(this.outputDeviceId);
    }
  }

  async start() {
    if (this.isRunning) return;

    const settings = this.getSettings();
    this.pitchMode = settings.pitchMode;
    this.tone = settings.tone;
    this.smoothedPitch = 0;
    this.pitchReference = 0;
    this.pitchOutlierPending = 0;
    await this.ensureAudioContext();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("マイク入力に対応していません。Chrome/EdgeでlocalhostまたはHTTPSから開いてください。");
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      }
    });

    const ac = this.audioContext;
    await ac.resume();

    this.source = ac.createMediaStreamSource(this.stream);
    this.analyser = ac.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);

    const preHP = ac.createBiquadFilter();
    preHP.type = "highpass";
    preHP.frequency.value = 55;
    preHP.Q.value = 0.707;
    this.source.connect(preHP);

    const carrierMix = this.createCarrierMix(ac, settings.baseFreq, settings.tone);

    const wetSum = ac.createGain();
    wetSum.gain.value = 1.1;

    const edges = this.makeBandEdges(settings.bands, ac.sampleRate);
    this.envBoostGains = [];

    for (let i = 0; i < settings.bands; i++) {
      const lo = edges[i];
      const hi = edges[i + 1];
      const center = Math.sqrt(lo * hi);
      const bandwidth = hi - lo;
      const q = Math.max(0.45, Math.min(9, center / bandwidth));

      // バンドパスを2段カスケードで急峻化(skirt 12→24dB/oct)。2段で実効Qが
      // 上がるぶん、各段のQは緩めてバンド同士の被り(カバレッジ)を保つ。
      const qStage = q / 1.55;
      const modBand = this.makeCascade(ac, "bandpass", center, qStage, 2);

      const abs = this.createWaveShaperAbs(ac);

      // 包絡の平滑化も2段にしてリップル(ザラつき)を低減する。
      const envLP = this.makeCascade(ac, "lowpass", 30, 0.707, 2);

      // 重要: ブラウザのマイク入力はかなり小さいことがあるため、包絡を大きく増幅する。
      const envScale = ac.createGain();
      envScale.gain.value = settings.envBoost;
      this.envBoostGains.push(envScale);

      const carBand = this.makeCascade(ac, "bandpass", center, qStage, 2);

      const bandGain = ac.createGain();
      bandGain.gain.value = 0;

      const bandLevel = ac.createGain();
      bandLevel.gain.value = 0.95 + 0.75 * (i / Math.max(1, settings.bands - 1));

      preHP.connect(modBand.first);
      modBand.last.connect(abs).connect(envLP.first);
      envLP.last.connect(envScale).connect(bandGain.gain);
      carrierMix.connect(carBand.first);
      carBand.last.connect(bandGain).connect(bandLevel).connect(wetSum);

      this.nodes.push(...modBand.all, abs, ...envLP.all, envScale, ...carBand.all, bandGain, bandLevel);
    }

    // 子音(サ行・破裂音)の明瞭度補助: 声の高域だけを取り出し、それ自身の包絡で
    // ゲートして wet に混ぜる。母音やピッチ成分を含まないので「生声」には聞こえず、
    // 無音時はゲートが閉じるためノイズも増えない。
    const sibHP = this.makeCascade(ac, "highpass", 3800, 0.707, 2);

    const sibAbs = this.createWaveShaperAbs(ac);
    const sibEnvLP = this.makeCascade(ac, "lowpass", 42, 0.707, 2);
    const sibEnvScale = ac.createGain();
    sibEnvScale.gain.value = settings.envBoost;
    this.envBoostGains.push(sibEnvScale);
    const sibGate = this.createNoiseGate(ac);

    const sibVca = ac.createGain();
    sibVca.gain.value = 0;
    const sibLevel = ac.createGain();
    sibLevel.gain.value = 0.55;

    preHP.connect(sibHP.first);
    sibHP.last.connect(sibAbs).connect(sibEnvLP.first);
    sibEnvLP.last.connect(sibEnvScale).connect(sibGate).connect(sibVca.gain);
    sibHP.last.connect(sibVca).connect(sibLevel).connect(wetSum);

    this.nodes.push(...sibHP.all, sibAbs, ...sibEnvLP.all, sibEnvScale, sibGate, sibVca, sibLevel);

    const compressor = ac.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 24;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.12;

    const softClipper = this.createSoftClipper(ac);

    // wet全体のマスターノイズゲート。帯域ごとには触れないので、
    // 開いている間は発話の明瞭度・スペクトルバランスを一切損なわない。
    this.wetGate = ac.createGain();
    this.wetGate.gain.value = 0;

    // 高音ハウリング抑制: キャリア音程が高いほど wet を下げる(メーターループで制御)。
    this.hfDamp = ac.createGain();
    this.hfDamp.gain.value = 1;

    this.masterGain = ac.createGain();
    this.masterGain.gain.value = settings.output;

    this.dryGain = ac.createGain();
    this.dryGain.gain.value = settings.dryMix;

    this.monitorGain = ac.createGain();
    this.monitorGain.gain.value = settings.monitor;

    // monitorGain は「音が出るか」の切り分け用。不要なら0にする。
    preHP.connect(this.monitorGain);
    preHP.connect(this.dryGain);

    wetSum.connect(compressor).connect(softClipper).connect(this.wetGate).connect(this.hfDamp).connect(this.masterGain);
    this.dryGain.connect(this.masterGain);
    this.monitorGain.connect(this.masterGain);
    this.masterGain.connect(ac.destination);

    this.nodes.push(preHP, carrierMix, wetSum, compressor, softClipper, this.wetGate, this.hfDamp, this.masterGain, this.dryGain, this.monitorGain, this.analyser);
    this.isRunning = true;

    // MIDIモードで既に鍵盤が押されていれば、その音程を反映しておく。
    if (this.pitchMode === "midi") this.applyMidiPitch();

    // R2-D2モードは音程シーケンサで細かくピヨピヨ動かす。
    if (this.tone === "r2d2") this.startR2Sequencer();

    this.startMeter();
  }

  applyLightSettings() {
    if (!this.isRunning || !this.audioContext) return;
    const settings = this.getSettings();
    const now = this.audioContext.currentTime;
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(settings.output, now, 0.02);
    if (this.dryGain) this.dryGain.gain.setTargetAtTime(settings.dryMix, now, 0.02);
    if (this.monitorGain) this.monitorGain.gain.setTargetAtTime(settings.monitor, now, 0.02);
    for (const g of this.envBoostGains) {
      g.gain.setTargetAtTime(settings.envBoost, now, 0.02);
    }
    // 基準音程スライダー: 固定モードは音程そのもの、MIDIは移調量として即反映。
    // R2-D2モードは音程をシーケンサが握るので、ここでは触らない。
    if (this.tone !== "r2d2") {
      if (this.pitchMode === "fixed") {
        this.setCarrierPitch(settings.baseFreq);
      } else if (this.pitchMode === "midi") {
        this.applyMidiPitch();
      }
    }
  }

  async playTestTone() {
    await this.ensureAudioContext();
    const ac = this.audioContext;

    if (this.testOsc) {
      try { this.testOsc.stop(); } catch (_) {}
      try { this.testOsc.disconnect(); } catch (_) {}
      this.testOsc = null;
    }
    if (this.testGain) {
      try { this.testGain.disconnect(); } catch (_) {}
      this.testGain = null;
    }

    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = "sawtooth";
    osc.frequency.value = 220;
    g.gain.value = 0.0;
    osc.connect(g).connect(ac.destination);
    osc.start();
    g.gain.setTargetAtTime(0.18, ac.currentTime, 0.01);
    g.gain.setTargetAtTime(0.0, ac.currentTime + 0.45, 0.04);
    setTimeout(() => {
      try { osc.stop(); } catch (_) {}
      try { osc.disconnect(); } catch (_) {}
      try { g.disconnect(); } catch (_) {}
    }, 800);
    this.testOsc = osc;
    this.testGain = g;
  }

  startMeter() {
    const bar = document.getElementById("rtMeterBar");
    const levelText = document.getElementById("rtLevelText");
    const timeData = new Uint8Array(this.analyser.fftSize);
    const floatData = new Float32Array(this.analyser.fftSize);
    const tick = () => {
      if (!this.isRunning || !this.analyser) return;
      this.analyser.getByteTimeDomainData(timeData);
      let sum = 0;
      for (const v of timeData) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / timeData.length);
      const level = Math.min(100, Math.round(rms * 520));
      if (bar) bar.style.width = `${level}%`;

      // マスターノイズゲート: 入力全体のRMSで wet を開閉する。帯域ごとには
      // 触らないため、開いている間の発話は明瞭なまま。閾値はノイズフロアに自動追従。
      if (this.wetGate) {
        // ノイズフロア追従: 速く下げ・ゆっくり上げて無音時のレベルに収束させる。
        if (rms < this.noiseFloor) {
          this.noiseFloor = this.noiseFloor * 0.65 + rms * 0.35;
        } else {
          this.noiseFloor = this.noiseFloor * 0.997 + rms * 0.003;
        }
        this.noiseFloor = Math.min(0.15, Math.max(0.0005, this.noiseFloor));

        const openThresh = Math.max(0.006, this.noiseFloor * 2.6);
        const closeThresh = Math.max(0.004, this.noiseFloor * 1.8);
        if (!this.wetGateOpen && rms > openThresh) {
          this.wetGateOpen = true;
        } else if (this.wetGateOpen && rms < closeThresh) {
          this.wetGateOpen = false;
        }
        const tc = this.wetGateOpen ? 0.008 : 0.12;  // 速いアタック / ゆるいリリース
        this.wetGate.gain.setTargetAtTime(
          this.wetGateOpen ? 1 : 0, this.audioContext.currentTime, tc);
      }

      // ピッチ追従モード: 声の基本周波数を検出してキャリア音程に反映する。
      if (this.pitchMode === "pitch" && this.tone !== "r2d2") {
        this.analyser.getFloatTimeDomainData(floatData);
        const f0 = this.detectPitch(floatData, this.audioContext.sampleRate);
        if (f0 > 0) {
          if (this.smoothedPitch <= 0) {
            // 最初の検出を「基準入力ピッチ」として記録する。
            this.smoothedPitch = f0;
            this.pitchReference = f0;
            this.pitchOutlierPending = 0;
          } else {
            const ratio = f0 / this.smoothedPitch;
            if (ratio > 1.7 || ratio < 0.59) {
              // 1オクターブ近く外れた検出。単発ならオクターブ誤検出/雑音として無視し、
              // 2フレーム連続で同じ音域なら本物の跳躍とみなして追従する。
              if (this.pitchOutlierPending > 0 &&
                  Math.abs(f0 / this.pitchOutlierPending - 1) < 0.12) {
                this.smoothedPitch = f0;
                this.pitchOutlierPending = 0;
              } else {
                this.pitchOutlierPending = f0;
              }
            } else {
              // 通常の追従。強めに平滑化して細かい揺れ(twitch)を抑える。
              this.smoothedPitch = this.smoothedPitch * 0.8 + f0 * 0.2;
              this.pitchOutlierPending = 0;
            }
          }
          // 入力ピッチの「基準入力ピッチからの相対変化」を基準音程に掛ける。
          // 例: 声が基準より1.2倍上がれば、キャリアも基準音程の1.2倍へ動く。
          const rel = this.pitchReference > 0 ? this.smoothedPitch / this.pitchReference : 1;
          this.setCarrierPitch(this.getSettings().baseFreq * rel);
        }
      }

      // 高音ハウリング抑制: キャリア基本周波数が高いほど wet を下げ、帰還ループの
      // 利得を減らす。350Hz以下は等倍、それ以上で漸減(下限0.45)。
      if (this.hfDamp) {
        const cf = this.carrierFreq;
        const damp = cf > 350 ? Math.max(0.45, 1 - (cf - 350) / 2000) : 1.0;
        this.hfDamp.gain.setTargetAtTime(damp, this.audioContext.currentTime, 0.06);
      }

      if (levelText) {
        levelText.textContent =
          `入力RMS: ${rms.toFixed(4)} / ${level}% / キャリア: ${Math.round(this.carrierFreq)}Hz` +
          ` / ${this.wetGateOpen ? "GATE開" : "GATE閉"}`;
      }
      this.meterTimer = requestAnimationFrame(tick);
    };
    tick();
  }

  async rebuild() {
    if (!this.isRunning) return;
    await this.stop(false);
    await this.start();
  }

  async stop(closeContext = true) {
    if (this.meterTimer) cancelAnimationFrame(this.meterTimer);
    this.meterTimer = null;
    this.stopR2Sequencer();

    for (const osc of this.oscillators) {
      try { osc.stop(); } catch (_) {}
      try { osc.disconnect(); } catch (_) {}
    }
    this.oscillators = [];
    this.carrierVoices = [];

    for (const node of this.nodes) {
      try { node.disconnect(); } catch (_) {}
    }
    this.nodes = [];
    this.envBoostGains = [];

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (closeContext && this.audioContext) {
      try { await this.audioContext.close(); } catch (_) {}
      this.audioContext = null;
    }

    this.source = null;
    this.masterGain = null;
    this.dryGain = null;
    this.monitorGain = null;
    this.analyser = null;
    this.wetGate = null;
    this.hfDamp = null;
    this.wetGateOpen = false;
    this.noiseFloor = 0.012;
    this.isRunning = false;
    this.smoothedPitch = 0;
    this.pitchReference = 0;
    this.pitchOutlierPending = 0;

    const bar = document.getElementById("rtMeterBar");
    if (bar) bar.style.width = "0%";
    const levelText = document.getElementById("rtLevelText");
    if (levelText) levelText.textContent = "入力RMS: -";
  }
}

const rt = new RealtimeVocoder();

const rtStartBtn = document.getElementById("rtStartBtn");
const rtStopBtn = document.getElementById("rtStopBtn");
const rtApplyBtn = document.getElementById("rtApplyBtn");
const rtTestBtn = document.getElementById("rtTestBtn");
const rtStatus = document.getElementById("rtStatus");
const rtBadge = document.getElementById("rtBadge");

function bindRangeValue(inputId, outputId, digits = 0) {
  const input = document.getElementById(inputId);
  const output = document.getElementById(outputId);
  if (!input || !output) return;
  const update = () => {
    const v = Number(input.value);
    output.textContent = digits > 0 ? v.toFixed(digits) : String(Math.round(v));
    rt.applyLightSettings();
  };
  input.addEventListener("input", update);
  update();
}

bindRangeValue("rtBaseFreq", "rtBaseFreqVal", 0);
bindRangeValue("rtBands", "rtBandsVal", 0);
bindRangeValue("rtDryMix", "rtDryMixVal", 2);
bindRangeValue("rtOutput", "rtOutputVal", 2);
bindRangeValue("rtEnvBoost", "rtEnvBoostVal", 0);
bindRangeValue("rtMonitor", "rtMonitorVal", 2);

document.getElementById("rtTone")?.addEventListener("change", () => {
  if (rt.isRunning) rtStatus.textContent = "波形変更は『設定を反映』で反映されます。";
});

document.getElementById("rtBands")?.addEventListener("input", () => {
  if (rt.isRunning) rtStatus.textContent = "バンド数変更は『設定を反映』で反映されます。";
});

// キャリア音程モードの切替
const rtPitchMode = document.getElementById("rtPitchMode");
if (rtPitchMode) {
  rt.pitchMode = rtPitchMode.value;
  rtPitchMode.addEventListener("change", async () => {
    const mode = rtPitchMode.value;
    rt.setPitchMode(mode);
    if (mode === "midi") {
      rtStatus.textContent = "MIDIデバイスを初期化しています…";
      try {
        const n = await rt.setupMidi();
        rtStatus.textContent = n > 0
          ? `MIDI入力モード: ${n}台のMIDIデバイスを検出しました。鍵盤でキャリア音程を演奏できます。`
          : "MIDI入力モード: MIDIデバイスが見つかりません。接続後にもう一度このモードを選び直してください。";
      } catch (err) {
        rtStatus.textContent = "MIDI初期化に失敗しました: " + err.message;
      }
    } else if (mode === "pitch") {
      rtStatus.textContent = "ピッチ追従モード: 声の音程にキャリアが追従します。単音(歌)向けです。";
    } else {
      rtStatus.textContent = "固定モード: 基準音程スライダーでキャリア音程を決めます。";
    }
  });
}

// 出力先デバイス選択 — Web会議へ流すための仮想オーディオケーブル対応(setSinkId)
const rtOutputDevice = document.getElementById("rtOutputDevice");
const rtRefreshDevices = document.getElementById("rtRefreshDevices");

async function populateOutputDevices() {
  if (!rtOutputDevice || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return 0;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    const current = rtOutputDevice.value;
    rtOutputDevice.innerHTML = '<option value="">既定の出力(スピーカー/ヘッドホン)</option>';
    for (const d of outputs) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `出力デバイス (${String(d.deviceId).slice(0, 8)}…)`;
      rtOutputDevice.appendChild(opt);
    }
    // 再列挙前の選択を復元する。
    if (current && outputs.some((d) => d.deviceId === current)) {
      rtOutputDevice.value = current;
    }
    return outputs.length;
  } catch (err) {
    console.warn("出力デバイスの列挙に失敗:", err);
    return 0;
  }
}

if (rtOutputDevice) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC && !("setSinkId" in AC.prototype)) {
    rtStatus.textContent =
      "注意: このブラウザは出力先デバイス選択(setSinkId)に未対応です。Chrome/Edgeをお使いください。";
  }
  populateOutputDevices();
  rtOutputDevice.addEventListener("change", async () => {
    try {
      await rt.setOutputDevice(rtOutputDevice.value);
      const name = rtOutputDevice.options[rtOutputDevice.selectedIndex]?.textContent || "既定";
      rtStatus.textContent = `出力先を「${name}」に切り替えました。`;
    } catch (err) {
      rtStatus.textContent = "出力先の切り替えに失敗しました: " + err.message;
    }
  });
}

rtRefreshDevices?.addEventListener("click", async () => {
  const n = await populateOutputDevices();
  rtStatus.textContent =
    `出力デバイスを ${n} 件検出しました。一覧に仮想ケーブルが無い場合は、` +
    `仮想オーディオケーブル未インストール、またはWindows側で無効になっています。`;
});

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", populateOutputDevices);
}

function setRealtimeUi(running) {
  rtStartBtn.disabled = running;
  rtStopBtn.disabled = !running;
  rtApplyBtn.disabled = !running;
  rtBadge.textContent = running ? "LIVE" : "STOP";
  rtBadge.classList.toggle("on", running);
  rtBadge.classList.toggle("off", !running);
}

rtTestBtn?.addEventListener("click", async () => {
  try {
    await rt.playTestTone();
    rtStatus.textContent = "テストトーンを再生しました。聞こえない場合はブラウザ/OS/出力デバイス側の問題です。";
  } catch (err) {
    rtStatus.textContent = "テストトーン再生に失敗しました: " + err.message;
  }
});

rtStartBtn?.addEventListener("click", async () => {
  // 許可ダイアログ表示中の連打で二重起動しないよう、await前に無効化する。
  rtStartBtn.disabled = true;
  try {
    rtStatus.textContent = "マイクを初期化しています。ブラウザの許可ダイアログを承認してください。";
    await rt.start();
    setRealtimeUi(true);
    populateOutputDevices();  // マイク許可後はデバイス名が取得できる
    rtStatus.textContent = "リアルタイム変換中です。まず入力レベルメーターが動くか確認してください。";
  } catch (err) {
    setRealtimeUi(false);
    console.error(err);
    rtStatus.textContent = "リアルタイム開始に失敗しました: " + err.message;
  }
});

rtStopBtn?.addEventListener("click", async () => {
  await rt.stop();
  setRealtimeUi(false);
  rtStatus.textContent = "停止しました。";
});

rtApplyBtn?.addEventListener("click", async () => {
  try {
    rtStatus.textContent = "設定を反映しています。";
    await rt.rebuild();
    setRealtimeUi(true);
    rtStatus.textContent = "設定を反映しました。";
  } catch (err) {
    setRealtimeUi(false);
    console.error(err);
    rtStatus.textContent = "設定反映に失敗しました: " + err.message;
  }
});

window.addEventListener("beforeunload", () => {
  rt.stop();
});
