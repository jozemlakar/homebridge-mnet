/*jslint node: true */
/* jshint esversion: 6, strict: true, node: true */

'use strict';
/**
 * http://usejsdoc.org/
 */

var globs;
var mnetd = require('eibd');
var iterate = require('./iterate');
var mnet_client=require('./mnet_client');
var allFunctions =  {};
// all purpose / all types write function	

/**
 *  Writes a value to mnetd
 *  @param {function()} callback - function to call upon completion/error
 *  @param {string} groupAddress - GroupAddress string in triple notation as "1/2/3"
 *  @param {string} dpt - Data Point Type string as "DPT1"
 *  @param {string} value - Value to send
 */
allFunctions.mnetwrite = function(callback, groupAddress, dpt, value) {
	let addressArray = groupAddress.split('/');
	let group = addressArray[0];
	let action = addressArray[1];
	// '/1' address is On/Off action
	console.log('HOT: Write from 0/0/1 to ' + groupAddress + ': ' + value + ' [' + dpt + ']');
	if (action === mnet_client.subAddresses.Active) {
		// value 1 is On
		mnet_client.setDrive(group, value, callback);
	}
	if (action === mnet_client.subAddresses.TargetHeaterCoolerState) {
		mnet_client.setMode(group, value, callback);
	}
	if (action === mnet_client.subAddresses.CoolingThresholdTemperature) {
		mnet_client.setTemperature(group, value, callback);
	}
	if (action === mnet_client.subAddresses.HeatingThresholdTemperature) {
		mnet_client.setTemperature(group, value, callback);
	}
	if (action === mnet_client.subAddresses.RotationSpeed) {
		mnet_client.setFanSpeed(group, value, callback);
	}
	if (action === mnet_client.subAddresses.SwingMode) {
		mnet_client.setSwingMode(group, value, callback);
	}
	// //globs.info("DEBUG in mnetwrite");
	// /** @type {eibd~Connection} */
	// var mnetdConnection = new mnetd.Connection();
	// //globs.info("DEBUG in mnetwrite: created empty connection, trying to connect socket to " + globs.mnetd_ip + ":" + globs.mnetd_port);
	// mnetdConnection.socketRemote({
	// 	host : globs.mnetd_ip,
	// 	port : globs.mnetd_port
	// }, function(err) {
	// 	if (err) {
	// 		// a fatal error occurred
	// 		console.error("FATAL: mnetd or eibd not reachable: " + err);
	// 		throw new Error("Cannot reach mnetd or eibd service, please check installation and configuration .json");
	// 	}
	// 	var dest = mnetd.str2addr(groupAddress);
	// 	globs.debug("DEBUG mnetwrite Address conversion, converted "+ groupAddress+ " to " + dest);
	// 	mnetdConnection.openTGroup(dest, 1, function(err) {
	// 		if (err) {
	// 			globs.errorlog("[ERROR] mnetwrite:openTGroup: " + err);
	// 			if (callback) {
	// 				try {
	// 					callback(err);
	// 				} catch (e) {
	// 					globs.log('Caught error '+ e + ' when calling homebridg callback.');
	// 				}
	// 			}
	// 		} else {
	// 			//globs.debug("DEBUG opened TGroup ");
	// 			var msg = mnetd.createMessage('write', dpt, parseFloat(value));
	// 			mnetdConnection.sendAPDU(msg, function(err) {
	// 				if (err) {
	// 					globs.errorlog("[ERROR] mnetwrite:sendAPDU: " + err);
	// 					if (callback) {
	// 						try {
	// 							callback(err);
	// 						} catch (e) {
	// 							globs.log('Caught error '+ e + ' when calling homebridg callback.');
	// 						}
	// 					}
	// 				} else {
	// 					globs.debug("mnetAccess.mnetwrite: mnet data sent: Value " + value + " for GA " + groupAddress);
	// 					if (callback) {
	// 						try {
	// 							callback();
	// 						} catch (e) {
	// 							globs.log('Caught error '+ e + ' when calling homebridg callback.');
	// 						}
	// 					}
	// 				}
	// 			});
	// 		}
	// 	});
	// });
};

