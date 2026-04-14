class ShowdownUIManager {
    constructor() {
        this.styleElement = null;
        this.init();
    }

    init() {
        if (this.styleElement) return;

        this.styleElement = document.createElement('style');
        this.styleElement.textContent = `
            /* Base context */
            .innerbattle {
                position: relative !important;
                isolation: isolate !important;
            }

            /* Backdrop */
            .innerbattle > .backdrop {
                z-index: 1 !important;
            }

            /* Terrain */
            .innerbattle > .weather:nth-of-type(2) {
                z-index: 2 !important;
            }

            /* Weather */
            .innerbattle > .weather:nth-of-type(3) {
                z-index: 3 !important;
            }

            /* Background effects */
            .innerbattle > .pks-bg-effect-layer {
                position: absolute !important;
                inset: 0 !important;
                z-index: 4 !important;
            }

            /* Background 3D canvas, behind sprites */
            .canvas-sprites-canvas {
                position: absolute !important;
                inset: 0 !important;
                z-index: 24 !important;
                pointer-events: none !important;
            }

            /* 2D sprites */
            .innerbattle > .pks-sprite-root {
                position: absolute !important;
                inset: 0 !important;
                z-index: 25 !important;
                pointer-events: none !important;
            }

            .innerbattle > .pks-sprite-root > .pks-sprites-back {
                position: absolute !important;
                inset: 0 !important;
                z-index: 25 !important;
            }

            .innerbattle > .pks-sprite-root > .pks-sprites-front {
                position: absolute !important;
                inset: 0 !important;
                z-index: 26 !important;
            }

            /* 3D canvas directly above sprites */
            .pks-3d-canvas {
                position: absolute !important;
                inset: 0 !important;
                z-index: 27 !important;
                pointer-events: none !important;
            }

            /* Tooltip layer (sprite hover) */
            .innerbattle > .tooltips {
                position: absolute !important;
                inset: 0 !important;
                z-index: 28 !important;
                pointer-events: none !important;
            }
            .innerbattle > .tooltips > div {
                pointer-events: auto !important;
            }

            /* Main battle UI */
            .innerbattle > .pks-stat-layer {
                position: absolute !important;
                inset: 0 !important;
                z-index: 30 !important;
                pointer-events: none !important;
            }

            .innerbattle .statbar,
            .innerbattle .result,
            .innerbattle [class^="sidecondition-"],
            .innerbattle [class^="turnstatus-"] {
                z-index: 31 !important;
                pointer-events: auto !important;
            }

            /* Showdown FX */
            .innerbattle > .pks-fx-layer {
                position: absolute !important;
                inset: 0 !important;
                z-index: 40 !important;
                pointer-events: none !important;
            }

            /* Side panels */
            .innerbattle > .leftbar,
            .innerbattle > .rightbar {
                z-index: 45 !important;
            }

            /* Turn indicator */
            .innerbattle > .pks-turn-layer {
                position: absolute !important;
                inset: 0 !important;
                z-index: 50 !important;
                pointer-events: none !important;
            }
            .innerbattle > .pks-turn-layer > .turn {
                pointer-events: auto !important;
            }

            /* Message bar */
            .innerbattle > .messagebar {
                z-index: 60 !important;
            }

            /* Auxiliary message layers */
            .innerbattle > .pks-delay-layer,
            .innerbattle > .pks-hidden-message-layer {
                position: absolute !important;
                inset: 0 !important;
                z-index: 61 !important;
                pointer-events: none !important;
            }

            /* Global overlays */
            .ps-room .foehint,
            #tooltipwrapper,
            #pks-camera-controls {
                z-index: 1000 !important;
            }
        `;
        document.head.appendChild(this.styleElement);
    }

    setElementVisibility(selector, visible) {
    }
}

window.uiManager = new ShowdownUIManager();
