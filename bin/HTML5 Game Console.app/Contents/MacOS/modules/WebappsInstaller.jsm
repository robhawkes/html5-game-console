/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

let EXPORTED_SYMBOLS = ["WebappsInstaller"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");

let WebappsInstaller = {
  /**
   * Creates a native installation of the web app in the OS
   *
   * @param aData the manifest data provided by the web app
   *
   * @returns bool true on success, false if an error was thrown
   */
  install: function(aData) {

    try {
      if (Services.prefs.getBoolPref("browser.mozApps.installer.dry_run")) {
        return true;
      }
    } catch (ex) {}

    let shell = new MacNativeApp(aData);

    try {
      shell.install();
    } catch (ex) {
      Cu.reportError("Error installing app: " + ex);
      return null;
    }

    let data = {
      "installDir": shell.installDir.path,
      "app": aData.app
    };
    Services.obs.notifyObservers(null, "webapp-installed", JSON.stringify(data));

    return shell;
  }
}

/**
 * This function implements the common constructor for
 * the Windows, Mac and Linux native app shells. It reads and parses
 * the data from the app manifest and stores it in the NativeApp
 * object. It's meant to be called as NativeApp.call(this, aData)
 * from the platform-specific constructor.
 *
 * @param aData the data object provided by the web app with
 *              all the app settings and specifications.
 *
 */
function NativeApp(aData) {
  let app = this.app = aData.app;

  let origin = Services.io.newURI(app.origin, null, null);

  if (app.manifest.launch_path) {
    this.launchURI = Services.io.newURI(origin.resolve(app.manifest.launch_path),
                                        null, null);
  } else {
    this.launchURI = origin.clone();
  }

  let biggestIcon = getBiggestIconURL(app.manifest.icons);
  try {
    let iconURI = Services.io.newURI(biggestIcon, null, null);
    if (iconURI.scheme == "data") {
      this.iconURI = iconURI;
    }
  } catch (ex) {}

  if (!this.iconURI) {
    try {
      this.iconURI = Services.io.newURI(origin.resolve(biggestIcon), null, null);
    }
    catch (ex) {}
  }

  this.appName = sanitize(app.manifest.name);
  this.appNameAsFilename = stripStringForFilename(this.appName);

  if(app.manifest.developer && app.manifest.developer.name) {
    let devName = app.manifest.developer.name.substr(0, 128);
    devName = sanitize(devName);
    if (devName) {
      this.developerName = devName;
    }
  }

  let shortDesc = this.appName;
  if (app.manifest.description) {
    let firstLine = app.manifest.description.split("\n")[0];
    shortDesc = firstLine.length <= 256
                ? firstLine
                : firstLine.substr(0, 253) + "...";
  }
  this.shortDescription = sanitize(shortDesc);

  // The app registry is the Firefox profile from which the app
  // was installed.
  this.registryFolder = Services.dirsvc.get("ProfD", Ci.nsIFile);

  this.webappJson = {
    "registryDir": this.registryFolder.path,
    "app": app
  };

  this.runtimeFolder = Services.dirsvc.get("GreD", Ci.nsIFile);
}


function MacNativeApp(aData) {
  NativeApp.call(this, aData);
  this._init();
}

MacNativeApp.prototype = {
  _init: function() {
    this.appSupportDir = Services.dirsvc.get("ULibDir", Ci.nsILocalFile);
    this.appSupportDir.append("Application Support");

    let filenameRE = new RegExp("[<>:\"/\\\\|\\?\\*]", "gi");
    this.appNameAsFilename = this.appNameAsFilename.replace(filenameRE, "");
    if (this.appNameAsFilename == "") {
      this.appNameAsFilename = "Webapp";
    }

    // The ${ProfileDir} format is as follows:
    //  host of the app origin + ";" +
    //  protocol + ";" +
    //  port (-1 for default port)
    this.appProfileDir = this.appSupportDir.clone();
    this.appProfileDir.append(this.launchURI.host + ";" +
                              this.launchURI.scheme + ";" +
                              this.launchURI.port);

    this.installDir = Services.dirsvc.get("TmpD", Ci.nsILocalFile);
    this.installDir.append(this.appNameAsFilename + ".app");
    this.installDir.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0755);

    this.contentsDir = this.installDir.clone();
    this.contentsDir.append("Contents");

    this.macOSDir = this.contentsDir.clone();
    this.macOSDir.append("MacOS");

    this.resourcesDir = this.contentsDir.clone();
    this.resourcesDir.append("Resources");

    this.iconFile = this.resourcesDir.clone();
    this.iconFile.append("appicon.icns");
  },

  install: function() {
    this._removeInstallation(true);
    try {
      this._createDirectoryStructure();
      this._copyPrebuiltFiles();
      this._createConfigFiles();
      this._createAppProfile();
    } catch (ex) {
      this._removeInstallation(false);
      throw(ex);
    }

    getIconForApp(this, this._moveToApplicationsFolder);
  },

  _removeInstallation: function(keepProfile) {
    let filesToRemove = [this.installDir];

    if (!keepProfile) {
      filesToRemove.push(this.appProfileDir);
    }

    removeFiles(filesToRemove);
  },

  _createDirectoryStructure: function() {
    if (!this.appProfileDir.exists())
      this.appProfileDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);

    this.contentsDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
    this.macOSDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
    this.resourcesDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
  },

  _createAppProfile: function() {
    let profSvc = Cc["@mozilla.org/toolkit/profile-service;1"]
                    .getService(Ci.nsIToolkitProfileService);

    try {
      this.appProfile = profSvc.createDefaultProfileForApp(this.appProfileDir.leafName,
                                                           null, null);
    } catch (ex if ex.result == Cr.NS_ERROR_ALREADY_INITIALIZED) {}
  },

  _copyPrebuiltFiles: function() {
    let webapprt = this.runtimeFolder.clone();
    webapprt.append("webapprt-stub");
    webapprt.copyTo(this.macOSDir, "webapprt");
  },

  _createConfigFiles: function() {
    // ${ProfileDir}/webapp.json
    let configJson = this.appProfileDir.clone();
    configJson.append("webapp.json");
    writeToFile(configJson, JSON.stringify(this.webappJson), function() {});

    // ${InstallDir}/Contents/MacOS/webapp.ini
    let applicationINI = this.macOSDir.clone().QueryInterface(Ci.nsILocalFile);
    applicationINI.append("webapp.ini");

    let factory = Cc["@mozilla.org/xpcom/ini-processor-factory;1"]
                    .getService(Ci.nsIINIParserFactory);

    let writer = factory.createINIParser(applicationINI).QueryInterface(Ci.nsIINIParserWriter);
    writer.setString("Webapp", "Name", this.appName);
    writer.setString("Webapp", "Profile", this.appProfileDir.leafName);
    writer.writeFile();

    // ${InstallDir}/Contents/Info.plist
    let infoPListContent = '<?xml version="1.0" encoding="UTF-8"?>\n\
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n\
<plist version="1.0">\n\
  <dict>\n\
    <key>CFBundleDevelopmentRegion</key>\n\
    <string>English</string>\n\
    <key>CFBundleDisplayName</key>\n\
    <string>' + escapeXML(this.appName) + '</string>\n\
    <key>CFBundleExecutable</key>\n\
    <string>webapprt</string>\n\
    <key>CFBundleIconFile</key>\n\
    <string>appicon</string>\n\
    <key>CFBundleIdentifier</key>\n\
    <string>' + escapeXML(this.launchURI.prePath) + '</string>\n\
    <key>CFBundleInfoDictionaryVersion</key>\n\
    <string>6.0</string>\n\
    <key>CFBundleName</key>\n\
    <string>' + escapeXML(this.appName) + '</string>\n\
    <key>CFBundlePackageType</key>\n\
    <string>APPL</string>\n\
    <key>CFBundleVersion</key>\n\
    <string>0</string>\n\
    <key>FirefoxBinary</key>\n\
    <string>org.mozilla.b2g</string>\n\
  </dict>\n\
</plist>';

    let infoPListFile = this.contentsDir.clone();
    infoPListFile.append("Info.plist");
    writeToFile(infoPListFile, infoPListContent, function() {});
  },

  _moveToApplicationsFolder: function() {
    let appDir = Services.dirsvc.get("LocApp", Ci.nsILocalFile);
    let destination = getAvailableFile(appDir,
                                       this.appNameAsFilename,
                                       ".app");
    if (!destination) {
      return false;
    }
    this.installDir.moveTo(destination.parent, destination.leafName);
  },

  /**
   * This variable specifies if the icon retrieval process should
   * use a temporary file in the system or a binary stream. This
   * is accessed by a common function in WebappsIconHelpers.js and
   * is different for each platform.
   */
  useTmpForIcon: true,

  /**
   * Process the icon from the imageStream as retrieved from
   * the URL by getIconForApp(). This will bundle the icon to the
   * app package at Contents/Resources/appicon.icns.
   *
   * @param aMimeType     the icon mimetype
   * @param aImageStream  the stream for the image data
   * @param aCallback     a callback function to be called
   *                      after the process finishes
   */
  processIcon: function(aMimeType, aIcon, aCallback) {
    try {
      let process = Cc["@mozilla.org/process/util;1"]
                    .createInstance(Ci.nsIProcess);
      let sipsFile = Cc["@mozilla.org/file/local;1"]
                    .createInstance(Ci.nsILocalFile);
      sipsFile.initWithPath("/usr/bin/sips");

      process.init(sipsFile);
      process.run(true, ["-s",
                  "format", "icns",
                  aIcon.path,
                  "--out", this.iconFile.path,
                  "-z", "128", "128"],
                  9);
    } catch(e) {
      throw(e);
    } finally {
      aCallback.call(this);
    }
  }

}