allFunctions.setBooleanState = function(value, callback, gaddress, reverseflag) {
	var numericValue = reverseflag ? 1 : 0;
	if (value) {
		numericValue = reverseflag ? 0 : 1; // need 0 or 1, not true or something
	}
	globs.debug("setBooleanState: Setting " + gaddress + " " + reverseflag ? " (reverse)" : "" + " Boolean to " + numericValue);
	allFunctions.mnetwrite(callback, gaddress, 'DPT1', numericValue);
};

allFunctions.setPercentage = function(value, callback, gaddress, reverseflag) {

	var numericValue = 0;
	value = (value >= 0 ? (value <= 100 ? value : 100) : 0); //ensure range 0..100
	if (reverseflag) {
		numericValue = 255 - Math.round(255 * value / 100); // convert 0..100 to 255..0 for MNET bus  
	} else {
		numericValue = Math.round(255 * value / 100); // convert 0..100 to 0..255 for MNET bus  
	}
	globs.debug("setPercentage: Setting " + gaddress + " percentage " + reverseflag ? " (reverse)" : "" + "  to " + value + " (" + numericValue + ")");
	allFunctions.mnetwrite(callback, gaddress, 'DPT5', numericValue);
};

allFunctions.setInt = function(value, callback, gaddress) {

	var numericValue = 0;
	if (value && value >= 0 && value <= 255) {
		numericValue = value; // assure 0..255 for MNET bus  
	}
	globs.debug("setInt: Setting " + gaddress + " int to " + value + " (" + numericValue + ")");
	allFunctions.mnetwrite(callback, gaddress, 'DPT5', numericValue);

};

allFunctions.setFloat = function(value, callback, gaddress) {

	var numericValue = 0;
	if (value) {
		numericValue = value; // homekit expects precision of 1 decimal
	}
	globs.debug("setFloat: Setting " + gaddress + " Float to %s", numericValue);
	allFunctions.mnetwrite(callback, gaddress, 'DPT9', numericValue);

};


// issues an all purpose read request on the mnet bus
// DOES NOT WAIT for an answer. Please register the address with a callback using registerGA() function
allFunctions.mnetread = function(groupAddress) {
	globs.debug("DEBUG in mnetread");
	if (!groupAddress) {
		return null;
	}
	globs.debug("[mnetdevice:mnetread] preparing mnet request for " + groupAddress);
	var mnetdConnection = new mnetd.Connection();
	//globs.info("DEBUG in mnetread: created empty connection, trying to connect socket to " + globs.mnetd_ip + ":" + globs.mnetd_port);
	mnetdConnection.socketRemote({
		host : globs.mnetd_ip,
		port : globs.mnetd_port
	}, function(err) {
		if (err) {
			throw {
				name : "MNETD connection failed",
				message : "The connection to the mnet daemon failed. Check IP and Port."
			};
		}
		var dest = mnetd.str2addr(groupAddress);
		// globs.info("DEBUG got dest="+dest);
		mnetdConnection.openTGroup(dest, 1, function(err) {
			if (err) {
				globs.errorlog("[ERROR] mnetread:openTGroup: " + err);
			} else {
				// globs.info("DEBUG mnetread: opened TGroup ");
				var msg = mnetd.createMessage('read', 'DPT1', 0);
				mnetdConnection.sendAPDU(msg, function(err) {
					if (err) {
						globs.errorlog("[ERROR] mnetread:sendAPDU: " + err);
					} else {
						globs.debug("[mnetdevice:mnetread] mnet request sent for " + groupAddress);
					}
				});
			}
		});
	});
};

// issuing multiple read requests at once 
allFunctions.mnetreadarray = function(groupAddresses) {
	if (groupAddresses.constructor.toString().indexOf("Array") > -1) {
		// handle multiple addresses
		for (var i = 0; i < groupAddresses.length; i++) {
			if (groupAddresses[i]) { // do not bind empty addresses
				allFunctions.mnetread(groupAddresses[i].match(/(\d*\/\d*\/\d*)/)[0]); // clean address
			}
		}
	} else {
		// it's only one
		allFunctions.mnetread(groupAddresses.match(/(\d*\/\d*\/\d*)/)[0]); // regex for cleaning address
	}
};

