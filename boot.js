(function () {
    const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
    if (!runtime) return;

    const extUrl = runtime.getURL('');
    const root = document.documentElement;
    if (!root) return;

    root.setAttribute('data-pks-ext-url', extUrl);
    if (root.dataset.pksInjected === '1') return;
    root.dataset.pksInjected = '1';

    const pageScripts = [
        'libs/utils/fflate.js',
        'ui-manager.js',
        'custom-battle-animations.js',
        'engine.js',
        'content.js',
    ];

    const loadScript = (path) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${extUrl}${path}`;
        script.onload = () => {
            script.remove();
            resolve();
        };
        script.onerror = () => {
            script.remove();
            reject(new Error(`Failed to load ${path}`));
        };
        (document.head || root).appendChild(script);
    });

    const injectPageScripts = async () => {
        for (const path of pageScripts) {
            await loadScript(path);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            void injectPageScripts();
        }, { once: true });
        return;
    }

    void injectPageScripts();
})();
