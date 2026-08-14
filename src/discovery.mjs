/**
 * SSDP discovery for Yeelight devices on the local network.
 *
 * Devices answer an M-SEARCH sent to 239.255.255.250:1982 and also advertise
 * themselves unsolicited, so a single socket bound for the scan window picks up
 * both. Probes are repeated because UDP multicast on a busy Wi-Fi network drops
 * packets freely.
 */

import dgram from 'node:dgram';

import {
  DISCOVERY_MESSAGE,
  YEELIGHT_MULTICAST_ADDR,
  YEELIGHT_MULTICAST_PORT,
  parseDiscoveryResponse
} from './protocol.mjs';

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 4000;

/**
 * Scans for devices and resolves with everything that answered.
 *
 * Never rejects on a network-level failure: on a laptop that has just moved
 * networks — or before macOS has granted Orca local-network access — the right
 * behaviour is "no devices found", not a crashed plugin worker.
 */
export function discoverDevices({
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  probes = 3,
  onDevice,
  log
} = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;
    let probeTimers = [];
    let deadline = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      for (const timer of probeTimers) clearTimeout(timer);
      probeTimers = [];
      if (deadline) clearTimeout(deadline);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve([...found.values()]);
    };

    socket.on('error', (error) => {
      log?.(`discovery socket error: ${error.message}`);
      finish();
    });

    socket.on('message', (buffer, rinfo) => {
      const device = parseDiscoveryResponse(buffer.toString('utf8'), rinfo.address);
      if (!device || found.has(device.id)) return;
      found.set(device.id, device);
      try {
        onDevice?.(device);
      } catch (error) {
        log?.(`discovery callback failed: ${error.message}`);
      }
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.addMembership(YEELIGHT_MULTICAST_ADDR);
      } catch (error) {
        // Joining the group is best-effort: unicast replies to our ephemeral
        // port still arrive, which is enough for the common case.
        log?.(`could not join multicast group: ${error.message}`);
      }

      const send = () => {
        socket.send(
          DISCOVERY_MESSAGE,
          0,
          DISCOVERY_MESSAGE.length,
          YEELIGHT_MULTICAST_PORT,
          YEELIGHT_MULTICAST_ADDR,
          (error) => {
            if (error) log?.(`discovery probe failed: ${error.message}`);
          }
        );
      };

      const spacing = Math.max(200, Math.floor(timeoutMs / (probes + 1)));
      for (let i = 0; i < probes; i++) {
        probeTimers.push(setTimeout(send, i * spacing));
      }

      deadline = setTimeout(finish, timeoutMs);
    });
  });
}
