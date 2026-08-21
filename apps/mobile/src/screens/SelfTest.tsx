import {
  acceptInbound,
  getSelfDevice,
  markProcessed,
  nextLocalSeq,
} from '@rcn/core';
import {
  associatedData,
  decodeEnvelope,
  deriveSessionKey,
  deviceIdFromIdentityKey,
  encodeEnvelope,
  fromBase64,
  generateAgreementKeyPair,
  openPayload,
  pairingTranscript,
  sealPayload,
  shortAuthenticationString,
  toBase64,
  utf8Decode,
  utf8Encode,
  PROTOCOL_VERSION,
  PacketType,
  type DeviceId,
} from '@rcn/protocol';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { ensureIdentity, seal, sign, unseal } from '../../../../modules/rcn-identity';
import { randomBytes } from '../engine/identity';
import { AppState } from '../state/useApp';
import { Button, Card } from '../ui/components';
import { colors, styles } from '../ui/theme';

/**
 * On-device self-test.
 *
 * Everything below is verified in Node except the parts that cannot be: the
 * Keystore, and how the pure code behaves under Hermes rather than V8. Phase 0
 * demonstrated that a clean build and a green Node suite say nothing about
 * either, so this runs the same checks on the hardware and reports layer by
 * layer.
 *
 * The point is to make a failure locatable. "Sealing failed" is a fact you can
 * act on; "the app does not work" is an evening of bisecting.
 */

type Result = { name: string; ok: boolean; detail: string };

