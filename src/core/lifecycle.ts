export function onBfcacheRestore(restore: () => void): void {
    window.addEventListener('pageshow', event => {
        if (event.persisted) restore();
    });
}
