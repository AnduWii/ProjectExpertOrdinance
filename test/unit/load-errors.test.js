'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeLoadError } = require('../../src/main/window');

test('error pages say who blocked a page: extension, administrator, network filter, proxy, certificate', () => {
  assert.match(describeLoadError(-20, 'ERR_BLOCKED_BY_CLIENT').detail, /An extension blocked this page/);
  assert.equal(describeLoadError(-20, 'ERR_BLOCKED_BY_CLIENT').heading, 'This page was blocked');
  assert.match(describeLoadError(-22, 'ERR_BLOCKED_BY_ADMINISTRATOR').detail, /manages this computer/);
  assert.match(describeLoadError(-105, 'ERR_NAME_NOT_RESOLVED').detail, /web filter/);
  assert.match(describeLoadError(-130, 'ERR_PROXY_CONNECTION_FAILED').detail, /proxy/);
  assert.equal(describeLoadError(-202, 'ERR_CERT_AUTHORITY_INVALID').heading, 'Your connection is not private');
  assert.equal(describeLoadError(-102, 'ERR_CONNECTION_REFUSED').heading, "Can't reach this page");
  assert.match(describeLoadError(-102, 'ERR_CONNECTION_REFUSED').detail, /ERR_CONNECTION_REFUSED \(-102\)$/);
  assert.deepEqual(describeLoadError(-999, 'ERR_SOMETHING'), { heading: "Can't reach this page", detail: 'ERR_SOMETHING (-999)' });
});
