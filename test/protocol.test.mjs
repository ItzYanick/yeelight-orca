import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFlowExpression,
  decodeMessages,
  encodeCommand,
  parseDiscoveryResponse,
  sceneFingerprint,
  sceneToCommands,
  toRgbInt
} from '../src/protocol.mjs';

const SEARCH_REPLY = [
  'HTTP/1.1 200 OK',
  'Cache-Control: max-age=3584',
  'Location: yeelight://192.168.1.50:55443',
  'Server: POSIX UPnP/1.0 YGLC/1',
  'id: 0x0000000012345678',
  'model: colorb',
  'fw_ver: 18',
  'support: get_prop set_default set_power toggle set_bright set_scene start_cf stop_cf set_rgb',
  'power: on',
  'bright: 62',
  'name: Desk cube',
  ''
].join('\r\n');

describe('parseDiscoveryResponse', () => {
  it('parses a search reply into a device descriptor', () => {
    const device = parseDiscoveryResponse(SEARCH_REPLY, '192.168.1.50');
    assert.equal(device.id, '0x0000000012345678');
    assert.equal(device.host, '192.168.1.50');
    assert.equal(device.port, 55443);
    assert.equal(device.model, 'colorb');
    assert.equal(device.name, 'Desk cube');
    assert.equal(device.power, 'on');
    assert.ok(device.support.includes('set_scene'));
  });

  it('accepts unsolicited NOTIFY advertisements', () => {
    const notify = SEARCH_REPLY.replace('HTTP/1.1 200 OK', 'NOTIFY * HTTP/1.1');
    assert.equal(parseDiscoveryResponse(notify, '192.168.1.50').host, '192.168.1.50');
  });

  it('rejects non-Yeelight SSDP traffic', () => {
    const foreign = ['HTTP/1.1 200 OK', 'Location: http://192.168.1.9:80/desc.xml', ''].join('\r\n');
    assert.equal(parseDiscoveryResponse(foreign), null);
    assert.equal(parseDiscoveryResponse('garbage', '10.0.0.1'), null);
  });

  it('falls back to the sender address when Location is missing', () => {
    const noLocation = SEARCH_REPLY.replace('Location: yeelight://192.168.1.50:55443\r\n', '');
    const device = parseDiscoveryResponse(noLocation, '192.168.1.77');
    assert.equal(device.host, '192.168.1.77');
    assert.equal(device.port, 55443);
  });
});

describe('wire encoding', () => {
  it('encodes a CRLF-terminated JSON-RPC command', () => {
    assert.equal(
      encodeCommand(7, 'set_power', ['on', 'smooth', 500]),
      '{"id":7,"method":"set_power","params":["on","smooth",500]}\r\n'
    );
  });

  it('decodes whole messages and carries the partial tail forward', () => {
    const { messages, rest } = decodeMessages('{"id":1,"result":["ok"]}\r\n{"id":2,"resu');
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { id: 1, result: ['ok'] });
    assert.equal(rest, '{"id":2,"resu');
  });

  it('skips malformed lines instead of throwing', () => {
    const { messages } = decodeMessages('not json\r\n{"id":3,"result":["ok"]}\r\n');
    assert.deepEqual(messages, [{ id: 3, result: ['ok'] }]);
  });
});

describe('toRgbInt', () => {
  it('accepts hex strings, short hex, triples and integers', () => {
    assert.equal(toRgbInt('#ff0000'), 0xff0000);
    assert.equal(toRgbInt('0f0'), 0x00ff00);
    assert.equal(toRgbInt([0, 0, 255]), 0x0000ff);
    assert.equal(toRgbInt(0x123456), 0x123456);
  });

  it('never emits 0, which the device reads as "unset"', () => {
    assert.equal(toRgbInt('#000000'), 1);
  });
});

describe('buildFlowExpression', () => {
  it('emits duration,mode,value,brightness tuples', () => {
    const expression = buildFlowExpression([
      { duration: 1000, mode: 1, color: '#ff0000', brightness: 100 },
      { duration: 1000, mode: 1, color: '#ff0000', brightness: 20 }
    ]);
    assert.equal(expression, '1000,1,16711680,100,1000,1,16711680,20');
  });

  it('clamps below the 50ms firmware minimum', () => {
    assert.match(buildFlowExpression([{ duration: 5, color: '#ffffff' }]), /^50,1,/);
  });
});

describe('sceneToCommands', () => {
  const support = ['set_power', 'set_scene', 'set_rgb', 'set_bright', 'stop_cf', 'start_cf'];

  it('collapses a solid scene into a single set_scene call', () => {
    const commands = sceneToCommands(
      { power: 'on', color: '#1e6bff', brightness: 70 },
      { support }
    );
    assert.deepEqual(commands, [{ method: 'set_scene', params: ['color', 0x1e6bff, 70] }]);
  });

  it('collapses a flow scene into a single set_scene cf call', () => {
    const commands = sceneToCommands(
      {
        power: 'on',
        flow: { steps: [{ duration: 500, color: '#ff0000', brightness: 100 }], count: 0, action: 0 }
      },
      { support }
    );
    assert.equal(commands.length, 1);
    assert.equal(commands[0].method, 'set_scene');
    assert.equal(commands[0].params[0], 'cf');
  });

  it('falls back to discrete commands when set_scene is unsupported', () => {
    const commands = sceneToCommands(
      { power: 'on', color: '#ffffff', brightness: 50 },
      { support: ['set_power', 'set_rgb', 'set_bright'] }
    );
    assert.deepEqual(
      commands.map((command) => command.method),
      ['set_power', 'set_rgb', 'set_bright']
    );
  });

  it('turns the light off without touching colour', () => {
    assert.deepEqual(sceneToCommands({ power: 'off' }, { support, transitionMs: 400 }), [
      { method: 'set_power', params: ['off', 'smooth', 400] }
    ]);
  });
});

describe('sceneFingerprint', () => {
  it('is stable for equivalent scenes and distinct for different ones', () => {
    const a = { power: 'on', color: '#ff0000', brightness: 80 };
    const b = { power: 'on', color: 'ff0000', brightness: 80 };
    const c = { power: 'on', color: '#ff0000', brightness: 81 };
    assert.equal(sceneFingerprint(a), sceneFingerprint(b));
    assert.notEqual(sceneFingerprint(a), sceneFingerprint(c));
    assert.equal(sceneFingerprint({ power: 'off' }), 'off');
  });
});
