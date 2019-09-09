/*
 * Platform shim for use with nfarina's homebridge plugin system 
 * This is the version for plugin support for M-NET 
 * M-NET is Mitsibushi central control management network
 * This plugin uses G-50A or GB-50 or AG-2000 interface to communicate
 * ******************************************************************************************** 
 * 
ECMA-Script 2015 (6.0) Language required
 */
/* jshint esversion: 6, strict: true, node: true */

'use strict';

var AccConstructor = require('./lib/mnetdevice.js');
var userOpts = require('./lib/user').User;
var Service, Characteristic; // passed default objects from hap-nodejs
var globs = {}; // the storage for cross module data pooling;

var MNETAccess = require("./lib/mnetaccess");
var mnetmonitor = require("./lib/mnet_client.js");
var getServiceData = require("./lib/servicedata"); // the data for the web server to show available services and characteristics

var http = require('http');

// G-50A 192.168.1.1 v. 2.60
// http://192.168.1.1/g-50/en/administrator.html
// http://192.168.1.1/g-50/en/head-login.html
// Maintenance user: initial/init
// Building manager: administrator/admin

function MNETPlatform(log, config, newAPI) {
	var that = this;
	this.log = log;
	//this.Old_config = config;

	// new API for creating accessory and such.
	globs.newAPI = newAPI;
	/**
	 * Talkative Info spitting thingy.
	 * 
	 * @param {string} comment
	 * 
	 */
	globs.info = function(comment) {
		that.log.info(comment);
	};
	globs.debug = function(comment) {
		that.log.debug(comment);
	};
	globs.errorlog = function(comment) {
		that.log.error(comment);
	};

	/* our own config file */

	globs.debug("Trying to load user settings");
	userOpts.setStoragePath(newAPI.user.storagePath()); // get path from homebridge!
	globs.debug(userOpts.configPath());
	this.config = userOpts.loadConfig();
	globs.config = this.config;
	globs.restoredAccessories = []; //plugin-2

	/* we should have now:
	 * - mnetd_ip
	 * - mnetd_port
	 * - GroupAddresses object
	 * - Devices Object
	 */
	globs.mnet_id = this.config.mnet_ip;
	mnetmonitor.mnet_config.host = globs.mnet_id;
	// globs.mnetd_port = this.config.mnetd_port || 6720;
	globs.log = log;
	globs.mnetmonitor = mnetmonitor;
	/**
	 * To store all unique read requests
	 * 
	 * @type {string[]}
	 */
	globs.readRequests = {};

	MNETAccess.setGlobs(globs); // init link for module;
        mnetmonitor.startMonitoring(globs);
	// mnetmonitor.startMonitor({
	// 	host : globs.mnetd_ip,
	// 	port : globs.mnetd_port
	// });

	// plugin-2 system: wait for the homebridge to finish restoring the accessories from its own persistence layer.
	if (newAPI) {
		newAPI.on('didFinishLaunching', function() {
			globs.info('homebridge event didFinishLaunching');
			this.configure();
		}.bind(this));
	}

}

function registry(homebridgeAPI) {
	console.log("homebridge API version: " + homebridgeAPI.version);
	
	/*
	 * Experimental: Look for a user file called mnet-ignore.txt in the user config path.
	 * If it is there, exit here and DO NOT REGISTER the platform
	 */
	let fs = require('fs');
	let path = require('path');
	let checkfilepath = path.join(homebridgeAPI.user.storagePath(), 'mnet-ignore.txt');
	if (fs.existsSync(checkfilepath)) {
		console.log('[WARNING] Found blocking file, exiting now. To load homebridge-mnet, remove '+ checkfilepath);
		return;
	}
	// END OF INSERTION FOR BRANCH ignore-option
	
	Service = homebridgeAPI.hap.Service;
	Characteristic = homebridgeAPI.hap.Characteristic;
	globs.Service = Service;
	globs.Characteristic = Characteristic;
	globs.API = homebridgeAPI;

	/* load our custom types
	 * 
	 */
	require('./lib/customtypes/mnet_thermostat.js')(homebridgeAPI);
	
	/*
	 *  get the data for the web server (show available services and characteristics)
	 */
	
	globs.webdata = getServiceData(globs);
	
	//debug
	//iterate(globs.API.hap.Characteristic.MNETThermAtHome);
	//iterate(globs.API.hap.Characteristic.On);
	// third parameter dynamic = true
	homebridgeAPI.registerPlatform("homebridge-mnet", "MNET", MNETPlatform, true); //update signature for plugin-2
	//homebridgeAPI.registerPlatform("homebridge-mnet", "MNET", MNETPlatform, false); //update signature 
}

