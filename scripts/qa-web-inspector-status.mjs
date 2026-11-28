import assert from 'node:assert/strict';
import {isAdminIpGateStatus} from './web-inspector-status.mjs';

for (const status of [404,503]) assert.equal(isAdminIpGateStatus(status),true,`HTTP ${status} must prove the Admin IP Gate blocked the public runner`);
for (const status of [200,201,301,302,401,403,429,500,502]) assert.equal(isAdminIpGateStatus(status),false,`HTTP ${status} must not satisfy the Admin IP Gate probe`);

console.log('WEB_INSPECTOR_IP_GATE_STATUS_PASS');
