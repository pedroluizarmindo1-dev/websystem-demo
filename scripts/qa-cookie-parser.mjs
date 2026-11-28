import assert from 'node:assert/strict';
import {parseCookies} from '../api/cookies.mjs';
const parse=cookie=>parseCookies({headers:{cookie}});
assert.equal(parse('broken=%ZZ; ws_session=abc').ws_session,'abc');
assert.equal(parse('ws_session=a; ws_session=b').ws_session,'');
assert.equal(parse('value=a=b').value,'a=b');
assert.equal(Object.getPrototypeOf(parse('__proto__=x')),null);
assert.equal(parse('').ws_session,undefined);
console.log('COOKIE_PARSER_PASS');
