/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is bbs2chreader.
 *
 * The Initial Developer of the Original Code is
 * flyson.
 * Portions created by the Initial Developer are Copyright (C) 2004
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *    flyson <flyson at users.sourceforge.jp>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const Ci = Components.interfaces;
const Cc = Components.classes;


function b2rGlobalHistory(aBbs2chService){
	this._init(aBbs2chService);
}

b2rGlobalHistory.prototype = {

	get historyDB(){
		return this._historyDB;
	},

	_init: function(aBbs2chService){
		var storageService = Cc["@mozilla.org/storage/service;1"]
				.getService(Ci.mozIStorageService);
		var dbFile = aBbs2chService.getDataDir();
		dbFile.appendRelativePath("history.sqlite");
			// 初回起動でデータディレクトリが存在しない場合にそなえて先に作成
		if(!dbFile.exists()){
			dbFile.create(dbFile.NORMAL_FILE_TYPE, 0666);
		}

		this._historyDB = storageService.openDatabase(dbFile);

		this._historyDB.beginTransaction();
		try{
			if(!this._historyDB.tableExists("history")){
				var sql = <><![CDATA[
					CREATE TABLE history(
						id INTEGER PRIMARY KEY,
						url TEXT NOT NULL,
						title NOT NULL,
						last_visited INTEGER NOT NULL DEFAULT 0,
						visit_count INTEGER NOT NULL DEFAULT 1,
						type INTEGER NOT NULL DEFAULT 0
					);
				]]></>.toString();
				this._historyDB.executeSimpleSQL(sql);
			}

			var historyExpireDays = aBbs2chService.pref.getIntPref("extensions.chaika.history_expire_days");
			if(historyExpireDays > 365) historyExpireDays = 365;
			var sql = "DELETE FROM history WHERE last_visited < strftime('%s', 'now', '-" + historyExpireDays +  " day')";
			this._historyDB.executeSimpleSQL(sql);

		}finally{
			this.historyDB.commitTransaction();
		}
	},

	visitPage: function(aURL, aTitle, aType){
		var pageID = null;

		this.historyDB.beginTransaction();
		try{
			var sql = "SELECT id FROM history WHERE url=?1";
			var statement = this.historyDB.createStatement(sql);
			statement.bindStringParameter(0, aURL.spec);
			if(statement.executeStep()){
				pageID = statement.getInt32(0);
			}
			statement.reset();

			if(pageID){
				sql = "UPDATE history SET title=?1, visit_count=visit_count+1, last_visited=?2 WHERE id=?3;";
				statement = this.historyDB.createStatement(sql);
				statement.bindStringParameter(0, aTitle);
				statement.bindInt32Parameter(1, Date.now() / 1000);
				statement.bindInt32Parameter(2, pageID);
				statement.execute();
			}else{
				sql = "INSERT INTO history(url, title, type, last_visited) VALUES(?1, ?2, ?3, ?4);";
				statement = this.historyDB.createStatement(sql);
				statement.bindStringParameter(0, aURL.spec);
				statement.bindStringParameter(1, aTitle);
				statement.bindInt32Parameter(2, aType);
				statement.bindInt32Parameter(3, Date.now() / 1000);
				statement.execute();
			}
		}finally{
			this.historyDB.commitTransaction();
		}
		return true;
	},

	clearHistory: function(){
		this._historyDB.beginTransaction();
		try{
			this._historyDB.executeSimpleSQL("DELETE FROM history;");
		}finally{
			this.historyDB.commitTransaction();
		}

		try{
			this._historyDB.executeSimpleSQL("VACUUM");
		}catch(ex){}
	}
};




