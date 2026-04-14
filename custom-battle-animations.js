(function () {
    let customAnimationsEnabled = true;
    let effectManifestPromise = null;

    function isDoubleBattle(scene) {
        return scene?.battle?.gameType === 'doubles' || (Number.isInteger(scene?.activeCount) && scene.activeCount > 1);
    }

    function areCustomAnimationsSuspended() {
        return !!document.hidden || !!window.pksEffekseer?.isSuspended?.();
    }

    function getSelfEffectTransform(sprite) {
        const isFoe = sprite?.side?.n === sprite?.battle?.farSide?.n;
        return {
            pos: [0, 0, 0],
            rot: isFoe ? [0, 180, 0] : [0, 0, 0],
        };
    }

    function getAttackEffectTransform(attacker) {
        const isFoe = attacker?.side?.n === attacker?.battle?.farSide?.n;
        return {
            pos: [0, 0, 0],
            rot: isFoe ? [0, 180, 0] : [0, 0, 0],
        };
    }

    function getSummonEffectTransform(pokemon) {
        const isFoe = pokemon?.side?.n === pokemon?.battle?.farSide?.n;
        return {
            pos: [0, 0, 0],
            rot: isFoe ? [0, 180, 0] : [0, 0, 0],
        };
    }

    function scheduleSummonLandEffect(scene, pokemon) {
        if (!scene || !pokemon) return;

        const summonDelay = Math.max(0, (scene.timeOffset || 0) + 300 / (scene.acceleration || 1));
        const sprite = pokemon.sprite;
        if (sprite?._pksLandTimer) {
            clearTimeout(sprite._pksLandTimer);
        }

        const { pos, rot } = getSummonEffectTransform(pokemon);
        const timerId = setTimeout(() => {
            if (!window.pksCustomBattleAnimations?.isEnabled()) return;
            if (areCustomAnimationsSuspended()) return;
            playEffekseerMove('land', pos, rot);
        }, summonDelay);

        if (sprite) {
            sprite._pksLandTimer = timerId;
        }
    }

    function isMissedMoveAnimation(participants) {
        if (!Array.isArray(participants) || participants.length < 2) return false;
        return participants.slice(1).some((pokemon) => pokemon?.sprite?.isMissedPokemon);
    }

    function hasUpcomingMissLine(scene) {
        const battle = scene?.battle;
        const queue = battle?.stepQueue;
        const currentStep = battle?.currentStep;
        if (!Array.isArray(queue) || !Number.isInteger(currentStep)) return false;

        for (let i = currentStep + 1; i < queue.length; i += 1) {
            const line = queue[i];
            if (!line) continue;
            if (!line.startsWith('|-')) break;
            if (line.startsWith('|-miss|')) return true;
        }

        return false;
    }

    function getEffectBaseUrl(effectId) {
        const baseUrl = document.documentElement.getAttribute('data-pks-ext-url') || "";
        return `${baseUrl}libs/effects/${effectId}`;
    }

    function loadEffectManifest() {
        if (effectManifestPromise) {
            return effectManifestPromise;
        }

        const baseUrl = document.documentElement.getAttribute('data-pks-ext-url') || "";
        effectManifestPromise = fetch(`${baseUrl}libs/effects/manifest.json`)
            .then((response) => response.ok ? response.json() : {})
            .catch(() => ({}));
        return effectManifestPromise;
    }

    function playEffekseerMove(effectId, pos = [0, 0, 0], rotation = [0, 0, 0]) {
        if (!window.pksEffekseer?.playPair) return;
        const effectBaseUrl = getEffectBaseUrl(effectId);
        void loadEffectManifest().then((effectManifest) => {
            const pairConfig = {
                foreground: `${effectBaseUrl}/${effectId}.efkwgd`,
                position: pos,
                rotation,
            };

            if (effectManifest?.[effectId]?.hasBackground) {
                pairConfig.background = `${effectBaseUrl}/${effectId}_bg.efkwgd`;
            }

            window.pksEffekseer.playPair(pairConfig);
        });
    }

    const customMoveAnims = {
        swordsdance: {
            anim(scene, [attacker]) {
                const { pos, rot } = getSelfEffectTransform(attacker);
                scene.backgroundEffect('#FFCC66', 600, 0.3);
                if (window.BattleOtherAnims?.shake) {
                    window.BattleOtherAnims.shake.anim(scene, [attacker]);
                }
                playEffekseerMove('swordsdance', pos, rot);
            },
        },
        moonblast: {
            anim(scene, [attacker, defender]) {
                const { pos, rot } = getAttackEffectTransform(attacker);
                attacker.anim({
                    z: attacker.behind(-8),
                    time: 150,
                }, 'swing');
                playEffekseerMove('moonblast', pos, rot);
                attacker.anim({
                    time: 250,
                }, 'swing');
                scene.wait(400);
                defender.delay(650);
                defender.anim({
                    z: defender.behind(8),
                    time: 240,
                }, 'swing');
                defender.anim({
                    time: 340,
                }, 'swing');
            },
        },
        mysticalfire: {
            anim(scene, [attacker, defender]) {
                const { pos, rot } = getAttackEffectTransform(attacker);
                attacker.anim({
                    z: attacker.behind(-8),
                    time: 150,
                }, 'swing');
                playEffekseerMove('mysticalfire', pos, rot);
                attacker.anim({
                    time: 250,
                }, 'swing');
                scene.wait(600);
                defender.anim({
                    z: defender.behind(5),
                    time: 100,
                }, 'swing');
                defender.anim({
                    time: 100,
                }, 'swing');
                defender.delay(200);
                defender.anim({
                    z: defender.behind(5),
                    time: 100,
                }, 'swing');
                defender.anim({
                    time: 100,
                }, 'swing');
            },
        },
        shadowball: {
            anim(scene, [attacker, defender]) {
                const { pos, rot } = getAttackEffectTransform(attacker);
                attacker.delay(400);
                attacker.anim({
                    z: attacker.behind(-8),
                    time: 150,
                }, 'swing');
                playEffekseerMove('shadowball', pos, rot);
                attacker.anim({
                    time: 250,
                }, 'swing');
                scene.wait(1000);
                defender.delay(900);
                defender.anim({
                    z: defender.behind(8),
                    time: 150,
                }, 'swing');
                defender.anim({
                    time: 200,
                }, 'swing');
            },
        },
        willowisp: {
            anim(scene, [attacker, defender]) {
                const { pos, rot } = getAttackEffectTransform(attacker);
                scene.backgroundEffect('#440066', 800, 0.4);
                attacker.anim({
                    z: attacker.behind(-5),
                    time: 300,
                }, 'swing');
                playEffekseerMove('willowisp', pos, rot);
                attacker.anim({
                    time: 300,
                }, 'swing');
                defender.delay(600);
                defender.anim({
                    z: defender.behind(5),
                    time: 200,
                }, 'swing');
                defender.anim({
                    time: 200,
                }, 'swing');
            },
        },
        psychic: {
            anim(scene, [attacker, defender]) {
                const { pos, rot } = getAttackEffectTransform(attacker);
                scene.backgroundEffect('#FFDDFF', 1000, 0.4);
                attacker.anim({
                    z: attacker.behind(-10),
                    time: 300,
                }, 'step');
                playEffekseerMove('psychic', pos, rot);
                attacker.anim({
                    time: 300,
                }, 'step');
                scene.wait(500);
                defender.delay(400);
                defender.anim({
                    opacity: 0.2,
                    time: 100,
                }, 'step');
                defender.anim({
                    opacity: 1,
                    time: 100,
                }, 'step');
                defender.anim({
                    z: defender.behind(5),
                    time: 200,
                }, 'swing');
                defender.anim({
                    time: 200,
                }, 'swing');
            },
        },
        hydropump: {
            anim(scene, [attacker, defender]) {
                const { pos, rot } = getAttackEffectTransform(attacker);
                scene.backgroundEffect('#0000DD', 1000, 0.2);
                attacker.anim({
                    z: attacker.behind(-5),
                    time: 100,
                }, 'swing');
                playEffekseerMove('hydropump', pos, rot);
                attacker.anim({
                    time: 200,
                }, 'swing');
                defender.delay(300);
                defender.anim({
                    z: defender.behind(10),
                    time: 100,
                }, 'swing');
                defender.anim({
                    time: 150,
                }, 'swing');
                defender.delay(100);
                defender.anim({
                    z: defender.behind(5),
                    time: 100,
                }, 'swing');
                defender.anim({
                    time: 100,
                }, 'swing');
            },
        },
        gunkshot: {
            anim(scene, [attacker, defender]) {
                const { pos, rot } = getAttackEffectTransform(attacker);
                scene.backgroundEffect('#442244', 800, 0.4);
                attacker.anim({
                    z: attacker.behind(-10),
                    time: 150,
                }, 'swing');
                playEffekseerMove('gunkshot', pos, rot);
                attacker.anim({
                    time: 250,
                }, 'swing');
                scene.wait(800);
                defender.delay(650);
                defender.anim({
                    z: defender.behind(12),
                    time: 120,
                }, 'swing');
                defender.anim({
                    time: 150,
                }, 'swing');
                defender.anim({
                    z: defender.behind(5),
                    time: 100,
                }, 'swing');
                defender.anim({
                    time: 100,
                }, 'swing');
            },
        },
    };

    function patchScene(scene) {
        if (!scene) return;
        if (scene._pksCustomBattleAnimationsPatched) return;

        if (!scene._pksOriginalRunMoveAnim) {
            scene._pksOriginalRunMoveAnim = scene.runMoveAnim.bind(scene);
        }
        if (!scene._pksOriginalAnimSummon) {
            scene._pksOriginalAnimSummon = scene.animSummon.bind(scene);
        }

        scene.runMoveAnim = function (moveid, participants) {
            if (!this.animating) return;

            if (!window.pksCustomBattleAnimations?.isEnabled()) {
                return scene._pksOriginalRunMoveAnim(moveid, participants);
            }

            if (areCustomAnimationsSuspended()) {
                return scene._pksOriginalRunMoveAnim(moveid, participants);
            }

            if (isDoubleBattle(this)) {
                return scene._pksOriginalRunMoveAnim(moveid, participants);
            }

            if (isMissedMoveAnimation(participants)) {
                return scene._pksOriginalRunMoveAnim(moveid, participants);
            }

            if (hasUpcomingMissLine(this)) {
                return scene._pksOriginalRunMoveAnim(moveid, participants);
            }

            const moves = window.pksCustomBattleAnimations?.moves;
            const customAnim = moves ? moves[moveid] : null;

            if (customAnim && typeof customAnim.anim === 'function') {
                const sprites = participants.map((p) => {
                    const sprite = p.sprite;
                    if (sprite) {
                        sprite.side = p.side;
                        sprite.battle = p.battle;
                    }
                    return sprite;
                });
                customAnim.anim(this, sprites);
                return;
            }

            return scene._pksOriginalRunMoveAnim(moveid, participants);
        };

        scene.animSummon = function (pokemon, slot, instant) {
            const result = scene._pksOriginalAnimSummon(pokemon, slot, instant);

            if (this.animating && !instant && !isDoubleBattle(this) && !areCustomAnimationsSuspended() && window.pksCustomBattleAnimations?.isEnabled()) {
                scheduleSummonLandEffect(this, pokemon);
            }

            return result;
        };

        scene._pksCustomBattleAnimationsPatched = true;
    }

    window.pksCustomBattleAnimations = {
        moves: customMoveAnims,
        patchScene,
        playEffekseerMove,
        isEnabled() {
            return customAnimationsEnabled;
        },
        setEnabled(value) {
            customAnimationsEnabled = !!value;
            return customAnimationsEnabled;
        },
        toggle() {
            customAnimationsEnabled = !customAnimationsEnabled;
            return customAnimationsEnabled;
        },
    };
})();
