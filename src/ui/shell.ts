import cssContent from '../css/style.css?inline';

export function cleanDocument(): void {
    document.open();
    document.close();
    const style = document.createElement('style');
    style.textContent = cssContent;
    document.head.appendChild(style);
}
