import { PROTOCOL_VERSION, PacketType } from './constants';
import { Envelope } from './envelope';

export const DEVICE_A = '0102030405060708090a0b0c0d0e0f10';
export const DEVICE_B = 'f0e0d0c0b0a090807060504030201000';
export const MESSAGE_1 = 'aaaabbbbccccddddeeeeffff00001111';

export const PING_A_TO_B: Envelope = {
  v: PROTOCOL_VERSION,
  type: PacketType.TEST_PING,
  id: MESSAGE_1,
  from: DEVICE_A,
  to: DEVICE_B,
  seq: 0,
  ts: 1700000000000,
  payload: 'phase0-ping',
};

/**
 * Golden bytes for PING_A_TO_B. A change here means the wire format changed and
 * older builds can no longer decode newer frames.
 */
export const PING_A_TO_B_CANONICAL =
  '{"v":1,"type":"TEST_PING","id":"aaaabbbbccccddddeeeeffff00001111",' +
  '"from":"0102030405060708090a0b0c0d0e0f10",' +
  '"to":"f0e0d0c0b0a090807060504030201000",' +
  '"seq":0,"ts":1700000000000,"payload":"phase0-ping"}';
