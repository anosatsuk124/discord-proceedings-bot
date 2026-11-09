import {
    ApplicationIntegrationType,
    InteractionContextType,
    SlashCommandBuilder,
} from 'discord.js';
import { PERIOD_CHOICES } from './report/period.ts';

/** コマンド名。ほかの Bot の /join などと被らない名前にしている。 */
export const COMMAND_NAME = 'gijiroku';
export const START_SUBCOMMAND = 'start';
export const STOP_SUBCOMMAND = 'stop';
export const REPORT_SUBCOMMAND = 'report';
export const INDEX_SUBCOMMAND = 'index';
export const PERIOD_OPTION = 'period';
export const FROM_OPTION = 'from';
export const TO_OPTION = 'to';

/** Bot が登録するスラッシュコマンド(/gijiroku start、stop、report、index)。 */
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
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName(REPORT_SUBCOMMAND)
                .setDescription(
                    '録音をまとめた議事録ページを作ります(指定がなければ、まとめていない録音)'
                )
                .addStringOption((option) =>
                    option
                        .setName(PERIOD_OPTION)
                        .setDescription('対象の期間')
                        .addChoices(...PERIOD_CHOICES)
                )
                .addStringOption((option) =>
                    option
                        .setName(FROM_OPTION)
                        .setDescription(
                            '開始(例: 2026-11-06 または 2026-11-06 21:00)'
                        )
                )
                .addStringOption((option) =>
                    option
                        .setName(TO_OPTION)
                        .setDescription(
                            '終了(日付だけならその日の終わりまで。省略すると現在まで)'
                        )
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName(INDEX_SUBCOMMAND)
                .setDescription('このサーバーの議事録の入口ページを表示します')
        ),
].map((command) => command.toJSON());
