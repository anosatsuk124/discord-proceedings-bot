import { Client, ClientOptions, GatewayIntentBits, Partials } from 'discord.js';
import {
    VoiceConnection,
    getVoiceConnection,
    joinVoiceChannel,
} from '@discordjs/voice';
import { createWriteStream, writeFile } from 'fs';
import { opus } from 'prism-media';
import pathToFfmpeg from 'ffmpeg-static';
import { exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { config } from 'dotenv';
import path from 'path';
config();

if (!process.argv[1]) {
    console.log('Please provide a directory path to store the files');
    process.exit(1);
}

const dirPath = process.argv[2];

interface Talk {
    date: string;
    discord_name: string;
    uuid: string;
}

const options: ClientOptions = {
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.GuildMember, Partials.Message],
};
const client = new Client(options);

client.on('ready', () => {
    console.log(`${client.user?.tag} is logged in`);
});

const talks: Set<Talk> = new Set();
client.on('messageCreate', (msg) => {
    const idDateMap = new Map<string, Date>();
    if (msg.author.bot) return;
    if (msg.content.startsWith('!join')) {
        const channel = msg.member?.voice.channel;
        const connection = joinVoiceChannel({
            channelId: channel?.id!,
            guildId: channel?.guildId!,
            adapterCreator: channel?.guild.voiceAdapterCreator!,
            selfDeaf: false,
        });
        connection.dispatchAudio();
        const receiver = connection.receiver;

        receiver.speaking.on('start', async (userId) => {
            console.log('start');
            const stream = receiver.subscribe(userId);
            const uuid = uuidv4();
            const fileName = path.join(dirPath, uuid);
            const pcmFile = createWriteStream(`${fileName}.pcm`);
            stream
                .pipe(
                    new opus.Decoder({
                        rate: 48000,
                        channels: 2,
                        frameSize: 960,
                    })
                )
                .pipe(pcmFile);
            receiver.speaking.once('end', async (endUserId) => {
                if (userId !== endUserId) return;
                exec(
                    `${pathToFfmpeg} -y -f s16le -ar 44.1k -ac 2 -i ${fileName}.pcm -f mp3 -ar 44.1k -ac 2 pipe:1 | ffmpeg -i - -ar 16k -ac 1 ${fileName}.wav`,
                    (err) => {
                        if (err) {
                            console.log(err);
                        }
                    }
                );
                const talk: Talk = {
                    date: new Date().toISOString(),
                    discord_name: client.users.cache.get(userId)?.username!,
                    uuid: uuid,
                };
                talks.add(talk);
                console.log('end');
            });
        });
    }

    if (msg.content.startsWith('!leave')) {
        const connection = getVoiceConnection(msg.guildId!);
        if (!connection) return;
        connection.disconnect();
        const talksArray = Array.from(talks);
        writeFile(
            path.join(dirPath, 'talks.json'),
            JSON.stringify(talksArray),
            (err) => {
                if (err) {
                    console.log(err);
                }
                Array;
            }
        );
    }
});

client.login(process.env.TOKEN);