/**
 * reads all addresses that are stored in an named list (Object) in notation {"1/2/3":1, "1/2/4":1, ...}
 * @param {object[]} groupAddresses - group addresses in an object notation
 */
allFunctions.mnetreadhash = function(groupAddresses) {
	for ( var address in groupAddresses) {
		if (groupAddresses.hasOwnProperty(address)) { // do not use inherited properties
			allFunctions.mnetread(address.match(/(\d*\/\d*\/\d*)/)[0]); // clean address
		}
		
	}
};

allFunctions.setGlobs = function(globsObject) {
	globs = globsObject;
};

/**
 * Writes a to the bus, using the safe MNETAccess.setXXX methods according to groupAddress.dptype.type
 * 
 * @param {number} value - the new value
 * @param {GroupAddress} groupAddress Object
 * @param {function()} callback - the callback to be called upon completion
 */
allFunctions.writeValueMNET = function(value, groupAddress, callback) {
	/* depending on the DPT of the target address we have to convert the value. 
	 * As with the possible mappings the dpt could be different for mapping results, 
	 * we do it at runtime, and do not do the decision at init time.
	 */

	var setGA = groupAddress.address;
	var setReverse = groupAddress.reversed;

/*
	iterate(groupAddress);
	globs.debug("Value: " + value);
	globs.debug("Reversed: "+ setReverse);
*/
	switch (groupAddress.dptype) {
	case "DPT1":
		allFunctions.setBooleanState(value, callback, setGA, setReverse); 
		break;
	case "DPT5.001":
		allFunctions.setPercentage(value, callback, setGA, setReverse);
		break;
	case "DPT9":
		allFunctions.setFloat(value, callback, setGA);
		break;
	case "DPT5":
		allFunctions.setInt(value, callback, setGA);
		break;
	default: 
		globs.errorlog( "[ERROR] unknown type passed: [" + groupAddress.dptype + "]" );
	throw new Error("[ERROR] unknown type passed");

	}

};

/**
 * Writes a value to a HomeKit characteristic, depending on the compatibility of the characteristic and the value
 * 
 * @param {number} val - the value to be written to HK
 * @param {./lib/characterisitic-mnet~CharacteristicMNET} chrMNET
 * @param {String} type - the DPT of the value received, if received directly from the bus. null or undefined if
 *        mapped using values.
 */
