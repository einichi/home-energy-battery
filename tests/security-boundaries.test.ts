import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { validateHttpHost } from "../lib/http/host-validation.js";
import { requestHasValidOrigin, requestHostValidation } from "../lib/http/server.js";
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
