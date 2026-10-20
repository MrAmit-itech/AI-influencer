const path = require("path");
const ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

module.exports = { ROOT };
