import globals from "globals";
import pluginJs from "@eslint/js";

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ["node_modules/**", "coverage/**", "octokit.js"] },
  // Scoped, not global. Without a `files` key this entry applies to every file, the dashboard's
  // scripts included, and no-undef then stops flagging `process`, `require` or `Buffer` in code
  // that runs in a browser and has none of them.
  {
    files: ["src/**/*.js", "jobs/**/*.js", "scripts/**/*.mjs", "test/**/*.js", "test-support/**/*.js", "*.js"],
    languageOptions: { globals: globals.node },
  },
  // The dashboard's scripts. They live in views/ beside the templates rather than under public/,
  // because they are served through the same gate the page is - see src/index.js. `Dash` is the
  // one global they share, defined by views/dashboard/core.js before any of the others runs, and
  // `Chart` the one they are given: Chart.js, served from node_modules/ ahead of core.js.
  {
    files: ["views/**/*.js"],
    languageOptions: { globals: { ...globals.browser, Dash: "readonly", Chart: "readonly" } },
  },
  pluginJs.configs.recommended,
  // Formatting rules, every one of them already true of this tree - they lock in what review
  // has been enforcing by hand, they do not impose anything new. All are deprecated in core
  // since 8.53 and still ship in 10.9.1; the major that removes them will fail this lint with
  // "Definition for rule ... was not found", and the answer then is @stylistic/eslint-plugin.
  {
    rules: {
      semi: ["error", "always"],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      indent: ["error", 2, { SwitchCase: 1 }],
      curly: ["error", "multi-line"],
      "dot-notation": "error",
      "object-curly-spacing": ["error", "always"],
      // named: "never" - `function handleGetDashboard(req, res)` is what every named function
      // here does. The default is "always", which would reformat every one of them the wrong way.
      "space-before-function-paren": ["error", { anonymous: "always", named: "never", asyncArrow: "always" }],
      "no-trailing-spaces": "error",
      "no-else-return": "error",
      "no-lonely-if": "error",
      "no-useless-concat": "error",
      "arrow-parens": ["error", "always"],
      "object-shorthand": ["error", "always"],
      "prefer-template": "error",
      "eol-last": ["error", "always"],
      "quote-props": ["error", "as-needed"],
      // Spelled out rather than "always-multiline": the shorthand also demands a trailing
      // comma in multi-line call arguments, 98 further edits this repo consistently omits.
      "comma-dangle": ["error", {
        arrays: "always-multiline", objects: "always-multiline",
        imports: "always-multiline", exports: "always-multiline", functions: "never",
      }],
    },
  },
];
