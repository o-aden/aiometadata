# No-Jikan mode

Set `NO_JIKAN=true` for the pinned Nuvio V1 build. The switch is opt-in and read per operation; omitted or `false` preserves upstream behavior. Use `deployment/no-jikan.env` as the AIOMetadata Compose `env_file`. Do not configure MAL OAuth credentials or connect a MAL account; MAL OAuth tracking is separate from the Jikan transport.

Configure anime metadata and search as Kitsu, anime compatibility IDs as Kitsu, and catalogs as AniList Trending and native AniList Discover. Disable existing MAL catalogs, both MAL search engines, and `malWatchTracking`. No MongoDB, Jikan Redis, Typesense, or Jikan service is needed. Retain AIOMetadata SQLite state and Redis 8+.

Jikan requests are rejected before queueing and checked again at the HTTP boundary, including retries. Direct producer searches are also disabled. Kitsu does not use MAL fallback or MAL rating enrichment. MAL genre links disappear; genre labels remain. Missing ratings and MAL-only metadata/features are unavailable. Numeric cross-provider MAL mapping IDs do not require the MAL API.

Run focused offline regression checks with `node --test scripts/no-jikan.test.cjs`. These exercise pinned source functions with dependency stubs and blocked HTTP, without starting servers or Redis.