export function SelfTest(props: { app: AppState; onBack: () => void }) {
  const { app } = props;
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    const out: Result[] = [];
    const check = async (name: string, fn: () => Promise<string> | string) => {
      try {
        out.push({ name, ok: true, detail: await fn() });
      } catch (error) {
        out.push({ name, ok: false, detail: (error as Error).message });
      }
      setResults([...out]);
    };

    await check('Random bytes', () => {
      const a = randomBytes(32);
      const b = randomBytes(32);
      if (a.length !== 32) throw new Error(`expected 32 bytes, got ${a.length}`);
      if (toBase64(a) === toBase64(b)) throw new Error('two draws were identical');
      return '32 bytes, distinct across draws';
    });

    await check('UTF-8 codec under Hermes', () => {
      const sample = 'ligtas ako 🚨 ñ 中文';
      if (utf8Decode(utf8Encode(sample)) !== sample) throw new Error('round trip changed the text');
      return 'round trips including emoji and accents';
    });

    await check('Base64 codec under Hermes', () => {
      const data = Uint8Array.from({ length: 91 }, (_, i) => (i * 7) & 0xff);
      if (toBase64(fromBase64(toBase64(data))) !== toBase64(data)) {
        throw new Error('round trip changed the bytes');
      }
      return '91-byte round trip matches';
    });

    await check('Keystore identity', async () => {
      const identity = await ensureIdentity();
      const again = await ensureIdentity();
      if (toBase64(identity.publicKeyDer) !== toBase64(again.publicKeyDer)) {
        throw new Error('a second call returned a different key');
      }
      return `${identity.securityLevel}, ${identity.publicKeyDer.length}-byte SPKI`;
    });

    await check('Keystore signing', async () => {
      const sig = await sign(utf8Encode('hudyat self test'));
      if (sig.length < 32) throw new Error(`signature looks wrong: ${sig.length} bytes`);
      return `${sig.length}-byte ECDSA signature`;
    });

    await check('Keystore sealing', async () => {
      const secret = randomBytes(32);
      const sealed = await seal(secret);
      const opened = await unseal(sealed);
      if (toBase64(opened) !== toBase64(secret)) throw new Error('unsealed value did not match');
      if (toBase64(sealed) === toBase64(secret)) throw new Error('sealed value equals plaintext');
      return `${secret.length} bytes sealed to ${sealed.length} and recovered`;
    });

    await check('Sealing is non-deterministic', async () => {
      const secret = randomBytes(32);
      const a = await seal(secret);
      const b = await seal(secret);
      // Identical output for identical input would mean a fixed GCM nonce,
      // which breaks the cipher outright.
      if (toBase64(a) === toBase64(b)) throw new Error('the same input sealed to the same bytes');
      return 'same input produces different sealed bytes';
    });

    await check('Device id derivation', async () => {
      const identity = await ensureIdentity();
      const id = deviceIdFromIdentityKey(identity.publicKeyDer);
      if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`malformed id: ${id}`);
      const stored = app.db !== null ? getSelfDevice(app.db)?.device_id : undefined;
      if (stored !== undefined && stored !== id) {
        throw new Error('stored identity does not match the hardware key');
      }
      return id;
    });

    await check('Key agreement', () => {
      const a = generateAgreementKeyPair(randomBytes);
      const b = generateAgreementKeyPair(randomBytes);
      const nonce = randomBytes(16);
      const idA = 'a'.repeat(32) as DeviceId;
      const idB = 'b'.repeat(32) as DeviceId;
      const ka = deriveSessionKey({
        ownAgreementPrivate: a.privateKey,
        peerAgreementPublic: b.publicKey,
        invitationNonce: nonce,
        aDeviceId: idA,
        bDeviceId: idB,
      });
      const kb = deriveSessionKey({
        ownAgreementPrivate: b.privateKey,
        peerAgreementPublic: a.publicKey,
        invitationNonce: nonce,
        aDeviceId: idA,
        bDeviceId: idB,
      });
      if (toBase64(ka) !== toBase64(kb)) throw new Error('the two sides derived different keys');
      return 'both sides reached the same 32-byte key';
    });

    await check('Encrypt and decrypt', () => {
      const key = randomBytes(32);
      const header = {
        v: PROTOCOL_VERSION,
        type: PacketType.MESSAGE,
        id: 'a'.repeat(32) as never,
        from: 'a'.repeat(32) as DeviceId,
        to: 'b'.repeat(32) as DeviceId,
        seq: 1,
        ts: Date.now(),
      };
      const aad = associatedData(header);
      const sealed = sealPayload({ sessionKey: key, plaintext: 'ligtas ako', aad, randomBytes });
      const opened = utf8Decode(openPayload({ sessionKey: key, sealed, aad }));
      if (opened !== 'ligtas ako') throw new Error('decrypted text did not match');
      return 'sealed and opened with authenticated header';
    });

    await check('Tampering is rejected', () => {
      const key = randomBytes(32);
      const header = {
        v: PROTOCOL_VERSION,
        type: PacketType.MESSAGE,
        id: 'a'.repeat(32) as never,
        from: 'a'.repeat(32) as DeviceId,
        to: 'b'.repeat(32) as DeviceId,
        seq: 1,
        ts: Date.now(),
      };
      const sealed = sealPayload({
        sessionKey: key,
        plaintext: 'private',
        aad: associatedData(header),
        randomBytes,
      });
      // Redirecting the message to a different device must fail the tag.
      const redirected = associatedData({ ...header, to: 'c'.repeat(32) as DeviceId });
      try {
        openPayload({ sessionKey: key, sealed, aad: redirected });
      } catch {
        return 'a redirected message fails authentication';
      }
      throw new Error('a redirected message was accepted');
    });

    await check('Envelope encoding', () => {
      const envelope = {
        v: PROTOCOL_VERSION,
        type: PacketType.MESSAGE,
        id: 'a'.repeat(32) as never,
        from: 'a'.repeat(32) as DeviceId,
        to: 'b'.repeat(32) as DeviceId,
        seq: 7,
        ts: 1234,
        payload: 'x',
      };
      const decoded = decodeEnvelope(encodeEnvelope(envelope));
      if (decoded.seq !== 7) throw new Error('sequence did not survive the round trip');
      return 'encode and decode agree';
    });

    await check('Verification digits', () => {
      const a = generateAgreementKeyPair(randomBytes);
      const b = generateAgreementKeyPair(randomBytes);
      const t = pairingTranscript({
        familyId: 'f',
        invitationNonce: randomBytes(16),
        a: { deviceId: 'a'.repeat(32) as DeviceId, identityKey: randomBytes(8), agreementKey: a.publicKey },
        b: { deviceId: 'b'.repeat(32) as DeviceId, identityKey: randomBytes(8), agreementKey: b.publicKey },
      });
      const sas = shortAuthenticationString(t);
      if (!/^[0-9]{6}$/.test(sas)) throw new Error(`malformed digits: ${sas}`);
      return `six digits produced (${sas})`;
    });

    await check('Database and migrations', () => {
      if (app.db === null) throw new Error('the database is not open');
      const row = app.db.get<{ user_version: number }>('PRAGMA user_version');
      const fk = app.db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
      if (fk?.foreign_keys !== 1) throw new Error('foreign keys are not enforced');
      return `schema v${row?.user_version ?? 0}, foreign keys on`;
    });

    await check('Sequence survives restart', () => {
      if (app.db === null) throw new Error('the database is not open');
      if (app.self === null) throw new Error('this device has no identity yet');
      const a = nextLocalSeq(app.db, app.self.deviceId);
      const b = nextLocalSeq(app.db, app.self.deviceId);
      if (b !== a + 1) throw new Error(`counter did not advance: ${a} then ${b}`);
      return `allocated ${a} then ${b} from the database`;
    });

    await check('Duplicate suppression', () => {
      if (app.db === null) throw new Error('the database is not open');
      const id = `selftest-${Date.now()}`;
      const first = markProcessed(app.db, { messageId: id, fromDevice: 'x', now: Date.now() });
      const second = markProcessed(app.db, { messageId: id, fromDevice: 'x', now: Date.now() });
      if (!first || second) throw new Error('a repeated message id was not suppressed');
      return 'a repeated message id is refused';
    });

    await check('Untrusted sender is refused', () => {
      // Name the missing piece. "not ready" sent me looking at the wrong layer.
      if (app.db === null) throw new Error('the database is not open');
      if (app.self === null) throw new Error('this device has no identity yet');
      if (app.family === null) throw new Error('no family exists on this device yet');
      const outcome = acceptInbound({
        db: app.db,
        messageId: `selftest-untrusted-${Date.now()}`,
        fromDevice: 'f'.repeat(32),
        toDevice: app.self.deviceId,
        seq: 1,
        kind: 'TEXT',
        body: 'x',
        familyId: app.family.family_id,
        conversationId: 'selftest',
        now: Date.now(),
      });
      if (outcome.kind !== 'UNTRUSTED') throw new Error(`expected UNTRUSTED, got ${outcome.kind}`);
      return 'a message from an unknown device is refused';
    });

    setRunning(false);
  };

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Self-test</Text>
      <Text style={styles.dim}>
        Checks the parts that can only be verified on a real phone: secure key storage, and how the
        cryptography behaves on this device's JavaScript engine.
      </Text>

      <Button label={running ? 'Running…' : 'Run self-test'} onPress={() => void run()} busy={running} />

      {results.length > 0 && (
        <Card>
          <Text style={{ color: failed === 0 ? colors.delivered : colors.rejected, fontSize: 17, fontWeight: '600' }}>
            {passed} passed{failed > 0 ? `, ${failed} failed` : ''}
          </Text>
        </Card>
      )}

      {results.map((r) => (
        <View
          key={r.name}
          style={[styles.card, { borderColor: r.ok ? colors.border : colors.rejected }]}
        >
          <View style={styles.spread}>
            <Text style={styles.body}>{r.name}</Text>
            <Text style={{ color: r.ok ? colors.delivered : colors.rejected, fontWeight: '600' }}>
              {r.ok ? 'PASS' : 'FAIL'}
            </Text>
          </View>
          <Text style={r.ok ? styles.dim : { color: colors.rejected, fontSize: 13 }}>{r.detail}</Text>
        </View>
      ))}

      <Button label="Back" variant="quiet" onPress={props.onBack} />
    </ScrollView>
  );
}
