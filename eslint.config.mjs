import tseslint from 'typescript-eslint'

export default tseslint.config({
  ignores: ['vendor/**', '**/node_modules/**', '**/dist/**', '**/target/**', 'artifacts/**', 'packages/*/lib/**'],
}, {
  files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
  languageOptions: { parser: tseslint.parser },
})
