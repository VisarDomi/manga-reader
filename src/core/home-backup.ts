import { computeRequest } from './compute/transport';

export function installManualPC(parent: HTMLElement, provider: string, loaded: () => void): void {
    const controls = document.createElement('p');
    controls.className = 'hs-home-pc'; controls.hidden = true;
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    const buttons = ['Load', 'Save'].map(label => {
        const button = document.createElement('button'); button.textContent = label;
        button.title = label === 'Load' ? 'Replace local reading state with the PC save' : 'Replace the PC save with local reading state';
        button.onclick = async () => {
            buttons.forEach(b => b.disabled = true); status.textContent = '';
            try {
                const ok = await computeRequest('manual-pc', { action: label === 'Load' ? 'load' : 'save', provider });
                if (!ok) { controls.hidden = true; return; }
                status.textContent = label === 'Load' ? 'Loaded' : 'Saved';
                if (label === 'Load') loaded();
            } catch (error) {
                const available = await computeRequest('manual-pc', { action: 'available', provider }).catch(() => false);
                controls.hidden = !available;
                if (available) status.textContent = error instanceof Error ? error.message : 'PC request failed';
            } finally { buttons.forEach(b => b.disabled = false); }
        };
        controls.append(button); return button;
    });
    controls.append(status); parent.append(controls);
    const probe = () => { void computeRequest('manual-pc', { action: 'available', provider }).then(ok => { controls.hidden = !ok; }).catch(() => { controls.hidden = true; }); };
    probe();
    addEventListener('pageshow', event => { if (event.persisted) probe(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) probe(); });
}