/* Helper Functions */

/**
 * Async write a data string into a file
 *
 * @param aFile     the nsIFile to write to
 * @param aData     a string with the data to be written
 * @param aCallback a callback to be called after the process is finished
 */
function writeToFile(aFile, aData, aCallback) {
  let ostream = FileUtils.openSafeFileOutputStream(aFile);
  let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                    .createInstance(Ci.nsIScriptableUnicodeConverter);
  converter.charset = "UTF-8";
  let istream = converter.convertToInputStream(aData);
  NetUtil.asyncCopy(istream, ostream, function(x) aCallback(x));
}

/**
 * Removes unprintable characters from a string.
 */
function sanitize(aStr) {
  let unprintableRE = new RegExp("[\\x00-\\x1F\\x7F]" ,"gi");
  return aStr.replace(unprintableRE, "");
}

/**
 * Strips all non-word characters from the beginning and end of a string
 */
function stripStringForFilename(aPossiblyBadFilenameString) {
  //strip everything from the front up to the first [0-9a-zA-Z]

  let stripFrontRE = new RegExp("^\\W*","gi");
  let stripBackRE = new RegExp("\\s*$","gi");

  let stripped = aPossiblyBadFilenameString.replace(stripFrontRE, "");
  stripped = stripped.replace(stripBackRE, "");
  return stripped;
}