module.exports = registry;


//Function invoked when homebridge tries to restore cached accessory
//Developer can configure accessory at here (like setup event handler)
//Update current value

/**
 * configureAccessory() is invoked for each accessory homebridge restores from its persistence layer. The restored
 * accessory has all the homekit properties, but none of the implementation at this point of time. This happens before
 * the didFinishLaunching event.
 * 
 * @param {platformAccessory} accessory
 */
MNETPlatform.prototype.configureAccessory = function(accessory) {
	console.log("Plugin - Configure Accessory: " + accessory.displayName + " --> Added to restoredAccessories[]");

	// set the accessory to reachable if plugin can currently process the accessory
	// otherwise set to false and update the reachability later by invoking 
	// accessory.updateReachability()
	accessory.updateReachability(false);

	// collect the accessories 
	globs.restoredAccessories.push(accessory);
};

/**
 * With plugin-2 system, accessories are re-created by the homebridge itself, but without all the event functions etc.
 * 
 * We need to re-connect all our accessories to the right functions
 * 
 * This is my event handler for the "didFinishLaunching" event of the newAPI
 */

MNETPlatform.prototype.configure = function() {
	globs.info('Configuration starts');
	userOpts.LogHomebridgeMNETSTarts();
	// homebridge has now finished restoring the accessories from its persistence layer.
	// Now we need to get their implementation back to them

	globs.debug('We think homebridge has restored ' + globs.restoredAccessories.length + ' accessories.');

	/* *************** read the config the first time 
	 * 
	 */
	if (!this.config.GroupAddresses) {
		this.config.GroupAddresses = [];
	}

	// iterate through all devices the platform my offer
	// for each device, create an accessory

	// read accessories from file !!!!!
	var foundAccessories = this.config.Devices || [];

	//create array of accessories
	/** @type {lib/mnetdevice.js~mnetDevice[]} */
	globs.devices = [];

	for (var int = 0; int < foundAccessories.length; int++) {
		var currAcc = foundAccessories[int];
		globs.info("Reading from config: Device/Accessory " + (int + 1) + " of " + foundAccessories.length);

		globs.debug("Match device [" + currAcc.DeviceName + "]");

		//match them to the restored accessories:
		/** @type {homebridge/lib/platformAccessory.js/PlatformAccessory} */
		var matchAcc = getAccessoryByUUID(globs.restoredAccessories, currAcc.UUID);
		if (matchAcc) {
			// we found one
			globs.debug('Matched an accessory: ' + currAcc.DeviceName + ' === ' + matchAcc.displayName);
			// Instantiate and pass the existing platformAccessory
			matchAcc.active = true;
			globs.devices.push(new AccConstructor(globs, foundAccessories[int], matchAcc));
		} else {
			// this one is new
			globs.debug('New accessory found: ' + currAcc.DeviceName);
			globs.devices.push(new AccConstructor(globs, foundAccessories[int]));
		}
		// do not construct here: var acc = new accConstructor(globs,foundAccessories[int]);

		globs.info("Done with [" + currAcc.DeviceName + "] accessory");
	}
	// now the globs.devices contains an array of working accessories, that are not yet passed to homebridge
	globs.info('We have read ' + globs.devices.length + ' devices from file.');

	//now we need to store our updated config file to disk, or else all that is in vain next startup!
	globs.info('Saving config file!');
	userOpts.storeConfig();
	
	
	/*********************************************************************************/
	// start the tiny web server for deleting orphaned devices
	globs.debug('BEFORE http.createServer');
	var that=this;
	this.startUpDateAndTime = new Date();
	this.startUpDateAndTimeString = this.startUpDateAndTime.toString();
	this.requestServer = http.createServer(function(request, response) {
		globs.debug('http.createServer CALLBACK FUNCTION URL=' + request.url);
		var reqparsed = request.url.substr(1).split('?');
		var params = {};
		var paramstemp = [];
		if (reqparsed[1]) {
			paramstemp = reqparsed[1].split('&');
			for (var i = 0; i < paramstemp.length; i++) {
				/** @type {string[]} */
				var b = paramstemp[i].split('=');
				params[decodeURIComponent(b[0])] = decodeURIComponent(b[1] || '');
			}
		}
		/*
		 * Now we have: path in reqparsed[0] like "list" or "delete"
		 * param
		 */
		if (request.url === "/list") {
			//response.writeHead(200);
			response.write('<HEAD><meta http-equiv="content-type" content="text/html; charset=utf-8"><TITLE>Homebridge-MNET</TITLE></HEAD>');
			response.write('<BODY>');
			response.write('homebridge-mnet started at ' + that.startUpDateAndTimeString);
			response.write('<hr>');
			response.write('Restored devices from homebridge cache:<BR><BR>');
			var idev = 0, tdev = {};
			for (idev = 0; idev < globs.restoredAccessories.length; idev++) {
				tdev = globs.restoredAccessories[idev];
				// debug spit-out:
				//response.write('<BR><HR><BR>' + JSON.stringify(tdev) + '<BR><BR>');
				globs.debug(tdev.UUID);
				if (tdev.UUID !== 'ERASED') {
					response.write('Device ' + tdev.displayName);
					response.write(' <a href="/delete?UUID=' + tdev.UUID + '">[Delete from cache!]</a> ');
					if (!tdev.active) {
						response.write(' (orphaned) ');
					}
					response.write(' <BR>');
				}
			}
			response.write('<HR><BR>Devices from homebridge-mnet config:<BR><BR>');
			for (idev = 0; idev < globs.devices.length; idev++) {
				tdev = globs.devices[idev].getPlatformAccessory();
				if (tdev.UUID !== 'ERASED') {
					response.write('Device ' + tdev.displayName);
					response.write(' <a href="/delete?UUID=' + tdev.UUID + '">[Delete from cache!]</a> ' + ' <BR>');
// TODO: List Services here - Services are the prime homekit objects!
				}
			}
			if (that.config.AllowKillHomebridge===true) {
				response.write(' <br><hr><br><a href="/kill">Kill homebridge</a> by throwing an Error. Use this to restart HomeBridge if you have it configured as a self-starting service ' + ' <BR>');
			}
			response.write(`<HR><BR>Available pages are <br>
					<a href="/list">list devices</a> and <br>
					<a href="/availservices">list available services</a><br>
					 <a href="/availcharacteristics">list available characteristics</a>
					`);
			response.write('URL<BR><BR>' + request.url + '<BR>');
			response.write(JSON.stringify(params) + '<BR>');
			response.end('</BODY>');

		} else if (reqparsed[0] === 'delete') {
			// now delete the accessory from homebridge
			globs.debug("delete accessory with UUID ");

			if (params.UUID) {
				try {
					globs.debug(params.UUID);
					var delAcc = getAccessoryByUUID(globs.restoredAccessories, params.UUID);
					if (delAcc) {
						globs.newAPI.unregisterPlatformAccessories(undefined, undefined, [ delAcc ]);
						delAcc.UUID = "ERASED";
					} else {
						delAcc = getAccessoryByUUID(globs.devices, params.UUID);
						if (delAcc) {
							globs.newAPI.unregisterPlatformAccessories(undefined, undefined, [ delAcc ]);
							delAcc.UUID = "ERASED";
						}
					}
					globs.debug(params.UUID + ' deleted');
				} catch (err) {
					globs.errorlog('ERR Could not delete accessory with UUID ' + params.UUID);
				} finally {
					response.end('<HEAD><meta http-equiv="refresh" content="0; url=http:/list" /></HEAD><BODY> done. Go back in browser and refresh</BODY>');
				}
			}
		} else if (reqparsed[0] === 'kill') {
			// commit suicide
			if (that.config.AllowKillHomebridge===true) {
				response.end('<HEAD><meta http-equiv="refresh" content="20; url=http:/list" /></HEAD><BODY> Committed suicide. Reloading in 20 seconds.</BODY>');
				var timerX = setTimeout(function() {
					throw "Commited_Suicide";
				}, 500);
			}
		
		} else if (reqparsed[0] === 'availservices') {
			// list the Services that homebridge knows about
			response.write('<HEAD><TITLE>Homebridge-MNET</TITLE></HEAD>');
			response.write('<BODY>');
			response.write('<h1>Available services for homebridge are: </h1>');
			for (let srvName in globs.webdata.servData) {
				if (globs.webdata.servData.hasOwnProperty(srvName)) {
					let srv = globs.webdata.servData[srvName];
					response.write('<a href="/servicedata?name='+ srvName+'">' + srv.displayName + ' (' + srv.localized.en.displayName +')</a><BR>');
				}
				
			}  
			response.write(`<HR><BR>Available pages are <br>
			<a href="/list">list devices</a> and <br>
			<a href="/availservices">list available services</a><br>
			 <a href="/availcharacteristics">list available characteristics</a>
			`);
			response.write('URL<BR><BR>' + request.url + '<BR>');
			response.write(JSON.stringify(params) + '<BR>');
			response.end('</BODY>');	
		} else if (reqparsed[0] === 'availcharacteristics') {
			// list the Services that homebridge knows about
			response.write('<HEAD><TITLE>Homebridge-MNET</TITLE></HEAD>');
			response.write('<BODY>');
			response.write('<h1>Available characteristics for homebridge are: </h1>');
			for (let chrName in globs.webdata.charData) {
				if (globs.webdata.charData.hasOwnProperty(chrName)) {
					let chr = globs.webdata.charData[chrName];
					response.write('<a href="/chardata?name='+ chr.displayName+'">' + chr.displayName + '</a><BR>');
				}
			}  
			response.write(`<HR><BR>Available pages are <br>
					<a href="/list">list devices</a> and <br>
					<a href="/availservices">list available services</a><br>
					 <a href="/availcharacteristics">list available characteristics</a>
					`);
			response.write('URL<BR><BR>' + request.url + '<BR>');
			response.write(JSON.stringify(params) + '<BR>');
			response.end('</BODY>');	
		} else if (reqparsed[0] === 'servicedata') {
			// show service
			globs.debug("list service characteristics");
			response.write('<HEAD><TITLE>Homebridge-MNET</TITLE></HEAD>');
			response.write('<BODY>');
			if (params.name && globs.webdata.availableServices.Services[params.name]) {
				let service1 = globs.webdata.availableServices.Services[params.name];
				let disp1 = globs.webdata.servData[params.name];
				response.write('<H1>' + disp1.displayName +'</H1>');
				response.write(`<H2>Mandatory characteristics</H2>`);
				response.write(`<H4>Mandatory characteristics are created automatically by homebridge. If they are not connected to group addresses they are dysfunct although displayed in HomeKit apps.</H4>`);
				for (let chrName in service1.characteristics) { // service1.characteristics is a numbered array !!!
					if (service1.characteristics.hasOwnProperty(chrName)) {
						//console.log('Searching for '+service1.characteristics[chrName].displayName);
						//console.dir(globs.webdata.charData);
						let chr1 = globs.webdata.charData[service1.characteristics[chrName].displayName];
						response.write('<a href="/chardata?name='+ chr1.displayName+'">' + chr1.objectName + '</a> ('+ chr1.localized.en.displayName+ ') <BR>'); // TODO localisation
					}
					
				}  
				response.write(`<H2>Optional characteristics</H2>`);
				response.write(`<H4>Optional characteristics are created if listed in configuration. Any other characteristic might also work, these are thought by Apple to work best with the service</H4>`);
				for (let chrName in service1.optionalCharacteristics) { // service1.characteristics is a numbered array !!!
					if (service1.optionalCharacteristics.hasOwnProperty(chrName)) {
						//console.log('Searching for '+service1.optionalCharacteristics[chrName].displayName);
						//console.dir(globs.webdata.charData);
						let chr1 = globs.webdata.charData[service1.optionalCharacteristics[chrName].displayName];
						response.write('<a href="/chardata?name='+ chr1.displayName+'">' + chr1.objectName + '</a> ('+ chr1.localized.en.displayName+ ') <BR>');  // TODO localisation
					}
					
				}  
			} else {
				response.write('<H1>Error in URL</H1>');
			}
			response.write(`<HR><BR>Available pages are <br>
					<a href="/list">list devices</a> and <br>
					<a href="/availservices">list available services</a><br>
					 <a href="/availcharacteristics">list available characteristics</a>
					`);
			response.write('URL<BR><BR>' + request.url + '<BR>');
			response.write(JSON.stringify(params) + '<BR>');
			response.end('</BODY>');
		} else if (reqparsed[0] === 'chardata') {
			// show characteristic
			globs.debug("list characteristic");
			response.write('<HEAD><TITLE>Homebridge-MNET</TITLE></HEAD>');
			response.write('<BODY>');
			if (params.name && globs.webdata.charData[params.name]) {
				let disp1 = globs.webdata.charData[params.name];
				let char1 = globs.webdata.availableCharacteristics[disp1.objectName];
				response.write('<H1>' + disp1.displayName +'</H1>');
				response.write(`<H2>Properties</H2>`);
				response.write(`<H4>Properties define the behaviour of the characteristic</H4>`);
				for (let prop in char1) { // service1.characteristics is a numbered array !!!
					if (char1.hasOwnProperty(prop)) {
						//console.log('Searching for '+service1.characteristics[chrName].displayName);
						//console.dir(globs.webdata.charData);
						if (prop!=='props') {
							response.write(prop + ': '+ char1[prop] +' <BR>'); // TODO localisation
						} else {
							for (let pp in char1[prop]) {
								if (char1[prop].hasOwnProperty(pp)) {
									response.write(pp + ': '+ char1[prop][pp] +' <BR>'); // TODO localisation
								}
							}
						}
						
					}
					
				}  

			} else {
				response.write('<H1>Error in URL</H1>');
				console.dir(globs.webdata.charData);
			}
			response.write(`<HR><BR>Available pages are <br>
					<a href="/list">list devices</a> and <br>
					<a href="/availservices">list available services</a><br>
					 <a href="/availcharacteristics">list available characteristics</a>
					`);
			response.write('URL<BR><BR>' + request.url + '<BR>');
			response.write(JSON.stringify(params) + '<BR>');
			response.end('</BODY>');
		} else {
			// any other URL
			response.write('<HEAD><TITLE>Homebridge-MNET</TITLE></HEAD>');
			response.write('<BODY>');
			response.write(`<BR>Available pages are <br>
					<a href="/list">list devices</a> and <br>
					<a href="/availservices">list available services</a><br>
					 <a href="/availcharacteristics">list available characteristics</a>
					`);
			response.write('<h1>URL<h1/><BR><BR>' + request.url + '<BR>');
			response.write(JSON.stringify(params) + '<BR>');
			response.end('</BODY>');

		}

	}.bind(this));
	globs.debug('BEFORE requestServer.listen');
	if (this.config.AllowWebserver) {
		let that = this;
		this.requestServer.listen(that.config.WebserverPort || 18081, function() {
			console.log("Server Listening...localhost:" + that.config.WebserverPort || 18081 + "/list");
		});
	}

	// we're done, now issue the startup read requests to the bus
	require('./lib/mnetaccess.js').mnetreadhash(globs.readRequests);

};

