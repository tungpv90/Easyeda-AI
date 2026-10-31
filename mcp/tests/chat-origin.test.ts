import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedHost, isAllowedOrigin } from '../src/chat/server';

test('chat daemon accepts EasyEDA, local dev and non-browser clients', () => {
    assert.equal(isAllowedOrigin(undefined), true);
    assert.equal(isAllowedOrigin('https://pro.easyeda.com'), true);
    assert.equal(isAllowedOrigin('https://pro.lceda.cn'), true);
    assert.equal(isAllowedOrigin('http://localhost:4001'), true);
    assert.equal(isAllowedOrigin('app://easyeda'), true);
});

test('chat daemon rejects ordinary web pages', () => {
    assert.equal(isAllowedOrigin('https://evil.example'), false);
    assert.equal(isAllowedOrigin('https://easyeda.com.evil.example'), false);
    assert.equal(isAllowedOrigin('https://noteasyeda.com'), false);
    assert.equal(isAllowedOrigin('null'), false);
    assert.equal(isAllowedOrigin('not a url'), false);
});

test('chat daemon honours extra allowed origins', () => {
    assert.equal(isAllowedOrigin('null', ['null']), true);
    assert.equal(isAllowedOrigin('https://evil.example', ['*']), true);
});

test('chat daemon requires a loopback Host header', () => {
    assert.equal(isAllowedHost('127.0.0.1:8788', 8788), true);
    assert.equal(isAllowedHost('localhost:8788', 8788), true);
    assert.equal(isAllowedHost('attacker.example:8788', 8788), false);
    assert.equal(isAllowedHost(undefined, 8788), false);
});
