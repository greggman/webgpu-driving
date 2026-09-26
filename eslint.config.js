import gts from 'gts';

export default [
  {ignores: ['dist/', 'build/', 'node_modules/', 'test/', '*.mjs', 'eslint.config.js', '.prettierrc.cjs']},
  ...gts,
];
