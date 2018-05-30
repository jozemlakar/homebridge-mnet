/**
 * Add the Characteristic of home temperature
 */
/* jshint esversion: 6, strict: true, node: true */
'use strict';

var inherits = require('util').inherits;
var log = require('debug')('MNETThermAtHome custom service/characteristic');


module.exports = function(API) {
	// we are going to extend API.hap.Characteristic and API.hap.Service

	var Characteristic = API.hap.Characteristic;
	var Service = API.hap.Service;

	Characteristic.MNETThermAtHome = function() {
		Characteristic.call(this, 'At Home', '00001025-0000-1000-8000-0026BB765292');
		this.setProps({
			format : Characteristic.Formats.BOOL,
			perms : [
				Characteristic.Perms.READ,
				Characteristic.Perms.WRITE,
				Characteristic.Perms.NOTIFY ]
		});
		this.value = this.getDefaultValue();
	};
	inherits(Characteristic.MNETThermAtHome, Characteristic);
	Characteristic.MNETThermAtHome.UUID = '00001025-0000-1000-8000-0026BB765292';

	log('Done');
};