function nsBbs2chService(){
		// getBoardType で利用する例外的な URL のリスト( 2ch だけど板じゃない URL)
	this._exURLs = new Array(
		"http://find.2ch.net/enq/board.php",	// こっそりアンケート
		"http://info.2ch.net/wiki/",			// ２ちゃんねるWiki
		"http://epg.2ch.net/tv2chwiki/",		// テレビ番組欄＠2ch
		"http://info.2ch.net/rank/",			// いろいろランキング
		"http://info.2ch.net/guide/adv.html",	// ガイドライン
		"http://info.2ch.net/mag.html"			// ２ちゃんねるメールマガジン
	);

	this.__unicodeConverter = null;
	this.__ioService = null;
	this._globalHistory = null;
	this._pref = null;
	this._prefDefault = null;
	this._userAgent = null;
	this._serverURL = null;
}

nsBbs2chService.prototype = {

	BOARD_TYPE_2CH:    Ci.nsIBbs2chService.BOARD_TYPE_2CH,
	BOARD_TYPE_OLD2CH: Ci.nsIBbs2chService.BOARD_TYPE_OLD2CH,
	BOARD_TYPE_BE2CH:  Ci.nsIBbs2chService.BOARD_TYPE_BE2CH,
	BOARD_TYPE_JBBS:   Ci.nsIBbs2chService.BOARD_TYPE_JBBS,
	BOARD_TYPE_MACHI:  Ci.nsIBbs2chService.BOARD_TYPE_MACHI,
	BOARD_TYPE_PAGE:   Ci.nsIBbs2chService.BOARD_TYPE_PAGE,


	get _unicodeConverter(){
		if(!this.__unicodeConverter){
			this.__unicodeConverter =
				Cc["@mozilla.org/intl/scriptableunicodeconverter"]
					.createInstance(Ci.nsIScriptableUnicodeConverter);
		}
		return this.__unicodeConverter;
	},

	get _ioService(){
		if(!this.__ioService){
			this.__ioService =
				Cc["@mozilla.org/network/io-service;1"]
				.getService(Ci.nsIIOService);
		}
		return this.__ioService;
	},

	get userAgent(){
		if(!this._userAgent){
			try{
				var extensionManager = Cc["@mozilla.org/extensions/manager;1"]
						.getService(Ci.nsIExtensionManager);
				var appInfo = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo);
				var bbs2chID = "chaika@chaika.xrea.jp";
				var item = extensionManager.getItemForID(bbs2chID);
				this._userAgent = new Array(
							"Monazilla/1.00 (", item.name, "/", item.version, "; ",
							appInfo.name, "/", appInfo.version, ")").join("");
			}catch(ex){
				this._userAgent = "Monazilla/1.00 (chaika/0.4.0)"
			}
		}

		return this._userAgent;
	},

	get nameSpace(){ return "http://bbs2ch.sourceforge.jp/#"; },

	get serverURL(){
		if(!this._serverURL){
			var port = 0;
			try{
				var appInfo = Cc["@mozilla.org/xre/app-info;1"].createInstance(Ci.nsIXULAppInfo);
	    	    if(appInfo.name == "Firefox"){
					port = this.pref.getIntPref("extensions.chaika.server_port");
				}else if(appInfo.name == "SeaMonkey"){
					port = this.pref.getIntPref("extensions.chaika.server_port.seamonkey");
				}else{
					port = this.pref.getIntPref("extensions.chaika.server_port.other");
				}
			}catch(ex){
				port = this.pref.getIntPref("extensions.chaika.server_port.other");
			}

			var spec = "http://127.0.0.1:" + port;
			this._serverURL = this._ioService.newURI(spec, null, null)
						.QueryInterface(Ci.nsIURL);
		}
		return this._serverURL.clone();
	},

	get pref(){
		if(!this._pref){
			this._pref = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
		}
		return this._pref;
	},


	get prefDefault(){
		if(!this._prefDefault){
			this._prefDefault = Cc["@mozilla.org/preferences-service;1"]
						.getService(Ci.nsIPrefService).getDefaultBranch("");
		}
		return this._prefDefault;
	},

	get maruLogined(){
		return this._maruLogined;
	},

	get maruSessionID(){
		return this._maruSessionID;
	},

	get historyDB(){
		return this._globalHistory.historyDB;
	},

	_delayInit: function(){
		this._globalHistory = new b2rGlobalHistory(this);
		this._maruAutoAuth();
	},

	_shutdown: function(){
		this.__unicodeConverter = null;
		this.__ioService = null;
		this._globalHistory = null;
		this._pref = null;
		this._prefDefault = null;
		this._userAgent = null;
		this._serverURL = null;
	},

	toSJIS: function(aString){
		this._unicodeConverter.charset = "Shift_JIS";
		return this._unicodeConverter.ConvertFromUnicode(aString);
	},

	fromSJIS: function(aString){
		this._unicodeConverter.charset = "Shift_JIS";
		return this._unicodeConverter.ConvertToUnicode(aString);
	},

	toEUC: function(aString){
		this._unicodeConverter.charset = "EUC-JP";
		return this._unicodeConverter.ConvertFromUnicode(aString);
	},

	fromEUC: function(aString){
		this._unicodeConverter.charset = "EUC-JP";
		return this._unicodeConverter.ConvertToUnicode(aString);
	},

	fromType: function(aString, aBoardType){
		switch(aBoardType){
			case this.BOARD_TYPE_2CH:
			case this.BOARD_TYPE_OLD2CH:
			case this.BOARD_TYPE_MACHI:
				return this.fromSJIS(aString);
				break;
			case this.BOARD_TYPE_BE2CH:
			case this.BOARD_TYPE_JBBS:
				return this.fromEUC(aString);
				break;
		}
		return aString;
	},

	toType: function(aString, aBoardType){
		switch(aBoardType){
			case this.BOARD_TYPE_2CH:
			case this.BOARD_TYPE_OLD2CH:
			case this.BOARD_TYPE_MACHI:
				return this.toSJIS(aString);
				break;
			case this.BOARD_TYPE_BE2CH:
			case this.BOARD_TYPE_JBBS:
				return this.toEUC(aString);
				break;
		}
		return aString;
	},

	getBoardType: function(aURLSpec){
		if(aURLSpec.search(/^http:/) == -1) return this.BOARD_TYPE_PAGE;

		if(this._exURLs.indexOf(aURLSpec) != -1) return this.BOARD_TYPE_PAGE;

			// ヘッドライン
		if(aURLSpec.search(/^http:\/\/headline\.2ch\.net\/.+/) != -1 ||
					aURLSpec.search(/^http:\/\/headline\.bbspink\.com\/.+/) != -1)
			return this.BOARD_TYPE_PAGE;

			// Be@2ch.net
		if(aURLSpec.search(/^http:\/\/be\.2ch\.net\/.+/) != -1)
			return this.BOARD_TYPE_BE2CH;
			// 2ch.net
		if(aURLSpec.search(/^http:\/\/([^\.]+)\.2ch\.net\/.+/) != -1)
			return this.BOARD_TYPE_2CH;
			// bbspink.com
		if(aURLSpec.search(/^http:\/\/([^\.]+)\.bbspink\.com\/.+/) != -1)
			return this.BOARD_TYPE_2CH;
			// JBBS
		if(aURLSpec.search(/^http:\/\/jbbs\.livedoor\.jp\/.+/) != -1)
			return this.BOARD_TYPE_JBBS;
			// まちBBS
		if(aURLSpec.search(/^http:\/\/([^\.]+)\.machi\.to\/.+/) != -1)
			return this.BOARD_TYPE_MACHI;

		var url = this._ioService.newURI(aURLSpec, null, null).QueryInterface(Ci.nsIURL);

			// スレッド URL
		if(url.directory.indexOf("/test/read.cgi/") != -1)
			return this.BOARD_TYPE_2CH;
		if(url.fileName == "read.cgi" && url.query.indexOf("key=") != -1)
			return this.BOARD_TYPE_OLD2CH;

		return this.BOARD_TYPE_PAGE;
	},

	getBoardURL: function(aURLSpec){
		var url = this._ioService.newURI(aURLSpec, null, null).QueryInterface(Ci.nsIURL);

		var boardURLSpec = url.resolve("../");

		switch(this.getBoardType(aURLSpec)){
			case this.BOARD_TYPE_2CH:
			case this.BOARD_TYPE_BE2CH:
				boardURLSpec = boardURLSpec.replace("/test/read.cgi/", "/");
				break;
			case this.BOARD_TYPE_JBBS:
			case this.BOARD_TYPE_MACHI:
				boardURLSpec = boardURLSpec.replace("/bbs/read.cgi/", "/");
				break;
			case this.BOARD_TYPE_OLD2CH:
				break;
		}
		return this._ioService.newURI(boardURLSpec, null, null)
							.QueryInterface(Ci.nsIURL);
	},

	openURL: function(aURLSpec, aReferrer, aAddTab){
		var windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"]
									.getService(Ci.nsIWindowMediator);
		var browserWindow = windowMediator.getMostRecentWindow("navigator:browser");
		if(browserWindow){
			var contentBrowser = browserWindow.document.getElementById("content");
			if(aAddTab){
				var newTab = contentBrowser.addTab(aURLSpec, aReferrer);
				if(this.pref.getBoolPref("extensions.chaika.tab_load_in_foreground"))
					contentBrowser.selectedTab = newTab;
			}else{
				contentBrowser.loadURI(aURLSpec, aReferrer);
			}
			return;
		}

		// Firefox/Seamonkey 以外のブラウザでの処理はここに書く

		this.openNewWindow(aURLSpec);
	},

	openNewWindow: function(aURLSpec){
		var argString = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
		argString.data = aURLSpec || "about:blank";;

		var browserURL = this.pref.getCharPref("browser.chromeURL");
		var winWatcher = Cc["@mozilla.org/embedcomp/window-watcher;1"]
				.getService(Ci.nsIWindowWatcher);
		winWatcher.openWindow(null, browserURL, "_blank",
				"chrome,all,dialog=no", argString);
	},


	getDataDir: function(){
		const DATA_DIR_NAME = "bbs2chreader";
		var dataDir;

			// ログファイルの位置を指定
		if(this.pref.getBoolPref("extensions.chaika.appoint_data_dir")){
			try{
				var dataDirPath = this.pref.getComplexValue("extensions.chaika.data_dir",
										Ci.nsISupportsString).data;
				dataDir = this._createLocalFile(dataDirPath);
				if(dataDir.leafName != DATA_DIR_NAME)
					dataDir.appendRelativePath(DATA_DIR_NAME);
				return dataDir;
			}catch(ex){}

		}

			// 指定していないときはプロファイルディレクトリ
		var dirService = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties);
		dataDir = dirService.get("ProfD", Ci.nsILocalFile);
		dataDir.appendRelativePath(DATA_DIR_NAME);

		return dataDir;
	},

	getLogFileAtURL: function(aURLSpec){
		const LOGS_DIR_NAME = "logs";

		var fromURL = this._ioService.newURI(aURLSpec, null, null).QueryInterface(Ci.nsIURL);

		var logFile = this.getDataDir();
		logFile.appendRelativePath(LOGS_DIR_NAME);
		logFile.appendRelativePath(fromURL.host);

		var pathArray = fromURL.path.split("/");
		for(var i=0; i<pathArray.length; i++){
			if(pathArray[i]) logFile.appendRelativePath(pathArray[i]);
		}

		return logFile;
	},


	geckoVersionCompare: function(aVersion){
		var versionComparator = Cc["@mozilla.org/xpcom/version-comparator;1"]
				.getService(Ci.nsIVersionComparator);
		var appInfo = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo);
		return versionComparator.compare(aVersion, appInfo.platformVersion);
	},


	readLocalURI: function(aURISpec){
		var	localURI = Cc["@mozilla.org/network/simple-uri;1"].createInstance(Ci.nsIURI);
		localURI.spec = aURISpec;
		localURI = this._ioService.getProtocolHandler(localURI.scheme)
										.newURI(localURI.spec, null, null);
		var channel = this._ioService.newChannelFromURI(localURI);
		channel.notificationCallbacks = {
		    getInterface: function(aIID, aInstance) {
	    	    Components.returnCode = Components.results.NS_ERROR_NO_INTERFACE;
	        	return null;
		    }
		};
		var stream	= channel.open();
		var scriptableStream = Cc['@mozilla.org/scriptableinputstream;1']
						.createInstance(Ci.nsIScriptableInputStream);
		scriptableStream.init(stream);

		var fileContents = scriptableStream.read(scriptableStream.available());

		scriptableStream.close();
		stream.close();

		return fileContents;
	},


	readFile: function(aFilePath){
		var fileInputStream = Cc["@mozilla.org/network/file-input-stream;1"]
					.createInstance(Ci.nsIFileInputStream);
		var scriptableInputStream = Cc["@mozilla.org/scriptableinputstream;1"]
					.createInstance(Ci.nsIScriptableInputStream);
		try{
			var localFile = this._createLocalFile(aFilePath);
			fileInputStream.init(localFile, 0x01, 0666, 0);
			scriptableInputStream.init(fileInputStream);
			var fileContent = scriptableInputStream.read(scriptableInputStream.available());
			scriptableInputStream.close();
			fileInputStream.close();
		}catch(ex){
			return null;
		}

		return fileContent;
	},

	readFileLine: function(aFilePath, aCount){
		var fileLines = new Array();

		var fileInputStream = Cc["@mozilla.org/network/file-input-stream;1"]
					.createInstance(Ci.nsIFileInputStream);
		try{
			var localFile = this._createLocalFile(aFilePath);
				// 0x01=PR_RDONLY;
			fileInputStream.init(localFile, 0x01, 0666, 0);
			fileInputStream.QueryInterface(Ci.nsILineInputStream);

			var more;
			var line = {};
			do{
				more = fileInputStream.readLine(line);
				fileLines.push(line.value);
			}while(more);
			fileInputStream.close();
		}catch(ex){}

		aCount.value = fileLines.length;
		return fileLines;
	},

	writeFile: function(aFilePath, aContent, aAppend){
		var fileOutputStream = Cc["@mozilla.org/network/file-output-stream;1"]
						.createInstance(Ci.nsIFileOutputStream);
		try{
			var localFile = this._createLocalFile(aFilePath);
				// nsILocalFIle.create は親フォルダをふくめて作成する
			if(!localFile.exists()) localFile.create(localFile.NORMAL_FILE_TYPE, 0666);
				// 0x02=PR_WRONLY; 0x08=PR_CREATE_FILE;
				// 0x10=PR_APPEND; 0x20=PR_TRUNCATE;
			var flag = (aAppend==true) ? 0x02|0x08|0x10 : 0x02|0x08|0x20;
			fileOutputStream.init(localFile, flag, 0666, 0);
			fileOutputStream.write(aContent, aContent.length);
			fileOutputStream.flush();
			fileOutputStream.close();
		}catch(ex){
			dump(ex +"\n")
			return false;
		}
		return true;
	},


	getHttpChannel: function(aURL){
		var httpChannel;
		var proxyMode = this.pref.getIntPref("extensions.chaika.http_proxy_mode");
		if(proxyMode != 0){
			var httpProtocolHandler = this._ioService.getProtocolHandler("http")
					.QueryInterface(Ci.nsIHttpProtocolHandler);
			var pps = Cc["@mozilla.org/network/protocol-proxy-service;1"]
                    .getService(Ci.nsIProtocolProxyService);
			if(proxyMode == 1){
				var proxyInfo = pps.newProxyInfo("direct", "", -1, 0, 0, null);
				httpChannel = httpProtocolHandler.newProxiedChannel(aURL, proxyInfo)
						.QueryInterface(Ci.nsIHttpChannel);
			}else if(proxyMode == 2){
					var httpProxyValue = this.pref.getComplexValue(
							"extensions.chaika.http_proxy_value",
								Ci.nsISupportsString).data;
					httpProxyValue = httpProxyValue.replace(/\s/g, "");
					if(httpProxyValue.match(/([^:]+):(\d+)/)){
						var host = RegExp.$1;
						var port = parseInt(RegExp.$2);
						try{
							var proxyInfo = pps.newProxyInfo("http", host, port, 0, 10,
									pps.newProxyInfo("direct", "", -1, 0, 0, null));
							httpChannel = httpProtocolHandler.newProxiedChannel(aURL, proxyInfo)
								.QueryInterface(Ci.nsIHttpChannel);
						}catch(ex){dump(ex)}
					}
			}
		}

		if(!httpChannel){
			httpChannel = this._ioService.newChannelFromURI(aURL)
					.QueryInterface(Ci.nsIHttpChannel);
		}

		httpChannel.setRequestHeader("User-Agent", this.userAgent, false);
		httpChannel.notificationCallbacks = {
		    getInterface: function(aIID, aInstance) {
	    	    Components.returnCode = Components.results.NS_ERROR_NO_INTERFACE;
	        	return null;
		    }
		};
		return httpChannel;
	},


	_createLocalFile: function(aFilePath){
		var localFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
		localFile.initWithPath(aFilePath);
		return localFile;
	},


	maruAuth: function(){
		this._maruLogined = false;
		this._maruSessionID = "";

		var maruEnabled = this.pref.getBoolPref("extensions.chaika.maru_enabled");
		if(!maruEnabled){ return; }
		this._maruAuthDelay();
	},

	_maruAutoAuth: function(){
		this._maruLogined = false;
		this._maruSessionID = "";

		var maruAutoAuth = this.pref.getBoolPref("extensions.chaika.maru_auto_auth");
		if(!maruAutoAuth){ return; }

		var maruEnabled = this.pref.getBoolPref("extensions.chaika.maru_enabled");
		if(!maruEnabled){ return; }

		var lastAuthTime = this.pref.getIntPref("extensions.chaika.maru_last_auth_time");
		var nowTime = Math.round(Date.now() / 1000);
		if((nowTime - lastAuthTime) < 21600){
			this._maruLogined = true;
			this._maruSessionID = this.pref.getCharPref("extensions.chaika.maru_session_id");

			dump("nsBbs2chService: 2ch Viewer Auth SKIP\n");
			var os = Cc["@mozilla.org/observer-service;1"]
						.getService(Ci.nsIObserverService);
			os.notifyObservers(null, "b2r-2ch-viewer-auth", "SKIP");
			return;
		}

		var timer = Cc["@mozilla.org/timer;1"]
						.createInstance(Ci.nsITimer);
		var timerCallback = {};
		timerCallback._context = this;
		timerCallback.observe = function(aTimer){
			dump("nsBbs2chService: 2ch Viewer Auth Start\n");
			this._context._maruAuthDelay();
		}
		timer.init(timerCallback, 500, timer.TYPE_ONE_SHOT);
	},

	_maruAuthDelay: function(){
		var maruAuthURLSpec = this.pref.getCharPref("extensions.chaika.maru_auth_url");
		var maruID = this.pref.getCharPref("extensions.chaika.maru_id");
		var maruPass = this.pref.getCharPref("extensions.chaika.maru_password");

		var maruAuthURL = this._ioService.newURI(maruAuthURLSpec, null, null)
				.QueryInterface(Ci.nsIURL);
		var httpChannel = this.getHttpChannel(maruAuthURL);
		httpChannel.setRequestHeader("User-Agent", "DOLIB/1.00", false);
		httpChannel.setRequestHeader("X-2ch-UA", this.userAgent, false);
		httpChannel.setRequestHeader("Content-Type",
					"application/x-www-form-urlencoded", false);
		httpChannel = httpChannel.QueryInterface(Ci.nsIUploadChannel);
		var strIStream = Cc["@mozilla.org/io/string-input-stream;1"]
							.createInstance(Ci.nsIStringInputStream)
		var postString = String("ID=" + maruID + "&PW=" + maruPass);
		strIStream.setData(postString, postString.length);
		httpChannel.setUploadStream(strIStream, "application/x-www-form-urlencoded", -1);
		httpChannel.requestMethod = "POST";

		var listener = {
			onStartRequest: function(aRequest, aContext){
				this._bInputStream = Cc["@mozilla.org/binaryinputstream;1"]
							.createInstance(Ci.nsIBinaryInputStream);
				this._data = new Array();
			},
			onDataAvailable: function (aRequest, aContext, aInputStream, aOffset, aCount){
				this._bInputStream.setInputStream(aInputStream);
				this._data.push(this._bInputStream.readBytes(aCount));
			},
			onStopRequest: function(aRequest, aContext, aStatus){
				var data = this._data.join("");
				if(data.indexOf("ERROR:") != -1){
					aContext.wrappedJSObject._maruLoginNG();
					return;
				}
				aContext.wrappedJSObject._maruLoginOK(data.substring(11, data.length -1));
			}
		};
		this.wrappedJSObject = this;
		httpChannel.asyncOpen(listener, this);
	},

	_maruLoginOK: function(aSessionID){
		this._maruLogined = true;
		this._maruSessionID = aSessionID;

		var nowTime = Math.round(Date.now() / 1000);
		this.pref.setCharPref("extensions.chaika.maru_session_id", aSessionID);
		this.pref.setIntPref("extensions.chaika.maru_last_auth_time", nowTime);
		dump("nsBbs2chService: 2ch Viewer Auth OK\n");

		var os = Cc["@mozilla.org/observer-service;1"]
					.getService(Ci.nsIObserverService);
		os.notifyObservers(null, "b2r-2ch-viewer-auth", "OK");
	},

	_maruLoginNG: function(aSessionID){
		this._maruLogined = false;
		this._maruSessionID = "";
		dump(this.maruSessionID + "\n");
		dump("nsBbs2chService: 2ch Viewer Auth NG\n");

		var alertsService = Cc["@mozilla.org/alerts-service;1"]
	            .getService(Ci.nsIAlertsService);
		alertsService.showAlertNotification("", "bbs2chreader",
				"Login failed on 2ch Viewer", false, "", null);

		var os = Cc["@mozilla.org/observer-service;1"]
					.getService(Ci.nsIObserverService);
		os.notifyObservers(null, "b2r-2ch-viewer-auth", "NG");
	},


	visitPage: function(aURL, aTitle, aType){
		return this._globalHistory.visitPage(aURL, aTitle, aType);
	},


	clearHistory :function(){
		this._globalHistory.clearHistory();
	},


  	// ********** ********* implements nsIObserver ********** **********

	observe: function(aSubject, aTopic, aData){
		var os = Cc["@mozilla.org/observer-service;1"]
					.getService(Ci.nsIObserverService);
		switch(aTopic){
			case "app-startup":
				os.addObserver(this, "final-ui-startup", false);
				os.addObserver(this, "xpcom-shutdown", false);
				dump("nsBbs2chService\n");
				break;
			case "final-ui-startup":
				os.removeObserver(this, "final-ui-startup");
				this._delayInit();
				break;
			case "xpcom-shutdown":
				this._shutdown();
				os.removeObserver(this, "xpcom-shutdown");
				break;
		}
	},

  	// ********** ********* implements nsIClassInfo ********** **********

	get classDescription() {
		return "nsBbs2chService js component";
	},
	get classID() {
		return Components.ID("{4b76cc9e-04ed-4966-af22-5cc5dbdca0eb}");
	},
	get implementationLanguage() {
		return Ci.nsIProgrammingLanguage.JAVASCRIPT;
	},
	get flags() {
		return Ci.nsIClassInfo.SINGLETON;
	},
	get contractID() {
    	return "@mozilla.org/bbs2ch-service;1";
	},

	getInterfaces: function(aCount) {
	    var interfaces = [
			Ci.nsIBbs2chService,
			Ci.nsIClassInfo,
			Ci.nsIObserver,
			Ci.nsISupports
		];
	    aCount.value = interfaces.length;
    	return interfaces;
	},

 	getHelperForLanguage: function(aLanguage) {
    	return null;
	},

	QueryInterface: function(aIID){
		if(aIID.equals(Ci.nsIBbs2chService) ||
				aIID.equals(Ci.nsIClassInfo) ||
				aIID.equals(Ci.nsIObserver) ||
				aIID.equals(Ci.nsISupports)){
			return this;
		}
		throw Components.results.NS_ERROR_NO_INTERFACE;
	}

};