/**
 * Finds a unique name available in a folder (i.e., non-existent file)
 *
 * @param aFolder nsIFile that represents the directory where we want to write
 * @param aName   string with the filename (minus the extension) desired
 * @param aExtension string with the file extension, including the dot

 * @return nsILocalFile or null if folder is unwritable or unique name
 *         was not available
 */
function getAvailableFile(aFolder, aName, aExtension) {
  let folder = aFolder.QueryInterface(Ci.nsILocalFile);
  folder.followLinks = false;
  if (!folder.isDirectory() || !folder.isWritable()) {
    return null;
  }

  let file = folder.clone();
  file.append(aName + aExtension);

  if (!file.exists()) {
    return file;
  }

  for (let i = 2; i < 10; i++) {
    file.leafName = aName + " (" + i + ")" + aExtension;
    if (!file.exists()) {
      return file;
    }
  }

  for (let i = 10; i < 100; i++) {
    file.leafName = aName + "-" + i + aExtension;
    if (!file.exists()) {
      return file;
    }
  }

  return null;
}

/**
 * Attempts to remove files or directories.
 *
 * @param aFiles An array with nsIFile objects to be removed
 */
function removeFiles(aFiles) {
  for (let file of aFiles) {
    try {
      if (file.exists()) {
        file.followLinks = false;
        file.remove(true);
      }
    } catch(ex) {}
  }
}

