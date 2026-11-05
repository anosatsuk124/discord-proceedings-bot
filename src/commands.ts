import {
    ApplicationIntegrationType,
    InteractionContextType,
    SlashCommandBuilder,
} from 'discord.js';

/** コマンド名。ほかの Bot の /join などと被らない名前にしている。 */
export const COMMAND_NAME = 'gijiroku';
export const START_SUBCOMMAND = 'start';
export const STOP_SUBCOMMAND = 'stop';

/** Bot が登録するスラッシュコマンド(/gijiroku start と /gijiroku stop)。 */
export const commands = [
    new SlashCommandBuilder()
        .setName(COMMAND_NAME)
        .setDescription('ボイスチャンネルを録音して議事録を作ります')
        .setContexts(InteractionContextType.Guild)
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
        .addSubcommand((subcommand) =>
            subcommand
                .setName(START_SUBCOMMAND)
                .setDescription('あなたがいるボイスチャンネルの録音を始めます')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName(STOP_SUBCOMMAND)
                .setDescription('録音を終えてボイスチャンネルから退出します')
        ),
].map((command) => command.toJSON());
