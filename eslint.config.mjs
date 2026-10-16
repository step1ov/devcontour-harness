import tseslint from 'typescript-eslint';

/**
 * Границы пакета — ошибки, а не предупреждения. Harness не зависит от
 * DevContour, Relay и UI: пакет обязан работать, когда их нет на машине.
 */
const foreign = [
  {
    group: ['devcontour', 'devcontour/*', '**/devcontour/src/**', '**/devcontour/lib/**'],
    message: 'Harness не импортирует DevContour: зависимость только в обратную сторону.',
  },
  {
    group: ['relay', 'relay/*', '@relay/*'],
    message: 'Relay подключается через порты, не импортом.',
  },
  {
    group: [
      'react',
      'react-dom',
      'react/*',
      '@radix-ui/*',
      'vite',
      '@vitejs/*',
      'lucide-react',
      '@xyflow/*',
    ],
    message: 'UI-зависимости не входят в runtime harness.',
  },
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'lib/**',
      '.private/**',
      '.idea/**',
      'evidence/**',
      'test-results/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['tests/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: 'test' }] },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: foreign }] },
  },
  {
    // Договоры — лист графа зависимостей: ни движка, ни процессов, ни сети.
    files: ['src/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...foreign,
            {
              group: ['../*', '!../contracts/*'],
              message: 'contracts не зависит от других модулей harness.',
            },
            {
              group: [
                'node:child_process',
                'node:net',
                'node:http',
                'node:https',
                'node:sqlite',
                'node:fs',
              ],
              message: 'Договоры не выполняют процессов, ввода-вывода и сети.',
            },
          ],
        },
      ],
    },
  },
);
