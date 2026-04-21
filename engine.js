let _THREE, _WebGPURenderer, _gpuDevice, _gpuFormat;

const PKS_EFFECT_RESUME_SUPPRESSION_MS = 1000;

const PKS_FOREGROUND_BLOOM_CONFIG = {
    enabled: true,
    intensity: .5,
    threshold: .9,
    softKnee: .5,
};

const PKS_FOREGROUND_BLOOM_SHADERS = {
    extract: 'pks_bloom_extract.wgsl',
    downsample: 'pks_bloom_downsample.wgsl',
    blurH: 'pks_bloom_blur_h.wgsl',
    blurV: 'pks_bloom_blur_v.wgsl',
    blend: 'pks_bloom_blend_4.wgsl',
    present: 'pks_present_bloom_alpha.wgsl',
};

const loadTextAsset = async (path) => {
    try {
        const response = await fetch(path);
        if (!response.ok) return null;
        return await response.text();
    } catch {
        return null;
    }
};

const getHalfSize = (size) => Math.max(1, Math.floor((size + 1) / 2));

const resolveRendererWebGPUState = (renderer) => {
    const backend = renderer?.backend || renderer?._backend || null;
    const device = backend?.device || backend?.parameters?.device || null;
    const canvasContext = backend?.getContext?.() || backend?.context || null;

    if (!backend || !device || !canvasContext) {
        return null;
    }

    return {
        backend,
        device,
        canvasContext,
    };
};

