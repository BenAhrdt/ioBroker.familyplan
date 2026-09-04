import config from "@iobroker/eslint-config";
export default [
  {
    ignores: [
      "build/",
      ".dev-server/",
      "node_modules/",
      "test/**/*.js",
      "**/adapter-config.d.ts",
    ],
  },
  ...config,
  {
    rules: {
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-param": "off",
      "jsdoc/no-blank-blocks": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
];
