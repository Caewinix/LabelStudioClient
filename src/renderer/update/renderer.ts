type RuntimeKey = 'electron' | 'package' | 'python';

interface BusyPayload {
    busy: boolean;
    status: string;
    progress?: number;
    activeButton?: RuntimeKey;
    showsDownloadControls?: boolean;
    showsDownloadProgress?: boolean;
    showsInlineActivity?: boolean;
}

interface UpdateStatePayload {
    appVersion?: string;
    electronVersion?: string;
    packageVersion?: string;
    pythonVersion?: string;
    autoCheckElectron?: boolean;
    autoCheckPackage?: boolean;
    autoCheckPython?: boolean;
}

interface UpdateAPI {
    getState: () => Promise<UpdateStatePayload>;
    checkElectron: () => Promise<void>;
    checkPackage: () => Promise<void>;
    checkPython: () => Promise<void>;
    setPreference: (key: string, value: boolean) => Promise<void>;
    onState: (callback: (payload: UpdateStatePayload) => void) => void;
    onBusy: (callback: (payload: BusyPayload) => void) => void;
    onElectronVersion: (callback: (value: string) => void) => void;
    onPackageVersion: (callback: (value: string) => void) => void;
    onPythonVersion: (callback: (value: string) => void) => void;
    onDownloadPaused: (callback: (value: boolean) => void) => void;
    onDownloadStatus: (callback: (value: string) => void) => void;
    setPaused?: (paused: boolean) => void;
    togglePause: () => Promise<boolean>;
    cancelDownload: () => Promise<boolean>;
}

interface Window {
    updateAPI?: UpdateAPI;
}

interface RuntimeUI {
    row: HTMLElement;
    check: HTMLButtonElement;
    panel: HTMLElement;
    status: HTMLElement;
    fill: HTMLElement;
    pause: HTMLButtonElement;
    cancel: HTMLButtonElement;
}

function ready(callback: () => void): void {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
        callback();
    }
}

