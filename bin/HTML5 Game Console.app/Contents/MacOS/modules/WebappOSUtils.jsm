/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Cc = Components.classes;
const Ci = Components.interfaces;
const CC = Components.Constructor;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");

let EXPORTED_SYMBOLS = ["WebappOSUtils"];

let WebappOSUtils = {
  launch: function(aData) {
    let mwaUtils = Cc["@mozilla.org/widget/mac-web-app-utils;1"]
                    .createInstance(Ci.nsIMacWebAppUtils);
    let appPath;
    try {
      appPath = mwaUtils.pathForAppWithIdentifier(aData.origin);
    } catch (e) {}

    if (appPath) {
      mwaUtils.launchAppWithIdentifier(aData.origin);
      return true;
    }

    return false;
  },

  uninstall: function(aData) {
  }
}
