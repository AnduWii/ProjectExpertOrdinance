'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInput } = require('../../src/main/url');

const DDG = 'https://duckduckgo.com/?q=';

const cases = [
  ['example.com', 'https://example.com/'],
  ['  example.com/path?q=1  ', 'https://example.com/path?q=1'],
  ['https://example.com', 'https://example.com/'],
  ['http://example.com:8080/a', 'http://example.com:8080/a'],
  ['localhost', 'http://localhost/'],
  ['localhost:3000/app', 'http://localhost:3000/app'],
  ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
  ['[::1]:8080', 'http://[::1]:8080/'],
  ['sub.domain.co.uk', 'https://sub.domain.co.uk/'],
  ['file:///tmp/a.html', 'file:///tmp/a.html'],
  ['about:blank', 'about:blank'],
  ['hello world', DDG + 'hello%20world'],
  ['electron', DDG + 'electron'],
  ['what is 2.5', DDG + 'what%20is%202.5'],
  ['c++ & rust?', DDG + 'c%2B%2B%20%26%20rust%3F'],
  ['999.1.1.1', DDG + '999.1.1.1'],
  ['javascript://alert(1)', DDG + 'javascript%3A%2F%2Falert(1)'],
  ['javascript:alert(1)', DDG + 'javascript%3Aalert(1)'],
  ['-bad-.com', DDG + '-bad-.com'],
];

for (const [input, expected] of cases) {
  test(`normalizeInput(${JSON.stringify(input)})`, () => {
    assert.equal(normalizeInput(input), expected);
  });
}

test('empty input returns null', () => {
  assert.equal(normalizeInput('   '), null);
  assert.equal(normalizeInput(undefined), null);
});

test('custom search engine base is respected', () => {
  assert.equal(normalizeInput('cats', 'https://search.example/?s='), 'https://search.example/?s=cats');
});
