// Pin the timezone for the test process so local-time logic (rate bands,
// schedule "due" checks, daily history boundaries) is deterministic on any
// host or CI runner. This only stabilizes the tests; it does not change how
// the application resolves TZ at runtime (still the TZ environment variable).
process.env.TZ = "Asia/Tokyo";
