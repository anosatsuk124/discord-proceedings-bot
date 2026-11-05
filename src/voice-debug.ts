import type { VoiceConnection, VoiceUDPSocket } from '@discordjs/voice';

/**
 * VOICE_DEBUG のときだけ使う、音声の受信の様子を見る仕組み。
 *
 * 受け取った UDP パケットを種類(RTP なら SSRC ごと)に数えて一定間隔でログに出し、
 * 話し始め・話し終わりの通知も出す。録音が空になったときに、音声がそもそも届いて
 * いないのか、届いているのに録音に回っていないのかを見分けるため。
 *
 * @returns 監視をやめる関数
 */
export function watchVoiceTraffic(
    connection: VoiceConnection,
    log: (message: string) => void,
    intervalMs = 5000
): () => void {
    const counts = new Map<string, number>();
    const onMessage = (message: Buffer): void => {
        const kind = classifyUdpPacket(message);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    };

    // UDP ソケットは接続し直すたびに作り直されるので、状態が変わるたびに付け替える。
    let socket: VoiceUDPSocket | undefined;
    const attach = (): void => {
        const current = currentUdpSocket(connection);
        if (current === socket) return;
        socket?.off('message', onMessage);
        current?.on('message', onMessage);
        socket = current;
    };

    const { speaking } = connection.receiver;
    const onStart = (userId: string): void =>
        log(`speaking start: user ${userId}`);
    const onEnd = (userId: string): void => log(`speaking end: user ${userId}`);
    speaking.on('start', onStart);
    speaking.on('end', onEnd);
    connection.on('stateChange', attach);
    attach();

    const timer = setInterval(() => {
        attach();
        log(
            `udp packets in the last ${intervalMs / 1000}s: ${formatPacketCounts(counts)}`
        );
        counts.clear();
    }, intervalMs);
    timer.unref();

    return () => {
        clearInterval(timer);
        connection.off('stateChange', attach);
        speaking.off('start', onStart);
        speaking.off('end', onEnd);
        socket?.off('message', onMessage);
        socket = undefined;
    };
}

/**
 * UDP パケットの種類。音声(RTP)は `rtp ssrc=<SSRC> pt=<payload type>`、
 * RTCP は `rtcp`、それ以外(keepalive の応答など)は `other <長さ>B`。
 */
export function classifyUdpPacket(message: Buffer): string {
    if (message.length < 12 || message[0]! >> 6 !== 2) {
        return `other ${message.length}B`;
    }
    // RTCP は 2 バイト目全体が packet type(192〜223)。
    const secondByte = message[1]!;
    if (secondByte >= 192 && secondByte <= 223) return 'rtcp';
    return `rtp ssrc=${message.readUInt32BE(8)} pt=${secondByte & 0x7f}`;
}

export function formatPacketCounts(
    counts: ReadonlyMap<string, number>
): string {
    if (counts.size === 0) return 'none';
    let total = 0;
    for (const count of counts.values()) total += count;
    const details = [...counts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, count]) => `${kind}: ${count}`)
        .join(', ');
    return `${total} (${details})`;
}

function currentUdpSocket(
    connection: VoiceConnection
): VoiceUDPSocket | undefined {
    const { state } = connection;
    if (!('networking' in state)) return undefined;
    const networkingState = state.networking.state;
    return 'udp' in networkingState ? networkingState.udp : undefined;
}
