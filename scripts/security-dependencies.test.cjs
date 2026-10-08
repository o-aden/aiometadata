const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');

test('security lockfile pins cover direct and nested production packages', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const versions = {
    axios: '1.20.0', compression: '1.8.2', 'ip-address': '10.7.1',
    'proxy-addr': '2.0.8', qs: '6.16.0', sharp: '0.35.5', undici: '8.10.2',
    'cheerio/node_modules/undici': '7.29.1',
  };
  for (const [name, version] of Object.entries(versions)) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version, name);
  }
});

test('patched proxy-addr rejects IPv4 matches against an invalid mapped trust prefix', () => {
  const proxyaddr = require('proxy-addr');
  const mapped = proxyaddr.compile('::ffff:10.0.0.0/8');
  assert.equal(mapped('203.0.113.10'), false);
  const ipv4 = proxyaddr.compile('10.0.0.0/8');
  assert.equal(ipv4('10.1.2.3'), true);
  assert.equal(ipv4('203.0.113.10'), false);
});

test('Express default proxy trust ignores a forged forwarded client address', () => {
  const express = require('express');
  const app = express();
  assert.equal(app.get('trust proxy'), false);
  const req = Object.create(express.request);
  req.app = app;
  req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { 'x-forwarded-for': '203.0.113.10' };
  assert.equal(req.ip, '127.0.0.1');
  const source = fs.readFileSync(path.join(root, 'addon/index.ts'), 'utf8');
  assert.doesNotMatch(source, /^\s*addon\.set\(['"]trust proxy['"]/m);
});

test('the existing CSV parser mode does not enable vulnerable duplicate-column grouping', () => {
  const { parse } = require('csv-parse/sync');
  const [row] = parse('__proto__,__proto__,imdbId\nx,y,tt123\n', { columns: true });
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(row.imdbId, 'tt123');
  const source = fs.readFileSync(path.join(root, 'addon/lib/wiki-mapper.ts'), 'utf8');
  assert.match(source, /parse\(csvData, \{ columns: true \}\)/);
  assert.doesNotMatch(source, /group_columns_by_name\s*:\s*true/);
});

test('patched Sharp retains native image transformation support', async () => {
  const sharp = require('sharp');
  const buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).resize(2, 2).png().toBuffer();
  const info = await sharp(buffer).metadata();
  assert.equal(info.width, 2);
  assert.equal(info.height, 2);
});
