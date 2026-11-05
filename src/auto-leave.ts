/**
 * ボイスチャンネルから人(Bot を除く)がいなくなったら、少し待ってから退出するためのタイマー。
 * 待っているあいだに誰かが戻ってきたら取り消す。
 */
export class AutoLeaveTimers {
    readonly #delayMs: number;
    readonly #onExpire: (guildId: string) => void;
    readonly #timers = new Map<string, NodeJS.Timeout>();

    /** delayMs が 0 なら何もしない(自動では退出しない)。 */
    constructor(delayMs: number, onExpire: (guildId: string) => void) {
        this.#delayMs = delayMs;
        this.#onExpire = onExpire;
    }

    /** チャンネルに人がいるかを伝える。いなければタイマーを始め、いればタイマーを止める。 */
    update(guildId: string, humansPresent: boolean): void {
        if (humansPresent) {
            this.cancel(guildId);
            return;
        }
        if (this.#delayMs <= 0 || this.#timers.has(guildId)) return;
        const timer = setTimeout(() => {
            this.#timers.delete(guildId);
            this.#onExpire(guildId);
        }, this.#delayMs);
        this.#timers.set(guildId, timer);
    }

    isPending(guildId: string): boolean {
        return this.#timers.has(guildId);
    }

    cancel(guildId: string): void {
        clearTimeout(this.#timers.get(guildId));
        this.#timers.delete(guildId);
    }

    cancelAll(): void {
        for (const guildId of [...this.#timers.keys()]) this.cancel(guildId);
    }
}