// ********** ********* Component Registration ********** **********


var Factory = {

	createInstance: function (aOuter, aIID){
		if(aOuter != null)
			throw Components.results.NS_ERROR_NO_AGGREGATION;

		if(aIID.equals(Ci.nsIBbs2chService))
			return this.getInstance(aIID);
		if(aIID.equals(Ci.nsIClassInfo))
			return this.getInstance(aIID);
		if(aIID.equals(Ci.nsIObserver))
			return this.getInstance(aIID);
		if(aIID.equals(Ci.nsISupports))
			return this.getInstance(aIID);

		throw Components.results.NS_ERROR_INVALID_ARG;
	},

	getInstance: function(aIID){
		if(!this._instance){
			this._instance = new nsBbs2chService();
		}
		return this._instance.QueryInterface(aIID);
	}

};

var Module = {

	CONTRACTID: "@mozilla.org/bbs2ch-service;1",
	CID: Components.ID("{4b76cc9e-04ed-4966-af22-5cc5dbdca0eb}"),
	CNAME: "nsBbs2chService js component",


	registerSelf: function(aCompMgr, aFileSpec, aLocation, aType){
		aCompMgr = aCompMgr.QueryInterface(Ci.nsIComponentRegistrar);
		aCompMgr.registerFactoryLocation(this.CID, this.CNAME, this.CONTRACTID,
											aFileSpec, aLocation, aType);
		var categoryManager = Cc["@mozilla.org/categorymanager;1"]
					.getService(Ci.nsICategoryManager);
		categoryManager.addCategoryEntry("app-startup", this.CONTRACTID,
											this.CONTRACTID, true, true);
	},


	unregisterSelf: function(aCompMgr, aFileSpec, aLocation){
		aCompMgr = aCompMgr.QueryInterface(Ci.nsIComponentRegistrar);

		var categoryManager = Cc["@mozilla.org/categorymanager;1"]
					.getService(Ci.nsICategoryManager);
		categoryManager.deleteCategoryEntry("app-startup", this.CONTRACTID, true);
	},


	getClassObject: function(aCompMgr, aCID, aIID){
		if(aCID.equals(this.CID))
			return Factory;

		if(!aIID.equals(Ci.nsIFactory))
			throw Components.results.NS_ERROR_NOT_IMPLEMENTED;

		throw Components.results.NS_ERROR_NO_INTERFACE;
	},


	canUnload: function(aCompMgr){
		return true;
	}

};


function NSGetModule(aCompMgr, aFileSpec){
	return Module;
}
