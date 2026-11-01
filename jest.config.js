const { jestConfig } = require("@salesforce/sfdx-lwc-jest/config");

module.exports = {
  ...jestConfig,
  moduleNameMapper: {
    ...(jestConfig.moduleNameMapper || {}),
    // Composants de base sans bouchon dans sfdx-lwc-jest
    "^lightning/modal$": "<rootDir>/jest-mocks/lightning/modal"
  },
  setupFiles: [
    ...(jestConfig.setupFiles || []),
    "<rootDir>/jest-mocks/setup.js"
  ],
  modulePathIgnorePatterns: ["<rootDir>/.localdevserver"],
  // Les doublons iCloud (« fichier 2.js ») ne sont jamais des tests
  testPathIgnorePatterns: [
    ...(jestConfig.testPathIgnorePatterns || ["/node_modules/"]),
    " 2\\.js$"
  ]
};
