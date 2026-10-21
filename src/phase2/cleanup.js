const fs = require("fs");
const path = require("path");

function clearGeneratedFolders(directories) {
  for (const directory of directories) {
    for (const entry of fs.readdirSync(directory)) {
      const entryPath = path.join(directory, entry);
      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
      } catch (error) {
        throw new Error(`Could not clear generated file "${entryPath}".`, {
          cause: error,
        });
      }
    }
  }
}

module.exports = { clearGeneratedFolders };
