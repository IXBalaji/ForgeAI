import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

export default [
  {
    ignores: [".next/**", "node_modules/**"],
    rules: {
      "react/no-unescaped-entities": "off",
      "@typescript-eslint/triple-slash-reference": "off",
      "import/no-anonymous-default-export": "off",
    },
  },
  ...compat.extends("next/core-web-vitals", "next/typescript", "plugin:jsx-a11y/recommended"),
];
