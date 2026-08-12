import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * First lint setup for this workspace (2026-08-12).
 *
 * The `lint` script existed from Phase 0 but eslint was never installed and no
 * config was ever written, so this is a greenfield ruleset applied to a mature
 * codebase. It is deliberately calibrated to catch BUGS rather than to enforce
 * style: a maximalist config on ~51k unlinted lines produces a wall of findings
 * nobody reads, and a gate nobody can get green is a gate that gets deleted.
 *
 * Raise the strictness in follow-ups, once this baseline is green and enforced.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-electron/**",
      "out/**",
      "coverage/**",
      "node_modules/**",
      // Vite/electron-vite/tailwind configs are their own tooling context.
      "*.config.js",
      "*.config.ts",
      "*.config.mjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // tsc owns undefined-symbol detection and does it far better than eslint
      // can without type information. Leaving this on would flag every DOM and
      // Node global, since we do not install the `globals` package.
      "no-undef": "off",

      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // `console.warn`/`console.error` are used deliberately as operator-facing
      // diagnostics — most notably dumpInputsForInspection, which publishes
      // window.__chainpay_debug during testnet smoke sessions. Bare `log` is not.
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  {
    // React rules apply to the renderer only; electron/ is a Node context.
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The high-value pair. This project has already shipped a conditional-hook
      // bug (Phase 2.7c, mainnet-conditional renders) that only manual smoke
      // caught — rules-of-hooks is exactly the gate that would have stopped it.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // NOT enabled: the React Compiler rules that v7 bundles into its presets
      // (immutability, purity, set-state-in-effect, static-components, …).
      // set-state-in-effect in particular would flag PayPanel's two-pass
      // treasury-switch hydration, which is load-bearing and deliberate —
      // a single-pass rewrite encodes the packet against the wrong multisig
      // config. Adopting those rules is a project of its own.
    },
  },

  {
    files: ["**/*.test.{ts,tsx}", "**/*.fixtures.{ts,tsx}"],
    rules: {
      // Test doubles legitimately need shape-forcing that production code must not.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