/**
 * returns an accessory from an array of accessories if the context property is matched, or undefined.
 * 
 * @param {homebridge/lib/platformAccessory.js~PlatformAccessory[]} accessories The array of accessories.
 * @param {String} uuid The context object (presumably a string) to be matched.
 * @return {homebridge/lib/platformAccessory.js~PlatformAccessory} or undefined
 * 
 */
function getAccessoryByUUID(accessories, uuid) {
	globs.debug('--compare----------------');
	for (var ina = 0; ina < accessories.length; ina++) {
		var thisAcc = accessories[ina];
		globs.debug('Comparing ' + thisAcc.UUID + ' === ' + uuid + ' ==>' + (thisAcc.UUID === uuid));
		//console.log(thisAcc); // spit it out
		if (thisAcc.UUID === uuid) {
			globs.debug('---------------done---');
			return thisAcc;
		}
	}
	// nothing found:
	globs.debug('-----none----------return-undefined--');
	return undefined;
}

/**
 * Search the globs object's devices[] array for an mnetDevice with name 'name'
 */
globs.getDeviceByName = function(name) {
	for (var idevice = 0; idevice < globs.devices.length; idevice++) {
		var oDevice = globs.devices[idevice];
		if (oDevice.name === name) {
			return oDevice;
		}
	}
	return undefined;
};
