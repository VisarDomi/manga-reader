/** Browser document takeover; native builds replace only this platform boundary. */
export function takeOverDocument(): void {
    window.stop();
    document.open();
    document.close();
}