ready(() => {
    console.log('[update] renderer boot; updateAPI available =', Boolean(window.updateAPI));

    const appVersion = requireElement<HTMLElement>('appVersion');
    const electronVersion = requireElement<HTMLElement>('electronVersion');
    const packageVersion = requireElement<HTMLElement>('packageVersion');
    const pythonVersion = requireElement<HTMLElement>('pythonVersion');

    const electronCheck = requireElement<HTMLButtonElement>('electronCheck');
    const packageCheck = requireElement<HTMLButtonElement>('packageCheck');
    const pythonCheck = requireElement<HTMLButtonElement>('pythonCheck');

    const autoElectron = requireElement<HTMLInputElement>('autoElectron');
    const autoPackage = requireElement<HTMLInputElement>('autoPackage');
    const autoPython = requireElement<HTMLInputElement>('autoPython');

    const runtimeUI: Record<RuntimeKey, RuntimeUI> = {
        electron: {
            row: requireRuntimeRow('electron'),
            check: electronCheck,
            panel: requireElement<HTMLElement>('electronProgressPanel'),
            status: requireElement<HTMLElement>('electronStatus'),
            fill: requireElement<HTMLElement>('electronProgressFill'),
            pause: requireElement<HTMLButtonElement>('electronPause'),
            cancel: requireElement<HTMLButtonElement>('electronCancel')
        },
        package: {
            row: requireRuntimeRow('package'),
            check: packageCheck,
            panel: requireElement<HTMLElement>('packageProgressPanel'),
            status: requireElement<HTMLElement>('packageStatus'),
            fill: requireElement<HTMLElement>('packageProgressFill'),
            pause: requireElement<HTMLButtonElement>('packagePause'),
            cancel: requireElement<HTMLButtonElement>('packageCancel')
        },
        python: {
            row: requireRuntimeRow('python'),
            check: pythonCheck,
            panel: requireElement<HTMLElement>('pythonProgressPanel'),
            status: requireElement<HTMLElement>('pythonStatus'),
            fill: requireElement<HTMLElement>('pythonProgressFill'),
            pause: requireElement<HTMLButtonElement>('pythonPause'),
            cancel: requireElement<HTMLButtonElement>('pythonCancel')
        }
    };

    let paused = false;
    let currentDownloadStatus = '';
    let cancelInFlight = false;
    let lastPauseActionAt = 0;
    let lastCancelActionAt = 0;
    let layoutFrame = 0;
    let activeAction: RuntimeKey | undefined;
    let activeInlineRow: RuntimeKey | undefined;

    setInitialFallbackState();
    installDownloadButtonIcons();
    bindButtons();
    bindAPIEvents();
    void loadState();
    scheduleMeasuredLayout();

    function requireElement<T extends HTMLElement>(id: string): T {
        const element = document.getElementById(id);
        if (!element) {
            throw new Error(`[update] Missing required element #${id}`);
        }
        return element as T;
    }

    function requireRuntimeRow(runtime: RuntimeKey): HTMLElement {
        const element = document.querySelector<HTMLElement>(`.component-row[data-runtime="${runtime}"]`);
        if (!element) {
            throw new Error(`[update] Missing required component row for ${runtime}`);
        }
        return element;
    }

    function requireUpdateAPI(): UpdateAPI | undefined {
        const api = window.updateAPI;
        if (!api) {
            console.error('[update] window.updateAPI is unavailable. Check updatePreload.ts and BrowserWindow preload path.');
            window.alert('Update bridge unavailable. Please check preload.');
            scheduleMeasuredLayout();
            return undefined;
        }
        return api;
    }

    function setInitialFallbackState(): void {
        scheduleMeasuredLayout();
    }

    function setState(payload: UpdateStatePayload): void {
        if (payload.appVersion) appVersion.textContent = payload.appVersion;
        if (payload.electronVersion) electronVersion.textContent = payload.electronVersion;
        if (payload.packageVersion) packageVersion.textContent = payload.packageVersion;
        if (payload.pythonVersion) pythonVersion.textContent = payload.pythonVersion;

        if (typeof payload.autoCheckElectron === 'boolean') autoElectron.checked = payload.autoCheckElectron;
        if (typeof payload.autoCheckPackage === 'boolean') autoPackage.checked = payload.autoCheckPackage;
        if (typeof payload.autoCheckPython === 'boolean') autoPython.checked = payload.autoCheckPython;

        scheduleMeasuredLayout();
    }

    async function loadState(): Promise<void> {
        setInitialFallbackState();

        const api = requireUpdateAPI();
        if (!api) return;

        try {
            console.log('[update] requesting initial state');
            const state = await api.getState();
            console.log('[update] initial state received', state);
            setState(state);
        } catch (error) {
            console.error('[update] getState failed:', error);
            const message = error instanceof Error ? error.message : String(error);
            appVersion.textContent = 'Unavailable';
            electronVersion.textContent = 'Unavailable';
            packageVersion.textContent = 'Unavailable';
            pythonVersion.textContent = 'Unavailable';
            console.error(`[update] Failed to read versions: ${message}`);
            scheduleMeasuredLayout();
        }
    }

    function setBusy(payload: BusyPayload): void {
        const active = payload.activeButton ?? activeAction;

        if (payload.busy && active) {
            setChecksDisabled(true);
            setActiveButtonLoading(active);
            if (payload.showsDownloadProgress || payload.showsDownloadControls) {
                showInlineStatus(active, payload.status || '', payload.progress, 'progress', Boolean(payload.showsDownloadControls));
            } else if (payload.showsInlineActivity) {
                showInlineStatus(active, payload.status || '', undefined, 'activity', false);
            } else {
                hideInlineStatus();
            }
            scheduleMeasuredLayout();
            return;
        }

        if (activeAction) {
            setChecksDisabled(true);
            setActiveButtonLoading(activeAction);
            scheduleMeasuredLayout();
            return;
        }

        setChecksDisabled(false);
        setActiveButtonLoading(undefined);
        hideInlineStatus();
        scheduleMeasuredLayout();
    }

    function setChecksDisabled(disabled: boolean): void {
        for (const ui of Object.values(runtimeUI)) {
            ui.check.disabled = disabled;
        }
    }

    function setActiveButtonLoading(active: RuntimeKey | undefined): void {
        for (const [key, ui] of runtimeEntries()) {
            setButtonLoading(ui.check, active === key);
        }
    }

    function showInlineStatus(
        key: RuntimeKey,
        rawStatus: string,
        progress: number | undefined,
        mode: 'progress' | 'activity',
        showsDownloadControls: boolean
    ): void {
        const status = mode === 'progress' ? displayDownloadStatus(rawStatus) : rawStatus;
        activeInlineRow = key;

        for (const [runtime, ui] of runtimeEntries()) {
            const active = runtime === key;
            ui.row.classList.toggle('component-row-active', active);
            ui.row.classList.toggle('has-inline-status', active && status.length > 0);
            ui.row.classList.toggle('has-inline-progress', active && mode === 'progress');
            ui.row.classList.toggle('has-inline-activity', active && mode === 'activity');
            ui.panel.classList.toggle('is-visible', active && status.length > 0);
            ui.panel.classList.toggle('shows-progress', active && mode === 'progress');
            ui.panel.classList.toggle('shows-activity', active && mode === 'activity');
            ui.panel.setAttribute('aria-hidden', active && status.length > 0 ? 'false' : 'true');

            if (!active) {
                ui.status.textContent = '';
                ui.status.hidden = true;
                ui.fill.style.width = '0%';
                ui.pause.hidden = true;
                ui.cancel.hidden = true;
                continue;
            }

            ui.status.textContent = status;
            ui.status.hidden = status.length === 0;
            ui.fill.style.width = typeof progress === 'number'
                ? `${Math.max(0, Math.min(1, progress)) * 100}%`
                : '0%';
            ui.pause.hidden = mode !== 'progress' || !showsDownloadControls;
            ui.cancel.hidden = mode !== 'progress' || !showsDownloadControls;
        }
    }

    function hideInlineStatus(keepStatusFor?: RuntimeKey): void {
        for (const [runtime, ui] of runtimeEntries()) {
            if (keepStatusFor === runtime) {
                ui.pause.hidden = true;
                ui.cancel.hidden = true;
                ui.panel.classList.remove('shows-progress', 'shows-activity');
                ui.row.classList.remove('has-inline-progress', 'has-inline-activity');
                continue;
            }

            ui.row.classList.remove('component-row-active', 'has-inline-status', 'has-inline-progress', 'has-inline-activity');
            ui.panel.classList.remove('is-visible', 'shows-progress', 'shows-activity');
            ui.panel.setAttribute('aria-hidden', 'true');
            ui.status.textContent = '';
            ui.status.hidden = true;
            ui.fill.style.width = '0%';
            ui.pause.hidden = true;
            ui.cancel.hidden = true;
        }

        if (!keepStatusFor) activeInlineRow = undefined;
    }

    function runtimeEntries(): Array<[RuntimeKey, RuntimeUI]> {
        return Object.entries(runtimeUI) as Array<[RuntimeKey, RuntimeUI]>;
    }

    function displayDownloadStatus(value: string): string {
        if (!paused) return value;
        const trimmed = value.trim();
        if (!trimmed) return 'Paused';
        if (trimmed.endsWith('Paused')) return trimmed;
        return `${trimmed} Paused`;
    }

    function setButtonLoading(button: HTMLButtonElement, loading: boolean): void {
        button.classList.toggle('loading', loading);
        if (loading) {
            button.dataset.originalText = button.textContent || 'Check';
            button.textContent = '';
            button.setAttribute('aria-busy', 'true');
        } else {
            button.textContent = button.dataset.originalText || 'Check';
            button.removeAttribute('aria-busy');
        }
    }

    function flashButton(button: HTMLButtonElement): void {
        button.classList.add('pressed');
        window.setTimeout(() => button.classList.remove('pressed'), 140);
    }

    function isMouseInteraction(event?: Event): boolean {
        if (event instanceof PointerEvent) return event.pointerType === 'mouse';
        return event instanceof MouseEvent && event.detail > 0;
    }

    async function runUpdateAction(key: RuntimeKey, action: () => Promise<void>, event?: Event): Promise<void> {
        const button = runtimeUI[key].check;
        if (button.disabled || activeAction) return;

        activeAction = key;
        paused = false;
        currentDownloadStatus = '';
        if (!isMouseInteraction(event)) flashButton(button);
        setChecksDisabled(true);
        setActiveButtonLoading(key);
        hideInlineStatus();
        scheduleMeasuredLayout();

        try {
            await action();
        } catch (error) {
            console.error('[update] action failed:', error);
            window.alert(error instanceof Error ? error.message : String(error));
        } finally {
            activeAction = undefined;
            setChecksDisabled(false);
            setActiveButtonLoading(undefined);
            hideInlineStatus();
            scheduleMeasuredLayout();
        }
    }

    function bindExactButton(button: HTMLButtonElement, handler: (event: Event) => void): void {
        let activePointerId: number | undefined;
        let activePointerType: string | undefined;
        let ignoreNextClick = false;
        let ownsForcedPointerCursor = false;
        let pointerOutsideWindow = false;
        const pointerCaptureTarget = document.documentElement;

        const buttonIsInteractive = (): boolean => {
            return button.isConnected && !button.hidden && !button.disabled;
        };

        const pointerIsInside = (event: MouseEvent): boolean => {
            const bounds = button.getBoundingClientRect();
            return event.clientX >= bounds.left
                && event.clientX <= bounds.right
                && event.clientY >= bounds.top
                && event.clientY <= bounds.bottom;
        };

        const setForcedPointerCursor = (forced: boolean): void => {
            if (ownsForcedPointerCursor === forced) return;
            ownsForcedPointerCursor = forced;
            document.documentElement.classList.toggle('force-pointer-cursor', forced);
        };

        new MutationObserver(() => {
            if (!buttonIsInteractive()) setForcedPointerCursor(false);
        }).observe(button, { attributes: true, attributeFilter: ['class', 'disabled', 'hidden'] });

        const clearPointerState = (): void => {
            const pointerId = activePointerId;
            activePointerId = undefined;
            activePointerType = undefined;
            button.classList.remove('pressed');
            setForcedPointerCursor(false);
            if (pointerId !== undefined && pointerCaptureTarget.hasPointerCapture(pointerId)) {
                try { pointerCaptureTarget.releasePointerCapture(pointerId); } catch { /* capture may already be released */ }
            }
        };

        const cancelPointerState = (): void => {
            if (activePointerId === undefined) return;
            clearPointerState();
            ignoreNextClick = true;
            window.setTimeout(() => { ignoreNextClick = false; }, 0);
        };

        const updatePressedAppearance = (event: PointerEvent): void => {
            if (activePointerType === 'mouse'
                && event.pointerType === 'mouse'
                && activePointerId !== event.pointerId
                && (event.buttons & 1) !== 0) {
                activePointerId = event.pointerId;
            }
            if (activePointerId !== event.pointerId) return;

            if (!buttonIsInteractive()) {
                cancelPointerState();
                return;
            }

            button.classList.add('pressed');
            if (event.pointerType === 'mouse') {
                setForcedPointerCursor(true);
            }
        };

        button.addEventListener('pointerdown', (event) => {
            if (!buttonIsInteractive() || (event.pointerType === 'mouse' && event.button !== 0)) return;
            event.preventDefault();
            event.stopPropagation();
            pointerOutsideWindow = false;
            clearPointerState();
            activePointerId = event.pointerId;
            activePointerType = event.pointerType;
            button.classList.add('pressed');
            if (event.pointerType === 'mouse') setForcedPointerCursor(true);
            try { pointerCaptureTarget.setPointerCapture(event.pointerId); } catch { /* use document events as fallback */ }
        }, { passive: false });

        button.addEventListener('pointerup', (event) => {
            if (activePointerId !== event.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            const shouldRun = pointerIsInside(event) && buttonIsInteractive();
            clearPointerState();
            ignoreNextClick = true;
            window.setTimeout(() => { ignoreNextClick = false; }, 0);
            if (shouldRun) handler(event);
            if (shouldRun && event.pointerType === 'mouse' && buttonIsInteractive()) {
                setForcedPointerCursor(true);
            }
        }, { passive: false });

        button.addEventListener('click', event => {
            if (ignoreNextClick) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (buttonIsInteractive()) handler(event);
        }, { passive: false });

        document.addEventListener('pointermove', updatePressedAppearance, { capture: true, passive: true });

        document.addEventListener('pointerup', (event) => {
            if (activePointerId !== event.pointerId) return;
            const shouldRun = pointerIsInside(event) && buttonIsInteractive();
            clearPointerState();
            ignoreNextClick = true;
            window.setTimeout(() => { ignoreNextClick = false; }, 0);
            if (shouldRun) handler(event);
            if (shouldRun && event.pointerType === 'mouse' && buttonIsInteractive()) {
                setForcedPointerCursor(true);
            }
        }, { capture: true, passive: false });

        document.addEventListener('pointercancel', (event) => {
            if (activePointerId !== event.pointerId) return;
            cancelPointerState();
        }, { capture: true });

        button.addEventListener('pointerleave', () => {
            if (activePointerId === undefined) setForcedPointerCursor(false);
        });

        window.addEventListener('mouseout', (event) => {
            if (event.relatedTarget === null) {
                pointerOutsideWindow = true;
            }
        });

        window.addEventListener('mouseover', (event) => {
            if (!pointerOutsideWindow) return;
            pointerOutsideWindow = false;
            if (activePointerId === undefined || activePointerType !== 'mouse') return;
            if ((event.buttons & 1) === 0 || !buttonIsInteractive()) {
                cancelPointerState();
                return;
            }
            setForcedPointerCursor(true);
        });

    }

    function bindButtons(): void {
        bindExactButton(electronCheck, (event) => {
            const api = requireUpdateAPI();
            if (!api) return;
            void runUpdateAction('electron', () => api.checkElectron(), event);
        });

        bindExactButton(packageCheck, (event) => {
            const api = requireUpdateAPI();
            if (!api) return;
            void runUpdateAction('package', () => api.checkPackage(), event);
        });

        bindExactButton(pythonCheck, (event) => {
            const api = requireUpdateAPI();
            if (!api) return;
            void runUpdateAction('python', () => api.checkPython(), event);
        });

        autoElectron.addEventListener('change', () => {
            const api = requireUpdateAPI();
            if (!api) return;
            void api.setPreference('AutoCheckChromiumUpdates', autoElectron.checked);
        });

        autoPackage.addEventListener('change', () => {
            const api = requireUpdateAPI();
            if (!api) return;
            void api.setPreference('AutoCheckPackageUpdates', autoPackage.checked);
        });

        autoPython.addEventListener('change', () => {
            const api = requireUpdateAPI();
            if (!api) return;
            void api.setPreference('AutoCheckPythonUpdates', autoPython.checked);
        });

        for (const ui of Object.values(runtimeUI)) {
            bindExactButton(ui.pause, () => { void toggleDownloadPause(); });
            bindExactButton(ui.cancel, () => { void cancelDownload(); });
        }
    }

    async function toggleDownloadPause(): Promise<void> {
        const now = performance.now();
        if (now - lastPauseActionAt < 300) return;
        lastPauseActionAt = now;

        const api = requireUpdateAPI();
        if (!api) return;

        try {
            paused = await api.togglePause();
            updatePauseVisual();
        } catch (error) {
            console.error('[update] togglePause failed:', error);
        }
    }

    async function cancelDownload(): Promise<void> {
        const now = performance.now();
        if (cancelInFlight || now - lastCancelActionAt < 500) return;
        lastCancelActionAt = now;

        const api = requireUpdateAPI();
        if (!api) return;

        cancelInFlight = true;
        try {
            await api.cancelDownload();
        } catch (error) {
            console.error('[update] cancelDownload failed:', error);
        } finally {
            cancelInFlight = false;
        }
    }

    function bindAPIEvents(): void {
        const api = window.updateAPI;
        if (!api) {
            console.error('[update] updateAPI missing at startup.');
            return;
        }

        api.onState(payload => setState(payload as UpdateStatePayload));
        api.onBusy(payload => setBusy(payload as BusyPayload));
        api.onElectronVersion(value => { electronVersion.textContent = value; scheduleMeasuredLayout(); });
        api.onPackageVersion(value => { packageVersion.textContent = value; scheduleMeasuredLayout(); });
        api.onPythonVersion(value => { pythonVersion.textContent = value; scheduleMeasuredLayout(); });
        api.onDownloadPaused(value => {
            paused = value;
            updatePauseVisual();
        });
        api.onDownloadStatus(value => {
            currentDownloadStatus = value;
            if (activeInlineRow) {
                const ui = runtimeUI[activeInlineRow];
                const text = displayDownloadStatus(value);
                ui.status.textContent = text;
                ui.status.hidden = text.length === 0;
            }
            scheduleMeasuredLayout();
        });
    }

    function updatePauseVisual(): void {
        for (const ui of Object.values(runtimeUI)) {
            ui.pause.classList.toggle('is-paused', paused);
            ui.pause.innerHTML = pauseIconSVG(paused);
            ui.pause.title = paused ? 'Continue download' : 'Pause download';
            ui.pause.setAttribute('aria-label', paused ? 'Continue download' : 'Pause download');
            ui.cancel.setAttribute('aria-label', 'Cancel download');
        }

        if (activeInlineRow) {
            const ui = runtimeUI[activeInlineRow];
            ui.status.textContent = displayDownloadStatus(currentDownloadStatus);
            ui.status.hidden = ui.status.textContent.length === 0;
        }
        scheduleMeasuredLayout();
    }

    function installDownloadButtonIcons(): void {
        for (const ui of Object.values(runtimeUI)) {
            ui.pause.innerHTML = pauseIconSVG(paused);
            ui.cancel.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 3.2 8 7l3.8-3.8 1 1L9 8l3.8 3.8-1 1L8 9l-3.8 3.8-1-1L7 8 3.2 4.2z" fill="currentColor"/></svg>';
            ui.pause.setAttribute('aria-label', 'Pause download');
            ui.cancel.setAttribute('aria-label', 'Cancel download');
        }
    }

    function pauseIconSVG(isPaused: boolean): string {
        if (isPaused) {
            return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6L12.4 8z" fill="currentColor"/></svg>';
        }
        return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h2v10H4zM10 3h2v10h-2z" fill="currentColor"/></svg>';
    }

    function chooseMeasuredWidthMode(): void {
        function apply(mode: 'normal' | 'tight' | 'stack' | 'min'): void {
            document.body.classList.toggle('layout-width-tight', mode === 'tight' || mode === 'stack' || mode === 'min');
            document.body.classList.toggle('layout-width-stack', mode === 'stack' || mode === 'min');
            document.body.classList.toggle('layout-width-min', mode === 'min');
        }

        function overflowed(): boolean {
            const elements = Array.from(document.querySelectorAll<HTMLElement>(
                '.update-shell, .titlebar-card, .summary-card, .updates-card, .updates-header, .component-row, .component-text, .checkbox-row'
            ));
            return elements.some(element => element.scrollWidth > element.clientWidth + 1);
        }

        apply('normal');
        if (!overflowed()) return;

        apply('tight');
        if (!overflowed()) return;

        apply('stack');
        if (!overflowed()) return;

        apply('min');
    }

    function scheduleMeasuredLayout(): void {
        if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
        layoutFrame = window.requestAnimationFrame(() => {
            layoutFrame = 0;
            chooseMeasuredWidthMode();

            window.requestAnimationFrame(() => {
                chooseMeasuredWidthMode();
            });
        });
    }

    window.addEventListener('resize', scheduleMeasuredLayout);
    window.addEventListener('load', scheduleMeasuredLayout);

    if ('fonts' in document) {
        void document.fonts.ready.then(() => {
            scheduleMeasuredLayout();
            window.setTimeout(scheduleMeasuredLayout, 80);
            window.setTimeout(scheduleMeasuredLayout, 250);
            window.setTimeout(scheduleMeasuredLayout, 500);
        });
    }
});
