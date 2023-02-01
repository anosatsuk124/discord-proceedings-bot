import { Client, ClientOptions, GatewayIntentBits, Partials } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { createWriteStream, writeFile } from 'fs';
import { opus } from 'prism-media';
import pathToFfmpeg from 'ffmpeg-static';
import { exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { config } from 'dotenv';
config();

if (!process.argv[1]) {
    console.log('Please provide a directory path to store the files');
    process.exit(1);
}

const path = process.argv[1];

interface Talk {
    [key: string]: {
        data: Date;
        id: string;
    };
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

client.on('messageCreate', (msg) => {
    const idDateMap = new Map<string, Date>();
    if (msg.author.bot) return;
    if (msg.content.startsWith('!join')) {
        const talks: Talk[] = [];
        const channel = msg.member?.voice.channel;
        const connection = joinVoiceChannel({
            channelId: channel?.id!,
            guildId: channel?.guildId!,
            adapterCreator: channel?.guild.voiceAdapterCreator!,
            selfDeaf: false,
        });
        connection.dispatchAudio();
        const receiver = connection.receiver;

        receiver.speaking.addListener('start', async (userId) => {
            console.log('start');
            console.log(userId);
            const stream = receiver.subscribe(userId);
            const uuid = uuidv4();
            const fileName = `${path}/${uuid}`;
            const talk: Talk = {
                uuid: {
                    data: new Date(),
                    id: userId,
                },
            };
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
            receiver.speaking.addListener('end', (endUserId) => {
                if (userId !== endUserId) return;
                exec(
                    `${pathToFfmpeg} -y -f s16le -ar 44.1k -ac 2 -i "${fileName}.pcm" "${fileName}.mp3"`,
                    (err) => {
                        if (err) {
                            console.log(err);
                        }
                    }
                );
                exec(`rm "${fileName}.pcm"`);
                talks.push(talk);
                console.log('end');
            });
        });

        if (msg.content.startsWith('!leave')) {
            connection.disconnect();
            writeFile(`${path}/talks.json`, JSON.stringify(talks), (err) => {
                if (err) {
                    console.log(err);
                }
            });
        }
    }
});

client.login(process.env.TOKEN);
