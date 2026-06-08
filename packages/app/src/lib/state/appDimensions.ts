const isClient = typeof window !== 'undefined';
export const appDimensions = { width: isClient ? window.innerWidth : 390, height: isClient ? window.innerHeight : 844 };

function currentViewport() {
	const viewport = window.visualViewport;
	return {
		width: Math.round(viewport?.width ?? window.innerWidth),
		height: Math.round(viewport?.height ?? window.innerHeight)
	};
}

function update() {
	const viewport = currentViewport();
	appDimensions.width = viewport.width;
	appDimensions.height = viewport.height;
}

export function initAppDimensions() {
	update();
	window.addEventListener('resize', update);
	window.visualViewport?.addEventListener('resize', update);
}
