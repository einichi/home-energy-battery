import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { validateHttpHost } from "../lib/http/host-validation.js";
import { requestHasValidOrigin, requestHostValidation, requestHasPrivateClient } from "../lib/http/server.js";
import { normalizePublicHost } from "../lib/domain/hostname.js";
import { isLoopbackAddress, isPrivateAddress } from "../lib/net/address-classification.js";
import {
  invalidDiscoverySubnets,
  isPrivateDiscoverySubnet,
  normalizePrivateDiscoverySubnets,
} from "../lib/domain/discovery-subnets.js";
import { ipRangeFromCidr, subnetFromHost } from "../lib/services/discovery-protocol.js";

for (const host of [
  "192.168.1.10:8787",
  "10.0.0.10:8787",
  "[fd00::10]:8787",
  "home-energy:8787",
  "home-energy.local:8787",
  "energy.home.arpa:8787",
  "energy.internal:8787",
  "HOME-ENERGY.LOCAL.:8787",
]) {
  assert.equal(validateHttpHost(host).valid, true, `${host} should be accepted`);
}

for (const host of [
  "attacker.example.com:8787",
  "example.com",
  "foo.example.net",
  "host.test",
  "192.168.1.1:99999",
  "999.1.1.1:8787",
  "fd00::10",
  "user@home-energy:8787",
  "home-energy:8787:80",
  "home-energy..local",
  "home-energy.local..",
  "",
]) {
  assert.equal(validateHttpHost(host).valid, false, `${host || "empty Host"} should be rejected`);
}

const matchingPublicOriginRequest = Object.assign(new EventEmitter(), {
  method: "POST",
  headers: {
    host: "attacker.example.com:8787",
    origin: "http://attacker.example.com:8787",
    "sec-fetch-site": "same-origin",
  },
  headersDistinct: { host: ["attacker.example.com:8787"] },
});
assert.equal(requestHasValidOrigin(matchingPublicOriginRequest as any), true);
assert.equal(requestHostValidation(matchingPublicOriginRequest as any).valid, false);

// Host classification is lexical and deliberately independent of DNS results.
assert.equal(validateHttpHost("attacker.example.com:8787").valid, false);
assert.equal(validateHttpHost("xn--bcher-kva.example:8787").valid, false);
assert.equal(validateHttpHost(["home-energy", "attacker.example.com"]).valid, false);

// A publicly-delegated name is accepted only when it is explicitly trusted.
const trustedHosts = new Set(["hems.example.com"]);
assert.equal(validateHttpHost("hems.example.com:8787", { trustedHosts }).valid, true);
assert.equal(validateHttpHost("hems.example.com:8787").valid, false);
assert.equal(validateHttpHost("other.example.com:8787", { trustedHosts }).valid, false);
assert.equal(validateHttpHost("sub.hems.example.com:8787", { trustedHosts }).valid, false);
const trustedResult = validateHttpHost("hems.example.com:8787", { trustedHosts });
assert.equal(trustedResult.valid && trustedResult.trust, "trusted");
const localResult = validateHttpHost("192.168.1.10:8787");
assert.equal(localResult.valid && localResult.trust, "local");
assert.equal(requestHostValidation(Object.assign(new EventEmitter(), {
  method: "GET",
  headers: { host: "hems.example.com:8787" },
  headersDistinct: { host: ["hems.example.com:8787"] },
}) as any, { trustedHosts }).valid, true);

// normalizePublicHost accepts public FQDNs and rejects literals / local names.
assert.equal(normalizePublicHost("HEMS.Example.com."), "hems.example.com");
assert.equal(normalizePublicHost("hems.example.com:443"), null);
assert.equal(normalizePublicHost("hems.local"), null);
assert.equal(normalizePublicHost("192.168.1.10"), null);
assert.equal(normalizePublicHost("singlelabel"), null);
assert.equal(normalizePublicHost(""), null);
assert.equal(normalizePublicHost("evil .example.com"), null);

// Address classification.
for (const address of ["127.0.0.1", "::1", "10.1.2.3", "172.16.5.4", "172.31.255.1", "192.168.0.1", "169.254.1.1", "100.64.0.1", "fd00::1", "fe80::1", "::ffff:192.168.1.1"]) {
  assert.equal(isPrivateAddress(address), true, `${address} should be private`);
}
for (const address of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "193.168.0.1", "100.128.0.1", "2001:4860:4860::8888", "not-an-ip", ""]) {
  assert.equal(isPrivateAddress(address), false, `${address} should not be private`);
}
assert.equal(isLoopbackAddress("127.0.0.1"), true);
assert.equal(isLoopbackAddress("::1"), true);
assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
assert.equal(isLoopbackAddress("192.168.1.1"), false);
assert.equal(isLoopbackAddress("10.0.0.1"), false);

// X-Forwarded-For is consulted only when the socket peer is loopback.
assert.equal(requestHasPrivateClient(Object.assign(new EventEmitter(), {
  socket: { remoteAddress: "::ffff:127.0.0.1" },
  headers: { "x-forwarded-for": "203.0.113.9" },
}) as any), false);
assert.equal(requestHasPrivateClient(Object.assign(new EventEmitter(), {
  socket: { remoteAddress: "127.0.0.1" },
  headers: { "x-forwarded-for": "192.168.1.5" },
}) as any), true);
assert.equal(requestHasPrivateClient(Object.assign(new EventEmitter(), {
  socket: { remoteAddress: "203.0.113.9" },
  headers: {},
}) as any), false);

const acceptedSubnets = [
  "10.0.0.0/24",
  "10.200.14.0/24",
  "172.16.0.0/24",
  "172.31.255.0/24",
  "192.168.1.0/24",
];
const rejectedSubnets = [
  "8.8.8.0/24",
  "172.15.255.0/24",
  "172.32.0.0/24",
  "192.169.1.0/24",
  "127.0.0.0/24",
  "169.254.1.0/24",
  "224.0.0.0/24",
  "10.0.0.1/24",
  "bad",
];
for (const subnet of acceptedSubnets) assert.equal(isPrivateDiscoverySubnet(subnet), true, subnet);
for (const subnet of rejectedSubnets) assert.equal(isPrivateDiscoverySubnet(subnet), false, subnet);
assert.deepEqual(normalizePrivateDiscoverySubnets([...acceptedSubnets, ...rejectedSubnets]), acceptedSubnets);
assert.deepEqual(invalidDiscoverySubnets([...acceptedSubnets, ...rejectedSubnets]), rejectedSubnets);
assert.equal(subnetFromHost("10.22.33.44"), "10.22.33.0/24");
assert.equal(subnetFromHost("10.22.33.999"), null);
assert.equal(subnetFromHost("8.8.8.8"), null);
assert.equal(ipRangeFromCidr("8.8.8.0/24").length, 0);
assert.equal(ipRangeFromCidr("172.16.0.0/24").length, 254);

console.log("Security boundary tests passed");
