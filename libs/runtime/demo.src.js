const effekseerDemo = (() => {
  let Module = {};
  let Core = {};
  let runtimeInitialized = false;
  let runtimeInitializing = false;
  let preinitializedDevice = null;
  let externalWebGPUDevice = null;
  let requestedLogEnabled = true;
  let contextId = 0;
  let onRuntimeReadyQueue = [];

  const deferCallback = (callback) => {
    if (typeof callback !== "function") {
      return;
    }
    if (typeof queueMicrotask === "function") {
      queueMicrotask(callback);
    } else {
      Promise.resolve().then(callback);
    }
  };

  const syncCoreLogEnabled = () => {
    if (!runtimeInitialized || typeof Core.SetLogEnabled !== "function") {
      return;
    }
    Core.SetLogEnabled(requestedLogEnabled ? 1 : 0);
  };

  const toArrayBuffer = (data) => {
    if (data instanceof ArrayBuffer) {
      return data;
    }
    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    return null;
  };

  const stripUrlDecorations = (value) => {
    return String(value || "").replace(/\\/g, "/").split("?")[0].split("#")[0];
  };

  const readMagic4 = (buffer) => {
    const ab = toArrayBuffer(buffer);
    if (!ab || ab.byteLength < 4) {
      return "";
    }
    return String.fromCharCode(...new Uint8Array(ab, 0, 4));
  };

  const isEfkwgdPath = (value) => {
    return typeof value === "string" && stripUrlDecorations(value).toLowerCase().endsWith(".efkwgd");
  };

  const ensureEfkwgdBuffer = (data) => {
    const ab = toArrayBuffer(data);
    if (!ab) {
      throw new Error("loadEffect() expects a .efkwgd URL or binary payload.");
    }
    if (readMagic4(ab) !== "EWGD") {
      throw new Error("loadEffect() expects .efkwgd binary data.");
    }
    return ab;
  };

  const loadBinary = (url, onload, onerror) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      const status = xhr.status | 0;
      if ((status >= 200 && status < 300) || status === 0) {
        onload(xhr.response);
      } else if (onerror) {
        onerror("not found", url);
      }
    };
    xhr.onerror = () => {
      if (onerror) {
        onerror("not found", url);
      }
    };
    xhr.send(null);
  };

  const requestPreinitializedDevice = async () => {
    if (externalWebGPUDevice) {
      return externalWebGPUDevice;
    }
    if (!navigator.gpu) {
      throw new Error("WebGPU is not available in this browser.");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("Failed to acquire a WebGPU adapter.");
    }
    const requiredFeatures = [];
    if (adapter.features && adapter.features.has("float32-filterable")) {
      requiredFeatures.push("float32-filterable");
    }
    const hasTimestampOps =
      (typeof GPUCommandEncoder !== "undefined") &&
      GPUCommandEncoder.prototype &&
      (typeof GPUCommandEncoder.prototype.writeTimestamp === "function") &&
      (typeof GPUCommandEncoder.prototype.resolveQuerySet === "function");
    if (hasTimestampOps && adapter.features && adapter.features.has("timestamp-query")) {
      requiredFeatures.push("timestamp-query");
    }
    return await adapter.requestDevice(requiredFeatures.length > 0 ? { requiredFeatures } : undefined);
  };

  const floatArrayScratch = {
    ptr: 0,
    capacity: 0,
  };

  const ensureFloatArrayScratch = (requiredCount) => {
    if (requiredCount <= floatArrayScratch.capacity && floatArrayScratch.ptr !== 0) {
      return floatArrayScratch.ptr;
    }
    if (floatArrayScratch.ptr !== 0) {
      Module._free(floatArrayScratch.ptr);
      floatArrayScratch.ptr = 0;
      floatArrayScratch.capacity = 0;
    }
    floatArrayScratch.ptr = Module._malloc(requiredCount * 4);
    floatArrayScratch.capacity = requiredCount;
    return floatArrayScratch.ptr;
  };

  const withFloatArray = (arrayLike, callback) => {
    const arr = (arrayLike instanceof Float32Array) ? arrayLike : new Float32Array(arrayLike);
    if (arr.length <= 0) {
      callback(0);
      return;
    }
    const ptr = ensureFloatArrayScratch(arr.length);
    Module.HEAPF32.set(arr, ptr >> 2);
    callback(ptr);
  };

  const WGPUTextureFormatValues = Object.freeze({
    "rgba8unorm": 0x16,
    "rgba8unorm-srgb": 0x17,
    "bgra8unorm": 0x1B,
    "bgra8unorm-srgb": 0x1C,
    "rgba16float": 0x28,
    "depth24plus": 0x2E,
    "depth24plus-stencil8": 0x2F,
    "depth32float": 0x30
  });

  const toTextureFormatValue = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value | 0;
    }
    if (typeof value !== "string") {
      return null;
    }
    const key = value.trim().toLowerCase();
    if (!key) {
      return null;
    }
    return Object.prototype.hasOwnProperty.call(WGPUTextureFormatValues, key)
      ? WGPUTextureFormatValues[key]
      : null;
  };

  const toSampleCountValue = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      return 1;
    }
    return Math.max(1, Math.floor(n));
  };

  const initCoreBindings = () => {
    Core = {
      InitInternal: Module.cwrap("EffekseerInitInternal", "number", ["number", "number", "string", "number", "number"]),
      InitExternal: Module.cwrap("EffekseerInitExternal", "number", ["number", "number", "number", "number"]),
      Init: Module.cwrap("EffekseerInit", "number", ["number", "number", "string", "number", "number", "number"]),
      Terminate: Module.cwrap("EffekseerTerminate", "void", ["number"]),
      Update: Module.cwrap("EffekseerUpdate", "void", ["number", "number"]),
      BeginUpdate: Module.cwrap("EffekseerBeginUpdate", "void", ["number"]),
      EndUpdate: Module.cwrap("EffekseerEndUpdate", "void", ["number"]),
      UpdateHandle: Module.cwrap("EffekseerUpdateHandle", "void", ["number", "number", "number"]),
      Draw: Module.cwrap("EffekseerDraw", "void", ["number"]),
      DrawExternal: Module.cwrap("EffekseerDrawExternal", "void", ["number"]),
      DrawExternalBack: Module.cwrap("EffekseerDrawExternalBack", "void", ["number"]),
      DrawExternalFront: Module.cwrap("EffekseerDrawExternalFront", "void", ["number"]),
      BeginDraw: Module.cwrap("EffekseerBeginDraw", "void", ["number"]),
      EndDraw: Module.cwrap("EffekseerEndDraw", "void", ["number"]),
      DrawHandle: Module.cwrap("EffekseerDrawHandle", "void", ["number", "number"]),
      SetProjectionMatrix: Module.cwrap("EffekseerSetProjectionMatrix", "void", ["number", "number"]),
      SetProjectionPerspective: Module.cwrap("EffekseerSetProjectionPerspective", "void", ["number", "number", "number", "number", "number"]),
      SetProjectionOrthographic: Module.cwrap("EffekseerSetProjectionOrthographic", "void", ["number", "number", "number", "number", "number"]),
      SetCameraMatrix: Module.cwrap("EffekseerSetCameraMatrix", "void", ["number", "number"]),
      SetCameraLookAt: Module.cwrap("EffekseerSetCameraLookAt", "void", ["number", "number", "number", "number", "number", "number", "number", "number", "number", "number"]),
      LoadEffect: Module.cwrap("EffekseerLoadEffect", "number", ["number", "number", "number", "number"]),
      ReleaseEffect: Module.cwrap("EffekseerReleaseEffect", "void", ["number", "number"]),
      StopAllEffects: Module.cwrap("EffekseerStopAllEffects", "void", ["number"]),
      PlayEffect: Module.cwrap("EffekseerPlayEffect", "number", ["number", "number", "number", "number", "number"]),
      StopEffect: Module.cwrap("EffekseerStopEffect", "void", ["number", "number"]),
      StopRoot: Module.cwrap("EffekseerStopRoot", "void", ["number", "number"]),
      Exists: Module.cwrap("EffekseerExists", "number", ["number", "number"]),
      SetFrame: Module.cwrap("EffekseerSetFrame", "void", ["number", "number", "number"]),
      SetLocation: Module.cwrap("EffekseerSetLocation", "void", ["number", "number", "number", "number", "number"]),
      SetRotation: Module.cwrap("EffekseerSetRotation", "void", ["number", "number", "number", "number", "number"]),
      SetScale: Module.cwrap("EffekseerSetScale", "void", ["number", "number", "number", "number", "number"]),
      SetMatrix: Module.cwrap("EffekseerSetMatrix", "void", ["number", "number", "number"]),
      SetAllColor: Module.cwrap("EffekseerSetAllColor", "void", ["number", "number", "number", "number", "number", "number"]),
      SetTargetLocation: Module.cwrap("EffekseerSetTargetLocation", "void", ["number", "number", "number", "number", "number"]),
      GetDynamicInput: Module.cwrap("EffekseerGetDynamicInput", "number", ["number", "number", "number"]),
      SetDynamicInput: Module.cwrap("EffekseerSetDynamicInput", "void", ["number", "number", "number", "number"]),
      SendTrigger: Module.cwrap("EffekseerSendTrigger", "void", ["number", "number", "number"]),
      SetPaused: Module.cwrap("EffekseerSetPaused", "void", ["number", "number", "number"]),
      SetShown: Module.cwrap("EffekseerSetShown", "void", ["number", "number", "number"]),
      SetSpeed: Module.cwrap("EffekseerSetSpeed", "void", ["number", "number", "number"]),
      SetRandomSeed: Module.cwrap("EffekseerSetRandomSeed", "void", ["number", "number", "number"]),
      SetCompositeMode: Module.cwrap("EffekseerSetCompositeMode", "void", ["number", "number"]),
      GetRestInstancesCount: Module.cwrap("EffekseerGetRestInstancesCount", "number", ["number"]),
      GetUpdateTime: Module.cwrap("EffekseerGetUpdateTime", "number", ["number"]),
      GetDrawTime: Module.cwrap("EffekseerGetDrawTime", "number", ["number"]),
      GetDrawCallCount: Module.cwrap("EffekseerGetDrawCallCount", "number", ["number"]),
      GetDrawVertexCount: Module.cwrap("EffekseerGetDrawVertexCount", "number", ["number"]),
      GetTotalParticleCount: Module.cwrap("EffekseerGetTotalParticleCount", "number", ["number"]),
      SetRestorationOfStatesFlag: Module.cwrap("EffekseerSetRestorationOfStatesFlag", "void", ["number", "number"]),
      SetLogEnabled: Module.cwrap("EffekseerSetLogEnabled", "void", ["number"]),
    };

    runtimeInitialized = true;
    runtimeInitializing = false;
    syncCoreLogEnabled();
    const callbacks = onRuntimeReadyQueue;
    onRuntimeReadyQueue = [];
    callbacks.forEach((callback) => callback(true));
  };

  const initializeRuntimeInternal = async (wasmPath) => {
    if (runtimeInitialized) {
      return;
    }
    if (runtimeInitializing) {
      await new Promise((resolve, reject) => {
        onRuntimeReadyQueue.push((ok) => ok ? resolve() : reject(new Error("Demo runtime initialization failed.")));
      });
      return;
    }

    runtimeInitializing = true;

    if (typeof effekseer_webgpu_demo_native === "undefined") {
      runtimeInitializing = false;
      throw new Error("effekseer_webgpu_demo_native is not loaded.");
    }

    const params = {};
    if (typeof wasmPath === "string" && wasmPath.length > 0) {
      params.locateFile = (path) => path.endsWith(".wasm") ? wasmPath : path;
    }
    if (preinitializedDevice) {
      params.preinitializedWebGPUDevice = preinitializedDevice;
    }

    const moduleOrPromise = effekseer_webgpu_demo_native(params);
    Module = (moduleOrPromise instanceof Promise) ? await moduleOrPromise : moduleOrPromise;
    if (!preinitializedDevice && Module?.preinitializedWebGPUDevice) {
      preinitializedDevice = Module.preinitializedWebGPUDevice;
    }
    if (!preinitializedDevice) {
      preinitializedDevice = await requestPreinitializedDevice();
      Module.preinitializedWebGPUDevice = preinitializedDevice;
    }
    initCoreBindings();
  };

  class EffekseerEffect {
    constructor(context) {
      this.context = context;
      this.nativeptr = 0;
      this.mainBuffer = null;
      this.isLoaded = false;
      this.scale = 1.0;
      this.onload = null;
      this.onerror = null;
      this._loadFailed = false;
      this._loadErrorMessage = "";
      this._loadErrorPath = "";
    }

    _dispatchLoaded() {
      this.isLoaded = true;
      if (typeof this.onload === "function") {
        deferCallback(() => this.onload());
      }
    }

    _dispatchError(message, path = "") {
      this._loadFailed = true;
      this._loadErrorMessage = String(message || "failed to load effect");
      this._loadErrorPath = String(path || "");
      if (typeof this.onerror === "function") {
        deferCallback(() => this.onerror(this._loadErrorMessage, this._loadErrorPath));
      } else {
        console.error(`[EffekseerWebGPU Demo] ${this._loadErrorMessage}`);
      }
    }

    _load(buffer, sourcePath = "") {
      let ab = null;
      try {
        ab = ensureEfkwgdBuffer(buffer);
      } catch (error) {
        this._dispatchError(error && error.message ? error.message : "invalid efkwgd payload", sourcePath);
        return;
      }

      this.mainBuffer = ab;
      const memptr = Module._malloc(ab.byteLength);
      Module.HEAPU8.set(new Uint8Array(ab), memptr);
      this.nativeptr = Core.LoadEffect(this.context.nativeptr, memptr, ab.byteLength, this.scale);
      Module._free(memptr);

      if (!this.nativeptr) {
        this._dispatchError("failed to load .efkwgd effect", sourcePath);
        return;
      }

      this.context._effects.add(this);
      this._dispatchLoaded();
    }
  }

  class EffekseerHandle {
    constructor(context, nativeHandle) {
      this.context = context;
      this.native = nativeHandle;
    }

    stop() { Core.StopEffect(this.context.nativeptr, this.native); }
    stopRoot() { Core.StopRoot(this.context.nativeptr, this.native); }
    get exists() { return !!Core.Exists(this.context.nativeptr, this.native); }
    setFrame(frame) { Core.SetFrame(this.context.nativeptr, this.native, frame); }
    setLocation(x, y, z) { Core.SetLocation(this.context.nativeptr, this.native, x, y, z); }
    setRotation(x, y, z) { Core.SetRotation(this.context.nativeptr, this.native, x, y, z); }
    setScale(x, y, z) { Core.SetScale(this.context.nativeptr, this.native, x, y, z); }
    setAllColor(r, g, b, a) { Core.SetAllColor(this.context.nativeptr, this.native, r, g, b, a); }
    setTargetLocation(x, y, z) { Core.SetTargetLocation(this.context.nativeptr, this.native, x, y, z); }
    getDynamicInput(index) { return Core.GetDynamicInput(this.context.nativeptr, this.native, index); }
    setDynamicInput(index, value) { Core.SetDynamicInput(this.context.nativeptr, this.native, index, value); }
    sendTrigger(index) { Core.SendTrigger(this.context.nativeptr, this.native, index); }
    setPaused(paused) { Core.SetPaused(this.context.nativeptr, this.native, paused ? 1 : 0); }
    setShown(shown) { Core.SetShown(this.context.nativeptr, this.native, shown ? 1 : 0); }
    setSpeed(speed) { Core.SetSpeed(this.context.nativeptr, this.native, speed); }
    setRandomSeed(seed) { Core.SetRandomSeed(this.context.nativeptr, this.native, seed); }
    setMatrix(matrixArray) {
      withFloatArray(matrixArray, (ptr) => Core.SetMatrix(this.context.nativeptr, this.native, ptr));
    }
  }

  class EffekseerContext {
    constructor() {
      this.nativeptr = 0;
      this._effects = new Set();
      this.externalRenderPassEnabled = false;
      this.fixedUpdateStepFrames = 1.0;
      this.fixedUpdateMaxSubsteps = 4;
      this.fixedUpdateAccumulator = 0.0;
    }

    init(target, settings = {}) {
      if (settings.externalRenderPass === true) {
        return this.initExternal(settings);
      }

      let selector = "#canvas";
      if (typeof target === "string") {
        selector = target.startsWith("#") ? target : `#${target}`;
      } else if (typeof HTMLCanvasElement !== "undefined" && target instanceof HTMLCanvasElement) {
        if (!target.id) {
          contextId += 1;
          target.id = `effekseer_webgpu_demo_canvas_${contextId}`;
        }
        selector = `#${target.id}`;
      }

      this.externalRenderPassEnabled = false;
      this.nativeptr = Core.InitInternal(
        settings.instanceMaxCount || 4000,
        settings.squareMaxCount || 10000,
        selector,
        settings.linearColorSpace !== false ? 1 : 0,
        settings.compositeWithBackground ? 1 : 0
      );
      return !!this.nativeptr;
    }

    initExternal(settings = {}) {
      this.externalRenderPassEnabled = true;
      this.nativeptr = Core.InitExternal(
        settings.instanceMaxCount || 4000,
        settings.squareMaxCount || 10000,
        settings.linearColorSpace !== false ? 1 : 0,
        settings.compositeWithBackground ? 1 : 0
      );
      return !!this.nativeptr;
    }

    update(deltaFrames = 1.0) {
      const delta = Number(deltaFrames);
      if (!Number.isFinite(delta) || delta <= 0.0) {
        return;
      }

      this.fixedUpdateAccumulator += delta;
      let substeps = 0;
      while (this.fixedUpdateAccumulator >= this.fixedUpdateStepFrames && substeps < this.fixedUpdateMaxSubsteps) {
        Core.Update(this.nativeptr, this.fixedUpdateStepFrames);
        this.fixedUpdateAccumulator -= this.fixedUpdateStepFrames;
        substeps++;
      }
      if (substeps >= this.fixedUpdateMaxSubsteps && this.fixedUpdateAccumulator >= this.fixedUpdateStepFrames) {
        this.fixedUpdateAccumulator = 0.0;
      }
    }

    beginUpdate() { Core.BeginUpdate(this.nativeptr); }
    endUpdate() { Core.EndUpdate(this.nativeptr); }
    updateHandle(handle, deltaFrames = 1.0) { Core.UpdateHandle(this.nativeptr, handle.native, deltaFrames); }
    draw() {
      if (!this.externalRenderPassEnabled) {
        Core.Draw(this.nativeptr);
      }
    }

    drawExternal(renderPassEncoder, renderPassState = null, mode = "all") {
      if (!renderPassEncoder) {
        return;
      }

      const colorFormatRaw = toTextureFormatValue(renderPassState && renderPassState.colorFormat);
      const depthFormatRaw = (() => {
        const value = toTextureFormatValue(renderPassState && renderPassState.depthFormat);
        return value == null ? 0 : value;
      })();
      const sampleCountRaw = toSampleCountValue(renderPassState && renderPassState.sampleCount);
      const hasOwn = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);
      const hasDepthViewInState = hasOwn(renderPassState, "depthTextureView") || hasOwn(renderPassState, "importDepthTextureView");
      const hasBackgroundViewInState = hasOwn(renderPassState, "backgroundTextureView") || hasOwn(renderPassState, "importBackgroundTextureView");
      const depthTextureViewFromState = hasDepthViewInState
        ? (hasOwn(renderPassState, "depthTextureView") ? renderPassState.depthTextureView : renderPassState.importDepthTextureView)
        : null;
      const backgroundTextureViewFromState = hasBackgroundViewInState
        ? (hasOwn(renderPassState, "backgroundTextureView") ? renderPassState.backgroundTextureView : renderPassState.importBackgroundTextureView)
        : null;
      const prevDepthTextureView = hasDepthViewInState ? Module.__effekseerDepthTextureView : null;
      const prevBackgroundTextureView = hasBackgroundViewInState ? Module.__effekseerBackgroundTextureView : null;

      Module.__effekseerExternalRenderPass = renderPassEncoder;
      Module.__effekseerExternalPassColorFormat = colorFormatRaw;
      Module.__effekseerExternalPassDepthFormat = depthFormatRaw;
      Module.__effekseerExternalPassSampleCount = sampleCountRaw;
      if (hasDepthViewInState) {
        Module.__effekseerDepthTextureView = depthTextureViewFromState || null;
      }
      if (hasBackgroundViewInState) {
        Module.__effekseerBackgroundTextureView = backgroundTextureViewFromState || null;
      }

      try {
        if (mode === "back") {
          Core.DrawExternalBack(this.nativeptr);
        } else if (mode === "front") {
          Core.DrawExternalFront(this.nativeptr);
        } else {
          Core.DrawExternal(this.nativeptr);
        }
      } finally {
        if (hasDepthViewInState) {
          Module.__effekseerDepthTextureView = prevDepthTextureView || null;
        }
        if (hasBackgroundViewInState) {
          Module.__effekseerBackgroundTextureView = prevBackgroundTextureView || null;
        }
        Module.__effekseerExternalRenderPass = null;
        Module.__effekseerExternalPassColorFormat = null;
        Module.__effekseerExternalPassDepthFormat = null;
        Module.__effekseerExternalPassSampleCount = null;
      }
    }

    beginDraw() { Core.BeginDraw(this.nativeptr); }
    endDraw() { Core.EndDraw(this.nativeptr); }
    drawHandle(handle) { Core.DrawHandle(this.nativeptr, handle.native); }

    setProjectionMatrix(matrixArray) {
      withFloatArray(matrixArray, (ptr) => Core.SetProjectionMatrix(this.nativeptr, ptr));
    }

    setProjectionPerspective(fov, aspect, near, far) {
      Core.SetProjectionPerspective(this.nativeptr, fov, aspect, near, far);
    }

    setProjectionOrthographic(width, height, near, far) {
      Core.SetProjectionOrthographic(this.nativeptr, width, height, near, far);
    }

    setCameraMatrix(matrixArray) {
      withFloatArray(matrixArray, (ptr) => Core.SetCameraMatrix(this.nativeptr, ptr));
    }

    setCameraLookAt(positionX, positionY, positionZ, targetX, targetY, targetZ, upvecX, upvecY, upvecZ) {
      Core.SetCameraLookAt(this.nativeptr, positionX, positionY, positionZ, targetX, targetY, targetZ, upvecX, upvecY, upvecZ);
    }

    setCameraLookAtFromVector(position, target, upvec = { x: 0, y: 1, z: 0 }) {
      this.setCameraLookAt(position.x, position.y, position.z, target.x, target.y, target.z, upvec.x, upvec.y, upvec.z);
    }

    setCompositeMode(enabled) {
      Core.SetCompositeMode(this.nativeptr, enabled ? 1 : 0);
    }

    loadEffect(data, scale = 1.0, onload, onerror) {
      const effectScale = (typeof scale === "function") ? 1.0 : scale;
      const effectOnload = (typeof scale === "function") ? scale : onload;
      const effectOnerror = (typeof scale === "function") ? onload : onerror;
      const effect = new EffekseerEffect(this);
      effect.scale = effectScale;
      effect.onload = effectOnload;
      effect.onerror = effectOnerror;

      if (typeof data === "string") {
        if (!isEfkwgdPath(data)) {
          effect._dispatchError("loadEffect() only supports .efkwgd paths.", data);
          return effect;
        }
        loadBinary(
          data,
          (buffer) => effect._load(buffer, data),
          (message, path) => effect._dispatchError(message || "failed to fetch .efkwgd", path || data)
        );
        return effect;
      }

      try {
        const ab = ensureEfkwgdBuffer(data);
        effect._load(ab, "");
      } catch (error) {
        effect._dispatchError(error && error.message ? error.message : "invalid .efkwgd payload", "");
      }
      return effect;
    }

    loadEffectPackage() {
      throw new Error('loadEffectPackage() is not supported by the demo runtime. Use .efkwgd via loadEffect().');
    }

    releaseEffect(effect) {
      if (!effect || !effect.nativeptr || !this.nativeptr) {
        return;
      }
      Core.ReleaseEffect(this.nativeptr, effect.nativeptr);
      effect.nativeptr = 0;
      effect.isLoaded = false;
      this._effects.delete(effect);
    }

    play(effect, x = 0, y = 0, z = 0) {
      if (!effect || !effect.nativeptr) {
        return null;
      }
      const handle = Core.PlayEffect(this.nativeptr, effect.nativeptr, x, y, z);
      return handle >= 0 ? new EffekseerHandle(this, handle) : null;
    }

    stopAllEffects() { Core.StopAllEffects(this.nativeptr); }
    getRestInstancesCount() { return Core.GetRestInstancesCount(this.nativeptr); }
    getUpdateTime() { return Core.GetUpdateTime(this.nativeptr); }
    getDrawTime() { return Core.GetDrawTime(this.nativeptr); }
    getDrawCallCount() { return Core.GetDrawCallCount(this.nativeptr); }
    getDrawVertexCount() { return Core.GetDrawVertexCount(this.nativeptr); }
    getTotalParticleCount() { return Core.GetTotalParticleCount(this.nativeptr); }
    setRestorationOfStatesFlag(flag) { Core.SetRestorationOfStatesFlag(this.nativeptr, flag ? 1 : 0); }
  }

  class EffekseerDemo {
    async initRuntime(path, onload, onerror) {
      try {
        await initializeRuntimeInternal(path);
        if (onload) {
          onload();
        }
      } catch (error) {
        runtimeInitializing = false;
        runtimeInitialized = false;
        onRuntimeReadyQueue = [];
        if (onerror) {
          onerror(error);
        } else {
          console.error(error);
        }
      }
    }

    createContext() {
      if (!runtimeInitialized) {
        return null;
      }
      return new EffekseerContext();
    }

    releaseContext(context) {
      if (!context || !context.nativeptr) {
        return;
      }
      for (const effect of Array.from(context._effects || [])) {
        context.releaseEffect(effect);
      }
      Core.Terminate(context.nativeptr);
      context.nativeptr = 0;
      context._effects?.clear?.();
    }

    setLogEnabled(flag) {
      requestedLogEnabled = !!flag;
      syncCoreLogEnabled();
    }

    setImageCrossOrigin() {
    }

    setWebGPUDevice(device) {
      if (runtimeInitialized || runtimeInitializing) {
        throw new Error("setWebGPUDevice() must be called before initRuntime().");
      }
      if (device == null) {
        externalWebGPUDevice = null;
        preinitializedDevice = null;
        return;
      }
      if (
        typeof device !== "object" ||
        typeof device.createCommandEncoder !== "function" ||
        !device.queue
      ) {
        throw new Error("setWebGPUDevice() expects a valid GPUDevice.");
      }
      externalWebGPUDevice = device;
      preinitializedDevice = device;
    }

    getWebGPUDevice() {
      return preinitializedDevice || (Module ? Module.preinitializedWebGPUDevice : null) || null;
    }

    init(target, settings) {
      if (this.defaultContext?.nativeptr) {
        this.releaseContext(this.defaultContext);
      }
      this.defaultContext = new EffekseerContext();
      return this.defaultContext.init(target, settings);
    }

    update(deltaFrames) { this.defaultContext.update(deltaFrames); }
    beginUpdate() { this.defaultContext.beginUpdate(); }
    endUpdate() { this.defaultContext.endUpdate(); }
    updateHandle(handle, deltaFrames) { this.defaultContext.updateHandle(handle, deltaFrames); }
    draw() { this.defaultContext.draw(); }
    drawExternal(renderPassEncoder, renderPassState, mode = "all") { this.defaultContext.drawExternal(renderPassEncoder, renderPassState, mode); }
    beginDraw() { this.defaultContext.beginDraw(); }
    endDraw() { this.defaultContext.endDraw(); }
    drawHandle(handle) { this.defaultContext.drawHandle(handle); }
    setProjectionMatrix(matrixArray) { this.defaultContext.setProjectionMatrix(matrixArray); }
    setProjectionPerspective(fov, aspect, near, far) { this.defaultContext.setProjectionPerspective(fov, aspect, near, far); }
    setProjectionOrthographic(width, height, near, far) { this.defaultContext.setProjectionOrthographic(width, height, near, far); }
    setCameraMatrix(matrixArray) { this.defaultContext.setCameraMatrix(matrixArray); }
    setCameraLookAt(positionX, positionY, positionZ, targetX, targetY, targetZ, upvecX, upvecY, upvecZ) {
      this.defaultContext.setCameraLookAt(positionX, positionY, positionZ, targetX, targetY, targetZ, upvecX, upvecY, upvecZ);
    }
    setCameraLookAtFromVector(position, target, upvec) { this.defaultContext.setCameraLookAtFromVector(position, target, upvec); }
    setCompositeMode(enabled) { this.defaultContext.setCompositeMode(enabled); }
    loadEffect(pathOrBuffer, scale, onload, onerror) { return this.defaultContext.loadEffect(pathOrBuffer, scale, onload, onerror); }
    loadEffectPackage() { return this.defaultContext.loadEffectPackage(); }
    releaseEffect(effect) { this.defaultContext.releaseEffect(effect); }
    play(effect, x, y, z) { return this.defaultContext.play(effect, x, y, z); }
    stopAllEffects() { this.defaultContext.stopAllEffects(); }
    getRestInstancesCount() { return this.defaultContext.getRestInstancesCount(); }
    getUpdateTime() { return this.defaultContext.getUpdateTime(); }
    getDrawTime() { return this.defaultContext.getDrawTime(); }
    getDrawCallCount() { return this.defaultContext.getDrawCallCount(); }
    getDrawVertexCount() { return this.defaultContext.getDrawVertexCount(); }
    getTotalParticleCount() { return this.defaultContext.getTotalParticleCount(); }
    setRestorationOfStatesFlag(flag) { this.defaultContext.setRestorationOfStatesFlag(flag); }
  }

  return new EffekseerDemo();
})();

globalThis.effekseerDemo = effekseerDemo;