function escapeXML(aStr) {
  return aStr.toString()
             .replace(/&/g, "&amp;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&apos;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;");
}

/* More helpers for handling the app icon */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This function receives a list of icon sizes
 * and URLs and returns the url string for the biggest icon.
 *
 * @param aIcons An object where the keys are the icon sizes
 *               and the values are URL strings. E.g.:
 *               aIcons = {
 *                 "16": "http://www.example.org/icon16.png",
 *                 "32": "http://www.example.org/icon32.png"
 *               };
 *
 * @returns the URL string for the largest specified icon
 */
function getBiggestIconURL(aIcons) {
  if (!aIcons) {
    return "chrome://browser/skin/webapps-64.png";
  }

  let iconSizes = Object.keys(aIcons);
  if (iconSizes.length == 0) {
    return "chrome://browser/skin/webapps-64.png";
  }
  iconSizes.sort(function(a, b) a - b);
  return aIcons[iconSizes.pop()];
}

/**
 * This function retrieves the icon for an app as specified
 * in the iconURI on the shell object.
 * Upon completion it will call aShell.processIcon()
 *
 * @param aShell The shell that specifies the properties
 *               of the native app. Three properties from this
 *               shell will be used in this function:
 *                 - iconURI
 *                 - useTmpForIcon
 *                 - processIcon()
 */
function getIconForApp(aShell, callback) {
  let iconURI = aShell.iconURI;
  let mimeService = Cc["@mozilla.org/mime;1"]
                      .getService(Ci.nsIMIMEService);

  let mimeType;
  try {
    let tIndex = iconURI.path.indexOf(";");
    if("data" == iconURI.scheme && tIndex != -1) {
      mimeType = iconURI.path.substring(0, tIndex);
    } else {
      mimeType = mimeService.getTypeFromURI(iconURI);
    }
  } catch(e) {
    throw("getIconFromURI - Failed to determine MIME type");
  }

  try {
    let listener;
    if(aShell.useTmpForIcon) {
      let downloadObserver = {
        onDownloadComplete: function(downloader, request, cx, aStatus, file) {
          // pass downloader just to keep reference around
          onIconDownloaded(aShell, mimeType, aStatus, file, callback, downloader);
        }
      };

      let tmpIcon = Services.dirsvc.get("TmpD", Ci.nsIFile);
      tmpIcon.append("tmpicon." + mimeService.getPrimaryExtension(mimeType, ""));
      tmpIcon.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0666);

      listener = Cc["@mozilla.org/network/downloader;1"]
                   .createInstance(Ci.nsIDownloader);
      listener.init(downloadObserver, tmpIcon);
    } else {
      let pipe = Cc["@mozilla.org/pipe;1"]
                   .createInstance(Ci.nsIPipe);
      pipe.init(true, true, 0, 0xffffffff, null);

      listener = Cc["@mozilla.org/network/simple-stream-listener;1"]
                   .createInstance(Ci.nsISimpleStreamListener);
      listener.init(pipe.outputStream, {
          onStartRequest: function() {},
          onStopRequest: function(aRequest, aContext, aStatusCode) {
            pipe.outputStream.close();
            onIconDownloaded(aShell, mimeType, aStatusCode, pipe.inputStream, callback);
         }
      });
    }

    let channel = NetUtil.newChannel(iconURI);
    let CertUtils = { };
    Cu.import("resource://gre/modules/CertUtils.jsm", CertUtils);
    // Pass true to avoid optional redirect-cert-checking behavior.
    channel.notificationCallbacks = new CertUtils.BadCertHandler(true);

    channel.asyncOpen(listener, null);
  } catch(e) {
    throw("getIconFromURI - Failure getting icon (" + e + ")");
  }
}

function onIconDownloaded(aShell, aMimeType, aStatusCode, aIcon, aCallback) {
  if (Components.isSuccessCode(aStatusCode)) {
    aShell.processIcon(aMimeType, aIcon, aCallback);
  } else {
    aCallback.call(aShell);
  }
}