const createForegroundBloomPipeline = async ({
    device,
    canvasContext,
    rendererBackend,
    width,
    height,
    config,
    shaderBaseUrl,
}) => {
    const shaderPaths = Object.values(PKS_FOREGROUND_BLOOM_SHADERS).map((fileName) => `${shaderBaseUrl}/${fileName}`);
    const [
        extractWGSL,
        downsampleWGSL,
        blurHWGSL,
        blurVWGSL,
        blendWGSL,
        presentWGSL,
    ] = await Promise.all(shaderPaths.map((path) => loadTextAsset(path)));

    if (!extractWGSL || !downsampleWGSL || !blurHWGSL || !blurVWGSL || !blendWGSL || !presentWGSL) {
        return null;
    }

    const hdrFormat = 'rgba16float';
    const presentationFormat = canvasContext?.getConfiguration?.().format
        || globalThis.navigator?.gpu?.getPreferredCanvasFormat?.()
        || 'bgra8unorm';

    const linearSampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
    });

    const extractUniformBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const downsampleSizeBuffers = Array.from({ length: 4 }, () => device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));

    const blurSizeBuffers = Array.from({ length: 4 }, () => device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));

    const createFullscreenPipeline = (shaderCode, targetFormat, vertexEntry = 'vs_main', fragmentEntry = 'fs_main') => {
        const module = device.createShaderModule({ code: shaderCode });
        return device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module,
                entryPoint: vertexEntry,
            },
            fragment: {
                module,
                entryPoint: fragmentEntry,
                targets: [{ format: targetFormat }],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });
    };

    const extractPipeline = createFullscreenPipeline(extractWGSL, hdrFormat);
    const downsamplePipeline = createFullscreenPipeline(downsampleWGSL, hdrFormat);
    const blurHPipeline = createFullscreenPipeline(blurHWGSL, hdrFormat);
    const blurVPipeline = createFullscreenPipeline(blurVWGSL, hdrFormat);
    const blendPipeline = createFullscreenPipeline(blendWGSL, hdrFormat);
    const presentPipeline = createFullscreenPipeline(presentWGSL, presentationFormat, 'vs_fullscreen', 'fs_present');

    let currentWidth = width;
    let currentHeight = height;
    let extractTexture = null;
    let extractView = null;
    let bloomCombinedTexture = null;
    let bloomCombinedView = null;
    let lowresTextures = [[], []];
    let lowresViews = [[], []];
    let levelSizes = [];
    let downsampleBindGroups = [];
    let blurHBindGroups = [];
    let blurVBindGroups = [];
    let blendBindGroup = null;
    let sceneTextureCache = null;
    let extractBindGroup = null;
    let presentBindGroup = null;

    const createHdrTexture = (textureWidth, textureHeight) => device.createTexture({
        size: [textureWidth, textureHeight],
        format: hdrFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const destroyTexture = (texture) => {
        try {
            texture?.destroy?.();
        } catch { }
    };

    const invalidateSceneBindings = () => {
        sceneTextureCache = null;
        extractBindGroup = null;
        presentBindGroup = null;
    };

    const writeExtractParams = () => {
        const threshold = Number(config.threshold ?? 1.0);
        const softKnee = Number(config.softKnee ?? 0.5);
        const intensity = Number(config.intensity ?? 1.0);
        const knee = threshold * softKnee;
        const params = new Float32Array([
            threshold,
            threshold - knee,
            knee * 2.0,
            0.25 / (knee + 0.00001),
            intensity,
            0,
            0,
            0,
        ]);
        device.queue.writeBuffer(extractUniformBuffer, 0, params);
    };

    const writeSizeUniforms = () => {
        for (let level = 0; level < 4; level += 1) {
            const downsampleSource = level === 0
                ? { width: currentWidth, height: currentHeight }
                : levelSizes[level - 1];

            device.queue.writeBuffer(
                downsampleSizeBuffers[level],
                0,
                new Float32Array([downsampleSource.width, downsampleSource.height, 0, 0])
            );

            device.queue.writeBuffer(
                blurSizeBuffers[level],
                0,
                new Float32Array([levelSizes[level].width, levelSizes[level].height, 0, 0])
            );
        }
    };

    const rebuildStaticBindGroups = () => {
        downsampleBindGroups = [];
        blurHBindGroups = [];
        blurVBindGroups = [];

        for (let level = 0; level < 4; level += 1) {
            const downsampleSourceView = level === 0 ? extractView : lowresViews[0][level - 1];

            downsampleBindGroups.push(device.createBindGroup({
                layout: downsamplePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: downsampleSourceView },
                    { binding: 1, resource: linearSampler },
                    { binding: 2, resource: { buffer: downsampleSizeBuffers[level] } },
                ],
            }));

            blurHBindGroups.push(device.createBindGroup({
                layout: blurHPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: lowresViews[0][level] },
                    { binding: 1, resource: linearSampler },
                    { binding: 2, resource: { buffer: blurSizeBuffers[level] } },
                ],
            }));

            blurVBindGroups.push(device.createBindGroup({
                layout: blurVPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: lowresViews[1][level] },
                    { binding: 1, resource: linearSampler },
                    { binding: 2, resource: { buffer: blurSizeBuffers[level] } },
                ],
            }));
        }

        blendBindGroup = device.createBindGroup({
            layout: blendPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: lowresViews[0][0] },
                { binding: 1, resource: lowresViews[0][1] },
                { binding: 2, resource: lowresViews[0][2] },
                { binding: 3, resource: lowresViews[0][3] },
                { binding: 4, resource: linearSampler },
            ],
        });
    };

    const recreateTargets = (nextWidth, nextHeight) => {
        invalidateSceneBindings();

        destroyTexture(extractTexture);
        destroyTexture(bloomCombinedTexture);
        for (const bank of lowresTextures) {
            for (const texture of bank) {
                destroyTexture(texture);
            }
        }

        currentWidth = nextWidth;
        currentHeight = nextHeight;
        levelSizes = [];

        let sourceWidth = currentWidth;
        let sourceHeight = currentHeight;
        for (let level = 0; level < 4; level += 1) {
            sourceWidth = getHalfSize(sourceWidth);
            sourceHeight = getHalfSize(sourceHeight);
            levelSizes.push({ width: sourceWidth, height: sourceHeight });
        }

        extractTexture = createHdrTexture(currentWidth, currentHeight);
        extractView = extractTexture.createView();
        bloomCombinedTexture = createHdrTexture(currentWidth, currentHeight);
        bloomCombinedView = bloomCombinedTexture.createView();
        lowresTextures = [new Array(4), new Array(4)];
        lowresViews = [new Array(4), new Array(4)];

        for (let level = 0; level < 4; level += 1) {
            const size = levelSizes[level];
            lowresTextures[0][level] = createHdrTexture(size.width, size.height);
            lowresTextures[1][level] = createHdrTexture(size.width, size.height);
            lowresViews[0][level] = lowresTextures[0][level].createView();
            lowresViews[1][level] = lowresTextures[1][level].createView();
        }

        writeSizeUniforms();
        rebuildStaticBindGroups();
    };

    const ensureSceneBindGroups = (sceneTexture) => {
        if (sceneTextureCache === sceneTexture && extractBindGroup && presentBindGroup) {
            return;
        }

        sceneTextureCache = sceneTexture;
        const sceneView = sceneTexture.createView();

        extractBindGroup = device.createBindGroup({
            layout: extractPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: sceneView },
                { binding: 1, resource: linearSampler },
                { binding: 2, resource: { buffer: extractUniformBuffer } },
            ],
        });

        presentBindGroup = device.createBindGroup({
            layout: presentPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: sceneView },
                { binding: 1, resource: bloomCombinedView },
                { binding: 2, resource: linearSampler },
            ],
        });
    };

    const runFullscreenPass = (encoder, view, pipeline, bindGroup) => {
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
            }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
    };

    const clearTextureView = (encoder, view) => {
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
            }],
        });
        pass.end();
    };

    recreateTargets(width, height);
    writeExtractParams();

    return {
        render(sceneRenderTarget) {
            const sceneState = rendererBackend?.get?.(sceneRenderTarget?.texture) || null;
            const sceneTexture = sceneState?.texture || null;
            if (!sceneTexture) {
                return false;
            }

            writeExtractParams();
            ensureSceneBindGroups(sceneTexture);

            const encoder = device.createCommandEncoder();

            if (config.enabled) {
                runFullscreenPass(encoder, extractView, extractPipeline, extractBindGroup);

                for (let level = 0; level < 4; level += 1) {
                    runFullscreenPass(encoder, lowresViews[0][level], downsamplePipeline, downsampleBindGroups[level]);
                }
                for (let level = 0; level < 4; level += 1) {
                    runFullscreenPass(encoder, lowresViews[1][level], blurHPipeline, blurHBindGroups[level]);
                }
                for (let level = 0; level < 4; level += 1) {
                    runFullscreenPass(encoder, lowresViews[0][level], blurVPipeline, blurVBindGroups[level]);
                }

                runFullscreenPass(encoder, bloomCombinedView, blendPipeline, blendBindGroup);
            } else {
                clearTextureView(encoder, bloomCombinedView);
            }

            const presentPass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: canvasContext.getCurrentTexture().createView(),
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                }],
            });
            presentPass.setPipeline(presentPipeline);
            presentPass.setBindGroup(0, presentBindGroup);
            presentPass.draw(3);
            presentPass.end();

            device.queue.submit([encoder.finish()]);
            return true;
        },
        resize(nextWidth, nextHeight) {
            recreateTargets(nextWidth, nextHeight);
            writeExtractParams();
        },
        dispose() {
            invalidateSceneBindings();
            destroyTexture(extractTexture);
            destroyTexture(bloomCombinedTexture);
            for (const bank of lowresTextures) {
                for (const texture of bank) {
                    destroyTexture(texture);
                }
            }
            extractUniformBuffer.destroy();
            for (const buffer of downsampleSizeBuffers) {
                buffer.destroy();
            }
            for (const buffer of blurSizeBuffers) {
                buffer.destroy();
            }
        },
    };
};

