(function () {
    function initScene(room) {
        const scene = room?.battle?.scene;
        const battleRoot = scene?.$battle?.[0];
        const isVisible = !!battleRoot && battleRoot.isConnected && battleRoot.getClientRects().length > 0;
        if (!scene || !isVisible || scene._pks3dBooting) return;

        const needsInit = room._pks3dScene !== scene || !scene.threeInitialized;
        if (!needsInit) return;

        if (!window.init3DScene) {
            return;
        }

        scene._pks3dBooting = true;
        void Promise.resolve(window.init3DScene(scene.$battle?.[0], room))
            .catch(() => {})
            .finally(() => {
                scene._pks3dBooting = false;
            });
    }

    function checkAndInit() {
        if (window.app && window.app.rooms) {
            for (const id in window.app.rooms) {
                const room = window.app.rooms[id];
                if (!room?.battle?.scene) continue;

                if (window.pksCustomBattleAnimations?.patchScene) {
                    window.pksCustomBattleAnimations.patchScene(room.battle.scene);
                }

                initScene(room);
            }
        }
    }

    const observer = new MutationObserver(() => {
        checkAndInit();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(checkAndInit, 1000);
})();
