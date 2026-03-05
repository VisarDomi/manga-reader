export interface ToastItem {
    id: number;
    message: string;
    onClick?: () => void;
}

export class ToastState {
    items = $state<ToastItem[]>([]);
    private nextId = 0;

    show(message: string, duration = 2000, onClick?: () => void): number {
        const id = this.nextId++;
        this.items = [...this.items, { id, message, onClick }];
        setTimeout(() => {
            this.dismiss(id);
        }, duration);
        return id;
    }

    dismiss(id: number): void {
        this.items = this.items.filter(t => t.id !== id);
    }
}
