'use strict';

/**
 * The browser was renamed from "Ordinance Browser" to "Chrome2", which moves
 * its profile folder (Electron names it after the product). Carry the old
 * profile over so bookmarks, history, extensions and logins survive.
 */

const fs = require('node:fs');
const path = require('node:path');

const LEGACY_NAMES = ['Ordinance Browser'];

// Files that only exist once a profile has actually been used.
const PROFILE_MARKERS = ['settings.json', 'bookmarks.json', 'history.json', 'Partitions'];

const isUsedProfile = (dir) => PROFILE_MARKERS.some((f) => fs.existsSync(path.join(dir, f)));

/**
 * Move a legacy profile into `currentDir` if `currentDir` has not been used yet.
 * @returns {string|null} the legacy folder that was migrated, or null
 */
function migrateLegacyProfile(appDataDir, currentDir, legacyNames = LEGACY_NAMES) {
  if (fs.existsSync(currentDir) && isUsedProfile(currentDir)) return null;
  for (const name of legacyNames) {
    const legacy = path.join(appDataDir, name);
    if (path.resolve(legacy) === path.resolve(currentDir) || !fs.existsSync(legacy) || !isUsedProfile(legacy)) continue;
    fs.mkdirSync(currentDir, { recursive: true });
    for (const entry of fs.readdirSync(legacy)) {
      const target = path.join(currentDir, entry);
      if (fs.existsSync(target)) continue; // keep anything the new profile already has
      fs.renameSync(path.join(legacy, entry), target);
    }
    // Leave a pointer so it is obvious where the data went.
    try {
      fs.writeFileSync(path.join(legacy, 'MOVED.txt'), `This profile was moved to ${currentDir}\n`);
    } catch {
      /* read-only legacy folder: not important */
    }
    return legacy;
  }
  return null;
}

module.exports = { migrateLegacyProfile, LEGACY_NAMES };
