export interface TokenManager {
    start(): () => void;
}

export const noTokenManager: TokenManager = Object.freeze({
    start() {
        return () => undefined;
    },
});
