const path = require("node:path");
const { tests } = require("@iobroker/testing");

// Run the adapter startup test with an actual ioBroker instance.
tests.integration(path.join(__dirname, ".."));