const engineReadyPromise = (async () => {
    try {
        const baseUrl = document.documentElement.getAttribute('data-pks-ext-url') || "";

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("No se encontro adaptador de GPU");
        _gpuDevice = await adapter.requestDevice();
        _gpuFormat = navigator.gpu.getPreferredCanvasFormat();

        if (!document.querySelector('script[type="importmap"]')) {
            const im = {
                imports: {
                    "three": `${baseUrl}libs/three/three.webgpu.js`,
                    "three/webgpu": `${baseUrl}libs/three/three.webgpu.js`,
                    "three/tsl": `${baseUrl}libs/three/three.tsl.js`
                }
            };
            const s = document.createElement('script');
            s.type = 'importmap';
            s.textContent = JSON.stringify(im);
            document.head.appendChild(s);
        }

        const THREE_MOD = await import("three");
        const TSL_MOD = await import("three/tsl");

        _THREE = { ...THREE_MOD, ...TSL_MOD };
        _WebGPURenderer = _THREE.WebGPURenderer;

        await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = `${baseUrl}libs/runtime/Demo_Runtime.js`;
            script.onload = resolve;
            document.head.appendChild(script);
        });

        await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = `${baseUrl}libs/runtime/demo.src.js`;
            script.onload = resolve;
            document.head.appendChild(script);
        });

        return true;
    } catch {
        return false;
    }
})();

