import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: ["out/**", "node_modules/**", "resources/**"],
  },
  {
    rules: {
      // Extension host : beaucoup de promesses volontairement non attendues (`void` explicite ailleurs).
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      // Frontière API Git / messages webview : `any` et enums numériques externes.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      // `TreeItem.label` est `string | vscode.TreeItemLabel` — tri volontairement sur chaîne affichable.
      "@typescript-eslint/no-base-to-string": "off",
    },
  }
);
