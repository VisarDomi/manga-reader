import type { Provider } from '../provider';

export async function open(provider: Provider): Promise<void> {
    await provider.openHome?.();
}
