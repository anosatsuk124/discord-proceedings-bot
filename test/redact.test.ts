import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactVoiceSecrets } from '../src/bot.ts';

describe('redactVoiceSecrets', () => {
    it('音声接続のトークンと暗号鍵を伏せる', () => {
        const message =
            '>> {"op":0,"d":{"server_id":"1","session_id":"s","token":"abc.def"}} ' +
            '<< {"op":4,"d":{"mode":"aead_aes256_gcm_rtpsize","secret_key":[1,2,3],"dave_protocol_version":1}}';
        const redacted = redactVoiceSecrets(message);
        assert.doesNotMatch(redacted, /abc\.def|\[1,2,3\]/);
        assert.match(redacted, /"token":"<redacted>"/);
        assert.match(redacted, /"secret_key":"<redacted>"/);
        assert.match(redacted, /dave_protocol_version/);
    });
});
