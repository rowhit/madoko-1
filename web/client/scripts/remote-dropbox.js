/*---------------------------------------------------------------------------
  Copyright 2013 Microsoft Corporation.
 
  This is free software; you can redistribute it and/or modify it under the
  terms of the Apache License, Version 2.0. A copy of the License can be
  found in the file "license.txt" at the root of this distribution.
---------------------------------------------------------------------------*/

define(["../scripts/promise","../scripts/util","../scripts/oauthRemote"], 
        function(Promise,Util,OAuthRemote) {

var dropbox = new OAuthRemote( {
  name         : "dropbox",
  defaultDomain: "https://api.dropbox.com/1/",
  accountUrl   : "account/info",
  loginUrl     : "https://www.dropbox.com/1/oauth2/authorize",
  loginParams  : {
    client_id: "3vj9witefc2z44w",
  },
  logoutUrl    : "https://www.dropbox.com/logout",
  logoutTimeout: 500,
});


/* ----------------------------------------------
  Basic file API
---------------------------------------------- */
var longTimeout = 60000; // 1 minute for pull or push content
var root        = "dropbox";
var contentUrl  = "https://api-content.dropbox.com/1/files/" + root + "/";
var pushUrl     = "https://api-content.dropbox.com/1/files_put/" + root + "/";
var metadataUrl = "https://api.dropbox.com/1/metadata/" + root + "/";
var fileopsUrl  = "https://api.dropbox.com/1/fileops/";
var sharesUrl   = "https://api.dropbox.com/1/shares/" + root + "/";
var sharedFoldersUrl = "https://api.dropbox.com/1/shared_folders/";

function encodeURIPath(s) {
  var p = escape(s);
  return p.replace(/%2F/g,"/");
}


function addPathInfo(info) {
  return dropbox.withUserId( function(uid) {
    info.globalPath = "//dropbox/unshared/" + uid + info.path;
    if (!info.parent_shared_folder_id) return info;
    // shared
    return sharedFolderInfo(info.parent_shared_folder_id).then( function(sinfo) {  // this is cached
      if (sinfo || Util.startsWith(info.path,sinfo.path + "/")) {
        info.sharedPath = "//dropbox/shared/" + sinfo.shared_folder_id + "/" + sinfo.shared_folder_name + "/" + info.path.substr(sinfo.path.length + 1);
        info.globalPath = info.sharedPath; // use the shared path
      }      
      return info;
    }, function(err) {
      Util.message( new Error("dropbox: could not get shared info: " + (err.message || err)), Util.Msg.Error );
      return info;
    });
  });
}

function pullFile(fname,binary) {
  var opts = { url: contentUrl + encodeURIPath(fname), timeout: longTimeout, binary: binary };
  return dropbox.requestGET( opts ).then( function(content,req) {
    var infoHdr = req.getResponseHeader("x-dropbox-metadata");
    var info = (infoHdr ? JSON.parse(infoHdr) : { path: fname });
    info.content = content;
    return addPathInfo(info);
  });
}

function fileInfo(fname) {
  return dropbox.requestGET( { url: metadataUrl + encodeURIPath(fname) } );
}

function sharedFolderInfo(id) {
  var url = sharedFoldersUrl + encodeURIPath(id);
  return dropbox.requestGET( { url: url, cache: -60000, contentType: null } );  // cached, retry after 60 seconds;
}

function folderInfo(fname) {
  var url = metadataUrl + encodeURIPath(fname);
  return dropbox.requestGET( { url: url }, { list: true });
}

function pushFile(fname,content) {
  var url = pushUrl + encodeURIPath(fname); 
  return dropbox.requestPUT( { url: url, timeout: longTimeout }, {}, content ).then( function(info) {
    if (!info) throw new Error("dropbox: could not push file: " + fname);
    return addPathInfo(info);
  });  
}

function createFolder( dirname ) {
  var url = fileopsUrl + "create_folder";
  return dropbox.requestPOST( url, { root: root, path: dirname }).then( function(info) {
    return true; // freshly created
  }, function(err) {
    if (err && err.httpCode === 403) return false;
    throw err;
  });
}

function getShareUrl( fname ) {
  var url = sharesUrl + encodeURIPath(fname);
  return dropbox.requestPOST( { url: url }, { short_url: false } ).then( function(info) {
    return (info.url || null);
  }, function(err) {
    Util.message( err, Util.Msg.Trace );
    return null;
  });
}

/* ----------------------------------------------
   Main entry points
---------------------------------------------- */

function createAt( folder ) {
  return dropbox.login().then( function() {
    return new Dropbox(folder);
  });
}

function unpersist(obj) {
  return new Dropbox(obj.folder);
}

function type() {
  return dropbox.name;
}

function logo() {
  return dropbox.logo;
}

/* ----------------------------------------------
   Dropbox remote object
---------------------------------------------- */

var Dropbox = (function() {

  function Dropbox( folder ) {
    var self = this;
    self.folder = folder || "";
  }

  Dropbox.prototype.createNewAt = function(folder) {
    return createAt(folder);
  }

  Dropbox.prototype.type = function() {
    return type();
  }

  Dropbox.prototype.logo = function() {
    return logo();
  }

  Dropbox.prototype.readonly = false;
  Dropbox.prototype.canSync  = true;
  Dropbox.prototype.needSignin = true;

  Dropbox.prototype.getFolder = function() {
    var self = this;
    return self.folder;
  }

  Dropbox.prototype.getDisplayFolder = function() {
    var self = this;
    return self.getFolder();
  }

  Dropbox.prototype.persist = function() {
    var self = this;
    return { folder: self.folder };
  }

  Dropbox.prototype.fullPath = function(fname) {
    var self = this;
    return Util.combine(self.folder,fname);
  }

  Dropbox.prototype.connect = function() {
    return dropbox.connect();
  }

  Dropbox.prototype.login = function() {
    return dropbox.login();
  }

  Dropbox.prototype.logout = function(force) {
    return dropbox.logout(force);
  }

  Dropbox.prototype.getUserName = function() {
    return dropbox.getUserName();
  }

  Dropbox.prototype.pushFile = function( fpath, content ) {
    var self = this;
    return pushFile( self.fullPath(fpath), content ).then( function(info) {
      return { 
        path: info.path,
        createdTime: new Date(info.modified),
        globalPath: info.globalPath,
        sharedPath: info.sharedPath,
        rev: info.rev,
      };
    });
  }

  Dropbox.prototype.pullFile = function( fpath, binary ) {
    var self = this;
    return self.getRemoteTime(fpath).then( function(date) { // TODO: can we make this one request?
      if (!date) return Promise.rejected("file not found: " + fpath);
      return pullFile( self.fullPath(fpath), binary ).then( function(info) {
        var file = {
          path: fpath,
          content: info.content,
          createdTime: date,
          globalPath: info.globalPath,
          sharedPath: info.sharedPath
        };
        return file;
      });
    });
  }

  Dropbox.prototype.getRemoteTime = function( fpath ) {    
    var self = this;
    return fileInfo( self.fullPath(fpath) ).then( function(info) {
      return (info && !info.is_deleted ? new Date(info.modified) : null);
    }, function(err) {
      if (err && err.httpCode===404) return null;
      throw err;
    });
  }

  Dropbox.prototype.createSubFolder = function(dirname) {
    var self = this;
    var folder = self.fullPath(dirname);
    return createFolder(folder).then( function(created) {
      return { folder: folder, created: created };
    });
  }

  Dropbox.prototype.listing = function( fpath ) {
    var self = this;
    return folderInfo( self.fullPath(fpath) ).then( function(info) {
      return (info ? info.contents : []).map( function(item) {
        item.type = item.is_dir ? "folder" : "file";
        item.isShared = (item.shared_folder || item.parent_shared_folder_id ? true : false);
        return item;
      });
    });
  }

  Dropbox.prototype.getShareUrl = function(fname) {
    var self = this;
    return getShareUrl( self.fullPath(fname) );
  };

  return Dropbox;
})();   



return {
  createAt : createAt,
  unpersist: unpersist,
  type     : type,
  logo     : logo,
  Dropbox  : Dropbox,
}

});