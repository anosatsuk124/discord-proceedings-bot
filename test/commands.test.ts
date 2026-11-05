import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commands } from '../src/commands.ts';

describe('スラッシュコマンド', () => {
    it('/gijiroku start と /gijiroku stop だけを、サーバー内で使えるように登録する', () => {
        assert.equal(commands.length, 1);
        const [command] = commands;
        assert.equal(command?.name, 'gijiroku');
        assert.deepEqual(
            command?.options?.map((option) => option.name),
            ['start', 'stop']
        );
        assert.deepEqual(command?.contexts, [0]); // Guild
        assert.deepEqual(command?.integration_types, [0]); // GuildInstall
    });
});
