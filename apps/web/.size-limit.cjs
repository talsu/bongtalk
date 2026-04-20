/**
 * Bundle budgets, enforced by CI. Numbers reflect gzipped size.
 * Using `@size-limit/file` (not preset-app) because we can't ship a
 * headless Chrome on the Synology build host; we only need the byte
 * budget, not runtime timings.
 */
module.exports = [
  {
    name: 'initial entry + shell',
    path: 'dist/assets/index-*.js',
    limit: '200 KB',
    gzip: true,
  },
  {
    name: 'Shell chunk',
    path: 'dist/assets/Shell-*.js',
    limit: '80 KB',
    gzip: true,
  },
  {
    name: 'vendor-react',
    path: 'dist/assets/vendor-react-*.js',
    limit: '55 KB',
    gzip: true,
  },
  {
    name: 'vendor-radix',
    path: 'dist/assets/vendor-radix-*.js',
    limit: '70 KB',
    gzip: true,
  },
  {
    name: 'vendor-query',
    path: 'dist/assets/vendor-query-*.js',
    limit: '35 KB',
    gzip: true,
  },
  {
    name: 'vendor-socket',
    path: 'dist/assets/vendor-socket-*.js',
    limit: '30 KB',
    gzip: true,
  },
];