allFunctions.writeValueHK = function(val, chrMNET, type, reverse) {
	// switch depending on the value type to be written
	// @type {hap-nodeJS/lib/characteristic.js~characteristic}
	var characteristic = chrMNET.getHomekitCharacteristic();
	globs.debug("mnetAccess.writeValueHK("+ val +","+chrMNET.name+","+type+","+reverse + ")");
	globs.debug("mnetAccess.writeValueHK: Format "+ characteristic.props.format +"");
	
	var returnValue=null;
	
	switch (characteristic.props.format) {
	/*
	 * // Known HomeKit formats
		Characteristic.Formats = {
		BOOL: 'bool',
		INT: 'int',
		FLOAT: 'float',
		STRING: 'string',
		ARRAY: 'array', // unconfirmed
		DICTIONARY: 'dictionary', // unconfirmed
		UINT8: 'uint8',
		UINT16: 'uint16',
		UINT32: 'uint32',
		UINT64: 'uint64',
		DATA: 'data', // unconfirmed
		TLV8: 'tlv8'
		}
	 */
	case globs.Characteristic.Formats.BOOL:
		// boolean is good for any trueish expression from value
		globs.debug("BOOL:[" + characteristic.displayName + "]: Received value from MNET handler:" + val + " of type " + type );
		//characteristic.setValue(val ? (reverse ? 0 : 1) : (reverse ? 1 : 0), undefined, 'fromMNETBus');
		returnValue = val ? (reverse ? 0 : 1) : (reverse ? 1 : 0);
		break;
	case globs.Characteristic.Formats.INT:
		// let fall through
	case globs.Characteristic.Formats.UINT8:
		// to an INT we can assume that the min and max values are set, or a list of allowed values is supplied
		globs.debug("INT:[" + characteristic.displayName + "]: Received value from MNET handler:" + val + " of type " + type );
		
		//iterate(characteristic.props);

		/* using evil twins "==" to address bug #66 https://github.com/snowdd1/homebridge-mnet/issues/66 */
		if (characteristic.props.minValue == undefined && characteristic.props.maxValue == undefined) {
			// no min or max defined, we use the safeSet() function to check for a list of allowed values
			//characteristic.setValue(safeSet(characteristic, val), undefined, 'fromMNETBus');
			returnValue = val; // safeSet(characteristic, val);
			// does it behave boolean and has a Reverse key word?
// does not work, validation now part of HAP-nodeJS
//			if (characteristic.behaveBoolean && reverse) {
//				returnValue = returnValue ? 0:1 ; // true(ish) returns 0 and false(ish) returns 1
//			}
		} else {

			// we have a defined range. If it's a percentage, we want to convert the bus value to the spectrum
			if (characteristic.props.unit === globs.Characteristic.Units.PERCENTAGE) {
				if (type === 'DPT5' || type === 'DPT5.001') {
					val = (reverse ? (255 - val) : val) / 255 * 100;
				}
				// if the sending types are different, assume decimal percentage value (100=100%)
			}
			// round it for integer use:
			val = Math.round(val);
			if (val >= (characteristic.props.minValue || 0) && val <= (characteristic.props.maxValue || 255)) {
				// it's in range
				returnValue = val;
				//characteristic.setValue(val, undefined, 'fromMNETBus');
			} else {
				globs.errorlog('error', "["  + "]:[" + characteristic.displayName + "]: Value " + val + " out of bounds "+(characteristic.props.minValue || 0)+"..."+(characteristic.props.maxValue || 255));
			}
		}

		break;
	case globs.Characteristic.Formats.FLOAT:
		globs.debug("FLOAT:[" + characteristic.displayName + "]: Received value from MNET handler:" + val + " of type " + type + " for " +
				characteristic.displayName);

		// If it's a percentage, we want to convert the bus value to the spectrum
		if (characteristic.props.unit === globs.Characteristic.Units.PERCENTAGE) {
			if (type === 'DPT5' || type === 'DPT5.001') {
				val = Math.round((reverse ? (255 - val) : val) / 255 * 100);
			}
			// if the sending types are different, assume decimal percentage value (100=100%)
		}

		// make hk_value compliant to properties
		var hk_value;
		if (characteristic.props.minStep) {
			// quantize
			hk_value = Math.round(val / characteristic.props.minStep) / (1 / characteristic.props.minStep);
		} else {
			hk_value = val;
		}
		// range check
		var validValue = true; // assume validity at beginning
		if (characteristic.props.minValue) {
			validValue = validValue && (hk_value >= characteristic.props.minValue);
		}
		if (characteristic.props.maxValue) {
			validValue = validValue && (hk_value <= characteristic.props.maxValue);
		}
		if (validValue) {
			returnValue = hk_value;
			//characteristic.setValue(hk_value, undefined, 'fromMNETBus');
		} else {
			globs.errorlog(":[" + characteristic.displayName + "]: Value " + hk_value +" out of bounds "+ characteristic.props.minValue +" ... " + characteristic.props.maxValue);
		}
		break;
	default:
		globs.log.warn("mnetAccess.writeValueHK() - NO KNOWN TYPE");
		break;
	}
	if (returnValue!==null) {
		// the value has changed
		// is the value the same as in homebridge?
		if (characteristic.value!==returnValue) {
			// value has changed
			globs.debug('Value changed, updating homebridge');
			characteristic.updateValue(returnValue, undefined, 'fromMNETBus');
		} else {
			globs.debug('INFO HomeKit:  No value change');
		}
	} else {
		globs.debug('INFO HomeKit:  No valid value.');
	}
	globs.debug('exiting writeValueHK()');
};