window.init3DScene = async function (container, room) {
    const battleScene = room?.battle?.scene;
    const battleContainer = battleScene?.$battle?.[0] || container;
    if (!room || !battleScene || !battleContainer) return;

    if (typeof window._pks3dActiveCleanup === 'function' && window._pks3dActiveScene !== battleScene) {
        window._pks3dActiveCleanup();
    }

    if (room._pks3dScene === battleScene && battleScene.threeInitialized) return;

    if (typeof room._pks3dCleanup === 'function' && room._pks3dScene && room._pks3dScene !== battleScene) {
        room._pks3dCleanup();
    }

    const ready = await engineReadyPromise;
    const baseUrl = document.documentElement.getAttribute('data-pks-ext-url') || "";
    if (!ready || !window.effekseerDemo) return;
    if (room?.battle?.scene !== battleScene) return;

    let disposed = false;
    let cleanup = null;
    let efk = null;
    let backgroundEfkContext = null;
    let foregroundEfkContext = null;
    let backgroundEffectCache = null;
    let foregroundEffectCache = null;
    let effekseerDisabled = false;
    let effekseerTask = Promise.resolve();
    let foregroundBloomPipeline = null;
    let foregroundRenderTarget = null;
    let foregroundRendererState = null;
    let bloomDisabled = false;
    let effectRequestEpoch = 0;
    let visibilityRecoveryUntil = 0;
    const lifecycle = {
        observer: null,
        resizeObserver: null,
        backgroundCanvas: null,
        foregroundCanvas: null,
        backgroundRenderer: null,
        foregroundRenderer: null,
        foregroundBloomPipeline: null,
        foregroundRenderTarget: null,
        timer: null,
        onResize: null,
        onVisibilityChange: null,
        originalReset: null,
        patchedReset: null,
        effekseerApi: null,
    };

    const isEffectsSuspended = () => document.hidden || performance.now() < visibilityRecoveryUntil;

    const stopAllEffects = () => {
        try {
            backgroundEfkContext?.stopAll?.();
        } catch { }
        try {
            foregroundEfkContext?.stopAll?.();
        } catch { }
    };

    const invalidateEffekseerQueue = () => {
        effectRequestEpoch += 1;
        effekseerTask = Promise.resolve();
        stopAllEffects();
    };

    const disableEffekseer = (scope, error) => {
        if (effekseerDisabled || disposed) return;
        effekseerDisabled = true;
        stopAllEffects();
    };

    const drainEffectCache = (ctx, cache) => {
        if (!ctx || !cache) return;

        const entries = Array.from(cache.values());
        cache.clear();

        for (const entry of entries) {
            if (entry?.effect) {
                try {
                    ctx.releaseEffect?.(entry.effect);
                } catch { }
            }

            if (entry?.promise && typeof entry.promise.then === 'function') {
                void entry.promise.then((loadedEffect) => {
                    try {
                        ctx.releaseEffect?.(loadedEffect);
                    } catch { }
                }).catch(() => { });
            }
        }
    };

    const clearSceneState = () => {
        if (room._pks3dScene === battleScene || room._pks3dCleanup === cleanup) {
            room._pks3dInitialized = false;
        }
        if (room._pks3dScene === battleScene) {
            room._pks3dScene = null;
        }
        if (room._pks3dCleanup === cleanup) {
            room._pks3dCleanup = null;
        }
        if (window._pks3dActiveCleanup === cleanup) {
            window._pks3dActiveCleanup = null;
        }
        if (window._pks3dActiveScene === battleScene) {
            window._pks3dActiveScene = null;
        }
        battleScene.threeInitialized = false;
    };

    cleanup = () => {
        if (disposed) return;
        disposed = true;

        lifecycle.observer?.disconnect?.();
        lifecycle.resizeObserver?.disconnect?.();

        if (lifecycle.onResize) {
            window.removeEventListener('resize', lifecycle.onResize);
            window.visualViewport?.removeEventListener('resize', lifecycle.onResize);
        }
        if (lifecycle.onVisibilityChange) {
            document.removeEventListener('visibilitychange', lifecycle.onVisibilityChange);
        }
        if (lifecycle.patchedReset && lifecycle.originalReset && battleScene.reset === lifecycle.patchedReset) {
            battleScene.reset = lifecycle.originalReset;
        }

        lifecycle.backgroundCanvas?.remove?.();
        lifecycle.foregroundCanvas?.remove?.();

        try {
            lifecycle.backgroundRenderer?.setExternalRenderPassHook?.(null);
        } catch { }
        try {
            lifecycle.foregroundRenderer?.setExternalRenderPassHook?.(null);
        } catch { }

        stopAllEffects();

        drainEffectCache(backgroundEfkContext, backgroundEffectCache);
        drainEffectCache(foregroundEfkContext, foregroundEffectCache);

        try {
            lifecycle.foregroundBloomPipeline?.dispose?.();
        } catch { }
        try {
            lifecycle.foregroundRenderTarget?.dispose?.();
        } catch { }

        try {
            if (efk && backgroundEfkContext) {
                efk.releaseContext(backgroundEfkContext);
            }
        } catch { }
        try {
            if (efk && foregroundEfkContext) {
                efk.releaseContext(foregroundEfkContext);
            }
        } catch { }

        backgroundEfkContext = null;
        foregroundEfkContext = null;
        backgroundEffectCache = null;
        foregroundEffectCache = null;
        foregroundBloomPipeline = null;
        foregroundRenderTarget = null;
        foregroundRendererState = null;
        lifecycle.timer?.dispose?.();
        lifecycle.timer = null;

        lifecycle.backgroundRenderer?.dispose?.();
        lifecycle.foregroundRenderer?.dispose?.();

        if (window.pksEffekseer === lifecycle.effekseerApi) {
            delete window.pksEffekseer;
        }

        clearSceneState();
    };

    room._pks3dInitialized = true;
    room._pks3dScene = battleScene;
    room._pks3dCleanup = cleanup;
    window._pks3dActiveCleanup = cleanup;
    window._pks3dActiveScene = battleScene;
    battleScene.threeInitialized = true;

    try {
        const getBattleSize = () => {
            const battleRoot = battleScene?.$battle?.[0] || battleContainer;
            const rect = battleRoot?.getBoundingClientRect?.();
            const width = Math.round(rect?.width || battleRoot?.clientWidth || battleContainer.clientWidth || 640);
            const height = Math.round(rect?.height || battleRoot?.clientHeight || battleContainer.clientHeight || 360);
            return {
                width: Math.max(width, 1),
                height: Math.max(height, 1),
            };
        };

        const isBattleActive = () => {
            const battleRoot = battleScene?.$battle?.[0] || battleContainer;
            return !!battleRoot && battleRoot.isConnected && battleRoot.getClientRects().length > 0;
        };

        let { width, height } = getBattleSize();
        let pixelRatio = Math.max(window.devicePixelRatio || 1, 1);

        const createCanvas = (className) => {
            const targetCanvas = document.createElement('canvas');
            targetCanvas.className = className;
            targetCanvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none;';
            return targetCanvas;
        };

        const backgroundCanvas = createCanvas('canvas-sprites-canvas');
        const foregroundCanvas = createCanvas('pks-3d-canvas');
        lifecycle.backgroundCanvas = backgroundCanvas;
        lifecycle.foregroundCanvas = foregroundCanvas;

        const getRenderSize = () => ({
            width: Math.max(1, Math.round(width * pixelRatio)),
            height: Math.max(1, Math.round(height * pixelRatio)),
        });

        const createRenderer = async (targetCanvas) => {
            const targetRenderer = new _WebGPURenderer({
                canvas: targetCanvas,
                alpha: true,
                antialias: true,
                premultipliedAlpha: true,
                device: _gpuDevice
            });
            await targetRenderer.init();
            targetRenderer.setClearColor(0x000000, 0);
            targetRenderer.outputColorSpace = _THREE.SRGBColorSpace;
            if (targetRenderer.setPixelRatio) targetRenderer.setPixelRatio(pixelRatio);
            targetRenderer.setSize(width, height, false);
            return targetRenderer;
        };

        const backgroundRenderer = await createRenderer(backgroundCanvas);
        const foregroundRenderer = await createRenderer(foregroundCanvas);
        lifecycle.backgroundRenderer = backgroundRenderer;
        lifecycle.foregroundRenderer = foregroundRenderer;

        const createForegroundRenderTarget = () => {
            const renderSize = getRenderSize();
            const target = new _THREE.RenderTarget(renderSize.width, renderSize.height, {
                type: _THREE.HalfFloatType,
                format: _THREE.RGBAFormat,
                depthBuffer: true,
                stencilBuffer: false,
            });
            target.texture.colorSpace = _THREE.LinearSRGBColorSpace;
            return target;
        };

        const createCamera = () => {
            const targetCamera = new _THREE.PerspectiveCamera(25, width / height, 0.1, 1000);
            targetCamera.position.set(-9.4, 7.7, 8.1);
            targetCamera.lookAt(-0.1, 0.1, -0.5);
            return targetCamera;
        };

        const backgroundCamera = createCamera();
        const foregroundCamera = createCamera();

        const backgroundScene = new _THREE.Scene();
        const foregroundScene = new _THREE.Scene();
        backgroundScene.add(new _THREE.AmbientLight(0xffffff, 2.0));
        foregroundScene.add(new _THREE.AmbientLight(0xffffff, 2.0));

        foregroundRendererState = resolveRendererWebGPUState(foregroundRenderer);
        foregroundRenderTarget = createForegroundRenderTarget();
        lifecycle.foregroundRenderTarget = foregroundRenderTarget;

        if (foregroundRendererState) {
            const renderSize = getRenderSize();
            foregroundBloomPipeline = await createForegroundBloomPipeline({
                device: foregroundRendererState.device,
                canvasContext: foregroundRendererState.canvasContext,
                rendererBackend: foregroundRendererState.backend,
                width: renderSize.width,
                height: renderSize.height,
                config: { ...PKS_FOREGROUND_BLOOM_CONFIG },
                shaderBaseUrl: `${baseUrl}libs/wgsl`,
            });
        }

        if (!foregroundBloomPipeline) {
            bloomDisabled = true;
        } else {
            lifecycle.foregroundBloomPipeline = foregroundBloomPipeline;
        }

        const disableBloom = (scope, error) => {
            if (bloomDisabled) return;
            bloomDisabled = true;

            try {
                foregroundBloomPipeline?.dispose?.();
            } catch { }

            foregroundBloomPipeline = null;
            lifecycle.foregroundBloomPipeline = null;
        };

        const installEffekseerHook = (targetRenderer, efkCtx, camera) => {
            targetRenderer.setExternalRenderPassHook((info) => {
                if (!efkCtx || effekseerDisabled || disposed) return;

                try {
                    efkCtx.setProjectionMatrix(camera.projectionMatrix.elements);
                    efkCtx.setCameraMatrix(camera.matrixWorldInverse.elements);
                    efkCtx.drawExternal(info.renderPassEncoder, {
                        colorFormat: info.colorFormat,
                        depthFormat: info.depthStencilFormat,
                        sampleCount: info.sampleCount
                    });
                } catch (err) {
                    disableEffekseer('drawExternal', err);
                }
            });
        };

        const syncCanvasSize = () => {
            if (disposed) return;
            if (room?.battle?.scene !== battleScene || !isBattleActive()) {
                cleanup();
                return;
            }

            const nextSize = getBattleSize();
            const nextPixelRatio = Math.max(window.devicePixelRatio || 1, 1);
            if (nextSize.width === width && nextSize.height === height && nextPixelRatio === pixelRatio) return;

            width = nextSize.width;
            height = nextSize.height;
            pixelRatio = nextPixelRatio;

            for (const renderer of [backgroundRenderer, foregroundRenderer]) {
                if (renderer.setPixelRatio) renderer.setPixelRatio(pixelRatio);
                renderer.setSize(width, height, false);
            }
            for (const camera of [backgroundCamera, foregroundCamera]) {
                camera.aspect = width / height;
                camera.updateProjectionMatrix();
            }

            const renderSize = getRenderSize();
            foregroundRenderTarget?.setSize?.(renderSize.width, renderSize.height);
            foregroundBloomPipeline?.resize?.(renderSize.width, renderSize.height);
        };

        const ensureBattleLayers = () => {
            const battleRoot = battleScene?.$battle?.[0];
            const spriteRoot = battleScene?.$sprite?.[0];
            if (!battleRoot || !spriteRoot) return;

            battleScene?.$bgEffect?.[0]?.classList.add('pks-bg-effect-layer');
            battleScene?.$stat?.[0]?.classList.add('pks-stat-layer');
            battleScene?.$fx?.[0]?.classList.add('pks-fx-layer');
            battleScene?.$turn?.[0]?.classList.add('pks-turn-layer');
            battleScene?.$delay?.[0]?.classList.add('pks-delay-layer');
            battleScene?.$hiddenMessage?.[0]?.classList.add('pks-hidden-message-layer');

            spriteRoot.classList.add('pks-sprite-root');
            spriteRoot.style.position = 'absolute';
            spriteRoot.style.inset = '0';
            spriteRoot.style.pointerEvents = 'none';

            const spriteChildren = spriteRoot.children;
            if (spriteChildren[0]) spriteChildren[0].classList.add('pks-sprites-back', 'pks-sprites-foe');
            if (spriteChildren[1]) spriteChildren[1].classList.add('pks-sprites-front', 'pks-effects-foe');
            if (spriteChildren[2]) spriteChildren[2].classList.add('pks-sprites-front', 'pks-effects-player');
            if (spriteChildren[3]) spriteChildren[3].classList.add('pks-sprites-back', 'pks-sprites-player');

            if (spriteRoot.parentElement !== battleRoot) {
                const statLayer = battleScene?.$stat?.[0] || null;
                battleRoot.insertBefore(spriteRoot, statLayer);
            }
        };

        const insertCanvases = () => {
            if (disposed) return;
            if (room?.battle?.scene !== battleScene || !isBattleActive()) {
                cleanup();
                return;
            }

            const battleRoot = battleScene?.$battle?.[0];
            const spriteRoot = battleScene?.$sprite?.[0] || null;
            ensureBattleLayers();
            if (!battleRoot) return;

            syncCanvasSize();

            if (backgroundCanvas.parentElement !== battleRoot) {
                battleRoot.insertBefore(backgroundCanvas, spriteRoot);
            }
            if (foregroundCanvas.parentElement !== battleRoot) {
                battleRoot.appendChild(foregroundCanvas);
            }
        };

        if (battleScene) {
            const originalReset = battleScene.reset;
            const patchedReset = function (...args) {
                const result = originalReset.apply(this, args);
                setTimeout(insertCanvases, 0);
                setTimeout(insertCanvases, 500);
                return result;
            };
            lifecycle.originalReset = originalReset;
            lifecycle.patchedReset = patchedReset;
            battleScene.reset = patchedReset;
        }

        insertCanvases();
        const observer = new MutationObserver(insertCanvases);
        observer.observe(document.body, { childList: true, subtree: true });
        lifecycle.observer = observer;
        window.addEventListener('resize', syncCanvasSize);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', syncCanvasSize);
        }
        lifecycle.onResize = syncCanvasSize;
        const battleResizeObserver = new ResizeObserver(() => {
            syncCanvasSize();
        });
        battleResizeObserver.observe(battleContainer);
        lifecycle.resizeObserver = battleResizeObserver;

        efk = window.effekseerDemo;
        if (!efk.isInitialized) {
            efk.setWebGPUDevice(_gpuDevice);
            await efk.initRuntime(`${baseUrl}libs/runtime/Demo_Runtime.wasm`);
            efk.isInitialized = true;
        }

        const createEfkContext = () => {
            const ctx = efk.createContext();
            ctx.initExternal({ instanceMaxCount: 4000, squareMaxCount: 10000, linearColorSpace: true });
            return ctx;
        };

        backgroundEfkContext = createEfkContext();
        foregroundEfkContext = createEfkContext();
        backgroundEffectCache = new Map();
        foregroundEffectCache = new Map();

        const ensureEfkEffectLoaded = (ctx, cache, effectUrl) => {
            if (effekseerDisabled || !ctx || !cache) {
                return Promise.resolve(null);
            }

            const existingEntry = cache.get(effectUrl);
            if (existingEntry) {
                return existingEntry.promise;
            }

            const formatError = (message, path = effectUrl) => {
                if (message instanceof Error) return message;
                const detail = [message, path && path !== effectUrl ? `(${path})` : ''].filter(Boolean).join(' ');
                return new Error(detail || `Fallo cargando ${effectUrl}`);
            };
            const loadEffectWithCallbacks = (onload, onerror) =>
                ctx.loadEffect(effectUrl, 1.0, onload, onerror);

            let effect = null;
            const entry = {};
            entry.promise = new Promise((resolve, reject) => {
                const handleFailure = (message, path) => {
                    const error = formatError(message, path);
                    cache.delete(effectUrl);
                    disableEffekseer(`load ${effectUrl}`, error);
                    reject(error);
                };

                try {
                    effect = loadEffectWithCallbacks(
                        () => {
                            if (effekseerDisabled) {
                                cache.delete(effectUrl);
                                resolve(null);
                                return;
                            }

                            entry.effect = effect;
                            resolve(effect);
                        },
                        (message, path) => {
                            handleFailure(message, path);
                        }
                    );
                } catch (err) {
                    handleFailure(err, effectUrl);
                }
            });
            entry.effect = effect;
            cache.set(effectUrl, entry);
            return entry.promise;
        };

        void ensureEfkEffectLoaded(
            foregroundEfkContext,
            foregroundEffectCache,
            `${baseUrl}libs/effects/flowertrick/flowertrick.efkwgd`
        );

        const playEfkEffect = async (ctx, cache, effectUrl, position, rotation, requestEpoch) => {
            if (disposed || effekseerDisabled || room?.battle?.scene !== battleScene || !isBattleActive() || isEffectsSuspended()) return null;
            if (requestEpoch !== effectRequestEpoch) return null;

            try {
                const effect = await ensureEfkEffectLoaded(ctx, cache, effectUrl);
                if (!effect || effekseerDisabled || isEffectsSuspended()) return null;
                if (requestEpoch !== effectRequestEpoch) return null;

                syncCanvasSize();

                const [x, y, z] = position;
                const [rx, ry, rz] = rotation.map(r => r * (Math.PI / 180));
                const handle = ctx.play(effect, x, y, z);
                if (handle) {
                    handle.setRotation(rx, ry, rz);
                }
                return handle;
            } catch (err) {
                disableEffekseer(`play ${effectUrl}`, err);
                return null;
            }
        };

        const playEfkPair = async ({ background, foreground, position = [0, 0, 0], rotation = [0, 0, 0] }) => {
            if (disposed || effekseerDisabled || room?.battle?.scene !== battleScene || !isBattleActive()) return;
            if (isEffectsSuspended()) return;

            const requestEpoch = effectRequestEpoch;

            const runPair = async () => {
                if (disposed || effekseerDisabled || room?.battle?.scene !== battleScene || !isBattleActive()) return;
                if (isEffectsSuspended()) return;
                if (requestEpoch !== effectRequestEpoch) return;

                syncCanvasSize();

                if (background) {
                    await playEfkEffect(backgroundEfkContext, backgroundEffectCache, background, position, rotation, requestEpoch);
                }
                if (foreground) {
                    await playEfkEffect(foregroundEfkContext, foregroundEffectCache, foreground, position, rotation, requestEpoch);
                }
            };

            const task = effekseerTask.then(runPair, runPair);
            effekseerTask = task.catch(() => { });
            await task;
        };

        window.pksEffekseer = {
            playPair: playEfkPair,
            stopAll() {
                invalidateEffekseerQueue();
            },
            isSuspended() {
                return isEffectsSuspended();
            },
        };
        lifecycle.effekseerApi = window.pksEffekseer;

        installEffekseerHook(backgroundRenderer, backgroundEfkContext, backgroundCamera);
        installEffekseerHook(foregroundRenderer, foregroundEfkContext, foregroundCamera);

        const handleVisibilityChange = () => {
            if (disposed) return;
            visibilityRecoveryUntil = document.hidden ? 0 : performance.now() + PKS_EFFECT_RESUME_SUPPRESSION_MS;
            invalidateEffekseerQueue();
        };
        lifecycle.onVisibilityChange = handleVisibilityChange;
        document.addEventListener('visibilitychange', handleVisibilityChange);
        if (document.hidden) {
            handleVisibilityChange();
        }

        const timer = new _THREE.Timer();
        timer.connect(document);
        lifecycle.timer = timer;
        const animate = function (timestamp) {
            if (disposed) return;
            if (room?.battle?.scene !== battleScene || !isBattleActive()) {
                cleanup();
                return;
            }

            requestAnimationFrame(animate);
            timer.update(timestamp);
            const delta = timer.getDelta();
            syncCanvasSize();

            if (!effekseerDisabled) {
                try {
                    backgroundEfkContext?.update?.(delta * 60);
                    foregroundEfkContext?.update?.(delta * 60);
                } catch (err) {
                    disableEffekseer('update', err);
                }
            }

            backgroundRenderer.render(backgroundScene, backgroundCamera);

            let didRenderForeground = false;

            if (!bloomDisabled && foregroundBloomPipeline && foregroundRenderTarget) {
                try {
                    foregroundRenderer.setRenderTarget(foregroundRenderTarget);
                    foregroundRenderer.render(foregroundScene, foregroundCamera);
                    foregroundRenderer.setRenderTarget(null);
                    didRenderForeground = foregroundBloomPipeline.render(foregroundRenderTarget);
                } catch (err) {
                    try {
                        foregroundRenderer.setRenderTarget(null);
                    } catch { }
                    disableBloom('foreground bloom render', err);
                }
            }

            if (!didRenderForeground) {
                foregroundRenderer.setRenderTarget(null);
                foregroundRenderer.render(foregroundScene, foregroundCamera);
            }
        };
        animate();
    } catch {
        cleanup();
    }
};
