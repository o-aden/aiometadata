const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const logger = new Proxy({}, { get: () => () => {} });
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function functions(file, names) {
  const source = read(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, `${file}: ${name} exists`);
    return node.getText(ast).replace(/^export /, '');
  }).join('\n');
}
function evaluate(source, globals = {}) {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, ...globals });
  vm.runInContext(transpile(source), context);
  return context;
}
function malHarness(mode = 'true', httpReply) {
  const env = { NO_JIKAN: mode, JIKAN_MIN_INTERVAL: '0' };
  let httpCalls = 0;
  const normalizers = new Proxy({}, { get: () => value => value });
  const context = evaluate(read('addon/lib/mal.ts') + '\nmodule.exports._test = { enqueueRequest, _makeJikanRequest, queueSize: () => requestQueue.length };', {
    process: { env }, console, URLSearchParams, setInterval: () => 0, setTimeout: callback => { callback(); return 0; },
    require: id => {
      if (id === 'dotenv') return { config() {} };
      if (id.endsWith('httpClient')) return { httpGet: async () => { httpCalls++; return httpReply ? httpReply(env) : { data: { data: [] }, headers: {} }; } };
      if (id.endsWith('envNumber')) return { envInt: (key, fallback) => Number(env[key] ?? fallback) };
      if (id.endsWith('redisClient')) return null;
      if (id.endsWith('requestTracker')) return logger;
      if (id.endsWith('jikanCacheNormalizers')) return normalizers;
      if (id === 'consola') return { withTag: () => logger };
      if (id === 'undici') return { Agent: class {}, ProxyAgent: class {} };
      if (id === 'fetch-socks') return {};
      if (id.endsWith('getCache')) return { cacheWrapJikanApi: (_key, fn) => fn() };
      throw Error(`Unexpected dependency ${id}`);
    },
  });
  return { api: context.module.exports, env, httpCalls: () => httpCalls };
}
test('no-Jikan rejects before queueing and blocks the HTTP boundary', async () => {
  const h = malHarness();
  await assert.rejects(h.api._test.enqueueRequest(() => assert.fail('task ran'), 'https://example.invalid'), { code: 'JIKAN_DISABLED' });
  await assert.rejects(h.api._test._makeJikanRequest('https://example.invalid'), { code: 'JIKAN_DISABLED' });
  assert.equal(h.api._test.queueSize(), 0);
  assert.equal(h.httpCalls(), 0);
});
test('all exported Jikan operations produce no HTTP in no-Jikan mode', async () => {
  const h = malHarness();
  const args = { searchAnime: ['series', 'test'], getAnimeDetails: [1], getAnimeEpisodes: [1], getAnimeEpisodeVideos: [1], getAnimeCharacters: [1], getAnimeByVoiceActor: [1], getAnimeByGenre: [1], getAnimeGenres: [], getAiringNow: [], getUpcoming: [], getTopAnimeByType: ['tv'], getTopAnimeByFilter: ['bypopularity'], getTopAnimeByDateRange: ['2026-01-01','2026-02-01'], getAiringSchedule: ['monday'], getStudios: [1], getAnimeByStudio: [1], getAnimeBySeason: [2026,'spring'], getAvailableSeasons: [], getSeasonTopRated: [], getSeasonTopNew: [], fetchDiscover: [{}] };
  const exempt = new Set(['_test', 'isJikanDisabled', 'malPageSize', 'getMemoryStats']);
  assert.deepEqual(Object.keys(h.api).filter(key => !exempt.has(key)).sort(), Object.keys(args).sort());
  for (const [name, values] of Object.entries(args)) {
    try { await h.api[name](...values); } catch (error) { assert.equal(error.code, 'JIKAN_DISABLED', name); }
  }
  assert.equal(h.httpCalls(), 0);
  assert.equal(h.api._test.queueSize(), 0);
});
test('disabled switch retains normal HTTP behavior and reads mode per operation', async () => {
  for (const mode of ['false', undefined]) {
    const h = malHarness(mode);
    if (mode === undefined) delete h.env.NO_JIKAN;
    await h.api.getAnimeDetails(1);
    assert.equal(h.httpCalls(), 1);
    h.env.NO_JIKAN = 'true';
    await h.api.getAnimeDetails(2);
    assert.equal(h.httpCalls(), 1);
  }
});
function metaHarness(disabled) {
  let calls = 0;
  const genres = ['Action'];
  const details = { id: '1', attributes: { subtype: 'tv', canonicalTitle: 'Anime', titles: {}, synopsis: 'Description', ageRating: null } };
  const source = functions('addon/lib/getMeta.js', ['getAnimeMeta', 'buildKitsuAnimeResponse', '_markDegraded', 'stampIds']);
  const context = evaluate(source, {
    logger, jikan: { isJikanDisabled: () => disabled, getAnimeDetails: async () => { calls++; return { rating: 'PG-13' }; }, getAnimeCharacters: async () => [], getAnimeEpisodes: async () => [] },
    kitsu: { getMultipleAnimeDetails: async () => ({ data: [details], included: [{ type: 'categories', attributes: { title: 'Action' } }] }) },
    cacheWrapGlobal: (_key, fn) => fn(), cacheWrapJikanApi: (_key, fn) => fn(), CATALOG_TTL: () => 60,
    getAnimeArtwork: async () => ({}), deriveStabilityStamp: () => null,
    Utils: { getKitsuLocalizedTitle: () => 'Anime', parseAnimeGenreLink: () => [], addMetaProviderAttribution: value => value, parseRunTime: () => '', malRatingToCertification: () => 'PG-13' },
  });
  return { context, calls: () => calls, details, genres };
}
test('successful Kitsu metadata keeps genres without Jikan rating enrichment', async () => {
  const h = metaHarness(true);
  const result = await h.context.getAnimeMeta('kitsu', 'kitsu:1', 'en-US', { providers: { anime_id_provider: 'kitsu' } }, 'user', { kitsuId: '1', malId: 1 }, 'series', true, false);
  assert.ok(result);
  assert.equal(result._metaProvider, 'kitsu');
  assert.deepEqual(Array.from(result.genres), ['Action']);
  assert.equal(result.app_extras.certification, null);
  assert.equal(h.calls(), 0);
});
test('failed Kitsu metadata skips MAL and can retain TMDB fallback', async () => {
  const h = metaHarness(true);
  h.context.kitsu.getMultipleAnimeDetails = async () => { throw Error('Kitsu unavailable'); };
  h.context.moviedb = { tvInfo: async () => ({ name: 'TMDB fallback' }) };
  h.context.buildTmdbSeriesResponse = async (_id, data) => data;
  const result = await h.context.getAnimeMeta('kitsu', 'kitsu:1', 'en-US', {}, 'user', { kitsuId: '1', malId: 1, tmdbId: 2 }, 'series', true, false);
  assert.equal(result.name, 'TMDB fallback');
  assert.equal(h.calls(), 0);
});
test('normal mode retains Kitsu MAL rating enrichment', async () => {
  const h = metaHarness(false);
  const result = await h.context.buildKitsuAnimeResponse('kitsu:1', h.details, h.genres, [], [], {}, 'user', { mapping: { malId: 1 } });
  assert.ok(result);
  assert.equal(result.app_extras.certification, 'PG-13');
  assert.equal(h.calls(), 1);
});
test('MAL genre links are suppressed only in no-Jikan mode', () => {
  const context = evaluate(functions('addon/utils/parseProps.js', ['parseAnimeGenreLink']), { process: { env: { HOST_NAME: 'metadata.example' } }, jikan: { isJikanDisabled: () => true } });
  const genres = ['Action'];
  assert.equal(context.parseAnimeGenreLink(genres, 'series', 'user').length, 0);
  assert.deepEqual(genres, ['Action']);
  context.jikan.isJikanDisabled = () => false;
  assert.ok(context.parseAnimeGenreLink(genres, 'series', 'user')[0].url.includes('mal.genres'));
});
test('direct producer API rejects before HTTP or reading request input', async () => {
  const ast = ts.createSourceFile('index.ts', read('addon/index.ts'), ts.ScriptTarget.Latest, true);
  const statement = ast.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.arguments[0]?.text === '/api/mal/discover/search/producer');
  assert.ok(statement);
  const callback = statement.expression.arguments[1].getText(ast);
  const context = evaluate(`const handler = ${callback};`, { jikan: { isJikanDisabled: () => true }, require: () => assert.fail('HTTP dependency loaded') });
  const res = { status(code) { assert.equal(code, 403); return this; }, json(value) { return value; } };
  const result = await vm.runInContext('handler', context)({}, res);
  assert.match(result.error, /NO_JIKAN/);
});
test('AI entity producer resolution is disabled while AniList remains usable', async () => {
  let httpCalls = 0;
  const context = evaluate(functions('addon/utils/ai-catalog-entity-resolver.ts', ['resolveEntities']), { logger,
    require: id => id.endsWith('/mal') ? { isJikanDisabled: () => true } : id.endsWith('/anilist') ? { searchStudios: async () => [{ id: 7, name: 'Studio' }] } : id.endsWith('anilistUtils') ? { getAnilistAccessToken: async () => null } : id.endsWith('httpClient') ? { httpGet: async () => { httpCalls++; assert.fail('Jikan HTTP'); } } : {},
  });
  await context.resolveEntities({ source: 'mal', resolve: { producers: ['Studio'] } }, {});
  assert.equal(httpCalls, 0);
  const result = await context.resolveEntities({ source: 'anilist', resolve: { studios: ['Studio'] } }, {});
  assert.equal(result.resolved.studios, '7');
});
test('deployment preset disables all three warming mechanisms and MAL OAuth is absent', () => {
  const preset = read('deployment/no-jikan.env');
  for (const value of ['NO_JIKAN=true', 'MAL_WARMUP_ENABLED=false', 'ENABLE_CACHE_WARMING=false', 'CACHE_WARMUP_ON_STARTUP=false']) assert.ok(preset.split(/\r?\n/).includes(value));
  assert.doesNotMatch(preset, /^MAL_CLIENT_(ID|SECRET)=/m);
});


test('a 304 refetch rechecks no-Jikan mode before a second HTTP operation', async () => {
  const h = malHarness('false', env => {
    env.NO_JIKAN = 'true';
    return { status: 304, headers: {} };
  });
  await assert.rejects(h.api._test._makeJikanRequest('https://example.invalid'), { code: 'JIKAN_DISABLED' });
  assert.equal(h.httpCalls(), 1);
});

test('normal mode retains the existing MAL fallback when Kitsu is unavailable', async () => {
  const h = metaHarness(false);
  h.context.kitsu.getMultipleAnimeDetails = async () => { throw Error('Kitsu unavailable'); };
  h.context.buildAnimeResponse = async () => ({ name: 'MAL fallback' });
  const result = await h.context.getAnimeMeta('kitsu', 'kitsu:1', 'en-US', {}, 'user', { kitsuId: '1', malId: 1 }, 'series', true, false);
  assert.equal(result.name, 'MAL fallback');
  assert.equal(h.calls(), 1);
});
