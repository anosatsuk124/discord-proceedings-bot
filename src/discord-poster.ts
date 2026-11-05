import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js';
import {
    PermanentDeliveryError,
    type OutgoingMessage,
    type Poster,
} from './delivery.ts';

/** やり直しても成功しない Discord API のエラー。 */
const PERMANENT_ERRORS = new Set<number | string>([
    RESTJSONErrorCodes.UnknownChannel,
    RESTJSONErrorCodes.MissingAccess,
    RESTJSONErrorCodes.MissingPermissions,
    RESTJSONErrorCodes.CannotSendMessagesInNonTextChannel,
    RESTJSONErrorCodes.RequestEntityTooLarge,
]);

/** discord.js でチャンネルに投稿する Poster。 */
export function discordPoster(client: Client): Poster {
    return {
        async post(channelId: string, message: OutgoingMessage) {
            try {
                const channel = await client.channels.fetch(channelId);
                if (channel === null || !channel.isSendable()) {
                    throw new PermanentDeliveryError(
                        `channel ${channelId} is not a channel the bot can send messages to`
                    );
                }
                const sent = await channel.send({
                    content: message.content,
                    files: message.files.map((file) => ({
                        attachment: file.path,
                        name: file.name,
                    })),
                    // 本文にはチャンネルへのリンクしか入れないが、念のため誰にも通知しない。
                    allowedMentions: { parse: [] },
                });
                return { messageId: sent.id };
            } catch (error) {
                if (
                    error instanceof DiscordAPIError &&
                    PERMANENT_ERRORS.has(error.code)
                ) {
                    throw new PermanentDeliveryError(
                        `${error.message} (code ${error.code})`
                    );
                }
                throw error;
            }
        },
    };
}