/**
 * Validates a string as group Address and returns an explanatory text if wrong, and "OK" if ok.
 * 
 * 
 * @param {String} groupAddress - Address as String, such as "31/7/255"
 * @returns {String}
 */
allFunctions.validateAddressText = function(groupAddress) {
	if (typeof groupAddress !== 'string') {
		return 'ERR Invalid parameter';
	}
	// assume triple notation (0..31) (0..7) (0..255)
	// extended to 5 bit for first triple
	// https://github.com/snowdd1/homebridge-mnet/issues/72
	// https://github.com/andreek/node-eibd/pull/41
	var addressArray = groupAddress.match(/^(([0-9]|[1-9][0-9]{1,2})\/([0-9]|[1-9][0-9]{1,2})\/([0-9]|[1-9][0-9]{1,2}))/);
	if (!addressArray) {
		// no valid structure
		return 'ERR no valid group address structure (31/7/255)';
	}
	if (parseInt(addressArray[2]) > 31) {
		return 'ERR no valid group address structure (31/7/255): first triple exceeds 31';
	}
	if (parseInt(addressArray[3]) > 7) {
		return 'ERR no valid group address structure (31/7/255): second triple exceeds 7';
	}
	if (parseInt(addressArray[4]) > 255) {
		return 'ERR no valid group address structure (31/7/255): third triple exceeds 255';
	}
	return 'OK';
};

////function to avoid out of bounds for fixed-value characteristics
////for float types this is already managed by hap-nodeJS itself
////returns a value that can be safely used in 
//var safeSet = function(char, value) {
//	var Characteristic = globs.Characteristic;
//	//console.log("DEBUG: entered safeSet");
//	//iterate(char);
//	if (char.props.format === "uint8" || char.props.format === "int") {
//		//console.log("DEBUG: format ok");
//		// fixed-value formats use unsigned integer AFAIK
//		if (!char.hasOwnProperty("validValues")) {
//			//console.log("DEBUG: establishing safe values");
//			// we need to find those first
//			// find the prototype
//			var displayName = char.displayName;
//			if (Characteristic.hasOwnProperty(displayName.replace(/ /g, ''))) {
//				var chartype = displayName.replace(/ /g, '');
//				//console.log("DEBUG: chartype " + chartype);
//				for ( var name in Characteristic[chartype]) {
//					//console.log("DEBUG: chartype.name " + name);
//					if (Characteristic[chartype].hasOwnProperty(name)) {
//						//console.log("DEBUG: typeof chartype.name " + typeof Characteristic[chartype][name]);
//						if (typeof Characteristic[chartype][name] === 'number') {
//							// add it to the array
//							if (char.hasOwnProperty("validValues")) {
//								char.validValues = char.validValues.concat(Characteristic[chartype][name]);
//								//console.log("DEBUG: following: length " + char.validValues.length);
//							} else {
//								char.validValues = [ Characteristic[chartype][name] ];
//								//console.log("DEBUG: 1st: length " + char.validValues.length);
//							}
//						}
//					}
//				}
//			}
//			// sort the array of valid numeric values:
//			char.validValues.sort(function(a, b){return a-b});
//			if (char.validValues.toString === '0,1') {
//				// boolean behavior
//				char.behaveBoolean = true;
//			}
//			console.log("DEBUG: " + char.displayName + " has now validValues of " + char.validValues);
//		}
//		// compare value to allowed values
//		if (char.hasOwnProperty("validValues")) {
//			//do the check
//			if (char.validValues.indexOf(value) < 0) {
//				// didn't find
//				console.log("DEBUG: " + char.displayName + " has validValue of " + char.validValues);
//				console.log("DEBUG: " + char.displayName + " ERROR illegal value " + value);
//				value = char.validValues[0]; // default to first one
//				console.log("DEBUG: " + char.displayName + " ERROR returned instead " + value);
//			}
//		}
//
//	} else {
//		console.log("DEBUG: " + char.props.format + "!== uint8 and !==int" );
//	}
//	return value;
//};
module.exports = allFunctions;